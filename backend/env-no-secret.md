BACKEND_SERVICE_NAME = backend
BACKEND_PORT = 5000
FRONTEND_SERVICE_NAME = fronend
FRONTEND_PORT = 8080
MAPS_TOKEN = ""
MAPS_URL = https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png
MAPS_URL_ALT = https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}


### maps display parameters
MAP_PREVIEW_ZOOM_DEFAULT = 0
MAP_PREVIEW_X_DEFAULT = 0
MAP_PREVIEW_Y_DEFAULT = 0

MAP_PREVIEW_ZOOM_PRIMARY = 0
MAP_PREVIEW_X_PRIMARY = 0
MAP_PREVIEW_Y_PRIMARY = 0

MAP_PREVIEW_ZOOM_ALTERNATE = 0
MAP_PREVIEW_X_ALTERNATE = 0
MAP_PREVIEW_Y_ALTERNATE = 0


### DTM Loading Configuration (Python Backend)
# Directory containing source DTM files (read-only, server scans for available files)
DTM_DATA_DIR = /path/to/dtm/files

# Directory for cached clipped DTMs (read-write, server creates/deletes clipped outputs here)
DTM_CACHE_DIR = /path/to/dtm/cache

# Cache TTL in seconds - how long before stale cached clips are automatically deleted
# Default: 18000 (5 hours)
DTM_CACHE_TTL_SECONDS = 18000

# Cleanup interval in seconds - how often the background job runs to delete expired cache
# Default: 1800 (30 minutes)
DTM_CLEANUP_INTERVAL_SECONDS = 1800

# Options cache TTL in seconds - how long to cache the DTM options list in memory
# Default: 86400 (1 day)
DTM_OPTIONS_CACHE_TTL_SECONDS = 86400

# Legacy: Uploads directory (still used for direct file uploads)
UPLOADS_DIR = ../backend/uploads