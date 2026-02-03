# KML Import Test Files

This directory contains example KML files for testing the KML import functionality.

## Test Files

### 1. `test-import.kml` - **Mixed Content (Recommended for Testing)**
- **Contains:** 4 points + 1 polygon
- **Use case:** Tests the full import functionality with mixed geometry types
- **Features:**
  - Entry point with full ExtendedData (matches export format)
  - Climb point (+15) with ExtendedData
  - Simple point with just `<name>` (tests fallback label extraction)
  - Descent point (-10) with minimal ExtendedData
  - One AOI polygon

### 2. `test-points-only.kml` - **Points Only**
- **Contains:** 3 points only
- **Use case:** Tests point import without polygons
- **Features:**
  - Points with ExtendedData
  - Points with just `<name>` element
  - Tests label extraction priority

### 3. `test-polygon-only.kml` - **Polygons Only**
- **Contains:** 2 polygons only
- **Use case:** Tests polygon import and AOI decision modal
- **Features:**
  - Multiple polygons (tests AOI decision when one already exists)
  - Named polygons

### 4. `test-roundtrip.kml` - **Round-Trip Test**
- **Contains:** Points matching exact export format + polyline (for reference)
- **Use case:** Tests round-trip compatibility (export → import → export)
- **Features:**
  - Exact format match with our KML exporter
  - Entry point (גובה כניסה)
  - Climb point (+20)
  - Includes polyline (not imported, but shows full export structure)

## How to Test

1. **Start the application:**
   ```bash
   npm run dev
   ```

2. **Click the "Import KML" button** in the toolbar (upload icon)

3. **Select one of the test files:**
   - Start with `test-import.kml` for full testing
   - Try `test-polygon-only.kml` to test the AOI decision modal
   - Use `test-roundtrip.kml` to verify export/import compatibility

4. **Expected behavior:**
   - File picker opens
   - Summary toast shows: "Detected: X points, Y polygons. Importing..."
   - If AOI exists: Decision modal appears
   - Points are added to the active route
   - Polygon is set as AOI (or added as overlay)
   - Map zooms to imported bounds
   - Success toast: "Imported X points, Y polygons"

## Test Scenarios

### Scenario 1: Fresh Import (No Existing Data)
1. Clear the map (delete all routes/AOI)
2. Import `test-import.kml`
3. **Expected:** 4 points added to route, 1 polygon set as AOI, map zooms

### Scenario 2: AOI Decision Modal
1. Draw or import an AOI polygon first
2. Import `test-polygon-only.kml`
3. **Expected:** Modal appears with "Replace current AOI" / "Add as overlay layer" options

### Scenario 3: Round-Trip Test
1. Export a route with points
2. Import the exported KML file
3. **Expected:** Points appear with correct labels, export again to verify

### Scenario 4: Points Only
1. Import `test-points-only.kml`
2. **Expected:** 3 points added, no AOI decision needed

### Scenario 5: Error Handling
1. Try importing an invalid XML file (rename a .txt to .kml)
2. **Expected:** Error toast: "Invalid KML file"

## Coordinate Reference

All test files use coordinates in the Israel region:
- **Longitude (lng):** ~34.78 (East)
- **Latitude (lat):** ~32.08 (North)

These coordinates are near Tel Aviv, Israel, and should display correctly on most map providers.

## Notes

- All KML files use the standard KML 2.2 namespace
- Points with ExtendedData match the exact format our exporter generates
- Polygons are properly closed (first point == last point)
- Coordinate format: `lon,lat` (longitude first, then latitude)


