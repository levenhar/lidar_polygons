"""
Constants module for the lidar_polygons backend.

This module centralizes all repeated constants used across the codebase to ensure
they are defined in ONE place and can be easily updated.

Constants are organized by category for clarity.
"""

# ============================================================================
# FILE EXTENSIONS AND PATHS
# ============================================================================

# DTM file extensions
DTM_EXTENSIONS = ('.tif', '.tiff', '.geotiff')
DTM_EXTENSION_TIF = '.tif'
DTM_EXTENSION_TIFF = '.tiff'
DTM_EXTENSION_GEOTIFF = '.geotiff'

# Directory names
DIR_CACHE = 'Cache'
DIR_DTM_TIFF = 'DTM_TIFF'
DIR_VIEWSHED = 'Viewshed'

# Filename suffixes
SUFFIX_SUBSAMPLE = '_subsample'

# ============================================================================
# COORDINATE REFERENCE SYSTEMS (CRS)
# ============================================================================

# EPSG codes
EPSG_WGS84 = 'EPSG:4326'  # WGS84 geographic coordinate system
EPSG_UTM_36N = 'EPSG:32636'  # UTM Zone 36N (common for Israel/Palestine)

# ============================================================================
# NUMERIC ALGORITHM CONSTANTS
# ============================================================================

# Display and rendering
MAX_DISPLAY_DIM = 2048  # Maximum dimension for subsampled display versions (pixels)

# Default sampling and resolution parameters (meters)
DEFAULT_SAFETY_RADIUS_METERS = 50.0  # Default safety radius for elevation profile
DEFAULT_RESOLUTION_RADIUS_METERS = 50.0  # Default resolution radius for elevation profile
DEFAULT_SAMPLING_INTERVAL_METERS = 50.0  # Default sampling interval for viewshed
ELEVATION_PROFILE_SAMPLING_INTERVAL_METERS = 3.0  # Sampling interval for elevation profile generation

# Geographic conversion constants
METERS_PER_DEGREE_LATITUDE = 111320.0  # Approximate meters per degree of latitude (constant)
# Note: meters per degree longitude varies by latitude: 111320.0 * cos(latitude)

# Earth radius for haversine calculations (meters)
EARTH_RADIUS_METERS = 6371000  # Use 3956 for miles

# Viewshed algorithm constants
VIEWSHED_NODATA_VALUE = -1  # No-data value for viewshed raster output
VIEWSHED_MIN_ANGLE_INIT = -1e9  # Initial minimum angle for visibility calculation

# ============================================================================
# RASTERIO/GDAL CONSTANTS
# ============================================================================

# Raster driver names
RASTER_DRIVER_GTIFF = 'GTiff'

# Compression methods
RASTER_COMPRESSION_LZW = 'lzw'

# Resampling methods (imported from rasterio.enums when needed)
# Resampling.bilinear is used but imported directly where needed

# ============================================================================
# DTM LEASE MANAGEMENT CONSTANTS
# ============================================================================

# Lease durations (seconds)
DEFAULT_LEASE_DURATION_SECONDS = 300  # 5 minutes - default lease duration
IMPLICIT_LEASE_DURATION_SECONDS = 120  # 2 minutes - shorter duration for implicit leases
LEASE_GRACE_PERIOD_SECONDS = 30  # Grace period after lease expires before cleanup
CLEANUP_INTERVAL_SECONDS = 60  # Background cleanup interval

# SQLite connection settings
SQLITE_TIMEOUT_SECONDS = 30.0  # Wait up to 30 seconds for locks
SQLITE_BUSY_TIMEOUT_MS = 30000  # 30 seconds in milliseconds

# Lease status strings (used in database queries)
LEASE_STATUS_ACTIVE = 'active'
LEASE_STATUS_EXPIRED = 'expired'
LEASE_STATUS_RELEASED = 'released'

# DTM status strings (used in database queries)
DTM_STATUS_AVAILABLE = 'available'
DTM_STATUS_PROTECTED = 'protected'
DTM_STATUS_DELETING = 'deleting'
DTM_STATUS_DELETED = 'deleted'

# ============================================================================
# DEFAULT PARAMETERS
# ============================================================================

# Default values for API requests
DEFAULT_VIEWSHED_SAMPLING_INTERVAL_METERS = 50.0
DEFAULT_VIEWSHED_USE_SUBSAMPLED = True

# ============================================================================
# API ROUTES AND ENDPOINTS (if shared between backend and frontend logic)
# ============================================================================

# Note: Most API routes are defined in main.py and don't need to be constants
# unless they're referenced in multiple places or need to be shared with frontend

