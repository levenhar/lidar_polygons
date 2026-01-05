import os
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import rasterio
import rasterio.features
import rasterio.warp
import numpy as np
from typing import Optional, List
import json
import shutil
import time
from pydantic import BaseModel
from math import radians, cos, sin, asin, sqrt
import pyproj
from pyproj import Transformer

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

class ElevationProfileRequest(BaseModel):
    coordinates: List[List[float]]
    dtmPath: str
    safetyRadiusMeters: Optional[float] = 50.0
    resolutionRadiusMeters: Optional[float] = 50.0

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
                
            return {"profile": profile}
            
    except Exception as e:
        print(f"Error calculating elevation profile: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "backend_python"}

@app.get("/dtm/{filename}/metadata")
async def get_dtm_metadata(filename: str):
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
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
        print(f"Error reading metadata: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upload-dtm")
async def upload_dtm(dtm: UploadFile = File(...)):
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
        
        return {
            "success": True,
            "filename": filename,
            "path": f"/uploads/{filename}",
            "size": os.path.getsize(file_path),
            "bounds": metadata["bounds"],
            "resolution": metadata["resolution"]
        }
    except Exception as e:
        print(f"Error uploading DTM: {e}")
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
        
    try:
        with rasterio.open(file_path) as src:
            # Read first band
            data = src.read(1)
            
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
            
            # Handle serialization of special values (NaN, Infinity)
            # Replace NaNs/Infinity with null or custom handling if needed, 
            # but standard JSON doesn't support NaN.
            # Node.js backend seemed to simple pass it, but JSON.stringify usually turns NaN to null.
            # Rasterio reads into numpy array.
            
            return {
                "width": src.width,
                "height": src.height,
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
            
    except Exception as e:
        print(f"Error reading raster: {e}")
        raise HTTPException(status_code=500, detail=str(e))
