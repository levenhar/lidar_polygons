# LiDAR Mission Planner

A web application for planning aerial LiDAR scanning missions. Draw flight paths on a map, configure altitude and climb profiles, and visualize a synchronized elevation profile against a DTM (Digital Terrain Model). Projects save as `.nehorai` files.

## Architecture

Three services run together in development:

| Service | Directory | Stack | Port |
|---|---|---|---|
| Frontend | `frontend/` | React 18 + TypeScript, Vite, Leaflet, D3.js | 3000 |
| Node backend | `backend/` | Express, GeoTIFF.js, proj4 | 5000 |
| Python backend | `backend_python/` | FastAPI, rasterio, pyproj, numpy | configured via env |

The frontend proxies `/api` requests to the Node backend. The Node backend handles DTM uploads and map tile proxying. The Python backend handles heavy geospatial computation (elevation profiles, clipping, viewshed).

## Prerequisites

- **Node.js 18+** and npm
- **Python 3.10+** and pip (or conda)

---

## Installation

### 1. Node dependencies

From the repo root:

```bash
# Install root + frontend + backend dependencies
npm run install:all
```

Or install each separately:

```bash
npm install          # root
cd frontend && npm install
cd ../backend && npm install
```

### 2. Python dependencies

```bash
cd backend_python
pip install -r requirements.txt
```

Using a virtual environment is recommended:

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

---

## Configuration

### Node backend (`backend/.env`)

Create `backend/.env` based on `backend/env-no-secret.md`. Key variables:

| Variable | Description |
|---|---|
| `BACKEND_PORT` | Port for the Node server (default: 5000) |
| `MAPS_TOKEN` | API token for map tile provider |
| `MAPS_URL` | Map tile URL template |
| `UPLOADS_DIR` | Directory for uploaded DTM files |

### Python backend

The Python backend reads the same `backend/.env` file (via `python-dotenv`). Key variables:

| Variable | Description |
|---|---|
| `DTM_DATA_DIR` | Directory containing source DTM GeoTIFF files (read-only) |
| `DTM_CACHE_DIR` | Directory for cached clipped DTMs (read-write) |
| `DTM_SUBSAMPLED_CACHE_DIR` | Directory for subsampled display DTMs (optional) |
| `DTM_CACHE_TTL_SECONDS` | How long before stale cached clips are deleted (default: 18000) |
| `DTM_CLEANUP_INTERVAL_SECONDS` | Background cleanup interval (default: 1800) |

---

## Running Locally

### Option A — All services at once (recommended)

From the repo root:

```bash
npm run dev
```

This starts the frontend (port 3000) and Node backend (port 5000) concurrently. You still need to start the Python backend separately (see below).

### Option B — Each service individually

**Terminal 1 — Node backend and fronend:**

```bash
npm run dev
```

**Terminal 2 — Python backend:**

```bash
cd backend_python
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

> The Python backend port must match what the Node backend expects. Check your `.env` for the configured port.

Once both are running, open one of the following in your browser:

- **http://localhost:3000** — frontend dev server (hot reload, for active development)
- **http://localhost:5000** — Node backend serving the built static files (for testing the production build)

---

## Development

### Running tests

```bash
cd frontend
npm test
```

### Building for production

```bash
cd frontend
npm run build
```

Built files are output to `frontend/dist/`.

### Project file format

Projects are saved as `.nehorai` ZIP archives (schema version 4). The app also loads legacy `.routeproj` files.

---

## Project Structure

```
lidar_polygons/
├── frontend/               # React + TypeScript frontend (Vite, Leaflet, D3.js)
│   └── src/
│       ├── App.tsx         # Root component, owns all top-level state
│       ├── components/     # MapPanel, ElevationProfile, SettingsModal, etc.
│       ├── hooks/          # useFlightPath, useElevationProfile, useUndoRedo
│       ├── utils/          # climb.ts, projectSerializer.ts, kmlGenerator.ts, etc.
│       └── config/         # climbPresets.json
├── backend/                # Node.js / Express backend
│   ├── server.js
│   ├── .env                # Environment config (not committed)
│   └── env-no-secret.md    # Documented env vars (no values)
├── backend_python/         # Python / FastAPI backend
│   ├── main.py             # FastAPI app, startup cache build
│   ├── constants.py        # All shared numeric/string constants
│   ├── dtm_lease_manager.py # SQLite-backed DTM lease system
│   └── requirements.txt
└── README.md
```

---

## Troubleshooting

**Port already in use**
- Frontend: change the port in `frontend/vite.config.ts`
- Node backend: change `BACKEND_PORT` in `backend/.env`
- Python backend: pass a different `--port` to uvicorn

**Python backend fails to start**
- Make sure all packages from `requirements.txt` are installed in the active environment
- Verify `DTM_DATA_DIR` and `DTM_CACHE_DIR` point to existing directories

**Map tiles not loading**
- Set `MAPS_TOKEN` and `MAPS_URL` in `backend/.env`

**CORS errors**
- The Node backend includes CORS middleware. Verify the frontend proxy in `frontend/vite.config.ts` targets the correct backend port.

---

## License

MIT
