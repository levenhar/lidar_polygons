/**
 * Project Serializer
 * 
 * Handles saving and loading complete project snapshots including:
 * - DTM source (local or server) with metadata
 * - Routes, points, and climb points
 * - Settings (general, mission, ascend-descend, display)
 * - Planning area geometry (AOI)
 * - Map camera state (optional)
 */

import { FlightRoute } from '../hooks/useFlightPath';
import { ClimbConfig } from './climb';

// Project format marker for quick identification
export const PROJECT_FORMAT_NAME = 'nehorai';

// Schema version for backwards compatibility
// Version 2: Entry height changed from AGL to ASL
// Version 3: Persist uploaded KML overlays (including raw KML text)
// Version 4: Server DTM persistence stores only server ID + AOI bbox (no clippedId cache reference)
export const PROJECT_SCHEMA_VERSION = 4;

// Project file extension
export const PROJECT_FILE_EXTENSION = '.nehorai';
export const LEGACY_PROJECT_FILE_EXTENSION = '.routeproj';
export const PROJECT_FILE_ACCEPT = `${PROJECT_FILE_EXTENSION},${LEGACY_PROJECT_FILE_EXTENSION}`;

/**
 * Local DTM file descriptor
 * Stores metadata to help identify and validate the original file
 */
export interface LocalDtmDescriptor {
  sourceType: 'local';
  originalFileName: string;
  fileSize: number;
  lastModified: number; // timestamp
  contentHash?: string; // SHA-256 hash if available
  originHint?: string; // File System Access API handle info (optional, not guaranteed)
}

/**
 * Server DTM descriptor
 * Stores stable server reference to re-fetch the DTM
 */
export interface ServerDtmDescriptor {
  sourceType: 'server';
  dtmServerId: string; // The server identifier
  displayName?: string; // For display purposes
  sizeBytes?: number;
  modifiedAt?: string;
  // AOI used to clip the DTM (if applicable). Persisted as bbox for cache-independent restore.
  aoi?: {
    type: 'bbox' | 'polygon'; // 'polygon' kept for backwards compatibility with older files
    bbox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    polygon?: [number, number][]; // [lon, lat] pairs
  };
  clippedId?: string; // Legacy field from older project files (not persisted anymore)
}

export type DtmDescriptor = LocalDtmDescriptor | ServerDtmDescriptor;

/**
 * Planning area geometry (AOI)
 */
export interface PlanningAreaGeometry {
  type: 'bbox' | 'polygon' | 'kml';
  bbox?: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  polygon?: [number, number][]; // [lon, lat] pairs
}

/**
 * Persisted uploaded KML overlay
 */
export interface SavedKmlImport {
  id: string;
  name: string;
  points: Array<{ lng: number; lat: number; label: string }>;
  polygons: Array<{ coordinates: [number, number][]; name?: string }>;
  importedAt: number;
  color: string;
  symbol: 'square' | 'circle' | 'triangle' | 'star' | 'diamond' | 'cross';
  visible: boolean;
  rawKml: string;
}

/**
 * Map camera state (optional)
 */
export interface MapCameraState {
  center: [number, number]; // [lng, lat]
  zoom: number;
  bearing?: number;
  pitch?: number;
}

/**
 * Display settings
 */
export interface DisplaySettings {
  dtmPalette: 'gray' | 'jet';
  dtmInverted: boolean;
  dtmOpacity: number; // 0-1
  showMetadata?: boolean;
  showClimbLabels?: boolean;
  showNextLineSuggestions?: boolean;
}

/**
 * General settings
 */
export interface GeneralSettings {
  nominalFlightHeight: number;
  safetyRadius: number;
  safetyHeight: number;
  outputHeight: number;
}

/**
 * Mission settings
 */
export interface MissionSettings {
  overlapPercentage: number;
  fovDegrees: number;
}

/**
 * Ascend/Descend settings (climb configuration)
 */
export interface AscendDescendSettings {
  selectedPresetId: string;
  climbConfig: ClimbConfig;
}

/**
 * Complete project data structure
 */
export interface ProjectFileData {
  format?: string;
  schemaVersion: number;
  createdAt: string; // ISO 8601 timestamp
  appVersion?: string; // Optional app version
  projectId: string; // UUID
  
  // DTM source
  dtm: DtmDescriptor | null;
  
  // Routes and points
  routes: Array<{
    id: string;
    name: string;
    color: string;
    lineWidth: number;
    visible: boolean;
    points: Array<{
      lng: number;
      lat: number;
      height?: number;
      id?: string;
    }>;
    nominalFlightHeight: number;
    entranceHeightFromFile?: boolean;
  }>;
  activeRouteId: string;
  
  // Climb points by route
  climbRequestsByRoute: Record<string, Array<{
    endDistance: number;
    climbAmount: number;
    anchorPointIdA?: string;
    anchorPointIdB?: string;
    segmentRatio?: number;
  }>>;
  
  // Settings
  general: GeneralSettings;
  mission: MissionSettings;
  ascendDescend: AscendDescendSettings;
  display: DisplaySettings;
  
  // Planning area
  planningArea?: PlanningAreaGeometry;

  // Uploaded KML overlays
  kmlImports: SavedKmlImport[];
  
  // Map camera (optional)
  mapCamera?: MapCameraState;
}

function deriveAoiBbox(
  aoiGeometry?: PlanningAreaGeometry | null
): [number, number, number, number] | undefined {
  if (!aoiGeometry) return undefined;

  if (aoiGeometry.bbox) {
    return [
      aoiGeometry.bbox.minLon,
      aoiGeometry.bbox.minLat,
      aoiGeometry.bbox.maxLon,
      aoiGeometry.bbox.maxLat
    ];
  }

  if (aoiGeometry.polygon && aoiGeometry.polygon.length > 0) {
    const lons = aoiGeometry.polygon.map(([lon]) => lon);
    const lats = aoiGeometry.polygon.map(([, lat]) => lat);
    return [
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats)
    ];
  }

  return undefined;
}

/**
 * Validation error
 */
export class ProjectValidationError extends Error {
  constructor(message: string, public readonly details?: any) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

/**
 * Export project state to ProjectFileData
 */
export function exportProject(params: {
  // DTM
  dtmSource: string | null;
  dtmInfo: { path: string; bounds?: any; clippedId?: string } | null;
  activeClippedId: string | null;
  dtmSourceType: 'local' | 'server' | null;
  localDtmFile?: File | null; // Original file if local
  serverDtmId?: string | null; // Server ID if server
  serverDtmMetadata?: { displayName?: string; sizeBytes?: number; modifiedAt?: string } | null;
  aoiGeometry?: PlanningAreaGeometry | null;
  
  // Routes
  routes: FlightRoute[];
  activeRouteId: string;
  climbRequestsByRoute: Record<string, Array<{ endDistance: number; climbAmount: number; anchorPointIdA?: string; anchorPointIdB?: string; segmentRatio?: number }>>;
  
  // Settings
  general: GeneralSettings;
  mission: MissionSettings;
  ascendDescend: AscendDescendSettings;
  display: DisplaySettings;
  
  // Planning area
  planningArea?: PlanningAreaGeometry;

  // Uploaded KML overlays
  kmlImports?: SavedKmlImport[];
  
  // Map camera (optional)
  mapCamera?: MapCameraState;
}): ProjectFileData {
  const DEFAULT_ROUTE_COLOR = '#ff4d4f';
  const DEFAULT_ROUTE_LINE_WIDTH = 3;

  const { 
    dtmSource, 
    dtmSourceType,
    localDtmFile,
    serverDtmId,
    serverDtmMetadata,
    aoiGeometry,
    routes,
    activeRouteId,
    climbRequestsByRoute,
    general,
    mission,
    ascendDescend,
    display,
    planningArea,
    kmlImports,
    mapCamera
  } = params;
  
  // Build DTM descriptor
  let dtm: DtmDescriptor | null = null;
  
  if (dtmSource && dtmSourceType) {
    if (dtmSourceType === 'local' && localDtmFile) {
      // Local DTM
      dtm = {
        sourceType: 'local',
        originalFileName: localDtmFile.name,
        fileSize: localDtmFile.size,
        lastModified: localDtmFile.lastModified,
        // Note: contentHash would require async hashing, can be added later
        // originHint: can be stored if File System Access API handle is available
      };
    } else if (dtmSourceType === 'server' && serverDtmId) {
      const aoiBbox = deriveAoiBbox(aoiGeometry);
      // Server DTM
      dtm = {
        sourceType: 'server',
        dtmServerId: serverDtmId,
        displayName: serverDtmMetadata?.displayName,
        sizeBytes: serverDtmMetadata?.sizeBytes,
        modifiedAt: serverDtmMetadata?.modifiedAt,
        aoi: aoiBbox ? {
          type: 'bbox',
          bbox: aoiBbox
        } : undefined
      };
    }
  }
  
  // Default entrance height when not set (must match useFlightPath DEFAULT_NOMINAL_FLIGHT_HEIGHT)
  const DEFAULT_NOMINAL_FLIGHT_HEIGHT = 250;

  // Serialize routes (always save entrance height per route for nehorai file)
  const serializedRoutes = routes.map(route => {
    const entranceHeight = Number.isFinite(route.nominalFlightHeight)
      ? route.nominalFlightHeight
      : (Number.isFinite(general?.nominalFlightHeight) ? general.nominalFlightHeight : DEFAULT_NOMINAL_FLIGHT_HEIGHT);
    return {
      id: route.id,
      name: route.name,
      color: route.color || DEFAULT_ROUTE_COLOR,
      lineWidth: Number.isFinite(route.lineWidth) ? route.lineWidth : DEFAULT_ROUTE_LINE_WIDTH,
      visible: route.visible,
      points: route.points.map(p => ({
        lng: p.lng,
        lat: p.lat,
        ...(p.height !== undefined && { height: p.height }),
        ...(p.id && { id: p.id })
      })),
      nominalFlightHeight: entranceHeight,
      ...(route.entranceHeightFromFile && { entranceHeightFromFile: true })
    };
  });
  
  // Serialize climb requests
  const serializedClimbRequests: Record<string, Array<{
    endDistance: number;
    climbAmount: number;
    anchorPointIdA?: string;
    anchorPointIdB?: string;
    segmentRatio?: number;
  }>> = {};
  
  Object.entries(climbRequestsByRoute).forEach(([routeId, requests]) => {
    serializedClimbRequests[routeId] = requests.map(req => ({
      endDistance: req.endDistance,
      climbAmount: req.climbAmount,
      ...(req.anchorPointIdA && { anchorPointIdA: req.anchorPointIdA }),
      ...(req.anchorPointIdB && { anchorPointIdB: req.anchorPointIdB }),
      ...(req.segmentRatio !== undefined && { segmentRatio: req.segmentRatio })
    }));
  });
  
  return {
    format: PROJECT_FORMAT_NAME,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    projectId: generateUUID(),
    dtm,
    routes: serializedRoutes,
    activeRouteId,
    climbRequestsByRoute: serializedClimbRequests,
    general,
    mission,
    ascendDescend,
    display,
    ...(planningArea && { planningArea }),
    kmlImports: (kmlImports || []).map((kml) => ({
      id: kml.id,
      name: kml.name,
      points: kml.points.map((p) => ({ lng: p.lng, lat: p.lat, label: p.label })),
      polygons: kml.polygons.map((poly) => ({
        coordinates: poly.coordinates.map(([lon, lat]) => [lon, lat] as [number, number]),
        ...(poly.name ? { name: poly.name } : {})
      })),
      importedAt: kml.importedAt,
      color: kml.color,
      symbol: kml.symbol,
      visible: kml.visible,
      rawKml: kml.rawKml
    })),
    ...(mapCamera && { mapCamera })
  };
}

/**
 * Validate project file data
 */
export function validateProject(data: any): ProjectFileData {
  if (!data || typeof data !== 'object') {
    throw new ProjectValidationError('Invalid project file: not an object');
  }

  // If format marker is present, ensure we can read it.
  if (typeof data.format !== 'undefined' && data.format !== PROJECT_FORMAT_NAME) {
    throw new ProjectValidationError(`Invalid project file format: expected "${PROJECT_FORMAT_NAME}"`);
  }
  
  if (typeof data.schemaVersion !== 'number') {
    throw new ProjectValidationError('Invalid project file: missing or invalid schemaVersion');
  }
  
  // Check schema version compatibility
  if (data.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new ProjectValidationError(
      `Project file schema version (${data.schemaVersion}) is newer than supported version (${PROJECT_SCHEMA_VERSION}). Please update the application.`
    );
  }
  
  // Migrate if needed (for future versions)
  const migrated = migrateProject(data);
  
  // Validate required fields
  if (!migrated.routes || !Array.isArray(migrated.routes)) {
    throw new ProjectValidationError('Invalid project file: missing or invalid routes');
  }
  
  if (typeof migrated.activeRouteId !== 'string') {
    throw new ProjectValidationError('Invalid project file: missing or invalid activeRouteId');
  }
  
  if (!migrated.general || typeof migrated.general !== 'object') {
    throw new ProjectValidationError('Invalid project file: missing or invalid general settings');
  }
  
  if (!migrated.mission || typeof migrated.mission !== 'object') {
    throw new ProjectValidationError('Invalid project file: missing or invalid mission settings');
  }
  
  if (!migrated.ascendDescend || typeof migrated.ascendDescend !== 'object') {
    throw new ProjectValidationError('Invalid project file: missing or invalid ascend/descend settings');
  }
  
  if (!migrated.display || typeof migrated.display !== 'object') {
    throw new ProjectValidationError('Invalid project file: missing or invalid display settings');
  }

  if (!Array.isArray(migrated.kmlImports)) {
    throw new ProjectValidationError('Invalid project file: missing or invalid kmlImports');
  }
  
  return migrated as ProjectFileData;
}

/**
 * Migrate project data to current schema version
 */
function migrateProject(data: any): any {
  let migrated = { ...data };

  // Older files may not include a format marker.
  if (typeof migrated.format === 'undefined') {
    migrated.format = PROJECT_FORMAT_NAME;
  }
  
  // Migration from v1 to v2: Entry height changed from AGL to ASL
  if (migrated.schemaVersion < 2) {
    // Mark as needing migration - actual conversion requires DTM data
    // which is not available at validation time
    migrated._needsEntryHeightMigration = true;
    migrated.schemaVersion = 2;
    console.log('Project migration: Marked for entry height migration (AGL -> ASL). Conversion will happen when DTM is loaded.');
  }

  // Migration from v2 to v3: persist uploaded KML overlays
  if (migrated.schemaVersion < 3) {
    migrated.kmlImports = Array.isArray(migrated.kmlImports) ? migrated.kmlImports : [];
    migrated.schemaVersion = 3;
  }

  // Migration from v3 to v4:
  // Normalize server AOI persistence to bbox-only and drop stale clippedId cache references.
  if (migrated.schemaVersion < 4) {
    if (migrated?.dtm?.sourceType === 'server') {
      const oldAoi = migrated.dtm.aoi;
      const bboxFromAoi: [number, number, number, number] | undefined =
        Array.isArray(oldAoi?.bbox) && oldAoi.bbox.length === 4
          ? [oldAoi.bbox[0], oldAoi.bbox[1], oldAoi.bbox[2], oldAoi.bbox[3]]
          : Array.isArray(oldAoi?.polygon) && oldAoi.polygon.length > 0
            ? [
                Math.min(...oldAoi.polygon.map((p: [number, number]) => p[0])),
                Math.min(...oldAoi.polygon.map((p: [number, number]) => p[1])),
                Math.max(...oldAoi.polygon.map((p: [number, number]) => p[0])),
                Math.max(...oldAoi.polygon.map((p: [number, number]) => p[1]))
              ]
            : undefined;

      migrated.dtm = {
        ...migrated.dtm,
        aoi: bboxFromAoi ? { type: 'bbox', bbox: bboxFromAoi } : migrated.dtm.aoi,
        clippedId: undefined
      };
    }
    migrated.schemaVersion = 4;
  }

  // Safety net for partially-corrupted files
  if (!Array.isArray(migrated.kmlImports)) {
    migrated.kmlImports = [];
  }

  // Ensure route style fields and per-route entrance height exist for older project files
  const defaultEntranceHeight = 250;
  const generalHeight = Number.isFinite(migrated.general?.nominalFlightHeight)
    ? migrated.general.nominalFlightHeight
    : defaultEntranceHeight;
  if (Array.isArray(migrated.routes)) {
    migrated.routes = migrated.routes.map((route: any) => ({
      ...route,
      color: typeof route?.color === 'string' && route.color.trim() ? route.color : '#ff4d4f',
      lineWidth: Number.isFinite(route?.lineWidth) ? route.lineWidth : 3,
      nominalFlightHeight: Number.isFinite(route?.nominalFlightHeight)
        ? route.nominalFlightHeight
        : generalHeight
    }));
  }
  
  return migrated;
}

/**
 * Generate UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Download project file
 */
export function downloadProjectFile(projectData: ProjectFileData, filename?: string): void {
  const json = JSON.stringify(projectData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `project_${new Date().toISOString().split('T')[0]}${PROJECT_FILE_EXTENSION}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Read project file from File object
 */
export async function readProjectFile(file: File): Promise<ProjectFileData> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    return validateProject(data);
  } catch (error) {
    if (error instanceof ProjectValidationError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ProjectValidationError('Invalid project file: not valid JSON', { originalError: error.message });
    }
    throw new ProjectValidationError('Failed to read project file', { originalError: error });
  }
}

/**
 * Validate local DTM file matches descriptor
 */
export function validateLocalDtmFile(file: File, descriptor: LocalDtmDescriptor): {
  matches: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (file.name !== descriptor.originalFileName) {
    errors.push(`אי התאמה בשם הקובץ: צפוי "${descriptor.originalFileName}", התקבל "${file.name}"`);
  }
  
  if (file.size !== descriptor.fileSize) {
    errors.push(`אי התאמה בגודל הקובץ: צפוי ${descriptor.fileSize} בתים, התקבל ${file.size} בתים`);
  }
  
  if (file.lastModified !== descriptor.lastModified) {
    errors.push(`אי התאמה במועד השינוי: צפוי ${new Date(descriptor.lastModified).toISOString()}, התקבל ${new Date(file.lastModified).toISOString()}`);
  }
  
  // Note: Content hash validation would require async hashing
  // Can be added later if needed
  
  return {
    matches: errors.length === 0,
    errors
  };
}

