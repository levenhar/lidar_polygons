# DTM Clipping and Upload Flow Documentation

This document explains the complete flow for clipping a DTM (Digital Terrain Model) and uploading it, including all API endpoints (paths) used between client and server.

## Quick Answer: Storage Location and Client Paths

### Where Clipped DTM is Saved (Server-Side)

**Physical File Location:**
- **Directory**: `DTM_CACHE_DIR` (configurable via environment variable)
- **Default Path**: `backend_python/DTM_TIFF/CACHE/`
- **Full File Path Example**: `backend_python/DTM_TIFF/CACHE/1704123456789-mydtm.tif`
- **File Format**: `{timestamp}-{original_dtm_id}.tif`
  - `timestamp`: Milliseconds since epoch (e.g., `1704123456789`)
  - `original_dtm_id`: Source DTM filename without extension

**Configuration:**
- Set `DTM_CACHE_DIR` environment variable to customize location
- If not set, defaults to: `{backend_python_directory}/DTM_TIFF/CACHE/`
- Code location: `backend_python/main.py` (lines 54-60, 504)

### Paths Sent from Server to Client

When clipping completes, the server sends these **API endpoint paths** (NOT file system paths) to the client:

```json
{
  "clippedId": "1704123456789-mydtm",
  "dataUrl": "/api/dtm/clipped/1704123456789-mydtm/raster",
  "metadataUrl": "/api/dtm/clipped/1704123456789-mydtm/metadata",
  "tilesUrl": "/api/dtm/clipped/1704123456789-mydtm/tiles/{z}/{x}/{y}.png"
}
```

**Key Points:**
- **`dataUrl`**: Used by client as the `dtmSource` for loading raster data
- **`metadataUrl`**: Used to fetch metadata (bounds, resolution, CRS, etc.)
- **`tilesUrl`**: Template for map tile requests
- All paths are **relative URLs** (start with `/api/...`)
- Client accesses data via HTTP API, **never directly to file system**
- The `clippedId` (e.g., `1704123456789-mydtm`) is used as identifier in all API calls

**Client Usage:**
- Location: `frontend/src/components/MapPanel.tsx` (line ~616)
- The `dataUrl` path is passed to `onDtmLoad()` callback
- All subsequent data access uses API endpoints, not file paths

### How the Client Knows the Location - Complete Flow

**Step 1: Client Requests Clipping**
```javascript
// Client sends POST /api/dtm/clip request
const response = await fetch('/api/dtm/clip', {
  method: 'POST',
  body: JSON.stringify({
    dtmId: selectedDtmId,
    aoi: aoiPayload
  })
});
```

**Step 2: Server Returns Location Information**
```javascript
// Server responds with:
const clipResult = await response.json();
// clipResult contains:
// {
//   clippedId: "1704123456789-mydtm",
//   dataUrl: "/api/dtm/clipped/1704123456789-mydtm/raster",
//   metadataUrl: "/api/dtm/clipped/1704123456789-mydtm/metadata",
//   tilesUrl: "/api/dtm/clipped/1704123456789-mydtm/tiles/{z}/{x}/{y}.png",
//   raster: { bbox: [...], width: 1024, height: 1024, crs: "EPSG:32636" }
// }
```

**Step 3: Client Stores the Location in State**
```javascript
// In MapPanel.tsx (line ~570, ~616):
setActiveClippedId(clipResult.clippedId);  // Store the ID

// Pass location to parent component
onDtmLoad(
  clipResult.dataUrl,  // API endpoint path used as dtmSource
  { bounds: ..., clippedId: clipResult.clippedId, ... },
  clipResult.clippedId  // Also pass as separate parameter
);
```

**Step 4: Parent Component (App.tsx) Stores State**
```javascript
// In App.tsx handleDtmLoad (line ~722):
const handleDtmLoad = (source: string, info?: any, clippedId?: string) => {
  setDtmSource(source);           // Stores: "/api/dtm/clipped/{clippedId}/raster"
  setActiveClippedId(clippedId);  // Stores: "1704123456789-mydtm"
  setDtmInfo({
    path: source,                  // API endpoint path
    bounds: info.bounds,
    clippedId: clippedId
  });
};
```

**Step 5: Client Uses Stored Location for Subsequent Requests**
- The `dtmSource` state (which contains the `dataUrl`) is used for raster data requests
- The `activeClippedId` state is used to construct other API endpoints:
  - `/api/dtm/clipped/{activeClippedId}/metadata`
  - `/api/dtm/clipped/{activeClippedId}/raster`
  - `/api/dtm/clipped/{activeClippedId}/tiles/{z}/{x}/{y}.png`
  - `/api/dtm/clipped/{activeClippedId}` (for DELETE)

**Key Points:**
1. **Server provides the location** - The Python backend returns the API endpoint paths in the clip response
2. **Client stores in React state** - Two pieces of state:
   - `dtmSource`: The API endpoint path (e.g., `/api/dtm/clipped/{clippedId}/raster`)
   - `activeClippedId`: The unique identifier for the clipped DTM
3. **State persists during session** - These values remain in React state until the DTM is unloaded
4. **All access via API** - The client never accesses file paths directly; all access is through HTTP API endpoints using the stored `clippedId` or `dataUrl`

## Architecture Overview

The system uses a 3-tier architecture:
1. **Frontend (React/TypeScript)** - Client-side application
2. **Node.js Backend** (`backend/server.js`) - Express server that proxies requests
3. **Python Backend** (`backend_python/main.py`) - FastAPI server that handles DTM processing

The Node.js backend acts as a proxy/gateway, forwarding requests to the Python backend where the actual DTM processing occurs.

---

## Flow 1: Direct DTM File Upload

### Client → Server Paths:

1. **POST `/api/upload-dtm`** (Client to Node.js Backend)
   - **Location**: `frontend/src/components/MapPanel.tsx` (line ~2501)
   - **Method**: POST
   - **Content-Type**: `multipart/form-data`
   - **Body**: GeoTIFF file (`.tif`, `.tiff`, `.geotiff`)
   - **Purpose**: Upload a DTM file directly from the client

### Server → Server Paths (Internal):

2. **POST `/upload-dtm`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~277)
   - **Method**: POST (proxied)
   - **Purpose**: Node.js backend forwards the multipart request to Python backend
   - **Python Endpoint**: `backend_python/main.py` (line ~360)

### Response Flow:

3. **Response from Python Backend → Node.js Backend → Client**
   - Returns JSON with:
     - `success`: boolean
     - `filename`: string (timestamped filename)
     - `path`: string (file path)
     - `size`: number (file size in bytes)
     - `bounds`: array (bounding box coordinates)
     - `resolution`: object (width, height)

---

## Flow 2: DTM Clipping (from Available DTM Files)

### Step 1: Get Available DTM Options

**Client → Server:**

1. **GET `/api/dtm/options`** (Client to Node.js Backend)
   - **Location**: `frontend/src/components/MapPanel.tsx`
   - **Method**: GET
   - **Headers**: Optional `If-None-Match` (for caching)
   - **Purpose**: Get list of available DTM files to clip

**Server → Server (Internal):**

2. **GET `/api/dtm/options`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~361)
   - **Method**: GET (proxied)
   - **Headers**: Forwards `If-None-Match` header
   - **Python Endpoint**: Not shown in code, but proxied to Python backend
   - **Response Headers**: Forwards `ETag` and `Cache-Control` from Python backend

### Step 2: Clip DTM to AOI (Area of Interest)

**Client → Server:**

3. **POST `/api/dtm/clip`** (Client to Node.js Backend)
   - **Location**: `frontend/src/components/MapPanel.tsx` (line ~551)
   - **Method**: POST
   - **Content-Type**: `application/json`
   - **Body**: 
     ```json
     {
       "dtmId": "string",  // ID of the DTM file to clip
       "aoi": {
         "type": "bbox" | "polygon",
         "crs": "EPSG:4326",
         "bbox": [minLon, minLat, maxLon, maxLat],  // for bbox type
         "coordinates": [[lon, lat], ...]  // for polygon type
       }
     }
     ```
   - **Purpose**: Request clipping of a DTM file to a specified area

**Server → Server (Internal):**

4. **POST `/api/dtm/clip`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~389)
   - **Method**: POST (proxied)
   - **Python Endpoint**: `backend_python/main.py` (line ~483)
   - **Purpose**: Python backend performs the actual clipping operation
   - **Response**: Returns JSON with:
     ```json
     {
       "clippedId": "string",  // Unique ID for the clipped DTM
       "raster": {
         "crs": "string",
         "bbox": [minLon, minLat, maxLon, maxLat],
         "width": number,
         "height": number
       },
       "tilesUrl": "/api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png",
       "metadataUrl": "/api/dtm/clipped/{clippedId}/metadata",
       "dataUrl": "/api/dtm/clipped/{clippedId}/raster"
     }
     ```

### Step 3: Upload Clipped DTM File

**Client → Server:**

5. **POST `/api/dtm/clipped/{clippedId}/upload`** (Client to Node.js Backend)
   - **Location**: `frontend/src/components/MapPanel.tsx` (line ~597)
   - **Method**: POST
   - **URL Parameter**: `clippedId` - The ID of the clipped DTM
   - **Purpose**: Upload the clipped DTM file from Python backend cache to Node.js backend uploads folder
   - **Note**: This happens automatically after clipping completes

**Server → Server (Internal):**

6. **GET `/api/dtm/clipped/{clippedId}/file`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~545-581)
   - **Method**: GET (proxied)
   - **Purpose**: Node.js backend tries multiple endpoints to get the clipped file:
     - `/api/dtm/clipped/{clippedId}/file` (primary)
     - `/api/dtm/clipped/{clippedId}/download` (fallback)
     - `/api/dtm/clipped/{clippedId}/geotiff` (fallback)
     - `/api/dtm/clipped/{clippedId}/tif` (fallback)
   - **Python Endpoints**: `backend_python/main.py` (line ~745-748)
   - **Response**: Returns the GeoTIFF file as binary data

7. **POST `/upload-dtm`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~608)
   - **Method**: POST
   - **Content-Type**: `multipart/form-data`
   - **Body**: The clipped GeoTIFF file (read from Python backend and re-uploaded)
   - **Python Endpoint**: `backend_python/main.py` (line ~360)
   - **Purpose**: Upload the clipped file to the Python backend's upload directory
   - **Note**: This creates a copy in the uploads folder for legacy compatibility

---

## Additional Endpoints (Used After Clipping)

### Get Clipped DTM Metadata

**Client → Server:**

8. **GET `/api/dtm/clipped/{clippedId}/metadata`** (Client to Node.js Backend)
   - **Method**: GET
   - **URL Parameter**: `clippedId`
   - **Purpose**: Get metadata about a clipped DTM

**Server → Server (Internal):**

9. **GET `/api/dtm/clipped/{clippedId}/metadata`** (Node.js Backend to Python Backend)
   - **Location**: `backend/server.js` (line ~416)
   - **Python Endpoint**: `backend_python/main.py` (line ~605)
   - **Response**: JSON with metadata (bounds, resolution, CRS, etc.)

### Get Clipped DTM Raster Data

**Client → Server:**

10. **GET `/api/dtm/clipped/{clippedId}/raster`** (Client to Node.js Backend)
    - **Method**: GET
    - **URL Parameter**: `clippedId`
    - **Purpose**: Get raster data for visualization

**Server → Server (Internal):**

11. **GET `/api/dtm/clipped/{clippedId}/raster`** (Node.js Backend to Python Backend)
    - **Location**: `backend/server.js` (line ~437)
    - **Python Endpoint**: `backend_python/main.py` (line ~652)
    - **Response**: JSON with raster data (downsampled for visualization)
    - **Content-Type**: Streamed from Python backend

### Get Clipped DTM Image (PNG)

**Client → Server:**

12. **GET `/api/dtm/clipped/{clippedId}/image.png`** (Client to Node.js Backend)
    - **Method**: GET
    - **URL Parameter**: `clippedId`
    - **Purpose**: Get rendered PNG image of the clipped DTM

**Server → Server (Internal):**

13. **GET `/api/dtm/clipped/{clippedId}/image.png`** (Node.js Backend to Python Backend)
    - **Location**: `backend/server.js` (line ~465)
    - **Python Endpoint**: Not shown, but proxied
    - **Response**: PNG image binary data
    - **Content-Type**: `image/png`

### Get Map Tiles

**Client → Server:**

14. **GET `/api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png`** (Client to Node.js Backend)
    - **Method**: GET
    - **URL Parameters**: 
      - `clippedId`: ID of clipped DTM
      - `z`: Zoom level
      - `x`: Tile X coordinate
      - `y`: Tile Y coordinate
    - **Purpose**: Get map tiles for rendering the DTM on a map

**Server → Server (Internal):**

15. **GET `/api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png`** (Node.js Backend to Python Backend)
    - **Location**: `backend/server.js` (line ~493)
    - **Python Endpoint**: Not shown, but proxied
    - **Response**: PNG tile image
    - **Content-Type**: `image/png`

### Delete Clipped DTM

**Client → Server:**

16. **DELETE `/api/dtm/clipped/{clippedId}`** (Client to Node.js Backend)
    - **Location**: `frontend/src/App.tsx` (line ~609)
    - **Method**: DELETE
    - **URL Parameter**: `clippedId`
    - **Purpose**: Delete a clipped DTM from cache

**Server → Server (Internal):**

17. **DELETE `/api/dtm/clipped/{clippedId}`** (Node.js Backend to Python Backend)
    - **Location**: `backend/server.js` (line ~521)
    - **Python Endpoint**: `backend_python/main.py` (line ~791)
    - **Purpose**: Remove clipped DTM from Python backend cache directory

---

## Complete Flow Diagram

```
┌─────────┐
│ Client  │
└────┬────┘
     │
     │ 1. POST /api/upload-dtm (multipart/form-data)
     │    OR
     │    GET /api/dtm/options
     │    ↓
     │    POST /api/dtm/clip
     │    ↓
     │    POST /api/dtm/clipped/{clippedId}/upload
     │
     ▼
┌──────────────┐
│ Node.js      │
│ Backend      │
│ (server.js)  │
└──────┬───────┘
       │
       │ 2. POST /upload-dtm (proxied)
       │    OR
       │    GET /api/dtm/options (proxied)
       │    ↓
       │    POST /api/dtm/clip (proxied)
       │    ↓
       │    GET /api/dtm/clipped/{clippedId}/file (proxied)
       │    ↓
       │    POST /upload-dtm (proxied)
       │
       ▼
┌──────────────┐
│ Python       │
│ Backend      │
│ (main.py)    │
└──────────────┘

Storage:
- Python Backend: DTM_CACHE_DIR (for clipped DTMs)
- Python Backend: UPLOADS_DIR (for uploaded DTMs)
- Node.js Backend: uploadsDir (legacy, for static file serving)
```

---

## Summary of All API Paths

### Client → Node.js Backend:
1. `POST /api/upload-dtm` - Upload DTM file
2. `GET /api/dtm/options` - List available DTM files
3. `POST /api/dtm/clip` - Clip DTM to AOI
4. `POST /api/dtm/clipped/{clippedId}/upload` - Upload clipped DTM
5. `GET /api/dtm/clipped/{clippedId}/metadata` - Get metadata
6. `GET /api/dtm/clipped/{clippedId}/raster` - Get raster data
7. `GET /api/dtm/clipped/{clippedId}/image.png` - Get PNG image
8. `GET /api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png` - Get map tiles
9. `DELETE /api/dtm/clipped/{clippedId}` - Delete clipped DTM
10. `POST /api/dtm/cleanup` - Cleanup legacy DTM files

### Node.js Backend → Python Backend:
1. `POST /upload-dtm` - Upload DTM file
2. `GET /api/dtm/options` - List available DTM files
3. `POST /api/dtm/clip` - Clip DTM to AOI
4. `GET /api/dtm/clipped/{clippedId}/file` - Get clipped file (and variants: `/download`, `/geotiff`, `/tif`)
5. `GET /api/dtm/clipped/{clippedId}/metadata` - Get metadata
6. `GET /api/dtm/clipped/{clippedId}/raster` - Get raster data
7. `GET /api/dtm/clipped/{clippedId}/image.png` - Get PNG image
8. `GET /api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png` - Get map tiles
9. `DELETE /api/dtm/clipped/{clippedId}` - Delete clipped DTM

---

## Storage Locations

### Where Clipped DTMs are Saved

**Physical File Location (Python Backend):**
- **Directory**: `DTM_CACHE_DIR` (configurable via environment variable)
- **Default Path**: `backend_python/DTM_TIFF/CACHE/`
- **Full Path**: Can be set via `DTM_CACHE_DIR` environment variable, or defaults to:
  ```
  {backend_python_directory}/DTM_TIFF/CACHE/{clipped_id}.tif
  ```
- **File Naming**: `{timestamp}-{original_dtm_id}.tif`
  - Example: `1704123456789-mydtm.tif`
  - `timestamp`: Milliseconds since epoch (Unix timestamp × 1000)
  - `original_dtm_id`: The source DTM file ID (without extension)

**Code Reference:**
- Storage location: `backend_python/main.py` (line ~504)
- Directory configuration: `backend_python/main.py` (lines ~54-60)

### Paths Sent from Server to Client

After clipping, the Python backend returns JSON with these **relative URL paths** that the client uses:

**Response from `POST /api/dtm/clip`:**
```json
{
  "clippedId": "1704123456789-mydtm",
  "raster": {
    "crs": "EPSG:32636",
    "bbox": [minLon, minLat, maxLon, maxLat],
    "width": 1024,
    "height": 1024
  },
  "dataUrl": "/api/dtm/clipped/1704123456789-mydtm/raster",
  "metadataUrl": "/api/dtm/clipped/1704123456789-mydtm/metadata",
  "tilesUrl": "/api/dtm/clipped/1704123456789-mydtm/tiles/{z}/{x}/{y}.png"
}
```

**How Client Uses These Paths:**
1. **`dataUrl`** (`/api/dtm/clipped/{clippedId}/raster`)
   - Used as the primary `dtmSource` for raster data loading
   - Location: `frontend/src/components/MapPanel.tsx` (line ~616)
   - This path is passed to `onDtmLoad()` callback

2. **`metadataUrl`** (`/api/dtm/clipped/{clippedId}/metadata`)
   - Used to fetch metadata about the clipped DTM
   - Returns bounds, resolution, CRS, file size, etc.

3. **`tilesUrl`** (`/api/dtm/clipped/{clippedId}/tiles/{z}/{x}/{y}.png`)
   - Template URL for map tiles
   - Used by map libraries to request tiles dynamically

**Important Notes:**
- These are **relative paths** (starting with `/api/...`)
- They go through the **Node.js backend proxy** (which forwards to Python backend)
- The client does NOT access the physical file path directly
- The `clippedId` is the identifier used in all subsequent API calls

## Notes

- The Node.js backend acts primarily as a proxy/gateway
- Clipped DTMs are stored in Python backend's `DTM_CACHE_DIR` (default: `backend_python/DTM_TIFF/CACHE/`)
- Uploaded DTMs (via direct upload) are stored in Python backend's `UPLOADS_DIR`
- The upload endpoint for clipped DTMs (`/api/dtm/clipped/{clippedId}/upload`) creates a copy in the uploads folder for legacy compatibility
- All paths use RESTful conventions
- The Python backend handles all actual DTM processing (clipping, raster operations, etc.)
- Client never accesses file system directly - all access is through HTTP API endpoints

