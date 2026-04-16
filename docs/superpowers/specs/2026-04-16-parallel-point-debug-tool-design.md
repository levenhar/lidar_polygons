# Design: Parallel Point Debug Tool

**Date:** 2026-04-16  
**Status:** Approved

## Overview

Add a new toggle tool to the "מתקדם" (Advanced) control group. When active, hovering over the route line on the map shows — in addition to the existing elevation profile sync — a visual overlay indicating:

1. The **parallel point** (the nearest point on the adjacent parallel flight line, as computed by the Python safety algorithm)
2. A **dashed line** connecting the hovered point to its parallel point(s)

This visualizes the safety corridor that the backend uses to compute `minElevation` for each profile point.

---

## Constraint

The Python safety algorithm functions in `backend_python/safety.py` must **not be changed** — specifically `find_parallel_points`, `min_value_in_buffer`, and `min_height_between_points`.

---

## Data Flow

### Backend (`backend_python/main.py`)

Add `parallel_points` to the serialized columns returned by the `/elevation-profile` endpoint:

```python
# Before
cols = ["distance", "elevation", "longitude", "latitude", "minElevation", "maxElevation"]

# After
cols = ["distance", "elevation", "longitude", "latitude", "minElevation", "maxElevation", "parallel_points"]
```

`parallel_points` is already a column on `profile_df` (a list of integer indices per row). It serializes cleanly to JSON as an array of integers. No logic change required.

### Frontend Types (`src/App.tsx`)

Add optional field to `ElevationPoint`:

```ts
interface ElevationPoint {
  // ... existing fields
  parallelPoints?: number[];  // indices into the elevationProfile array
}
```

### `useElevationProfile.ts`

When mapping the API response to `ElevationPoint[]`, read `point.parallel_points` and store it as `parallelPoints`.

---

## UI

### Toggle Button

- **Location:** "מתקדם" control group in `MapPanel.tsx`, alongside rotate/viewshed/height-limit/reverse buttons
- **Icon:** existing icon (e.g. `"link"` or `"safety"` — pick whichever is available)
- **State name:** `isParallelDebugMode`
- **Disabled when:** DTM not loaded, fewer than 2 flight path points, or elevation profile is empty
- **Tooltip (off):** `"הצג קשרי בטיחות"` / **Tooltip (on):** `"כבה קשרי בטיחות"`
- **Activation:** disables other exclusive modes (rotate, drawing, measurement modes) — same pattern as `isRotateMode`

### Hover Behavior (tool ON)

Triggered by the existing `handlePathMouseMove` in `MapPanel.tsx`, which already computes `hoveredDistance`:

1. Find the nearest `ElevationPoint` in `elevationProfile` by matching `distance` field (pick the point with smallest `|point.distance - hoveredDistance|`)
2. Read `parallelPoints` from that profile point
3. For each parallel index in `parallelPoints`:
   - Look up `elevationProfile[index].latitude` / `elevationProfile[index].longitude`
   - Render a **circle marker** at that location (distinct color, e.g. orange `#f97316`, radius 6px)
   - Render a **dashed polyline** from the hovered map position to the parallel point
4. Store the Leaflet layers in a ref (`parallelDebugLayersRef`) for cleanup

### Mouse Leave

Clear all layers in `parallelDebugLayersRef` from the map.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Hovered point has no parallel points (empty array) | No overlay rendered |
| Point has 2 parallel points (left + right) | Both markers and both lines rendered |
| Tool toggled off while hovering | Overlays cleared immediately |
| Elevation profile reloaded | Overlays cleared; toggle state preserved |
| Route cleared | Toggle reset to off (same as `setIsInfoMode(false)` pattern) |

---

## Out of Scope

- No keyboard shortcut (button-only toggle)
- No entry needed in "מקשי קיצור" tab (no shortcut assigned)
- No change to the elevation profile chart rendering
- No "exact lowest point location" marker (option A chosen — the dashed line implies the corridor)
