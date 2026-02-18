import os
from fastapi import FastAPI, HTTPException, File, UploadFile, Request, Header, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import rasterio
import rasterio.features
import rasterio.warp
import rasterio.mask
from affine import Affine
import numpy as np
from typing import Optional, List, Dict, Any
import json
import shutil
import time
from pydantic import BaseModel
from math import radians, cos, sin, asin, sqrt
import pyproj
from pyproj import Transformer
import logging
from dotenv import load_dotenv
import threading
import uuid
import atexit
# Import constants
import constants as C

# Import DTM lease manager for protection
from dtm_lease_manager import (
    get_lease_manager, 
    shutdown_lease_manager,
    DtmLeaseManager,
    DEFAULT_LEASE_DURATION_SECONDS
)

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("backend_python")

# Global cache for TIF footprints (populated on startup)
tif_footprints_cache: Dict[str, Dict[str, Any]] = {}
tif_footprints_cache_lock = threading.Lock()

def build_tif_footprints_cache():
    """Scan DTM_DATA_DIR and cache TIF file footprints for fast overlap queries"""
    global tif_footprints_cache
    logger.info(f"Building TIF footprints cache from: {DTM_DATA_DIR}")
    
    if not os.path.exists(DTM_DATA_DIR):
        logger.warning(f"DTM_DATA_DIR does not exist: {DTM_DATA_DIR}")
        return
    
    cache = {}
    scanned_count = 0
    cached_count = 0
    
    try:
        for filename in os.listdir(DTM_DATA_DIR):
            if filename.lower().endswith(C.DTM_EXTENSIONS):
                file_path = os.path.join(DTM_DATA_DIR, filename)
                
                if not os.path.isfile(file_path):
                    continue
                
                scanned_count += 1
                
                try:
                    with rasterio.open(file_path) as src:
                        bounds = src.bounds
                        stats = os.stat(file_path)
                        
                        # Calculate resolution (pixel size in meters, approximate)
                        # Use transform to get pixel size
                        transform = src.transform
                        pixel_width = abs(transform[0])  # Usually in meters for projected CRS
                        pixel_height = abs(transform[4])  # Usually in meters for projected CRS
                        # Average pixel size for resolution estimate
                        resolution_meters = (pixel_width + pixel_height) / 2.0
                        
                        cache[filename] = {
                            "id": filename,
                            "filename": filename,
                            "displayName": filename,
                            "footprintBBox": {
                                "minX": bounds.left,
                                "minY": bounds.bottom,
                                "maxX": bounds.right,
                                "maxY": bounds.top
                            },
                            "crs": src.crs.to_string() if src.crs else None,
                            "resolution": {
                                "width": src.width,
                                "height": src.height
                            },
                            "resolutionMeters": resolution_meters,
                            "sizeMB": round(stats.st_size / (1024 * 1024), 2),
                            "sizeBytes": stats.st_size,
                            "modifiedAt": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(stats.st_mtime))
                        }
                        cached_count += 1
                except Exception as e:
                    logger.warning(f"Could not read footprint for {filename}: {e}")
                    continue
        
        with tif_footprints_cache_lock:
            tif_footprints_cache = cache
        
        logger.info(f"TIF footprints cache built: {cached_count}/{scanned_count} files cached")
    except Exception as e:
        logger.error(f"Error building TIF footprints cache: {e}", exc_info=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: build TIF footprints cache
    build_tif_footprints_cache()
    yield
    # Shutdown: cleanup if needed
    pass

app = FastAPI(lifespan=lifespan)

# Viewshed job state
viewshed_jobs = {}
viewshed_jobs_lock = threading.Lock()

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
# Resolve to absolute path
UPLOADS_DIR = os.path.abspath(UPLOADS_DIR)

# DTM data directory - where source TIFF files are stored
DTM_DATA_DIR = os.environ.get("DTM_DATA_DIR", UPLOADS_DIR)
# Resolve to absolute path
DTM_DATA_DIR = os.path.abspath(DTM_DATA_DIR)

# DTM cache directory - where clipped DTMs are stored
# Use env file configuration, with independent default (not based on UPLOADS_DIR)
DTM_CACHE_DIR_ENV = os.environ.get("DTM_CACHE_DIR")
if DTM_CACHE_DIR_ENV:
    DTM_CACHE_DIR = os.path.abspath(DTM_CACHE_DIR_ENV)
else:
    # Default to a path relative to the backend_python directory, independent of uploads
    backend_python_dir = os.path.dirname(os.path.abspath(__file__))
    # Use correct on-disk casing ('Cache') to work on case-sensitive filesystems (Linux prod)
    DTM_CACHE_DIR = os.path.abspath(os.path.join(backend_python_dir, f"{C.DIR_DTM_TIFF}/{C.DIR_CACHE}"))

# Subsampled cache directory - where subsampled versions for display are stored
DTM_SUBSAMPLED_CACHE_DIR_ENV = os.environ.get("DTM_SUBSAMPLED_CACHE_DIR")
if DTM_SUBSAMPLED_CACHE_DIR_ENV:
    DTM_SUBSAMPLED_CACHE_DIR = os.path.abspath(DTM_SUBSAMPLED_CACHE_DIR_ENV)
else:
    # Default: store subsampled artifacts directly in the cache folder (no "upload" subfolder)
    DTM_SUBSAMPLED_CACHE_DIR = DTM_CACHE_DIR

# Viewshed cache directory - where generated viewshed TIFFs are stored
VIEWSHED_CACHE_DIR_ENV = os.environ.get("VIEWSHED_CACHE_DIR")
if VIEWSHED_CACHE_DIR_ENV:
    VIEWSHED_CACHE_DIR = os.path.abspath(VIEWSHED_CACHE_DIR_ENV)
else:
    backend_python_dir = os.path.dirname(os.path.abspath(__file__))
    VIEWSHED_CACHE_DIR = os.path.abspath(os.path.join(backend_python_dir, f"{C.DIR_DTM_TIFF}/{C.DIR_VIEWSHED}"))

# Ensure cache directories exist
os.makedirs(DTM_CACHE_DIR, exist_ok=True)
os.makedirs(DTM_SUBSAMPLED_CACHE_DIR, exist_ok=True)
os.makedirs(VIEWSHED_CACHE_DIR, exist_ok=True)

def get_subsampled_filename(filename: str) -> str:
    """Add 'subsample' to the filename before the extension"""
    name, ext = os.path.splitext(filename)
    return f"{name}{C.SUFFIX_SUBSAMPLE}{ext}"

logger.info(f"UPLOADS_DIR: {UPLOADS_DIR}")
logger.info(f"DTM_DATA_DIR: {DTM_DATA_DIR}")
logger.info(f"DTM_CACHE_DIR: {DTM_CACHE_DIR}")
logger.info(f"DTM_SUBSAMPLED_CACHE_DIR: {DTM_SUBSAMPLED_CACHE_DIR}")

class ElevationProfileRequest(BaseModel):
    coordinates: List[List[float]]
    dtmPath: str
    safetyRadiusMeters: Optional[float] = C.DEFAULT_SAFETY_RADIUS_METERS
    resolutionRadiusMeters: Optional[float] = C.DEFAULT_RESOLUTION_RADIUS_METERS
    clippedId: Optional[str] = None

class AOI(BaseModel):
    type: str  # 'bbox' or 'polygon'
    crs: str  # e.g., 'EPSG:4326'
    bbox: Optional[List[float]] = None  # [minLon, minLat, maxLon, maxLat] for bbox type
    coordinates: Optional[List[List[float]]] = None  # [[lon, lat], ...] for polygon type

class ClipRequest(BaseModel):
    dtmId: str
    aoi: AOI

class AvailableTifsRequest(BaseModel):
    aoi: AOI
    bufferMeters: Optional[float] = 0.0

class ElevationAtPointRequest(BaseModel):
    longitude: float
    latitude: float
    dtmPath: str
    clippedId: Optional[str] = None

class ViewshedPoint(BaseModel):
    lng: float
    lat: float
    height: Optional[float] = None  # ASL meters (Above Sea Level)

class ViewshedRequest(BaseModel):
    coordinates: List[ViewshedPoint]
    dtmPath: str
    clippedId: Optional[str] = None
    samplingIntervalMeters: Optional[float] = C.DEFAULT_SAMPLING_INTERVAL_METERS
    maxDistanceMeters: Optional[float] = None
    useSubsampled: Optional[bool] = C.DEFAULT_VIEWSHED_USE_SUBSAMPLED
    outputHeight: Optional[float] = None
    fovDegrees: Optional[float] = None

# ============================================================================
# DTM LEASE API MODELS
# ============================================================================

class LeaseAcquireRequest(BaseModel):
    """Request to acquire a lease for a DTM."""
    dtmId: str
    clientId: str
    sessionId: Optional[str] = None
    durationSeconds: Optional[int] = DEFAULT_LEASE_DURATION_SECONDS

class LeaseRenewRequest(BaseModel):
    """Request to renew an existing lease."""
    leaseId: str
    durationSeconds: Optional[int] = DEFAULT_LEASE_DURATION_SECONDS

class LeaseReleaseRequest(BaseModel):
    """Request to release a lease."""
    leaseId: str


# ============================================================================
# LIFECYCLE HOOKS
# ============================================================================

@atexit.register
def cleanup_on_shutdown():
    """Clean up lease manager on shutdown."""
    logger.info("Shutting down DTM lease manager...")
    shutdown_lease_manager()
    logger.info("DTM lease manager shutdown complete")


# ============================================================================
# IMPLICIT LEASE MANAGEMENT FOR BACKWARD COMPATIBILITY
# ============================================================================

# Duration for implicit leases (shorter than explicit - 2 minutes)
IMPLICIT_LEASE_DURATION_SECONDS = C.IMPLICIT_LEASE_DURATION_SECONDS


def implicitly_acquire_or_renew_lease(
    dtm_id: str,
    client_ip: Optional[str] = None,
    session_id: Optional[str] = None
) -> Optional[str]:
    """
    Implicitly acquire or renew a lease when a client accesses DTM data.
    
    This provides backward compatibility for clients that don't explicitly
    manage leases. The lease is short-lived and should be renewed on each
    data access.
    
    Args:
        dtm_id: The DTM identifier being accessed
        client_ip: Client IP address (used as client_id if no session)
        session_id: Optional session identifier from header
        
    Returns:
        The lease ID if acquired/renewed, None if failed
    """
    try:
        lease_mgr = get_lease_manager()
        client_id = session_id or client_ip or "anonymous"
        
        lease, was_renewed = lease_mgr.acquire_lease(
            dtm_id=dtm_id,
            client_id=f"implicit:{client_id}",
            session_id=session_id,
            duration_seconds=IMPLICIT_LEASE_DURATION_SECONDS
        )
        
        logger.debug(
            f"Implicit lease {'renewed' if was_renewed else 'acquired'} for "
            f"dtm_id={dtm_id}, client={client_id}, lease_id={lease.lease_id}"
        )
        
        return lease.lease_id
    except Exception as e:
        logger.warning(f"Failed to acquire implicit lease for {dtm_id}: {e}")
        return None


def get_client_ip(request: Request) -> str:
    """Extract client IP from request, handling proxies."""
    # Check for forwarded header (behind proxy)
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    
    # Fall back to direct client
    if request.client:
        return request.client.host
    
    return "unknown"

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
    return c * C.EARTH_RADIUS_METERS

def interpolate_segment(start, end, interval_meters):
    dist = haversine(start[0], start[1], end[0], end[1])
    if dist < interval_meters:
        return [start, end]
        
    num_points = max(2, int(np.ceil(dist / interval_meters)))
    lons = np.linspace(start[0], end[0], num_points)
    lats = np.linspace(start[1], end[1], num_points)
    
    return [[float(lon), float(lat)] for lon, lat in zip(lons, lats)]

def interpolate_segment_with_height(start, end, interval_meters):
    dist = haversine(start["lng"], start["lat"], end["lng"], end["lat"])
    if dist < interval_meters:
        return [start, end]
    num_points = max(2, int(np.ceil(dist / interval_meters)))
    lons = np.linspace(start["lng"], end["lng"], num_points)
    lats = np.linspace(start["lat"], end["lat"], num_points)
    h1 = start.get("height", 0.0) or 0.0
    h2 = end.get("height", 0.0) or 0.0
    heights = np.linspace(h1, h2, num_points)
    return [
        {"lng": float(lon), "lat": float(lat), "height": float(h)}
        for lon, lat, h in zip(lons, lats, heights)
    ]

def bresenham_line(row0, col0, row1, col1):
    """Return list of (row, col) from start to end using Bresenham's algorithm."""
    points = []
    drow = abs(row1 - row0)
    dcol = abs(col1 - col0)
    srow = 1 if row0 < row1 else -1
    scol = 1 if col0 < col1 else -1
    err = dcol - drow
    r, c = row0, col0
    while True:
        points.append((r, c))
        if r == row1 and c == col1:
            break
        e2 = 2 * err
        if e2 > -drow:
            err -= drow
            c += scol
        if e2 < dcol:
            err += dcol
            r += srow
    return points

def compute_distance_meters(row, col, row0, col0, res_x, res_y, meters_per_deg_lon, meters_per_deg_lat, is_projected):
    drow = row - row0
    dcol = col - col0
    if is_projected:
        dx = dcol * res_x
        dy = drow * res_y
    else:
        dx = dcol * res_x * meters_per_deg_lon
        dy = drow * res_y * meters_per_deg_lat
    return sqrt(dx * dx + dy * dy)

def is_visible_line(data, row0, col0, row1, col1, obs_elev, res_x, res_y, meters_per_deg_lon, meters_per_deg_lat, is_projected):
    line = bresenham_line(row0, col0, row1, col1)
    if len(line) <= 2:
        return True
    target_elev = data[row1, col1]
    if np.isnan(target_elev):
        return False
    target_dist = compute_distance_meters(row1, col1, row0, col0, res_x, res_y, meters_per_deg_lon, meters_per_deg_lat, is_projected)
    if target_dist <= 0:
        return True
    target_angle = (target_elev - obs_elev) / target_dist
    max_angle = C.VIEWSHED_MIN_ANGLE_INIT
    for r, c in line[1:-1]:
        elev = data[r, c]
        if np.isnan(elev):
            continue
        dist = compute_distance_meters(r, c, row0, col0, res_x, res_y, meters_per_deg_lon, meters_per_deg_lat, is_projected)
        if dist <= 0:
            continue
        angle = (elev - obs_elev) / dist
        if angle > max_angle:
            max_angle = angle
            if max_angle >= target_angle:
                return False
    return True

def compute_viewshed(job_id: str, request: ViewshedRequest):
    start_time = time.time()
    logger.info(f"[{job_id}] Viewshed compute start")
    try:
        if len(request.coordinates) < 2:
            raise ValueError("At least two points required")

        if request.clippedId:
            file_path = os.path.join(DTM_CACHE_DIR, f"{request.clippedId}.tif")
            if not os.path.exists(file_path):
                if os.path.exists(DTM_CACHE_DIR):
                    cache_files = os.listdir(DTM_CACHE_DIR)
                    matching_files = [f for f in cache_files if f.startswith(request.clippedId)]
                    if matching_files:
                        file_path = os.path.join(DTM_CACHE_DIR, matching_files[0])
                    else:
                        raise FileNotFoundError(f"Clipped DTM not found: {request.clippedId}")
                else:
                    raise FileNotFoundError("Clipped DTM cache directory not found")
        else:
            filename = os.path.basename(request.dtmPath)
            file_path = os.path.join(DTM_CACHE_DIR, filename)
            if not os.path.exists(file_path):
                file_path = os.path.join(UPLOADS_DIR, filename)

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"DTM file not found: {file_path}")

        compute_path = file_path
        if request.useSubsampled:
            subsampled_filename = get_subsampled_filename(os.path.basename(file_path))
            subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
            if os.path.exists(subsampled_file_path):
                compute_path = subsampled_file_path
                logger.info(f"[{job_id}] Using subsampled DTM for viewshed: {compute_path}")

        with rasterio.open(compute_path) as src:
            src_crs_obj = src.crs  # Keep original CRS object
            if not src_crs_obj:
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs_str = C.EPSG_UTM_36N if is_projected else C.EPSG_WGS84
                # Create CRS object from string for transformation
                from rasterio.crs import CRS
                src_crs_obj = CRS.from_string(src_crs_str)
            else:
                src_crs_str = src_crs_obj.to_string()

            transformer = Transformer.from_crs(C.EPSG_WGS84, src_crs_obj, always_xy=True)
            data = src.read(1).astype(np.float32)
            nodata = src.nodata

            if nodata is not None:
                data[data == nodata] = np.nan
            if np.issubdtype(data.dtype, np.floating):
                data[np.isnan(data)] = np.nan

            res_x = abs(src.transform.a)
            res_y = abs(src.transform.e)
            is_projected = src.crs.is_projected if src.crs else (abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90)

            raw_points = [{"lng": p.lng, "lat": p.lat, "height": p.height} for p in request.coordinates]
            trajectory = []
            point_distances = []
            segment_boundaries = [0]
            interval = C.DEFAULT_SAMPLING_INTERVAL_METERS
            cumulative_dist = 0.0
            if interval and interval > 0:
                for i in range(len(raw_points) - 1):
                    if i > 0:
                        segment_boundaries.append(len(trajectory))
                    segment_points = interpolate_segment_with_height(raw_points[i], raw_points[i + 1], interval)
                    for j, pt in enumerate(segment_points):
                        if i > 0 and j == 0:
                            continue
                        trajectory.append(pt)
                        if len(trajectory) >= 2:
                            seg_len = haversine(
                                trajectory[-2]["lng"], trajectory[-2]["lat"],
                                trajectory[-1]["lng"], trajectory[-1]["lat"]
                            )
                            cumulative_dist += seg_len
                        point_distances.append(cumulative_dist)
                segment_boundaries.append(len(trajectory))
            else:
                trajectory = raw_points
                for i in range(len(trajectory)):
                    if i == 0:
                        point_distances.append(0.0)
                    else:
                        cumulative_dist += haversine(
                            trajectory[i - 1]["lng"], trajectory[i - 1]["lat"],
                            trajectory[i]["lng"], trajectory[i]["lat"]
                        )
                        point_distances.append(cumulative_dist)
                segment_boundaries = list(range(len(trajectory) + 1))

            # Client test mode: return constant TIFF of 1 (same dimensions and geo as DTM)
            viewshed = np.ones((src.height, src.width), dtype=np.int32)
            viewshed[np.isnan(data)] = C.VIEWSHED_NODATA_VALUE
            with viewshed_jobs_lock:
                if job_id in viewshed_jobs:
                    viewshed_jobs[job_id]["progress"] = 100

            # Reproject viewshed to WGS84 for consistent coordinate system
            output_name = f"viewshed_{int(time.time() * 1000)}.tif"
            output_path = os.path.join(VIEWSHED_CACHE_DIR, output_name)
            
            # Determine destination CRS (WGS84)
            dst_crs = C.EPSG_WGS84
            
            # If source CRS is already WGS84, just write directly
            if src_crs_obj and src_crs_obj.to_string() == C.EPSG_WGS84:
                out_meta = src.meta.copy()
                out_meta.update({
                    "driver": C.RASTER_DRIVER_GTIFF,
                    "height": viewshed.shape[0],
                    "width": viewshed.shape[1],
                    "count": 1,
                    "dtype": rasterio.int32,
                    "nodata": C.VIEWSHED_NODATA_VALUE,
                    "compress": C.RASTER_COMPRESSION_LZW,
                    "crs": dst_crs
                })
                with rasterio.open(output_path, "w", **out_meta) as dest:
                    dest.write(viewshed, 1)
            else:
                # Reproject to WGS84
                logger.info(f"[{job_id}] Reprojecting viewshed from {src_crs_str} to {dst_crs}")
                out_meta = src.meta.copy()
                out_meta.update({
                    "driver": C.RASTER_DRIVER_GTIFF,
                    "count": 1,
                    "dtype": rasterio.int32,
                    "nodata": C.VIEWSHED_NODATA_VALUE,
                    "compress": C.RASTER_COMPRESSION_LZW,
                    "crs": dst_crs
                })
                
                # Calculate destination transform and dimensions
                dst_transform, dst_width, dst_height = rasterio.warp.calculate_default_transform(
                    src_crs_obj, dst_crs, src.width, src.height, *src.bounds
                )
                
                out_meta.update({
                    "transform": dst_transform,
                    "width": dst_width,
                    "height": dst_height
                })
                
                # Reproject the viewshed raster
                reprojected_viewshed = np.zeros((dst_height, dst_width), dtype=rasterio.int32)
                rasterio.warp.reproject(
                    source=viewshed,
                    destination=reprojected_viewshed,
                    src_transform=src.transform,
                    src_crs=src_crs_obj,
                    dst_transform=dst_transform,
                    dst_crs=dst_crs,
                    resampling=rasterio.enums.Resampling.nearest  # Use nearest for integer data
                )
                
                with rasterio.open(output_path, "w", **out_meta) as dest:
                    dest.write(reprojected_viewshed, 1)

            duration = time.time() - start_time
            logger.info(f"[{job_id}] Viewshed generated in {duration:.2f}s: {output_name}")

            # Compute overlap by leg pairs for this job
            fov_deg = request.fovDegrees if request.fovDegrees is not None else 75.0
            agl = request.outputHeight if request.outputHeight and request.outputHeight > 0 else None
            if agl is None and trajectory:
                heights = [p.get("height") for p in trajectory if p.get("height") is not None]
                agl = float(np.mean(heights)) if heights else 100.0
            if agl is None or agl <= 0:
                agl = 100.0
            overlap_by_point, overlap_overall = _compute_overlap_by_leg_pairs(
                trajectory, segment_boundaries, fov_deg, agl
            )

            with viewshed_jobs_lock:
                if job_id in viewshed_jobs:
                    viewshed_jobs[job_id]["status"] = "done"
                    viewshed_jobs[job_id]["progress"] = 100
                    viewshed_jobs[job_id]["result_path"] = output_path
                    viewshed_jobs[job_id]["overlap_by_point"] = overlap_by_point
                    viewshed_jobs[job_id]["overlap_overall"] = overlap_overall
                    viewshed_jobs[job_id]["point_distances"] = point_distances
    except RuntimeError as e:
        if str(e) == "cancelled":
            logger.info(f"[{job_id}] Viewshed cancelled")
            with viewshed_jobs_lock:
                if job_id in viewshed_jobs:
                    viewshed_jobs[job_id]["status"] = "cancelled"
        else:
            logger.error(f"[{job_id}] Viewshed error: {e}", exc_info=True)
            with viewshed_jobs_lock:
                if job_id in viewshed_jobs:
                    viewshed_jobs[job_id]["status"] = "error"
                    viewshed_jobs[job_id]["error"] = str(e)
    except Exception as e:
        logger.error(f"[{job_id}] Viewshed error: {e}", exc_info=True)
        with viewshed_jobs_lock:
            if job_id in viewshed_jobs:
                viewshed_jobs[job_id]["status"] = "error"
                viewshed_jobs[job_id]["error"] = str(e)

@app.post("/elevation-profile")
async def get_elevation_profile(
    request: ElevationProfileRequest,
    raw_request: Request,
    x_session_id: Optional[str] = Header(None, alias="X-Session-ID")
):
    start_time = time.time()
    logger.info(f"Calculating elevation profile for {request.dtmPath} with {len(request.coordinates)} points")
    
    if len(request.coordinates) < 2:
        raise HTTPException(status_code=400, detail="At least two points required")
    
    # Implicitly acquire/renew lease for the DTM being accessed
    dtm_id = request.clippedId or os.path.basename(request.dtmPath)
    implicitly_acquire_or_renew_lease(
        dtm_id=dtm_id,
        client_ip=get_client_ip(raw_request),
        session_id=x_session_id
    )
    
    # Determine file path based on whether it's a clipped DTM or regular DTM
    if request.clippedId:
        # Use clipped DTM from cache directory
        file_path = os.path.join(DTM_CACHE_DIR, f"{request.clippedId}.tif")
        if not os.path.exists(file_path):
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                matching_files = [f for f in cache_files if f.startswith(request.clippedId)]
                if matching_files:
                    file_path = os.path.join(DTM_CACHE_DIR, matching_files[0])
                else:
                    raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {request.clippedId}")
            else:
                raise HTTPException(status_code=404, detail=f"Clipped DTM cache directory not found")
    else:
        # Extract filename from path for regular DTM
        # Use cache directory for calculations (original resolution)
        filename = os.path.basename(request.dtmPath)
        file_path = os.path.join(DTM_CACHE_DIR, filename)
        
        # Fallback to UPLOADS_DIR if not in cache (for backward compatibility)
        if not os.path.exists(file_path):
            file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail=f"DTM file not found: {file_path}")
        
    try:
        with rasterio.open(file_path) as src:
            # Prepare coordinate transformation
            src_crs = src.crs
            if not src_crs:
                # Heuristic fallback if CRS is missing
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs = C.EPSG_UTM_36N if is_projected else C.EPSG_WGS84
            
            transformer = Transformer.from_crs(C.EPSG_WGS84, src_crs, always_xy=True)
            
            # Generate sampling points along the route
            # IMPORTANT: Always use ELEVATION_PROFILE_SAMPLING_INTERVAL_METERS for ground elevation sampling,
            # regardless of safety radius or resolution radius values. The safety radius is only used
            # for calculating min/max elevation within a radius, not for determining sampling density.
            sampling_interval = C.ELEVATION_PROFILE_SAMPLING_INTERVAL_METERS
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
            res_min = min(abs(res_x), abs(res_y))
            if res_min <= 0 or not np.isfinite(res_min):
                raise HTTPException(
                    status_code=400,
                    detail=f"DTM has invalid resolution (res_x={res_x}, res_y={res_y}). Cannot compute elevation profile."
                )
            
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
                # Calculate pixel radius (res_min already validated above)
                # Using max of resolution because pixels might not be square
                pixel_radius_safety = int(np.ceil(request.safetyRadiusMeters / res_min))
                pixel_radius_resolution = int(np.ceil(request.resolutionRadiusMeters / res_min))
                
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
                    meters_per_degree_lat = C.METERS_PER_DEGREE_LATITUDE
                    meters_per_degree_lon = C.METERS_PER_DEGREE_LATITUDE * cos(radians(lat))
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

@app.post("/elevation-at-point")
async def get_elevation_at_point(
    request: ElevationAtPointRequest,
    raw_request: Request,
    x_session_id: Optional[str] = Header(None, alias="X-Session-ID")
):
    """Get elevation at a specific point from DTM"""
    try:
        # Implicitly acquire/renew lease for the DTM being accessed
        dtm_id = request.clippedId or os.path.basename(request.dtmPath)
        implicitly_acquire_or_renew_lease(
            dtm_id=dtm_id,
            client_ip=get_client_ip(raw_request),
            session_id=x_session_id
        )
        
        # Determine file path based on whether it's a clipped DTM or regular DTM
        if request.clippedId:
            # Use clipped DTM from cache directory
            file_path = os.path.join(DTM_CACHE_DIR, f"{request.clippedId}.tif")
            if not os.path.exists(file_path):
                # Try to find the file with any extension
                if os.path.exists(DTM_CACHE_DIR):
                    cache_files = os.listdir(DTM_CACHE_DIR)
                    matching_files = [f for f in cache_files if f.startswith(request.clippedId)]
                    if matching_files:
                        file_path = os.path.join(DTM_CACHE_DIR, matching_files[0])
                    else:
                        raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {request.clippedId}")
                else:
                    raise HTTPException(status_code=404, detail=f"Clipped DTM cache directory not found")
        else:
            # Extract filename from path for regular DTM
            filename = os.path.basename(request.dtmPath)
            file_path = os.path.join(DTM_CACHE_DIR, filename)
            
            # Fallback to UPLOADS_DIR if not in cache (for backward compatibility)
            if not os.path.exists(file_path):
                file_path = os.path.join(UPLOADS_DIR, filename)
        
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail=f"DTM file not found: {file_path}")
        
        with rasterio.open(file_path) as src:
            # Prepare coordinate transformation
            src_crs = src.crs
            if not src_crs:
                # Heuristic fallback if CRS is missing
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs = C.EPSG_UTM_36N if is_projected else C.EPSG_WGS84
            
            transformer = Transformer.from_crs(C.EPSG_WGS84, src_crs, always_xy=True)
            
            # Transform to DTM CRS
            x, y = transformer.transform(request.longitude, request.latitude)
            
            # Transform to pixel coordinates
            row, col = src.index(x, y)
            
            # Check if inside bounds
            if not (0 <= row < src.height and 0 <= col < src.width):
                return {"elevation": None}
            
            # Sample elevation at point
            elevation_arr = src.read(1, window=rasterio.windows.Window(col, row, 1, 1))
            elevation = float(elevation_arr[0, 0])
            
            nodata = src.nodata
            if nodata is not None and elevation == nodata:
                elevation = None
            elif np.isnan(elevation):
                elevation = None
            
            return {"elevation": elevation}
            
    except Exception as e:
        logger.error(f"Error getting elevation at point: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# DTM data directory - where source TIFF files are stored
DTM_DATA_DIR = os.environ.get("DTM_DATA_DIR", UPLOADS_DIR)
# Resolve to absolute path
DTM_DATA_DIR = os.path.abspath(DTM_DATA_DIR)

# DTM cache directory - where clipped DTMs are stored
DTM_CACHE_DIR = os.environ.get("DTM_CACHE_DIR", os.path.join(DTM_DATA_DIR, "Cache"))
# Resolve to absolute path
DTM_CACHE_DIR = os.path.abspath(DTM_CACHE_DIR)

# Ensure cache directory exists
os.makedirs(DTM_CACHE_DIR, exist_ok=True)
os.makedirs(DTM_SUBSAMPLED_CACHE_DIR, exist_ok=True)

# Maximum dimension for subsampled display versions
MAX_DISPLAY_DIM = 2048

def get_subsampled_filename(filename: str) -> str:
    """Add 'subsample' to the filename before the extension"""
    name, ext = os.path.splitext(filename)
    return f"{name}_subsample{ext}"

logger.info(f"UPLOADS_DIR: {UPLOADS_DIR}")
logger.info(f"DTM_DATA_DIR: {DTM_DATA_DIR}")
logger.info(f"DTM_CACHE_DIR: {DTM_CACHE_DIR}")
logger.info(f"DTM_SUBSAMPLED_CACHE_DIR: {DTM_SUBSAMPLED_CACHE_DIR}")

class ElevationProfileRequest(BaseModel):
    coordinates: List[List[float]]
    dtmPath: str
    safetyRadiusMeters: Optional[float] = 50.0
    resolutionRadiusMeters: Optional[float] = 50.0
    clippedId: Optional[str] = None

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
    
    # Determine file path based on whether it's a clipped DTM or regular DTM
    if request.clippedId:
        # Use clipped DTM from cache directory
        file_path = os.path.join(DTM_CACHE_DIR, f"{request.clippedId}.tif")
        if not os.path.exists(file_path):
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                matching_files = [f for f in cache_files if f.startswith(request.clippedId)]
                if matching_files:
                    file_path = os.path.join(DTM_CACHE_DIR, matching_files[0])
                else:
                    raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {request.clippedId}")
            else:
                raise HTTPException(status_code=404, detail=f"Clipped DTM cache directory not found")
    else:
        # Extract filename from path for regular DTM
        # Use cache directory for calculations (original resolution)
        filename = os.path.basename(request.dtmPath)
        file_path = os.path.join(DTM_CACHE_DIR, filename)
        
        # Fallback to UPLOADS_DIR if not in cache (for backward compatibility)
        if not os.path.exists(file_path):
            file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail=f"DTM file not found: {file_path}")
        
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

@app.post("/elevation-at-point")
async def get_elevation_at_point(request: ElevationAtPointRequest):
    """Get elevation at a specific point from DTM"""
    try:
        # Determine file path based on whether it's a clipped DTM or regular DTM
        if request.clippedId:
            # Use clipped DTM from cache directory
            file_path = os.path.join(DTM_CACHE_DIR, f"{request.clippedId}.tif")
            if not os.path.exists(file_path):
                # Try to find the file with any extension
                if os.path.exists(DTM_CACHE_DIR):
                    cache_files = os.listdir(DTM_CACHE_DIR)
                    matching_files = [f for f in cache_files if f.startswith(request.clippedId)]
                    if matching_files:
                        file_path = os.path.join(DTM_CACHE_DIR, matching_files[0])
                    else:
                        raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {request.clippedId}")
                else:
                    raise HTTPException(status_code=404, detail=f"Clipped DTM cache directory not found")
        else:
            # Extract filename from path for regular DTM
            filename = os.path.basename(request.dtmPath)
            file_path = os.path.join(DTM_CACHE_DIR, filename)
            
            # Fallback to UPLOADS_DIR if not in cache (for backward compatibility)
            if not os.path.exists(file_path):
                file_path = os.path.join(UPLOADS_DIR, filename)
        
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail=f"DTM file not found: {file_path}")
        
        with rasterio.open(file_path) as src:
            # Prepare coordinate transformation
            src_crs = src.crs
            if not src_crs:
                # Heuristic fallback if CRS is missing
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs = "EPSG:32636" if is_projected else "EPSG:4326"
            
            transformer = Transformer.from_crs("EPSG:4326", src_crs, always_xy=True)
            
            # Transform to DTM CRS
            x, y = transformer.transform(request.longitude, request.latitude)
            
            # Transform to pixel coordinates
            row, col = src.index(x, y)
            
            # Check if inside bounds
            if not (0 <= row < src.height and 0 <= col < src.width):
                return {"elevation": None}
            
            # Sample elevation at point
            elevation_arr = src.read(1, window=rasterio.windows.Window(col, row, 1, 1))
            elevation = float(elevation_arr[0, 0])
            
            nodata = src.nodata
            if nodata is not None and elevation == nodata:
                elevation = None
            elif np.isnan(elevation):
                elevation = None
            
            return {"elevation": elevation}
            
    except Exception as e:
        logger.error(f"Error getting elevation at point: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _compute_overlap_by_leg_pairs(
    trajectory: List[Dict[str, Any]],
    segment_boundaries: List[int],
    fov_degrees: float,
    effective_agl_meters: float,
) -> tuple:
    """Compute overlap by pairs of parallel legs. In a lawn-mower pattern, leg 1 & 3 are parallel,
    leg 2 & 4 are parallel, etc. So pair i = legs (2*i+1, 2*i+3) in 1-based.
    - 4 points (3 legs) → 1 pair: (leg 1, leg 3)
    - 6 points (5 legs) → 2 pairs: (leg 1, leg 3), (leg 2, leg 4)
    overlap_by_point: {"1-3": [[1, overlap], ..., [n, overlap]], ...}
    overlap_overall: {"1-3": 50, ...}
    MVP: return constant values.
    """
    overlap_by_point: Dict[str, List[List[float]]] = {}
    overlap_overall: Dict[str, float] = {}
    n_segments = len(segment_boundaries) - 1
    if n_segments < 2:
        return overlap_by_point, overlap_overall
    const_val = 50.0
    n_pairs = (n_segments - 1) // 2
    for pair_i in range(n_pairs):
        leg_a = 2 * pair_i
        leg_b = 2 * pair_i + 2
        label = f"{leg_a + 1}-{leg_b + 1}"
        points = []
        for seg_idx in (leg_a, leg_b):
            start_idx = segment_boundaries[seg_idx]
            end_idx = segment_boundaries[seg_idx + 1]
            for idx in range(start_idx, end_idx):
                points.append([idx + 1, const_val])
        points.sort(key=lambda p: p[0])
        if points:
            overlap_by_point[label] = points
            overlap_overall[label] = const_val
    return overlap_by_point, overlap_overall


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
            if filename.lower().endswith(C.DTM_EXTENSIONS):
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

@app.post("/api/dtm/available")
async def get_available_tifs(request: AvailableTifsRequest):
    """Return TIF files that overlap with the given AOI"""
    logger.info(f"POST /api/dtm/available called with AOI type: {request.aoi.type}")
    
    try:
        # Get cached footprints
        with tif_footprints_cache_lock:
            footprints = dict(tif_footprints_cache)  # Copy for thread safety
        
        if not footprints:
            logger.warning("TIF footprints cache is empty - rebuilding...")
            build_tif_footprints_cache()
            with tif_footprints_cache_lock:
                footprints = dict(tif_footprints_cache)
        
        # Convert AOI to a geometry we can use for intersection
        aoi_crs = pyproj.CRS.from_string(request.aoi.crs)
        
        # Create AOI bbox from request
        if request.aoi.type == "bbox" and request.aoi.bbox:
            min_lon, min_lat, max_lon, max_lat = request.aoi.bbox
            aoi_bbox = (min_lon, min_lat, max_lon, max_lat)
        elif request.aoi.type == "polygon" and request.aoi.coordinates:
            # Calculate bbox from polygon coordinates
            lons = [coord[0] for coord in request.aoi.coordinates]
            lats = [coord[1] for coord in request.aoi.coordinates]
            aoi_bbox = (min(lons), min(lats), max(lons), max(lats))
        else:
            raise HTTPException(status_code=400, detail="Invalid AOI: must have bbox for bbox type or coordinates for polygon type")
        
        # Apply buffer if specified (convert meters to degrees approximately)
        if request.bufferMeters and request.bufferMeters > 0:
            # Approximate conversion: 1 degree latitude ≈ 111320 meters
            buffer_deg_lat = request.bufferMeters / 111320.0
            # Longitude buffer depends on latitude - use average of min/max
            avg_lat = (aoi_bbox[1] + aoi_bbox[3]) / 2.0
            buffer_deg_lon = request.bufferMeters / (111320.0 * abs(cos(radians(avg_lat))))
            aoi_bbox = (
                aoi_bbox[0] - buffer_deg_lon,
                aoi_bbox[1] - buffer_deg_lat,
                aoi_bbox[2] + buffer_deg_lon,
                aoi_bbox[3] + buffer_deg_lat
            )
        
        overlapping_files = []
        
        # Check each TIF footprint for overlap
        for filename, footprint in footprints.items():
            tif_bbox = footprint["footprintBBox"]
            tif_crs_str = footprint.get("crs")
            
            if not tif_crs_str:
                # Skip files without CRS
                continue
            
            try:
                tif_crs = pyproj.CRS.from_string(tif_crs_str)
                
                # Transform AOI bbox to TIF CRS for intersection test
                transformer = Transformer.from_crs(aoi_crs, tif_crs, always_xy=True)
                
                # Transform AOI bbox corners
                min_x, min_y = transformer.transform(aoi_bbox[0], aoi_bbox[1])
                max_x, max_y = transformer.transform(aoi_bbox[2], aoi_bbox[3])
                
                # Normalize bbox (min/max might be swapped after transform)
                aoi_min_x, aoi_max_x = min(min_x, max_x), max(min_x, max_x)
                aoi_min_y, aoi_max_y = min(min_y, max_y), max(min_y, max_y)
                
                # Check bbox intersection
                tif_min_x = tif_bbox["minX"]
                tif_min_y = tif_bbox["minY"]
                tif_max_x = tif_bbox["maxX"]
                tif_max_y = tif_bbox["maxY"]
                
                # Bbox intersection test
                intersects = not (
                    aoi_max_x < tif_min_x or
                    aoi_min_x > tif_max_x or
                    aoi_max_y < tif_min_y or
                    aoi_min_y > tif_max_y
                )
                
                if intersects:
                    # Calculate overlap area (for sorting by best match)
                    overlap_min_x = max(aoi_min_x, tif_min_x)
                    overlap_max_x = min(aoi_max_x, tif_max_x)
                    overlap_min_y = max(aoi_min_y, tif_min_y)
                    overlap_max_y = min(aoi_max_y, tif_max_y)
                    
                    overlap_area = (overlap_max_x - overlap_min_x) * (overlap_max_y - overlap_min_y)
                    tif_area = (tif_max_x - tif_min_x) * (tif_max_y - tif_min_y)
                    
                    # Calculate how much of the TIF extends beyond the AOI (smaller is better match)
                    excess_area = tif_area - overlap_area
                    
                    overlapping_files.append({
                        **footprint,
                        "excessArea": excess_area,  # For sorting
                        "overlapArea": overlap_area
                    })
            except Exception as e:
                logger.warning(f"Error checking overlap for {filename}: {e}")
                continue
        
        # Sort by smallest excess area (best match first), then by highest resolution
        overlapping_files.sort(key=lambda x: (x["excessArea"], -x.get("resolutionMeters", 0)))
        
        # Format response (remove internal sorting fields)
        result_files = []
        for f in overlapping_files:
            result_files.append({
                "id": f["id"],
                "filename": f["filename"],
                "displayName": f.get("displayName", f["filename"]),
                "footprintBBox": f["footprintBBox"],
                "resolution": f["resolution"],
                "sizeMB": f.get("sizeMB"),
                "sizeBytes": f.get("sizeBytes", 0),
                "modifiedAt": f.get("modifiedAt")
            })
        
        logger.info(f"Found {len(result_files)} overlapping TIF files for AOI")
        return {"files": result_files}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error finding available TIFs: {e}", exc_info=True)
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
            src_crs = src.crs
            
            # Transform bounds to WGS84 if CRS is available
            if src_crs:
                wgs84_bounds = rasterio.warp.transform_bounds(
                    src_crs,
                    C.EPSG_WGS84,
                    bounds.left,
                    bounds.bottom,
                    bounds.right,
                    bounds.top
                )
                bounds_dict = {
                    "minX": wgs84_bounds[0],
                    "minY": wgs84_bounds[1],
                    "maxX": wgs84_bounds[2],
                    "maxY": wgs84_bounds[3]
                }
            else:
                # Fallback: use original bounds if no CRS
                bounds_dict = {
                    "minX": bounds.left,
                    "minY": bounds.bottom,
                    "maxX": bounds.right,
                    "maxY": bounds.top
                }
            
            return {
                "filename": filename,
                "bounds": bounds_dict,
                "resolution": {
                    "width": src.width,
                    "height": src.height
                },
                "noDataValue": src.nodata,
                "crs": src_crs.to_string() if src_crs else None
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
        
        # Copy original to cache directory for calculations (only if different directories)
        cache_file_path = os.path.join(DTM_CACHE_DIR, filename)
        file_path_abs = os.path.abspath(file_path)
        cache_file_path_abs = os.path.abspath(cache_file_path)
        
        if file_path_abs != cache_file_path_abs:
            shutil.copy2(file_path, cache_file_path)
            logger.info(f"Original DTM copied to cache for calculations: {cache_file_path}")
        else:
            logger.info(f"UPLOADS_DIR and DTM_CACHE_DIR are the same, skipping copy")
            cache_file_path = file_path  # Use the same file
        
        # Create subsampled version for display in subsampled cache directory
        # Ensure subsampled cache directory exists
        os.makedirs(DTM_SUBSAMPLED_CACHE_DIR, exist_ok=True)
        subsampled_filename = get_subsampled_filename(filename)
        subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
        with rasterio.open(cache_file_path) as src:
            if src.width > C.MAX_DISPLAY_DIM or src.height > C.MAX_DISPLAY_DIM:
                scale = max(src.width, src.height) / C.MAX_DISPLAY_DIM
                new_width = int(src.width / scale)
                new_height = int(src.height / scale)
                logger.info(f"Creating subsampled version for uploaded DTM: {src.width}x{src.height} -> {new_width}x{new_height}")
                
                # Calculate new transform for subsampled version
                src_transform = src.transform
                new_transform = Affine(
                    src_transform[0] * scale,  # pixel width
                    src_transform[1],
                    src_transform[2],
                    src_transform[3],
                    src_transform[4] * scale,  # pixel height
                    src_transform[5]
                )
                
                subsampled_meta = src.meta.copy()
                subsampled_meta.update({
                    "width": new_width,
                    "height": new_height,
                    "transform": new_transform
                })
                
                # Read and resample the full-resolution data
                subsampled_data = src.read(
                    1,
                    out_shape=(new_height, new_width),
                    resampling=rasterio.enums.Resampling.bilinear
                )
                
                # Write subsampled version
                with rasterio.open(subsampled_file_path, "w", **subsampled_meta) as dest:
                    dest.write(subsampled_data, 1)
                logger.info(f"Subsampled version saved to: {subsampled_file_path}")
            else:
                # If already small enough, just copy the full version
                shutil.copy2(file_path, subsampled_file_path)
                logger.info(f"DTM already small enough, copying full version for display")
        
        duration = time.time() - start_time
        logger.info(f"DTM uploaded successfully: {filename} in {duration:.3f}s")
        
        # Register DTM in lease manager for tracking
        try:
            lease_mgr = get_lease_manager()
            trace_id = str(uuid.uuid4())[:8]
            lease_mgr.register_dtm(
                dtm_id=filename,
                storage_path=cache_file_path,
                trace_id=trace_id
            )
            logger.info(f"[{trace_id}] DTM registered in lease manager: {filename}")
        except Exception as e:
            logger.warning(f"Failed to register DTM in lease manager: {e}")
               
        return {
            "success": True,
            "filename": filename,
            "path": f"{DTM_CACHE_DIR}/{filename}",
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
        # Clean up cache file if it was created
        if 'cache_file_path' in locals() and os.path.exists(cache_file_path):
            try:
                os.remove(cache_file_path)
            except:
                pass
        # Clean up subsampled version if it was created
        if 'subsampled_file_path' in locals() and os.path.exists(subsampled_file_path):
            try:
                os.remove(subsampled_file_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# DTM LEASE API ENDPOINTS
# ============================================================================

@app.post("/api/dtm/lease/acquire")
async def acquire_dtm_lease(
    request: LeaseAcquireRequest,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID")
):
    """
    Acquire a lease for a DTM.
    
    Clients should call this when they start using a DTM (viewing, planning, processing).
    If the client already has an active lease, it will be renewed instead.
    """
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        logger.info(f"[{trace_id}] Lease acquire request: dtm_id={request.dtmId}, client_id={request.clientId}")
        
        lease_mgr = get_lease_manager()
        lease, was_renewed = lease_mgr.acquire_lease(
            dtm_id=request.dtmId,
            client_id=request.clientId,
            session_id=request.sessionId,
            duration_seconds=request.durationSeconds or DEFAULT_LEASE_DURATION_SECONDS,
            trace_id=trace_id
        )
        
        return {
            "success": True,
            "lease": lease.to_dict(),
            "renewed": was_renewed
        }
    except Exception as e:
        logger.error(f"Error acquiring lease: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/dtm/lease/renew")
async def renew_dtm_lease(
    request: LeaseRenewRequest,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID")
):
    """
    Renew an existing lease.
    
    Clients should call this periodically (every 30-60s) while using a DTM.
    """
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        logger.info(f"[{trace_id}] Lease renew request: lease_id={request.leaseId}")
        
        lease_mgr = get_lease_manager()
        lease = lease_mgr.renew_lease(
            lease_id=request.leaseId,
            duration_seconds=request.durationSeconds or DEFAULT_LEASE_DURATION_SECONDS,
            trace_id=trace_id
        )
        
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found or expired")
        
        return {
            "success": True,
            "lease": lease.to_dict()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error renewing lease: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/dtm/lease/release")
async def release_dtm_lease(
    request: LeaseReleaseRequest,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID")
):
    """
    Release a lease (best-effort cleanup).
    
    Clients should call this when they stop using a DTM.
    """
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        logger.info(f"[{trace_id}] Lease release request: lease_id={request.leaseId}")
        
        lease_mgr = get_lease_manager()
        released = lease_mgr.release_lease(
            lease_id=request.leaseId,
            trace_id=trace_id
        )
        
        return {
            "success": True,
            "released": released
        }
    except Exception as e:
        logger.error(f"Error releasing lease: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dtm/lease/{lease_id}")
async def get_dtm_lease(lease_id: str):
    """Get details of a specific lease."""
    try:
        lease_mgr = get_lease_manager()
        lease = lease_mgr.get_lease(lease_id)
        
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        
        return {
            "success": True,
            "lease": lease.to_dict()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting lease: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dtm/{dtm_id}/leases")
async def get_dtm_leases(dtm_id: str):
    """Get all active leases for a DTM."""
    try:
        lease_mgr = get_lease_manager()
        leases = lease_mgr.get_active_leases_for_dtm(dtm_id)
        
        return {
            "success": True,
            "dtmId": dtm_id,
            "leases": [lease.to_dict() for lease in leases],
            "activeLeaseCount": len(leases),
            "isProtected": len(leases) > 0
        }
    except Exception as e:
        logger.error(f"Error getting DTM leases: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dtm/{dtm_id}/protection")
async def check_dtm_protection(dtm_id: str):
    """
    Check if a DTM is protected by active leases.
    
    Returns protection status and active lease count.
    """
    try:
        lease_mgr = get_lease_manager()
        is_protected, lease_count = lease_mgr.is_dtm_protected(dtm_id)
        
        return {
            "success": True,
            "dtmId": dtm_id,
            "isProtected": is_protected,
            "activeLeaseCount": lease_count
        }
    except Exception as e:
        logger.error(f"Error checking DTM protection: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dtm/leases/metrics")
async def get_lease_metrics():
    """Get metrics about lease system for monitoring."""
    try:
        lease_mgr = get_lease_manager()
        metrics = lease_mgr.get_metrics()
        
        return {
            "success": True,
            "metrics": metrics
        }
    except Exception as e:
        logger.error(f"Error getting lease metrics: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dtm/leases/audit")
async def get_lease_audit_log(
    dtm_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    since_hours: Optional[float] = Query(None, ge=0)
):
    """Get audit log entries for observability."""
    try:
        lease_mgr = get_lease_manager()
        since_timestamp = None
        if since_hours:
            since_timestamp = time.time() - (since_hours * 3600)
        
        entries = lease_mgr.get_audit_log(
            dtm_id=dtm_id,
            limit=limit,
            since_timestamp=since_timestamp
        )
        
        return {
            "success": True,
            "entries": entries,
            "count": len(entries)
        }
    except Exception as e:
        logger.error(f"Error getting audit log: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# PROTECTED DELETE ENDPOINTS
# ============================================================================

def check_dtm_protection_for_delete(
    dtm_id: str,
    caller: str,
    reason: str,
    trace_id: Optional[str] = None
) -> None:
    """
    Check if DTM is protected and raise 409 Conflict if it cannot be deleted.
    
    This is called by all delete endpoints to ensure consistent protection.
    """
    lease_mgr = get_lease_manager()
    can_delete, message, lease_count = lease_mgr.can_delete_dtm(
        dtm_id=dtm_id,
        trace_id=trace_id,
        caller=caller,
        reason=reason
    )
    
    if not can_delete:
        logger.warning(f"[{trace_id}] Delete blocked: {message}")
        raise HTTPException(
            status_code=409,
            detail={
                "error": "DTM is currently in use",
                "message": message,
                "dtmId": dtm_id,
                "activeLeaseCount": lease_count,
                "code": "DTM_PROTECTED"
            }
        )


@app.delete("/api/dtm/{filename}")
@app.delete("/dtm/{filename}")
async def delete_uploaded_dtm(
    filename: str,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID"),
    force: bool = Query(False, description="Force delete even if protected (admin only)")
):
    """Delete an uploaded DTM file and its subsampled version"""
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        logger.info(f"[{trace_id}] Delete request for uploaded DTM: {filename}, force={force}")
        
        # Check protection unless force delete
        if not force:
            check_dtm_protection_for_delete(
                dtm_id=filename,
                caller="delete_uploaded_dtm",
                reason="manual_delete",
                trace_id=trace_id
            )
        
        deleted_files = []
        not_found = True
        
        # Delete from UPLOADS_DIR
        upload_file_path = os.path.join(UPLOADS_DIR, filename)
        if os.path.exists(upload_file_path):
            try:
                os.remove(upload_file_path)
                deleted_files.append(f"uploads/{filename}")
                logger.info(f"Deleted uploaded DTM file: {upload_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting file from UPLOADS_DIR {upload_file_path}: {e}", exc_info=True)
        
        # Delete from DTM_CACHE_DIR (if different from UPLOADS_DIR)
        cache_file_path = os.path.join(DTM_CACHE_DIR, filename)
        upload_file_path_abs = os.path.abspath(upload_file_path)
        cache_file_path_abs = os.path.abspath(cache_file_path)
        
        if upload_file_path_abs != cache_file_path_abs and os.path.exists(cache_file_path):
            try:
                os.remove(cache_file_path)
                deleted_files.append(f"cache/{filename}")
                logger.info(f"Deleted cached DTM file: {cache_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting file from DTM_CACHE_DIR {cache_file_path}: {e}", exc_info=True)
        
        # Delete subsampled version from DTM_SUBSAMPLED_CACHE_DIR
        subsampled_filename = get_subsampled_filename(filename)
        subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
        logger.info(f"Checking for subsampled version in: {DTM_SUBSAMPLED_CACHE_DIR}")
        logger.info(f"Looking for subsampled file: {subsampled_filename} at path: {subsampled_file_path}")
        
        # First try the exact subsampled filename
        if os.path.exists(subsampled_file_path):
            try:
                os.remove(subsampled_file_path)
                deleted_files.append(f"cache/{subsampled_filename}")
                logger.info(f"Deleted subsampled DTM file: {subsampled_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting subsampled file {subsampled_file_path}: {e}", exc_info=True)
        else:
            logger.info(f"Subsampled file not found at exact path: {subsampled_file_path}")
            # Fallback: search for any file with "subsample" in the name that matches the base filename
            if os.path.exists(DTM_SUBSAMPLED_CACHE_DIR):
                try:
                    base_name = os.path.splitext(filename)[0]
                    all_files = os.listdir(DTM_SUBSAMPLED_CACHE_DIR)
                    for file in all_files:
                        file_lower = file.lower()
                        # Check if file contains "subsample" AND the base filename
                        if "subsample" in file_lower and base_name in file:
                            file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, file)
                            if os.path.isfile(file_path):
                                try:
                                    os.remove(file_path)
                                    deleted_files.append(f"cache/{file}")
                                    logger.info(f"Deleted subsampled DTM file (found by pattern match): {file_path}")
                                    not_found = False
                                except Exception as e:
                                    logger.error(f"Error deleting subsampled file {file_path}: {e}", exc_info=True)
                except Exception as e:
                    logger.warning(f"Error searching for subsampled files: {e}")
        
        if not_found:
            logger.warning(f"[{trace_id}] Uploaded DTM not found: {filename}")
            return {"success": True, "deleted": False, "message": f"Uploaded DTM {filename} not found"}
        
        # Confirm deletion in lease manager
        try:
            lease_mgr = get_lease_manager()
            lease_mgr.confirm_dtm_deleted(
                dtm_id=filename,
                trace_id=trace_id,
                caller="delete_uploaded_dtm"
            )
        except Exception as e:
            logger.warning(f"[{trace_id}] Failed to confirm DTM deletion in lease manager: {e}")
        
        logger.info(f"[{trace_id}] Successfully deleted {len(deleted_files)} file(s) for uploaded DTM: {filename}")
        return {
            "success": True,
            "deleted": True,
            "filename": filename,
            "deletedFiles": deleted_files
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting uploaded DTM {filename}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/dtm/cleanup")
async def cleanup_dtm(
    request: Request,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID")
):
    """Cleanup endpoint for deleting DTM files - matches Node.js backend API"""
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        body = await request.json()
        dtm_path = body.get("path")
        filename = body.get("filename")
        clipped_id = body.get("clippedId")
        force = body.get("force", False)
        
        logger.info(f"[{trace_id}] Cleanup request - path: {dtm_path}, filename: {filename}, clippedId: {clipped_id}, force={force}")
        
        # If clippedId is provided, delete the clipped DTM
        if clipped_id:
            try:
                # Check protection unless force delete
                if not force:
                    check_dtm_protection_for_delete(
                        dtm_id=clipped_id,
                        caller="cleanup_dtm",
                        reason="cleanup_clipped",
                        trace_id=trace_id
                    )
                
                logger.info(f"[{trace_id}] Deleting clipped DTM via cleanup: {clipped_id}")
                # Reuse the delete logic - search for files matching the clipped_id
                deleted_files = []
                not_found = True
                
                # Delete from cache directory
                if os.path.exists(DTM_CACHE_DIR):
                    cache_files = os.listdir(DTM_CACHE_DIR)
                    for file in cache_files:
                        if file.startswith(clipped_id):
                            file_path = os.path.join(DTM_CACHE_DIR, file)
                            try:
                                if os.path.isfile(file_path):
                                    os.remove(file_path)
                                    deleted_files.append(f"cache/{file}")
                                    logger.info(f"[{trace_id}] Deleted clipped DTM file: {file_path}")
                                    not_found = False
                            except Exception as e:
                                logger.error(f"[{trace_id}] Error deleting {file_path}: {e}")
                
                    # Delete subsampled version from DTM_SUBSAMPLED_CACHE_DIR
                    logger.info(f"[{trace_id}] Checking for subsampled version in: {DTM_SUBSAMPLED_CACHE_DIR}")
                    if os.path.exists(DTM_SUBSAMPLED_CACHE_DIR):
                        subsampled_files = os.listdir(DTM_SUBSAMPLED_CACHE_DIR)
                        logger.info(f"[{trace_id}] Found {len(subsampled_files)} files in subsampled cache directory")
                        for file in subsampled_files:
                            file_lower = file.lower()
                            # Check if file contains "subsample" AND matches the clipped_id pattern
                            has_subsample = "subsample" in file_lower
                            matches_clipped_id = file.startswith(clipped_id) or clipped_id in file
                            
                            if has_subsample and matches_clipped_id:
                                file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, file)
                                try:
                                    if os.path.isfile(file_path):
                                        os.remove(file_path)
                                        deleted_files.append(f"cache/{file}")
                                        logger.info(f"[{trace_id}] Deleted subsampled DTM file: {file_path}")
                                        not_found = False
                                except Exception as e:
                                    logger.error(f"[{trace_id}] Error deleting {file_path}: {e}")
                    else:
                        logger.warning(f"[{trace_id}] Subsampled cache directory does not exist: {DTM_SUBSAMPLED_CACHE_DIR}")
                
                if not_found:
                    return {"success": True, "deleted": False, "message": f"Clipped DTM {clipped_id} not found"}
                
                # Confirm deletion in lease manager
                try:
                    lease_mgr = get_lease_manager()
                    lease_mgr.confirm_dtm_deleted(
                        dtm_id=clipped_id,
                        trace_id=trace_id,
                        caller="cleanup_dtm"
                    )
                except Exception as e:
                    logger.warning(f"[{trace_id}] Failed to confirm clipped DTM deletion in lease manager: {e}")
                
                return {"success": True, "deleted": True, "clippedId": clipped_id, "deletedFiles": deleted_files}
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"[{trace_id}] Error deleting clipped DTM: {e}", exc_info=True)
                return {"success": False, "error": "Failed to delete clipped DTM"}
        
        # Legacy: delete uploaded file
        # Extract filename from path or use provided filename
        raw_name = filename
        if not raw_name and dtm_path:
            if isinstance(dtm_path, str):
                raw_name = os.path.basename(dtm_path)
        
        if not raw_name:
            logger.warning(f"[{trace_id}] No filename provided in cleanup request")
            return {"success": False, "error": "No filename provided"}
        
        # Use just the basename for safety
        safe_filename = os.path.basename(raw_name)
        
        # Check protection unless force delete
        if not force:
            check_dtm_protection_for_delete(
                dtm_id=safe_filename,
                caller="cleanup_dtm",
                reason="cleanup_legacy",
                trace_id=trace_id
            )
        
        logger.info(f"[{trace_id}] Attempting to delete legacy DTM file: {safe_filename}")
        
        # Call the delete function logic
        deleted_files = []
        not_found = True
        
        # Delete from UPLOADS_DIR
        upload_file_path = os.path.join(UPLOADS_DIR, safe_filename)
        if os.path.exists(upload_file_path):
            try:
                os.remove(upload_file_path)
                deleted_files.append(f"uploads/{safe_filename}")
                logger.info(f"Deleted uploaded DTM file: {upload_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting file from UPLOADS_DIR {upload_file_path}: {e}", exc_info=True)
        
        # Delete from DTM_CACHE_DIR (if different from UPLOADS_DIR)
        cache_file_path = os.path.join(DTM_CACHE_DIR, safe_filename)
        upload_file_path_abs = os.path.abspath(upload_file_path)
        cache_file_path_abs = os.path.abspath(cache_file_path)
        
        if upload_file_path_abs != cache_file_path_abs and os.path.exists(cache_file_path):
            try:
                os.remove(cache_file_path)
                deleted_files.append(f"cache/{safe_filename}")
                logger.info(f"Deleted cached DTM file: {cache_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting file from DTM_CACHE_DIR {cache_file_path}: {e}", exc_info=True)
        
        # Delete subsampled version from DTM_SUBSAMPLED_CACHE_DIR
        subsampled_filename = get_subsampled_filename(safe_filename)
        subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
        logger.info(f"Checking for subsampled version in: {DTM_SUBSAMPLED_CACHE_DIR}")
        logger.info(f"Looking for subsampled file: {subsampled_filename} at path: {subsampled_file_path}")
        
        # First try the exact subsampled filename
        if os.path.exists(subsampled_file_path):
            try:
                os.remove(subsampled_file_path)
                deleted_files.append(f"cache/{subsampled_filename}")
                logger.info(f"Deleted subsampled DTM file: {subsampled_file_path}")
                not_found = False
            except Exception as e:
                logger.error(f"Error deleting subsampled file {subsampled_file_path}: {e}", exc_info=True)
        else:
            logger.info(f"Subsampled file not found at exact path: {subsampled_file_path}")
            # Fallback: search for any file with "subsample" in the name that matches the base filename
            if os.path.exists(DTM_SUBSAMPLED_CACHE_DIR):
                try:
                    base_name = os.path.splitext(safe_filename)[0]
                    all_files = os.listdir(DTM_SUBSAMPLED_CACHE_DIR)
                    for file in all_files:
                        file_lower = file.lower()
                        # Check if file contains "subsample" AND the base filename
                        if "subsample" in file_lower and base_name in file:
                            file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, file)
                            if os.path.isfile(file_path):
                                try:
                                    os.remove(file_path)
                                    deleted_files.append(f"cache/{file}")
                                    logger.info(f"Deleted subsampled DTM file (found by pattern match): {file_path}")
                                    not_found = False
                                except Exception as e:
                                    logger.error(f"Error deleting subsampled file {file_path}: {e}", exc_info=True)
                except Exception as e:
                    logger.warning(f"Error searching for subsampled files: {e}")
        
        if not_found:
            logger.warning(f"Uploaded DTM not found: {safe_filename}")
            return {"success": True, "deleted": False, "message": f"Uploaded DTM {safe_filename} not found", "uploadsDir": UPLOADS_DIR}
        
        logger.info(f"Successfully deleted {len(deleted_files)} file(s) for uploaded DTM: {safe_filename}")
        return {
            "success": True,
            "deleted": True,
            "filename": safe_filename,
            "deletedFiles": deleted_files
        }
        
    except Exception as e:
        logger.error(f"Error in cleanup endpoint: {e}", exc_info=True)
        return {"success": False, "error": str(e)}

@app.get("/dtm/{filename}/raster")
async def get_dtm_raster(filename: str):
    # Use cache directory for original (calculations), fallback to UPLOADS_DIR
    file_path = os.path.join(DTM_CACHE_DIR, filename)
    if not os.path.exists(file_path):
        file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    start_time = time.time()
    logger.info(f"Reading raster data for DTM: {filename}")
    try:
        # First, read full resolution for min/max calculations from cache
        with rasterio.open(file_path) as src:
            # Calculate min/max from full resolution
            full_data = src.read(1)
            nodata = src.nodata
            bounds = src.bounds
            src_width = src.width
            src_height = src.height
            src_crs = src.crs  # Get CRS object for transformation
            src_crs_str = src_crs.to_string() if src_crs else None
            
            # Get stats from full resolution
            valid_mask = full_data != nodata if nodata is not None else np.ones_like(full_data, dtype=bool)
            if np.issubdtype(full_data.dtype, np.floating):
                valid_mask &= ~np.isnan(full_data)
            
            if valid_mask.any():
                min_val = float(np.min(full_data[valid_mask]))
                max_val = float(np.max(full_data[valid_mask]))
            else:
                min_val = 0.0
                max_val = 0.0
            
            # Check projection
            is_projected = False
            if src_crs:
                is_projected = src_crs.is_projected
            else:
                # Heuristic fallback
                is_projected = abs(bounds.left) > 180 or abs(bounds.bottom) > 90
        
        # Read subsampled version for display (from cache if available)
        subsampled_filename = get_subsampled_filename(filename)
        subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
        if os.path.exists(subsampled_file_path):
            logger.info(f"Using cached subsampled version for display: {subsampled_file_path}")
            with rasterio.open(subsampled_file_path) as subsampled_src:
                display_data = subsampled_src.read(1)
                render_width = subsampled_src.width
                render_height = subsampled_src.height
        else:
            # Fallback: if subsampled version doesn't exist, create on-the-fly from original
            logger.info(f"Subsampled version not found, creating on-the-fly for display")
            with rasterio.open(file_path) as src:  # file_path is already the original from cache
                if src_width > C.MAX_DISPLAY_DIM or src_height > C.MAX_DISPLAY_DIM:
                    scale = max(src_width, src_height) / C.MAX_DISPLAY_DIM
                    new_width = int(src_width / scale)
                    new_height = int(src_height / scale)
                    logger.info(f"On-the-fly subsampling: {src_width}x{src_height} -> {new_width}x{new_height} (factor {scale:.2f})")
                    
                    display_data = src.read(
                        1,
                        out_shape=(new_height, new_width),
                        resampling=rasterio.enums.Resampling.bilinear
                    )
                    render_width = new_width
                    render_height = new_height
                else:
                    display_data = full_data
                    render_width = src_width
                    render_height = src_height
        
        # Transform bounds to WGS84 if CRS is available
        if src_crs:
            wgs84_bounds = rasterio.warp.transform_bounds(
                src_crs,
                C.EPSG_WGS84,
                bounds.left,
                bounds.bottom,
                bounds.right,
                bounds.top
            )
            bounds_list = list(wgs84_bounds)
        else:
            # Fallback: use original bounds if no CRS
            bounds_list = [bounds.left, bounds.bottom, bounds.right, bounds.top]
        
        # Convert to list for JSON response
        flat_data = display_data.flatten()
        
        res = {
            "width": render_width,
            "height": render_height,
            "originalWidth": src_width,
            "originalHeight": src_height,
            "min": min_val,
            "max": max_val,
            "bounds": bounds_list,  # Now in WGS84
            "noDataValue": nodata,
            "isProjected": is_projected,
            "data": flat_data.tolist(),
            "crs": src_crs_str
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
        
        # Ensure cache directory exists
        os.makedirs(DTM_CACHE_DIR, exist_ok=True)
        
        # Verify directory is writable
        if not os.access(DTM_CACHE_DIR, os.W_OK):
            raise HTTPException(
                status_code=500,
                detail=f"DTM cache directory is not writable: {DTM_CACHE_DIR}"
            )
        
        # Generate unique clipped ID
        clipped_id = f"{int(time.time() * 1000)}-{request.dtmId.rsplit('.', 1)[0] if '.' in request.dtmId else request.dtmId}"
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        clipped_file_path = os.path.abspath(clipped_file_path)  # Use absolute path
        
        logger.info(f"Creating clipped DTM: {clipped_file_path}")
        logger.info(f"DTM_CACHE_DIR: {os.path.abspath(DTM_CACHE_DIR)}")
        
        # Open source DTM
        with rasterio.open(dtm_file_path) as src:
            src_crs = src.crs
            if not src_crs:
                # Try to infer CRS from bounds
                is_projected = abs(src.bounds.left) > 180 or abs(src.bounds.bottom) > 90
                src_crs_str = C.EPSG_UTM_36N if is_projected else C.EPSG_WGS84
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
                "driver": C.RASTER_DRIVER_GTIFF,
                "height": out_image.shape[1],
                "width": out_image.shape[2],
                "transform": out_transform,
                "compress": C.RASTER_COMPRESSION_LZW
            })
            
            # Calculate bounds from transform
            left = out_transform[2]
            top = out_transform[5]
            right = left + out_transform[0] * out_meta["width"]
            bottom = top + out_transform[4] * out_meta["height"]
            
            # Transform bounds to WGS84
            out_bounds = rasterio.warp.transform_bounds(src_crs, C.EPSG_WGS84, left, bottom, right, top)
            
            # Write full-resolution clipped raster (for calculations)
            with rasterio.open(clipped_file_path, "w", **out_meta) as dest:
                dest.write(out_image)
            
            # Verify the file was created successfully
            if not os.path.exists(clipped_file_path):
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to create clipped DTM file at {clipped_file_path}"
                )
            
            # Verify file is readable
            try:
                with rasterio.open(clipped_file_path) as test_src:
                    test_src.read(1)  # Try to read the first band
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Clipped DTM file created but not readable: {str(e)}"
                )
            
            logger.info(f"Clipped DTM file verified: {clipped_file_path} (size: {os.path.getsize(clipped_file_path)} bytes)")
            
            # Create subsampled version for display if needed
            # Ensure subsampled cache directory exists
            os.makedirs(DTM_SUBSAMPLED_CACHE_DIR, exist_ok=True)
            subsampled_filename = get_subsampled_filename(f"{clipped_id}.tif")
            subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
            if out_meta["width"] > C.MAX_DISPLAY_DIM or out_meta["height"] > C.MAX_DISPLAY_DIM:
                scale = max(out_meta["width"], out_meta["height"]) / C.MAX_DISPLAY_DIM
                new_width = int(out_meta["width"] / scale)
                new_height = int(out_meta["height"] / scale)
                logger.info(f"Creating subsampled version: {out_meta['width']}x{out_meta['height']} -> {new_width}x{new_height}")
                
                # Calculate new transform for subsampled version
                new_transform = Affine(
                    out_transform[0] * scale,  # pixel width
                    out_transform[1],
                    out_transform[2],
                    out_transform[3],
                    out_transform[4] * scale,  # pixel height
                    out_transform[5]
                )
                
                subsampled_meta = out_meta.copy()
                subsampled_meta.update({
                    "width": new_width,
                    "height": new_height,
                    "transform": new_transform
                })
                
                # Read and resample the full-resolution data
                with rasterio.open(clipped_file_path) as full_src:
                    subsampled_data = full_src.read(
                        1,
                        out_shape=(new_height, new_width),
                        resampling=rasterio.enums.Resampling.bilinear
                    )
                
                # Write subsampled version
                with rasterio.open(subsampled_file_path, "w", **subsampled_meta) as dest:
                    dest.write(subsampled_data, 1)
            else:
                # If already small enough, just copy the full version
                shutil.copy2(clipped_file_path, subsampled_file_path)
                logger.info(f"DTM already small enough, copying full version for display")
            
            # Generate URLs (these will be served by the Node.js backend)
            base_url = f"/api/dtm/clipped/{clipped_id}"
            
            duration = time.time() - start_time
            logger.info(f"DTM clipped successfully in {duration:.3f}s: {clipped_id}")
            
            # Register clipped DTM in lease manager for tracking
            try:
                lease_mgr = get_lease_manager()
                trace_id = str(uuid.uuid4())[:8]
                lease_mgr.register_dtm(
                    dtm_id=clipped_id,
                    storage_path=clipped_file_path,
                    trace_id=trace_id
                )
                logger.info(f"[{trace_id}] Clipped DTM registered in lease manager: {clipped_id}")
            except Exception as e:
                logger.warning(f"Failed to register clipped DTM in lease manager: {e}")
            
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
        # Resolve to absolute path for better error messages
        clipped_file_path = os.path.abspath(clipped_file_path)
        
        if not os.path.exists(clipped_file_path):
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                matching_files = [f for f in cache_files if f.startswith(clipped_id)]
                logger.warning(f"Clipped DTM not found: {clipped_file_path}")
                logger.info(f"Cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
                logger.info(f"Files in cache: {cache_files[:10]}")
                if matching_files:
                    logger.info(f"Found matching files: {matching_files}")
            raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id} in cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
        
        with rasterio.open(clipped_file_path) as src:
            bounds = src.bounds
            # Transform bounds to WGS84
            wgs84_bounds = rasterio.warp.transform_bounds(src.crs, C.EPSG_WGS84, *bounds)
            
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
async def get_clipped_dtm_raster(
    clipped_id: str,
    request: Request,
    x_session_id: Optional[str] = Header(None, alias="X-Session-ID")
):
    """Get raster data for a clipped DTM"""
    try:
        # Implicitly acquire/renew lease for this DTM access
        implicitly_acquire_or_renew_lease(
            dtm_id=clipped_id,
            client_ip=get_client_ip(request),
            session_id=x_session_id
        )
        
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        # Resolve to absolute path for better error messages
        clipped_file_path = os.path.abspath(clipped_file_path)
        
        if not os.path.exists(clipped_file_path):
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                matching_files = [f for f in cache_files if f.startswith(clipped_id)]
                logger.warning(f"Clipped DTM not found: {clipped_file_path}")
                logger.info(f"Cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
                logger.info(f"Files in cache: {cache_files[:10]}")
                if matching_files:
                    logger.info(f"Found matching files: {matching_files}")
                    # Try using the first matching file
                    clipped_file_path = os.path.abspath(os.path.join(DTM_CACHE_DIR, matching_files[0]))
                else:
                    raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id} in cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
            else:
                raise HTTPException(status_code=404, detail=f"Cache directory does not exist: {os.path.abspath(DTM_CACHE_DIR)}")
        
        start_time = time.time()
        logger.info(f"Reading raster data for clipped DTM: {clipped_id}")
        
        # Read full resolution for min/max calculations
        with rasterio.open(clipped_file_path) as full_src:
            full_data = full_src.read(1)
            nodata = full_src.nodata
            bounds = full_src.bounds
            src_width = full_src.width
            src_height = full_src.height
            src_crs = full_src.crs
            
            # Calculate min/max from full resolution
            valid_mask = full_data != nodata if nodata is not None else np.ones_like(full_data, dtype=bool)
            if np.issubdtype(full_data.dtype, np.floating):
                valid_mask &= ~np.isnan(full_data)
            
            if valid_mask.any():
                min_val = float(np.min(full_data[valid_mask]))
                max_val = float(np.max(full_data[valid_mask]))
            else:
                min_val = 0.0
                max_val = 0.0
            
            is_projected = src_crs.is_projected if src_crs else (abs(bounds.left) > 180 or abs(bounds.bottom) > 90)
        
        # Read subsampled version for display
        subsampled_filename = get_subsampled_filename(f"{clipped_id}.tif")
        subsampled_file_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, subsampled_filename)
        if os.path.exists(subsampled_file_path):
            logger.info(f"Using cached subsampled version for display: {subsampled_file_path}")
            with rasterio.open(subsampled_file_path) as subsampled_src:
                display_data = subsampled_src.read(1)
                render_width = subsampled_src.width
                render_height = subsampled_src.height
        else:
            # Fallback: if subsampled version doesn't exist, use full resolution
            logger.warning(f"Subsampled version not found, using full resolution for display")
            display_data = full_data
            render_width = src_width
            render_height = src_height
        
        wgs84_bounds = rasterio.warp.transform_bounds(src_crs, C.EPSG_WGS84, *bounds) if src_crs else bounds
        flat_data = display_data.flatten()
        
        res = {
            "width": render_width,
            "height": render_height,
            "originalWidth": src_width,
            "originalHeight": src_height,
            "min": min_val,
            "max": max_val,
            "bounds": list(wgs84_bounds),
            "noDataValue": nodata,
            "isProjected": is_projected,
            "data": flat_data.tolist(),
            "crs": src_crs.to_string() if src_crs else None
        }
        duration = time.time() - start_time
        logger.info(f"Raster data read for clipped DTM in {duration:.3f}s")
        return res
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading clipped DTM raster: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dtm/clipped/{clipped_id}/file")
@app.get("/api/dtm/clipped/{clipped_id}/download")
@app.get("/api/dtm/clipped/{clipped_id}/geotiff")
@app.get("/api/dtm/clipped/{clipped_id}/tif")
async def get_clipped_dtm_file(clipped_id: str):
    """Get the clipped DTM file directly from cache directory"""
    try:
        # Try with .tif extension first
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        clipped_file_path = os.path.abspath(clipped_file_path)
        
        # If not found, try without extension or with other extensions
        if not os.path.exists(clipped_file_path):
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                for file in cache_files:
                    if file.startswith(clipped_id):
                        clipped_file_path = os.path.abspath(os.path.join(DTM_CACHE_DIR, file))
                        break
                else:
                    logger.warning(f"Clipped DTM not found: {clipped_id}")
                    logger.info(f"Cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
                    logger.info(f"Files in cache: {cache_files[:10]}")
                    raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id} in cache directory: {os.path.abspath(DTM_CACHE_DIR)}")
            else:
                logger.warning(f"DTM_CACHE_DIR does not exist: {os.path.abspath(DTM_CACHE_DIR)}")
                raise HTTPException(status_code=404, detail=f"Cache directory not found: {os.path.abspath(DTM_CACHE_DIR)}")
        
        if not os.path.exists(clipped_file_path):
            logger.error(f"Clipped DTM file not found: {clipped_file_path}")
            logger.info(f"Cache directory contents: {os.listdir(DTM_CACHE_DIR) if os.path.exists(DTM_CACHE_DIR) else 'Directory does not exist'}")
            raise HTTPException(status_code=404, detail=f"Clipped DTM not found: {clipped_id}")
        
        logger.info(f"Serving clipped DTM file: {clipped_file_path}")
        return FileResponse(
            clipped_file_path,
            media_type="image/tiff",
            filename=f"{clipped_id}.tif"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving clipped DTM file: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dtm/clipped/{clipped_id}/ready")
async def check_clipped_dtm_ready(clipped_id: str, request: Request):
    """Check if a clipped DTM is fully ready for elevation queries"""
    trace_id = request.headers.get("X-Trace-ID", str(uuid.uuid4())[:8])
    logger.info(f"[{trace_id}] Checking readiness for clipped DTM: {clipped_id}")
    
    try:
        clipped_file_path = os.path.join(DTM_CACHE_DIR, f"{clipped_id}.tif")
        # Resolve to absolute path
        clipped_file_path = os.path.abspath(clipped_file_path)
        logger.info(f"[{trace_id}] Looking for clipped DTM at: {clipped_file_path}")
        
        # Check if file exists
        if not os.path.exists(clipped_file_path):
            logger.warning(f"[{trace_id}] Clipped DTM file not found at expected path: {clipped_file_path}")
            # Try to find the file with any extension
            if os.path.exists(DTM_CACHE_DIR):
                cache_files = os.listdir(DTM_CACHE_DIR)
                matching_files = [f for f in cache_files if f.startswith(clipped_id)]
                logger.info(f"[{trace_id}] Found {len(matching_files)} matching files in cache directory")
                if matching_files:
                    clipped_file_path = os.path.abspath(os.path.join(DTM_CACHE_DIR, matching_files[0]))
                    logger.info(f"[{trace_id}] Using matching file: {clipped_file_path}")
                else:
                    logger.warning(f"[{trace_id}] No matching files found for clipped_id: {clipped_id}")
                    return {
                        "ready": False,
                        "message": f"Clipped DTM not found: {clipped_id}"
                    }
            else:
                logger.error(f"[{trace_id}] DTM cache directory does not exist: {DTM_CACHE_DIR}")
                return {
                    "ready": False,
                    "message": f"DTM cache directory not found"
                }
        else:
            logger.info(f"[{trace_id}] Clipped DTM file found at: {clipped_file_path}")
        
        # Try to open and read from the file to verify it's fully written and readable
        try:
            with rasterio.open(clipped_file_path) as src:
                # Verify we can read basic metadata
                _ = src.width
                _ = src.height
                _ = src.crs
                _ = src.bounds
                
                # Try to read a small sample to ensure file is fully written
                # Read a 1x1 pixel window from the center
                center_row = src.height // 2
                center_col = src.width // 2
                sample = src.read(1, window=rasterio.windows.Window(center_col, center_row, 1, 1))
                _ = sample[0, 0]  # Access the value to ensure it's readable
                
                logger.info(f"[{trace_id}] Clipped DTM {clipped_id} is ready (size: {src.width}x{src.height})")
                return {
                    "ready": True,
                    "message": "DTM is ready for elevation queries"
                }
        except Exception as e:
            logger.warning(f"Clipped DTM file exists but is not fully readable: {e}")
            return {
                "ready": False,
                "message": f"DTM file exists but is not ready: {str(e)}"
            }
            
    except Exception as e:
        logger.error(f"Error checking clipped DTM readiness: {e}", exc_info=True)
        return {
            "ready": False,
            "message": f"Error checking readiness: {str(e)}"
        }

@app.delete("/api/dtm/clipped/{clipped_id}")
async def delete_clipped_dtm(
    clipped_id: str,
    x_trace_id: Optional[str] = Header(None, alias="X-Trace-ID"),
    force: bool = Query(False, description="Force delete even if protected (admin only)")
):
    """Delete a clipped DTM from the cache directory"""
    try:
        trace_id = x_trace_id or str(uuid.uuid4())[:8]
        logger.info(f"[{trace_id}] Delete request for clipped DTM: {clipped_id}, force={force}")
        
        # Check protection unless force delete
        if not force:
            check_dtm_protection_for_delete(
                dtm_id=clipped_id,
                caller="delete_clipped_dtm",
                reason="manual_delete",
                trace_id=trace_id
            )
        
        logger.info(f"[{trace_id}] Deleting clipped DTM: {clipped_id} from cache directory: {DTM_CACHE_DIR}")
        
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
        
        # Also explicitly check and delete from subsampled cache directory
        logger.info(f"Checking for subsampled version in: {DTM_SUBSAMPLED_CACHE_DIR}")
        if os.path.exists(DTM_SUBSAMPLED_CACHE_DIR):
            try:
                subsampled_files = os.listdir(DTM_SUBSAMPLED_CACHE_DIR)
                logger.info(f"Found {len(subsampled_files)} files in subsampled cache directory")
                for item in subsampled_files:
                    item_path = os.path.join(DTM_SUBSAMPLED_CACHE_DIR, item)
                    if os.path.isfile(item_path):
                        # Check if this is a subsampled version - must contain "subsample" in the name
                        # AND match the clipped_id pattern
                        item_lower = item.lower()
                        has_subsample = "subsample" in item_lower
                        
                        # Check if it matches the clipped_id pattern AND has "subsample" in the name
                        if has_subsample and should_delete_file(item_path, item):
                            try:
                                os.remove(item_path)
                                deleted_files.append(f"cache/{item}")
                                logger.info(f"Deleted subsampled DTM file: cache/{item} at {item_path}")
                                not_found = False
                            except Exception as e:
                                logger.error(f"Error deleting subsampled file {item}: {e}", exc_info=True)
                        elif has_subsample:
                            # Log when we find a subsampled file but it doesn't match (for debugging)
                            logger.debug(f"Found subsampled file but doesn't match clipped_id: {item}")
            except Exception as e:
                logger.warning(f"Error checking subsampled cache directory: {e}")
        else:
            logger.warning(f"Subsampled cache directory does not exist: {DTM_SUBSAMPLED_CACHE_DIR}")
        
        if not_found:
            logger.warning(f"[{trace_id}] Clipped DTM not found: {clipped_id} in directory: {DTM_CACHE_DIR}")
            logger.warning(f"[{trace_id}] Available files: {all_files}")
            return {"success": True, "deleted": False, "message": f"Clipped DTM {clipped_id} not found", "availableFiles": all_files[:20]}
        
        # Confirm deletion in lease manager
        try:
            lease_mgr = get_lease_manager()
            lease_mgr.confirm_dtm_deleted(
                dtm_id=clipped_id,
                trace_id=trace_id,
                caller="delete_clipped_dtm"
            )
        except Exception as e:
            logger.warning(f"[{trace_id}] Failed to confirm clipped DTM deletion in lease manager: {e}")
        
        logger.info(f"[{trace_id}] Successfully deleted {len(deleted_files)} file(s) for clipped DTM: {clipped_id}")
        return {
            "success": True,
            "deleted": True,
            "clippedId": clipped_id,
            "deletedFiles": deleted_files
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting clipped DTM {clipped_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
