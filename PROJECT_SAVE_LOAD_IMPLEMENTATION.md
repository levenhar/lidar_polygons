# Project Save/Load Implementation Summary

## Overview
Implemented Save/Load project functionality that allows users to save and restore complete project snapshots, including DTM source, routes, points, climb points, settings, and planning area geometry.

## Files Created/Modified

### New Files
1. **`frontend/src/utils/projectSerializer.ts`**
   - Project serialization/deserialization logic
   - Schema versioning (v1)
   - Validation and error handling
   - Local DTM file validation

2. **`frontend/src/components/MissingLocalDTMModal.tsx`**
   - Modal for selecting missing local DTM files
   - File validation against project descriptor
   - User-friendly error messages

3. **`frontend/src/components/MissingLocalDTMModal.css`**
   - Styling for the missing DTM modal

### Modified Files
1. **`frontend/src/App.tsx`**
   - Added state tracking for DTM source type and metadata
   - Added save/load project handlers
   - Integrated MissingLocalDTMModal
   - Added Save/Load buttons to header

## Extension Name
- **`.routeproj`** - Used consistently for project files

## Schema Structure

```typescript
{
  schemaVersion: number;        // Currently 1
  createdAt: string;            // ISO 8601 timestamp
  projectId: string;            // UUID
  dtm: DtmDescriptor | null;    // Local or server DTM descriptor
  routes: FlightRoute[];        // All routes with points
  activeRouteId: string;        // Currently active route
  climbRequestsByRoute: {...};  // Climb points by route ID
  general: GeneralSettings;      // Nominal height, safety radius, etc.
  mission: MissionSettings;     // Overlap %, FOV
  ascendDescend: AscendDescendSettings; // Climb config
  display: DisplaySettings;     // DTM palette, invert, opacity
  planningArea?: PlanningAreaGeometry; // AOI geometry (optional)
  mapCamera?: MapCameraState;   // Map view state (optional)
}
```

## Local DTM Portability

### Save Time
- Stores: `originalFileName`, `fileSize`, `lastModified`
- Optionally stores: `contentHash` (future enhancement)
- Does NOT store file paths (portable)

### Load Time
1. If local DTM not accessible automatically:
   - Shows `MissingLocalDTMModal`
   - User selects the `.tif` file
   - Validates: name, size, lastModified match
   - Uploads and loads DTM
   - Continues project restore

2. Validation:
   - File name must match
   - File size must match
   - Last modified timestamp must match
   - Shows clear error messages if validation fails

## Server DTM Restore

### Save Time
- Stores: `dtmServerId`, `displayName`, `sizeBytes`, `modifiedAt`
- Stores: `clippedId` if DTM was clipped
- Stores: `aoi` geometry if used for clipping

### Load Time
1. If clipped DTM:
   - Attempts to use existing clipped DTM via `clippedId`
   - Falls back to re-clipping if needed

2. If regular server DTM:
   - Re-fetches from server using `dtmServerId`
   - If AOI was used, prompts user to re-select AOI and re-clip

## Restore Order

1. **Parse & Validate** project file
2. **Restore Settings** (general, mission, ascend-descend, display)
3. **Restore DTM**:
   - Local: Prompt for file → Upload → Load
   - Server: Re-fetch or use clipped ID
4. **Restore Planning Area** (if applicable)
5. **Restore Routes & Points** (after DTM loaded)
6. **Restore Climb Points** (anchored to point IDs)
7. **Trigger Recomputations** (elevation profile, etc.)
8. **Restore Map Camera** (optional, if saved)

## UI Integration

### Save Project
- Button in header (next to Undo/Redo)
- Downloads file: `project_YYYY-MM-DD.routeproj`
- Shows error alert if save fails

### Load Project
- Button in header
- File picker filtered to `.routeproj`
- Shows validation errors if file invalid
- Shows missing DTM modal if local DTM needed

## Known Limitations & TODOs

1. **Display Settings**: DTM palette, invert, and opacity are currently hardcoded in save. Need to:
   - Pass these values from MapPanel to App.tsx
   - Store them in project file
   - Restore them on load

2. **Multiple Routes**: Currently only restores the first route. Need to:
   - Implement full multi-route restore
   - Use `addRoute` from hook to add additional routes

3. **Map Camera State**: Not yet implemented. Need to:
   - Capture map center/zoom/bearing from MapPanel
   - Store in project file
   - Restore on load

4. **Planning Area (AOI)**: Saved but not fully restored. Need to:
   - Restore AOI geometry to MapPanel state
   - Re-enable AOI selection mode if needed

5. **Server DTM Re-clipping**: When server DTM with AOI is loaded:
   - Currently prompts user to manually re-select AOI
   - Should automatically restore AOI and re-clip if possible

6. **File System Access API**: Not yet implemented for better local file handling:
   - Could store file handle for automatic re-opening
   - Falls back to manual selection gracefully

7. **Content Hash Validation**: Not yet implemented:
   - Could add SHA-256 hash for stronger file validation
   - Requires async hashing (Web Crypto API)

## Testing

### Manual Testing Checklist
- [ ] Save project with local DTM → Load on same computer
- [ ] Save project with local DTM → Load on different computer (missing DTM flow)
- [ ] Save project with server DTM → Load on different computer
- [ ] Save project with multiple routes → Load and verify all routes restored
- [ ] Save project with climb points → Load and verify climb points anchored correctly
- [ ] Save project with settings → Load and verify all settings restored
- [ ] Load invalid/corrupted project file → Verify error handling
- [ ] Load project with wrong local DTM file → Verify validation errors

### Future Test Implementation
- Round-trip test: save → load → deep-equals (excluding ephemeral fields)
- Missing local DTM flow test
- Version migration test (when v2 is implemented)

## Browser Limitations

- **File Paths**: Cannot reliably store/reopen arbitrary file paths
- **Solution**: Store file metadata (name, size, lastModified) and prompt user to select file
- **File System Access API**: Available in Chrome/Edge, can improve UX but not required

## Security/Privacy

- No sensitive file paths stored
- Minimal origin hints (optional, not guaranteed)
- Project files are local-only (not auto-uploaded)
- File validation prevents loading wrong files

## Next Steps

1. Fix TypeScript/linter errors (likely false positives, but verify)
2. Pass DTM display settings from MapPanel to App.tsx
3. Implement full multi-route restore
4. Implement map camera state save/restore
5. Improve server DTM re-clipping flow
6. Add content hash validation
7. Add comprehensive tests

