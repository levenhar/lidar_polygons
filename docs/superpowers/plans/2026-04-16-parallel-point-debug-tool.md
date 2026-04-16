# Parallel Point Debug Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggle button to the "מתקדם" panel that, when active, shows the nearest parallel safety point and a connecting line on the map whenever the user hovers the route line.

**Architecture:** The Python backend already computes `parallel_points` (indices of adjacent-line neighbours) but doesn't include them in the API response. We add one column to the serialized output. The frontend stores the indices on `ElevationPoint`, then on hover finds the nearest profile point by distance and renders a Leaflet circle-marker + polyline for each parallel index.

**Tech Stack:** Python/FastAPI (`backend_python/main.py`), TypeScript/React (`frontend/src`), Leaflet for map overlays.

---

## File Map

| File | Change |
|---|---|
| `backend_python/main.py` | Add `"parallel_points"` to serialized cols (line 837) |
| `frontend/src/App.tsx` | Add `parallelPoints?: number[]` to `ElevationPoint` interface |
| `frontend/src/hooks/useElevationProfile.ts` | Map `point.parallel_points` → `parallelPoints` |
| `frontend/src/hooks/useElevationProfile.test.ts` | Add test for `parallelPoints` field |
| `frontend/src/components/MapPanel.tsx` | Toggle state + button + hover overlay rendering |

---

## Task 1: Backend — expose `parallel_points` in API response

**Files:**
- Modify: `backend_python/main.py:837`

- [ ] **Step 1: Edit the cols list**

In `backend_python/main.py`, find the line (currently line 837):

```python
cols = ["distance", "elevation", "longitude", "latitude", "minElevation", "maxElevation"]
```

Change it to:

```python
cols = ["distance", "elevation", "longitude", "latitude", "minElevation", "maxElevation", "parallel_points"]
```

`parallel_points` is already a column on `profile_df` (a Python list of integer indices per row). `to_dict(orient="records")` serializes it as a JSON array of integers automatically.

- [ ] **Step 2: Verify serialization manually**

Start the Python backend and call the elevation-profile endpoint for a route with at least two parallel lines. Confirm that each element in the `profile` array now contains a `parallel_points` field, e.g.:

```json
{ "distance": 0, "elevation": 120.5, ..., "parallel_points": [47] }
```

Points with no neighbour should have `parallel_points: []`.

- [ ] **Step 3: Commit**

```bash
git add backend_python/main.py
git commit -m "feat: expose parallel_points in elevation-profile API response"
```

---

## Task 2: Frontend type — add `parallelPoints` to `ElevationPoint`

**Files:**
- Modify: `frontend/src/App.tsx:50-61`

- [ ] **Step 1: Extend the interface**

In `frontend/src/App.tsx`, find the `ElevationPoint` interface (lines 50–61):

```ts
export interface ElevationPoint {
  distance: number;
  elevation: number;
  longitude: number;
  latitude: number;
  flightHeight?: number;
  minElevation?: number;
  maxElevation?: number;
  plannedAltitude?: number;
  baseAltitude?: number;
  climbDelta?: number;
}
```

Add `parallelPoints` as the last optional field:

```ts
export interface ElevationPoint {
  distance: number;
  elevation: number;
  longitude: number;
  latitude: number;
  flightHeight?: number;
  minElevation?: number;
  maxElevation?: number;
  plannedAltitude?: number;
  baseAltitude?: number;
  climbDelta?: number;
  parallelPoints?: number[];  // indices into elevationProfile for adjacent parallel line points
}
```

- [ ] **Step 2: Run build to confirm no type errors**

```bash
cd frontend && npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: add parallelPoints field to ElevationPoint interface"
```

---

## Task 3: Hook — parse `parallel_points` from API response

**Files:**
- Modify: `frontend/src/hooks/useElevationProfile.ts:188-200`
- Modify: `frontend/src/hooks/useElevationProfile.test.ts`

- [ ] **Step 1: Write a failing test**

In `frontend/src/hooks/useElevationProfile.test.ts`, add inside the `describe('useElevationProfile')` block (after the existing `calculateProfile with valid path calls API...` test):

```ts
it('calculateProfile stores parallelPoints from API response', async () => {
  const mockProfile = [
    { distance: 0, elevation: 100, longitude: 34.5, latitude: 31.2, minElevation: 98, maxElevation: 102, parallel_points: [1] },
    { distance: 100, elevation: 105, longitude: 34.6, latitude: 31.2, minElevation: 103, maxElevation: 107, parallel_points: [] }
  ];
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { ready: true, profile: mockProfile } });

  const { result } = renderHook(() => useElevationProfile());
  await act(async () => {
    await result.current.calculateProfile(
      [{ lng: 34.5, lat: 31.2 }, { lng: 34.6, lat: 31.2 }],
      '/some/dtm',
      250,
      50
    );
  });

  expect(result.current.elevationProfile[0].parallelPoints).toEqual([1]);
  expect(result.current.elevationProfile[1].parallelPoints).toEqual([]);
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd frontend && npm test -- useElevationProfile --run
```

Expected: FAIL — `parallelPoints` is `undefined`.

- [ ] **Step 3: Implement the mapping**

In `frontend/src/hooks/useElevationProfile.ts`, update the profile mapping (lines 191–199). Add `parallelPoints` after `maxElevation`:

```ts
return {
  distance,
  elevation: point.elevation,
  longitude: point.longitude,
  latitude: point.latitude,
  flightHeight: interpolateFlightHeight(distance),
  minElevation: point.minElevation,
  maxElevation: point.maxElevation,
  parallelPoints: Array.isArray(point.parallel_points) ? point.parallel_points : undefined,
};
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd frontend && npm test -- useElevationProfile --run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useElevationProfile.ts frontend/src/hooks/useElevationProfile.test.ts
git commit -m "feat: parse parallelPoints from elevation-profile API response"
```

---

## Task 4: MapPanel — toggle state and button

**Files:**
- Modify: `frontend/src/components/MapPanel.tsx`

- [ ] **Step 1: Add state**

In `MapPanel.tsx`, find the `isRotateMode` state declaration (around line 1042):

```ts
const [isRotateMode, setIsRotateMode] = useState<boolean>(false);
```

Add directly below it:

```ts
const [isParallelDebugMode, setIsParallelDebugMode] = useState<boolean>(false);
```

- [ ] **Step 2: Reset in `deactivateAllMeasurementModes`**

Find `deactivateAllMeasurementModes` (around line 8022). It currently calls `setIsInfoMode(false)`, `setIsCoordMode(false)`, etc. Add `setIsParallelDebugMode(false)` to the list:

```ts
const deactivateAllMeasurementModes = useCallback(() => {
  setIsInfoMode(false);
  setIsCoordMode(false);
  setIsMeasureLengthMode(false);
  setIsAzimuthMode(false);
  setIsParallelDebugMode(false);   // ← add this line
  setCoordModePos(null);
  setCursorElevation(null);
  setMousePos(null);
  setMeasurePoint1(null);
  setMeasureResult(null);
  // ... rest of the function unchanged
```

- [ ] **Step 3: Reset when route is cleared**

Search for `setIsInfoMode(false)` at the point where the route is cleared (around line 8023, there's a `useEffect` that fires when `!dtmSource || !dtmLoaded`). Wherever `setIsInfoMode(false)` is called in that context, also call `setIsParallelDebugMode(false)`.

Find this block (around line 5074–5078):

```ts
useEffect(() => {
  if (!dtmSource || !dtmLoaded) {
    setIsInfoMode(false);
    setCursorElevation(null);
    setMousePos(null);
```

Add `setIsParallelDebugMode(false)` right after `setIsInfoMode(false)`:

```ts
useEffect(() => {
  if (!dtmSource || !dtmLoaded) {
    setIsInfoMode(false);
    setIsParallelDebugMode(false);   // ← add this line
    setCursorElevation(null);
    setMousePos(null);
```

- [ ] **Step 4: Add toggle button to "מתקדם" group**

Find the "מתקדם" control group (around line 9720). Inside it, after the existing four buttons (rotate, viewshed, height-limit, reverse), add a new button before the closing `</div>` tags:

```tsx
<Tooltip tooltip={isParallelDebugMode ? 'כבה קשרי בטיחות' : 'הצג קשרי בטיחות'}>
  <button
    onClick={() => {
      const next = !isParallelDebugMode;
      setIsParallelDebugMode(next);
      if (next) {
        setIsRotateMode(false);
        setIsDrawing(false);
        setIsParallelLineMode(false);
        deactivateAllMeasurementModes();
        setIsParallelDebugMode(true); // deactivateAllMeasurementModes clears it, re-set
      }
    }}
    className={isParallelDebugMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
    aria-label={isParallelDebugMode ? 'כבה קשרי בטיחות' : 'הצג קשרי בטיחות'}
    type="button"
    disabled={!dtmLoaded || flightPath.length < 2 || elevationProfile.length === 0}
  >
    <Icon name="parallel" />
    <span className="sr-only">{isParallelDebugMode ? 'כבה קשרי בטיחות' : 'הצג קשרי בטיחות'}</span>
  </button>
</Tooltip>
```

> Note: `deactivateAllMeasurementModes` now includes `setIsParallelDebugMode(false)`, so we must re-set it to `true` immediately after when turning the tool ON.

- [ ] **Step 5: Run build to confirm no type errors**

```bash
cd frontend && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/MapPanel.tsx
git commit -m "feat: add parallel debug mode toggle to advanced tools panel"
```

---

## Task 5: MapPanel — render parallel overlay on hover

**Files:**
- Modify: `frontend/src/components/MapPanel.tsx`

- [ ] **Step 1: Add overlay layer ref**

Near the top of the MapPanel component, in the block where other Leaflet layer refs are declared, add:

```ts
const parallelDebugLayersRef = useRef<L.Layer[]>([]);
```

Search for an existing layer ref as anchor, e.g. `const flightPathClickableLineRef` or `const markerLayerGroupRef`, and add the new ref adjacent to it.

- [ ] **Step 2: Add a helper to clear overlay layers**

Find `deactivateAllMeasurementModes` (around line 8022). After the state resets but before the end of the function, add the layer cleanup (the ref will be accessible via closure):

Actually, add a dedicated `clearParallelDebugLayers` helper right before `deactivateAllMeasurementModes`:

```ts
const clearParallelDebugLayers = useCallback(() => {
  parallelDebugLayersRef.current.forEach(layer => {
    if (map.current) map.current.removeLayer(layer);
  });
  parallelDebugLayersRef.current = [];
}, []);
```

And call it inside `deactivateAllMeasurementModes` (after `setIsParallelDebugMode(false)`):

```ts
const deactivateAllMeasurementModes = useCallback(() => {
  setIsInfoMode(false);
  setIsCoordMode(false);
  setIsMeasureLengthMode(false);
  setIsAzimuthMode(false);
  setIsParallelDebugMode(false);
  clearParallelDebugLayers();   // ← add this
  // ... rest unchanged
```

- [ ] **Step 3: Render overlay in `handlePathMouseMove`**

Find `handlePathMouseMove` in MapPanel.tsx (around line 5634). It ends with:

```ts
setMousePos({ x: (e as any).originalEvent.clientX, y: (e as any).originalEvent.clientY });
onPathPointHover(bestPoint, hoveredDistance);
```

Add the parallel debug overlay rendering immediately before `onPathPointHover`:

```ts
// Parallel debug overlay
if (isParallelDebugMode && map.current) {
  clearParallelDebugLayers();

  // Find nearest profile point by cumulative distance
  let nearestPoint: ElevationPoint | null = null;
  let minDiff = Infinity;
  for (const pt of elevationProfile) {
    const diff = Math.abs(pt.distance - hoveredDistance);
    if (diff < minDiff) {
      minDiff = diff;
      nearestPoint = pt;
    }
  }

  if (nearestPoint?.parallelPoints && nearestPoint.parallelPoints.length > 0) {
    for (const idx of nearestPoint.parallelPoints) {
      const parallelPt = elevationProfile[idx];
      if (!parallelPt) continue;

      // Circle marker at parallel point
      const marker = L.circleMarker(
        [parallelPt.latitude, parallelPt.longitude],
        { radius: 7, color: '#f97316', fillColor: '#f97316', fillOpacity: 0.85, weight: 2 }
      ).addTo(map.current);

      // Dashed line from hovered position to parallel point
      const line = L.polyline(
        [
          [bestPoint.lat, bestPoint.lng],
          [parallelPt.latitude, parallelPt.longitude]
        ],
        { color: '#f97316', weight: 2, dashArray: '6 4', opacity: 0.8 }
      ).addTo(map.current);

      parallelDebugLayersRef.current.push(marker, line);
    }
  }
}

setMousePos({ x: (e as any).originalEvent.clientX, y: (e as any).originalEvent.clientY });
onPathPointHover(bestPoint, hoveredDistance);
```

> `ElevationPoint` is already imported from `'../App'` via the MapPanel props type. `elevationProfile` is the prop passed in to MapPanel. Confirm the exact prop name by searching for `elevationProfile` in the MapPanel props interface.

- [ ] **Step 4: Clear overlay on mouse leave**

Find the `handleMouseLeave` callback (around line 4031):

```ts
const handleMouseLeave = () => {
  setMousePos(null);
  if (hoverSource === 'map') {
    onPathPointHover(null);
  }
  if (isInfoMode) {
    setCursorElevation(null);
  }
};
```

Add the overlay clear:

```ts
const handleMouseLeave = () => {
  setMousePos(null);
  if (hoverSource === 'map') {
    onPathPointHover(null);
  }
  if (isInfoMode) {
    setCursorElevation(null);
  }
  clearParallelDebugLayers();   // ← add this
};
```

- [ ] **Step 5: Run build**

```bash
cd frontend && npm run build
```

Expected: Build succeeds with no TypeScript errors. Resolve any type issues (e.g. ensure `ElevationPoint` is imported in MapPanel scope).

- [ ] **Step 6: Run all tests**

```bash
cd frontend && npm test --run
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/MapPanel.tsx
git commit -m "feat: render parallel safety overlay on map hover in debug mode"
```

---

## Task 6: Smoke test the feature end-to-end

- [ ] **Step 1: Start dev environment**

```bash
# Terminal 1 — Node backend
cd backend && npm start

# Terminal 2 — Python backend
cd backend_python && python main.py

# Terminal 3 — Frontend
cd frontend && npm run dev
```

- [ ] **Step 2: Load a DTM and draw a multi-segment route**

Draw at least two roughly parallel flight lines so the safety algorithm has adjacent lines to pair up.

- [ ] **Step 3: Enable the toggle**

Click the "הצג קשרי בטיחות" button in the "מתקדם" panel. Verify it highlights (btn-primary style).

- [ ] **Step 4: Hover the route line**

Move the mouse slowly along one of the lines. Verify:
- An orange circle marker appears at the corresponding parallel-line point
- An orange dashed line connects the hovered position to that marker
- Both disappear when the cursor leaves the route

- [ ] **Step 5: Toggle off**

Click the button again. Verify the overlay is immediately removed and the button returns to btn-tertiary style.

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "chore: verify parallel debug tool smoke test complete"
```
