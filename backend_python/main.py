import os
from fastapi import FastAPI, HTTPException, File, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
import rasterio
import rasterio.features
import rasterio.warp
import rasterio.mask
import numpy as np
from typing import Optional, List
import json
import shutil
import time
from pydantic import BaseModel
from math import radians, cos, sin, asin, sqrt
import pyproj
from pyproj import Transformer
import logging
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("backend_python")

app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Uploads directory - needs to be mounted or same path
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", "../backend/uploads")

# DTM data directory - where source TIFF files are stored
DTM_DATA_DIR = os.environ.get("DTM_DATA_DIR", UPLOADS_DIR)
DTM_CACHE_DIR = os.environ.get("DTM_CACHE_DIR", os.path.join(DTM_DATA_DIR, "Cache"))

logger.info(f"UPLOADS_DIR: {UPLOADS_DIR}")
logger.info(f"DTM_DATA_DIR: {DTM_DATA_DIR}")
logger.info(f"DTM_CACHE_DIR: {DTM_CACHE_DIR}")

class ElevationProfileRequest(BaseModel):
    coordinates: List[List[float]]
    dtmPath: str
    safetyRadiusMeters: Optional[float] = 50.0
    resolutionRadiusMeters: Optional[float] = 50.0

class AOI(BaseModel):
    type: str  # 'bbox' or 'polygon'
    crs: str  # e.g., 'EPSG:4326'
    bbox: Optional[List[float]] = None  # [minLon, minLat, maxLon, maxLat] for bbox type
    coordinates: Optional[List[List[float]]] = None  # [[lon, lat], ...] for polygon type

class ClipRequest(BaseModel):
    dtmId: str
    aoi: AOI

def haversine(lon1, lat1, lon2, lat2):
    """
    Calculate the great circle distance between two points 
    on the earth (specified in decimal degrees)
    """
    # convert decimal degrees to radians 
    lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])

    # haversine formula 
    dlon = lon2 - lon1 
    dlat = lat2 - lat1 
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    c = 2 * asin(sqrt(a)) 
    r = 6371000 # Radius of earth in meters. Use 3956 for miles
    return c * r

def interpolate_segment(start, end, interval_meters):
    dist = haversine(start[0], start[1], end[0], end[1])
    if dist < interval_meters:
        return [start, end]
        
    num_points = max(2, int(np.ceil(dist / interval_meters)))
    lons = np.linspace(start[0], end[0], num_points)
    lats = np.linspace(start[1], end[1], num_points)
    
    return [[float(lon), float(lat)] for lon, lat in zip(lons, lats)]

@app.post("/elevation-profile")
async def get_elevation_profile(request: ElevationProfileRequest):
    start_time = time.time()
    logger.info(f"Calculating elevation profile for {request.dtmPath} with {len(request.coordinates)} points")
    
    if len(request.coordinates) < 2:
        raise HTTPException(status_code=400, detail="At least two points required")
        
    # Extract filename from path
    filename = os.path.basename(request.dtmPath)
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail=f"DTM file not found: {filename}")
        
    try:
        with rasterio.open(file_path) as src:
            # Prepare coordinate transformation
            src_crs = src.crs
            if not src_crs:
                # Heuristic fallback if CRS is missing
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs = "EPSG:32636" if is_projected else "EPSG:4326"
            
            transformer = Transformer.from_crs("EPSG:4326", src_crs, always_xy=True)
            
            # Generate sampling points
            sampling_interval = 5.0 # meters
            all_points = [request.coordinates[0]]
            
            for i in range(len(request.coordinates) - 1):
                segment_points = interpolate_segment(request.coordinates[i], request.coordinates[i+1], sampling_interval)
                # Avoid duplicates at vertices
                all_points.extend(segment_points[1:])
                
            profile = []
            cumulative_distance = 0.0
            
            # Get raster data properties
            nodata = src.nodata
            res_x, res_y = src.res # Resolution in CRS units
            
            # Pre-calculate sampling points' pixel coordinates and distances
            for i in range(len(all_points)):
                lon, lat = all_points[i]
                if i > 0:
                    prev_lon, prev_lat = all_points[i-1]
                    cumulative_distance += haversine(prev_lon, prev_lat, lon, lat)
                
                # Transform to DTM CRS
                x, y = transformer.transform(lon, lat)
                
                # Transform to pixel coordinates
                row, col = src.index(x, y)
                
                # Check if inside bounds
                if not (0 <= row < src.height and 0 <= col < src.width):
                    profile.append({
                        "distance": cumulative_distance,
                        "elevation": 0.0,
                        "longitude": lon,
                        "latitude": lat,
                        "minElevation": 0.0,
                        "maxElevation": 0.0
                    })
                    continue
                
                # Sample elevation at point
                # Use a small window for point sampling or just read direct
                elevation_arr = src.read(1, window=rasterio.windows.Window(col, row, 1, 1))
                elevation = float(elevation_arr[0, 0])
                if nodata is not None and elevation == nodata:
                    elevation = 0.0
                elif np.isnan(elevation):
                    elevation = 0.0
                
                # Min/Max in radius
                # Calculate pixel radius
                # Using max of resolution because pixels might not be square
                pixel_radius_safety = int(np.ceil(request.safetyRadiusMeters / min(abs(res_x), abs(res_y))))
                pixel_radius_resolution = int(np.ceil(request.resolutionRadiusMeters / min(abs(res_x), abs(res_y))))
                
                max_pixel_radius = max(pixel_radius_safety, pixel_radius_resolution)
                
                # Define window for min/max
                win_row_start = max(0, row - max_pixel_radius)
                win_row_end = min(src.height, row + max_pixel_radius + 1)
                win_col_start = max(0, col - max_pixel_radius)
                win_col_end = min(src.width, col + max_pixel_radius + 1)
                
                window = rasterio.windows.Window(
                    win_col_start, 
                    win_row_start, 
                    win_col_end - win_col_start, 
                    win_row_end - win_row_start
                )
                
                data_window = src.read(1, window=window)
                
                # Create masks for safety and resolution radii
                # Relative coordinates in the window
                rel_row, rel_col = row - win_row_start, col - win_col_start
                rows, cols = np.ogrid[:data_window.shape[0], :data_window.shape[1]]
                
                if src.crs and src.crs.is_projected:
                    # Projected CRS (units are typically meters)
                    dist_sq = ((rows - rel_row) * abs(res_y))**2 + ((cols - rel_col) * abs(res_x))**2
                else:
                    # Geographic CRS (units are degrees)
                    # Convert degrees to meters approximately at this latitude
                    meters_per_degree_lat = 111320.0
                    meters_per_degree_lon = 111320.0 * cos(radians(lat))
                    dist_sq = ((rows - rel_row) * abs(res_y) * meters_per_degree_lat)**2 + \
                              ((cols - rel_col) * abs(res_x) * meters_per_degree_lon)**2
                
                mask_safety = dist_sq <= request.safetyRadiusMeters**2
                mask_resolution = dist_sq <= request.resolutionRadiusMeters**2
                
                # Handle no-data
                if nodata is not None:
                    valid_mask = data_window != nodata
                else:
                    valid_mask = np.ones_like(data_window, dtype=bool)
                
                if np.issubdtype(data_window.dtype, np.floating):
                    valid_mask &= ~np.isnan(data_window)

                # Min elevation (Safety)
                safety_data = data_window[mask_safety & valid_mask]
                min_elev = float(np.min(safety_data)) if safety_data.size > 0 else elevation
                
                # Max elevation (Resolution)
                resolution_data = data_window[mask_resolution & valid_mask]
                max_elev = float(np.max(resolution_data)) if resolution_data.size > 0 else elevation
                
                profile.append({
                    "distance": cumulative_distance,
                    "elevation": elevation,
                    "longitude": lon,
                    "latitude": lat,
                    "minElevation": min_elev,
                    "maxElevation": max_elev
                })
                
            duration = time.time() - start_time
            logger.info(f"Elevation profile calculated in {duration:.3f}s, sampled {len(profile)} points")
            return {"profile": profile}
            
    except Exception as e:
        logger.error(f"Error calculating elevation profile: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "backend_python"}

@app.get("/api/dtm/options")
async def get_dtm_options():
    """List available DTM files in the DTM_DATA_DIR"""
    print(f"=== GET /api/dtm/options called ===")
    print(f"DTM_DATA_DIR = {DTM_DATA_DIR}")
    try:
        logger.info(f"Scanning DTM_DATA_DIR: {DTM_DATA_DIR}")
        print(f"Directory exists: {os.path.exists(DTM_DATA_DIR)}")
        print(f"Directory contents: {os.listdir(DTM_DATA_DIR) if os.path.exists(DTM_DATA_DIR) else 'N/A'}")
        
        if not os.path.exists(DTM_DATA_DIR):
            logger.warning(f"DTM_DATA_DIR does not exist: {DTM_DATA_DIR}")
            return {"options": []}
        
        options = []
        
        # Scan for TIFF files
        for filename in os.listdir(DTM_DATA_DIR):
            if filename.lower().endswith(('.tif', '.tiff', '.geotiff')):
                file_path = os.path.join(DTM_DATA_DIR, filename)
                
                # Skip if it's not a file
                if not os.path.isfile(file_path):
                    continue
                
                try:
                    # Get file stats
                    stats = os.stat(file_path)
                    
                    # Try to open and get metadata
                    with rasterio.open(file_path) as src:
                        bounds = src.bounds
                        options.append({
                            "id": filename,
                            "displayName": filename,
                            "name": filename,
                            "sizeBytes": stats.st_size,
                            "modifiedAt": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(stats.st_mtime)),
                            "bounds": {
                                "minX": bounds.left,
                                "minY": bounds.bottom,
                                "maxX": bounds.right,
                                "maxY": bounds.top
                            },
                            "resolution": {
                                "width": src.width,
                                "height": src.height
                            },
                            "crs": src.crs.to_string() if src.crs else None
                        })
                        logger.info(f"Found DTM file: {filename}")
                except Exception as e:
                    logger.warning(f"Could not read {filename}: {e}")
                    continue
        
        logger.info(f"Found {len(options)} DTM files")
        return {"options": options}
        
    except Exception as e:
        logger.error(f"Error listing DTM options: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/dtm/{filename}/metadata")
async def get_dtm_metadata(filename: str):
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    logger.info(f"Fetching metadata for DTM: {filename}")
    try:
        with rasterio.open(file_path) as src:
            bounds = src.bounds
            return {
                "filename": filename,
                "bounds": {
                    "minX": bounds.left,
                    "minY": bounds.bottom,
                    "maxX": bounds.right,
                    "maxY": bounds.top
                },
                "resolution": {
                    "width": src.width,
                    "height": src.height
                },
                "noDataValue": src.nodata,
                "crs": src.crs.to_string() if src.crs else None
            }
    except Exception as e:
        logger.error(f"Error reading metadata for {filename}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upload-dtm")
async def upload_dtm(dtm: UploadFile = File(...)):
    start_time = time.time()
    logger.info(f"Uploading DTM: {dtm.filename}")
    try:
        # Generate filename with timestamp similar to Node.js backend
        filename = f"{int(time.time() * 1000)}-{dtm.filename}"
        file_path = os.path.join(UPLOADS_DIR, filename)
        
        # Ensure uploads directory exists
        os.makedirs(UPLOADS_DIR, exist_ok=True)
        
        # Save the uploaded file
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(dtm.file, buffer)
            
        # Get metadata for the newly uploaded file
        metadata = await get_dtm_metadata(filename)
        
        duration = time.time() - start_time
        logger.info(f"DTM uploaded successfully: {filename} in {duration:.3f}s")
        
        return {
            "success": True,
            "filename": filename,
            "path": f"/uploads/{filename}",
            "size": os.path.getsize(file_path),
            "bounds": metadata["bounds"],
            "resolution": metadata["resolution"]
        }
    except Exception as e:
        logger.error(f"Error uploading DTM {dtm.filename}: {e}", exc_info=True)
        # Clean up if file was partially written
        if 'file_path' in locals() and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/dtm/{filename}/raster")
async def get_dtm_raster(filename: str):
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    start_time = time.time()
    logger.info(f"Reading raster data for DTM: {filename}")
    try:
        with rasterio.open(file_path) as src:
            # Downsample for visualization if too large
            # 2048x2048 is more than enough for a map preview and stays well within JSON/browser limits
            MAX_DIM = 2048
            
            if src.width > MAX_DIM or src.height > MAX_DIM:
                scale = max(src.width, src.height) / MAX_DIM
                new_width = int(src.width / scale)
                new_height = int(src.height / scale)
                logger.info(f"Downsampling DTM from {src.width}x{src.height} to {new_width}x{new_height} (factor {scale:.2f})")
                
                data = src.read(
                    1,
                    out_shape=(new_height, new_width),
                    resampling=rasterio.enums.Resampling.bilinear
                )
                render_width = new_width
                render_height = new_height
            else:
                data = src.read(1)
                render_width = src.width
                render_height = src.height
            
            # Get stats
            nodata = src.nodata
            
            valid_mask = data != nodata if nodata is not None else np.ones_like(data, dtype=bool)
            # Handle NaN if present in float data
            if np.issubdtype(data.dtype, np.floating):
                valid_mask &= ~np.isnan(data)
                
            if valid_mask.any():
                min_val = float(np.min(data[valid_mask]))
                max_val = float(np.max(data[valid_mask]))
            else:
                min_val = 0.0
                max_val = 0.0
            
            bounds = src.bounds
            
            # Check projection
            is_projected = False
            if src.crs:
                is_projected = src.crs.is_projected
            else:
                # Heuristic fallback
                is_projected = abs(bounds.left) > 180 or abs(bounds.bottom) > 90
            
            # Convert to list for JSON response
            # Flatten array
            flat_data = data.flatten()
            
            res = {
                "width": render_width,
                "height": render_height,
                "originalWidth": src.width,
                "originalHeight": src.height,
                "min": min_val,
                "max": max_val,
                "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
                "noDataValue": nodata,
                "isProjected": is_projected,
                "data": flat_data.tolist(),
                "crs": src.crs.to_string() if src.crs else None
            }
            duration = time.time() - start_time
            logger.info(f"Raster data read and processed for {filename} in {duration:.3f}s")
            return res
            
    except Exception as e:
        logger.error(f"Error reading raster {filename}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/dtm/clip")
async def clip_dtm(request: ClipRequest):
    """Clip a DTM file to an area of interest (AOI)"""
    start_time = time.time()
    logger.info(f"Clipping DTM {request.dtmId} with AOI type: {request.aoi.type}")
    
    try:
        # Find the DTM file
        dtm_file_path = os.path.join(DTM_DATA_DIR, request.dtmId)
        
        if not os.path.exists(dtm_file_path):
            # Also check UPLOADS_DIR as fallback
            dtm_file_path = os.path.join(UPLOADS_DIR, request.dtmId)
            if not os.path.exists(dtm_file_path):
                raise HTTPException(status_code=404, detail=f"DTM file not found: {request.dtmId}")
        
        # Ensure cache directory exists
        os.makedirs(DTM_CACHE_DIR, exist_ok=True)
        
        # Generate unique clipped ID
        clipped_id = f"{int(time.time() * 1000)}-{request.dtmId.rsplit('.', 1)[0] if '.' in request.dtmId else request.dtmId}"
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        
        # Open source DTM
        with rasterio.open(dtm_file_path) as src:
            src_crs = src.crs
            if not src_crs:
                # Try to infer CRS from bounds
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs_str = "EPSG:32636" if is_projected else "EPSG:4326"
                src_crs = pyproj.CRS.from_string(src_crs_str)
            else:
                # Ensure src_crs is a pyproj.CRS object
                if not isinstance(src_crs, pyproj.CRS):
                    src_crs = pyproj.CRS.from_string(str(src_crs))
            
            # Convert AOI to source CRS
            aoi_crs = pyproj.CRS.from_string(request.aoi.crs)
            transformer = Transformer.from_crs(aoi_crs, src_crs, always_xy=True)
            
            # Create geometry from AOI (convert to shapely geometry via rasterio.features)
            if request.aoi.type == "bbox" and request.aoi.bbox:
                min_lon, min_lat, max_lon, max_lat = request.aoi.bbox
                # Transform bbox coordinates
                min_x, min_y = transformer.transform(min_lon, min_lat)
                max_x, max_y = transformer.transform(max_lon, max_lat)
                # Create polygon geometry as GeoJSON-like dict
                geom_dict = {
                    "type": "Polygon",
                    "coordinates": [[
                        [min_x, min_y],
                        [max_x, min_y],
                        [max_x, max_y],
                        [min_x, max_y],
                        [min_x, min_y]
                    ]]
                }
            elif request.aoi.type == "polygon" and request.aoi.coordinates:
                # Transform polygon coordinates
                transformed_coords = [list(transformer.transform(lon, lat)) for lon, lat in request.aoi.coordinates]
                # Ensure polygon is closed
                if transformed_coords[0] != transformed_coords[-1]:
                    transformed_coords.append(transformed_coords[0])
                # Create polygon geometry as GeoJSON-like dict
                geom_dict = {
                    "type": "Polygon",
                    "coordinates": [transformed_coords]
                }
            else:
                raise HTTPException(status_code=400, detail="Invalid AOI: must have bbox for bbox type or coordinates for polygon type")
            
            # Clip the raster (rasterio.mask.mask accepts GeoJSON-like dicts directly)
            out_image, out_transform = rasterio.mask.mask(src, [geom_dict], crop=True)
            out_meta = src.meta.copy()
            
            # Update metadata
            out_meta.update({
                "driver": "GTiff",
                "height": out_image.shape[1],
                "width": out_image.shape[2],
                "transform": out_transform,
                "compress": "lzw"
            })
            
            # Calculate bounds from transform
            left = out_transform[2]
            top = out_transform[5]
            right = left + out_transform[0] * out_meta["width"]
            bottom = top + out_transform[4] * out_meta["height"]
            
            # Transform bounds to WGS84
            out_bounds = rasterio.warp.transform_bounds(src_crs, "EPSG:4326", left, bottom, right, top)
            
            # Write clipped raster
            with rasterio.open(clipped_file_path, "w", **out_meta) as dest:
                dest.write(out_image)
            
            # Generate URLs (these will be served by the Node.js backend)
            base_url = f"/api/dtm/clipped/{clipped_id}"
            
            duration = time.time() - start_time
            logger.info(f"DTM clipped successfully in {duration:.3f}s: {clipped_id}")
            
            return {
                "clippedId": clipped_id,
                "raster": {
                    "crs": src_crs.to_string() if src_crs else None,
                    "bbox": list(out_bounds),  # [minLon, minLat, maxLon, maxLat]
                    "width": out_meta["width"],
                    "height": out_meta["height"]
                },
                "tilesUrl": f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.png",
                "metadataUrl": f"{base_url}/metadata",
                "dataUrl": f"{base_url}/raster"
            }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error clipping DTM: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dtm/clipped/{clipped_id}/metadata")
async def get_clipped_dtm_metadata(clipped_id: str):
    """Get metadata for a clipped DTM"""
    try:
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        
        if not os.path.exists(clipped_file_path):
            raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id}")
        
        with rasterio.open(clipped_file_path) as src:
            bounds = src.bounds
            # Transform bounds to WGS84
            wgs84_bounds = rasterio.warp.transform_bounds(src.crs, "EPSG:4326", *bounds)
            
            return {
                "clippedId": clipped_id,
                "filename": f"{clipped_id}.tif",
                "bounds": {
                    "minX": wgs84_bounds[0],
                    "minY": wgs84_bounds[1],
                    "maxX": wgs84_bounds[2],
                    "maxY": wgs84_bounds[3]
                },
                "resolution": {
                    "width": src.width,
                    "height": src.height
                },
                "noDataValue": src.nodata,
                "crs": src.crs.to_string() if src.crs else None
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading clipped DTM metadata: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dtm/clipped/{clipped_id}/raster")
async def get_clipped_dtm_raster(clipped_id: str):
    """Get raster data for a clipped DTM"""
    try:
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        
        if not os.path.exists(clipped_file_path):
            raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id}")
        
        start_time = time.time()
        logger.info(f"Reading raster data for clipped DTM: {clipped_id}")
        
        with rasterio.open(clipped_file_path) as src:
            # Downsample for visualization if too large
            MAX_DIM = 2048
            
            if src.width > MAX_DIM or src.height > MAX_DIM:
                scale = max(src.width, src.height) / MAX_DIM
                new_width = int(src.width / scale)
                new_height = int(src.height / scale)
                logger.info(f"Downsampling clipped DTM from {src.width}x{src.height} to {new_width}x{new_height}")
                
                data = src.read(
                    1,
                    out_shape=(new_height, new_width),
                    resampling=rasterio.enums.Resampling.bilinear
                )
                render_width = new_width
                render_height = new_height
            else:
                data = src.read(1)
                render_width = src.width
                render_height = src.height
            
            # Get stats
            nodata = src.nodata
            valid_mask = data != nodata if nodata is not None else np.ones_like(data, dtype=bool)
            if np.issubdtype(data.dtype, np.floating):
                valid_mask &= ~np.isnan(data)
            
            if valid_mask.any():
                min_val = float(np.min(data[valid_mask]))
                max_val = float(np.max(data[valid_mask]))
            else:
                min_val = 0.0
                max_val = 0.0
            
            bounds = src.bounds
            wgs84_bounds = rasterio.warp.transform_bounds(src.crs, "EPSG:4326", *bounds)
            
            is_projected = src.crs.is_projected if src.crs else (abs(bounds.left) > 180 or abs(bounds.bottom) > 90)
            
            flat_data = data.flatten()
            
            res = {
                "width": render_width,
                "height": render_height,
                "originalWidth": src.width,
                "originalHeight": src.height,
                "min": min_val,
                "max": max_val,
                "bounds": list(wgs84_bounds),
                "noDataValue": nodata,
                "isProjected": is_projected,
                "data": flat_data.tolist(),
                "crs": src.crs.to_string() if src.crs else None
            }
            duration = time.time() - start_time
            logger.info(f"Raster data read for clipped DTM in {duration:.3f}s")
            return res
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading clipped DTM raster: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/dtm/clipped/{clipped_id}")
async def delete_clipped_dtm(clipped_id: str):
    """Delete a clipped DTM from the cache directory"""
    try:
        logger.info(f"Deleting clipped DTM: {clipped_id} from cache directory: {DTM_CACHE_DIR}")
        
        # Ensure DTM_CACHE_DIR exists
        if not os.path.exists(DTM_CACHE_DIR):
            logger.warning(f"DTM_CACHE_DIR does not exist: {DTM_CACHE_DIR}")
            return {"success": True, "deleted": False, "message": "Cache directory does not exist"}
        
        # List all files in cache directory for debugging
        try:
            all_files = os.listdir(DTM_CACHE_DIR)
            logger.info(f"Files in cache directory ({len(all_files)} total): {all_files[:10]}...")  # Log first 10
        except Exception as e:
            logger.error(f"Error listing cache directory: {e}")
            all_files = []
        
        # Look for files matching the clipped_id in the cache directory
        # The clipped_id might be used as a prefix, exact filename, or in various formats
        deleted_files = []
        not_found = True
        
        def should_delete_file(filepath, name):
            """Check if a file/directory should be deleted based on clipped_id"""
            # Normalize the name for comparison (case-insensitive, remove extensions)
            name_lower = name.lower()
            clipped_id_lower = clipped_id.lower()
            
            # Check exact match
            if name == clipped_id or name_lower == clipped_id_lower:
                return True
            
            # Check if name starts with clipped_id
            if name.startswith(clipped_id) or name_lower.startswith(clipped_id_lower):
                return True
            
            # Check with common extensions
            for ext in ['.tif', '.tiff', '.geotiff', '.png', '.jpg', '.jpeg']:
                if name == f"{clipped_id}{ext}" or name_lower == f"{clipped_id_lower}{ext}":
                    return True
                if name.startswith(f"{clipped_id}_") or name.startswith(f"{clipped_id}-"):
                    return True
            
            # Check if clipped_id is contained in filename (more flexible)
            if clipped_id in name or clipped_id_lower in name_lower:
                return True
            
            return False
        
        def delete_recursive(root_dir, current_path=""):
            """Recursively search and delete matching files/directories"""
            nonlocal deleted_files, not_found
            full_path = os.path.join(root_dir, current_path) if current_path else root_dir
            
            if not os.path.exists(full_path):
                return
            
            try:
                items = os.listdir(full_path)
            except PermissionError:
                logger.warning(f"Permission denied accessing: {full_path}")
                return
            except Exception as e:
                logger.error(f"Error listing directory {full_path}: {e}")
                return
            
            for item in items:
                item_path = os.path.join(full_path, item)
                relative_path = os.path.join(current_path, item) if current_path else item
                
                try:
                    if os.path.isdir(item_path):
                        # Check if directory name matches
                        if should_delete_file(item_path, item):
                            # Delete entire directory
                            shutil.rmtree(item_path)
                            deleted_files.append(relative_path)
                            logger.info(f"Deleted clipped DTM directory: {relative_path}")
                            not_found = False
                        else:
                            # Recursively search subdirectories
                            delete_recursive(root_dir, relative_path)
                    elif os.path.isfile(item_path):
                        # Check if file name matches
                        if should_delete_file(item_path, item):
                            os.remove(item_path)
                            deleted_files.append(relative_path)
                            logger.info(f"Deleted clipped DTM file: {relative_path}")
                            not_found = False
                except Exception as e:
                    logger.error(f"Error deleting {relative_path}: {e}", exc_info=True)
        
        # Start recursive deletion
        delete_recursive(DTM_CACHE_DIR)
        
        if not_found:
            logger.warning(f"Clipped DTM not found: {clipped_id} in directory: {DTM_CACHE_DIR}")
            logger.warning(f"Available files: {all_files}")
            return {"success": True, "deleted": False, "message": f"Clipped DTM {clipped_id} not found", "availableFiles": all_files[:20]}
        
        logger.info(f"Successfully deleted {len(deleted_files)} file(s) for clipped DTM: {clipped_id}")
        return {
            "success": True,
            "deleted": True,
            "clippedId": clipped_id,
            "deletedFiles": deleted_files
        }
        
    except Exception as e:
        logger.error(f"Error deleting clipped DTM {clipped_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
