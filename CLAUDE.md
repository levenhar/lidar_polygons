# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiDAR Mission Planner — a web app for planning aerial LiDAR scanning missions. Users draw flight paths on a map, configure altitude/climb profiles, and see a synchronized elevation profile against a DTM (Digital Terrain Model). Projects save as `.nehorai` files.

## Architecture

Three services, all run together in development:

| Service | Dir | Stack | Port |
|---|---|---|---|
| Frontend | `frontend/` | React 18 + TypeScript, Vite, Leaflet, D3.js | 3000 |
| Node backend | `backend/` | Express, GeoTIFF.js, proj4 | 5000 |
| Python backend | `backend_python/` | FastAPI, rasterio, pyproj, numpy | configured via env |

The frontend proxies `/api` requests to the Node backend (port 5000) via `vite.config.ts`. The Node backend handles DTM file uploads and proxies map tiles. The Python backend handles the heavy geospatial computation (elevation profiles, clipping, viewshed).

## Frontend Change Validation (REQUIRED)

After **any** frontend code change, always run both:
```bash
npm test        # all tests must pass
npm run build   # build must succeed with no errors
```
Do not consider a frontend task complete until both commands succeed.

## Testing Rules (enforced by pre-push husky hook)

Tests **must pass** before pushing. The pre-push hook runs `npm test` automatically.

- Test files live beside the unit under test: `foo.ts` → `foo.test.ts`
- Use `describe('moduleName') > describe('functionName') > it('full sentence spec')`
- One behavior per `it()` block; arrange–act–assert structure
- No `.only`, `.skip` (without ticket ref), or commented-out tests in committed code
- Use `toBeCloseTo()` for floating-point assertions

## Key Frontend Modules

- **`src/App.tsx`** — root component; owns all top-level state (DTM source, routes, climb config, KML overlays, undo/redo). Very large; all major data flows through here.
- **`src/hooks/useFlightPath.ts`** — manages route coordinates; integrates with `useUndoRedo`
- **`src/hooks/useElevationProfile.ts`** — fetches and caches elevation data from the Python backend
- **`src/contexts/GlobalUndoRedoContext.tsx`** — app-wide undo/redo stack with `registerAction(type, undo, redo)`
- **`src/utils/climb.ts`** — climb/descent profile computation (climbRatio, descentRatio, vertexProximityMeters)
- **`src/utils/climbAnchors.ts`** — climb points anchored to specific route waypoints by stable `id`
- **`src/utils/projectSerializer.ts`** — save/load `.nehorai` project files (schema version 4)
- **`src/utils/kmlGenerator.ts`** / **`kmlImport.ts`** — KML export and import
- **`src/utils/constraints.ts`** — route constraint calculations (cumulative distances, etc.)
- **`src/config/climbPresets.json`** — named presets for climb configurations

## Key Types (defined in `src/App.tsx`)

```typescript
interface Coordinate { lng, lat, height?, id? }   // height = ASL meters
interface ElevationPoint { distance, elevation, plannedAltitude?, climbDelta?, ... }
```

- `height` on `Coordinate` is **ASL** (Above Sea Level), not AGL
- `flightHeight` on `ElevationPoint` is **AGL** (computed as plannedAltitude − elevation)

## Project File Format

Projects are saved as `.nehorai` ZIP archives (also accepts legacy `.routeproj`). Current schema version: **4**. The format constant `PROJECT_FORMAT_NAME = 'nehorai'` is used as a marker for quick identification.

## Python Backend Notes

- All shared constants live in `backend_python/constants.py` — add new numeric/string constants there, not inline.
- DTM files are managed via a lease system (`dtm_lease_manager.py`) backed by SQLite (`dtm_leases.db`). Leases prevent premature deletion of in-use DTM clips.
- On startup, `main.py` builds a `tif_footprints_cache` scanning `DTM_TIFF/` for fast overlap queries.
- CRS: WGS84 (`EPSG:4326`) for coordinates; UTM 36N (`EPSG:32636`) for metric calculations.

## Keyboard Shortcuts

Whenever a new keyboard shortcut is added to the app, it **must also be added** to the "מקשי קיצור" tab in `frontend/src/components/SettingsModal.tsx`. The shortcuts are listed as a static table grouped by category (מפה, פרויקט, דיאלוגים, etc.). Add a new category group if needed.

## Environment Variables

The Node backend reads from a `.env` file in `backend/`. Key vars: `BACKEND_PORT`, `MAPS_TOKEN`, `MAPS_URL`, `MAPS_CRS`, `UPLOADS_DIR`. See `backend/env-no-secret.md` for the full list (without values).
