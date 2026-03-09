import React, { useState, useCallback, useEffect } from 'react';
import MapPanel from './components/MapPanel';
import ElevationProfile from './components/ElevationProfile';
import ExportSettingsModal from './components/ExportSettingsModal';
import SettingsModal, { GearIcon } from './components/SettingsModal';
import AnchorPointWarningModal from './components/AnchorPointWarningModal';
import ReverseWarningModal from './components/ReverseWarningModal';
import MissingLocalDTMModal from './components/MissingLocalDTMModal';
import SaveFileDialog from './components/SaveFileDialog';
import SuccessNotification from './components/SuccessNotification';
import { generateUniqueFilenames } from './utils/filenameSanitizer';
import SplitPane from './components/SplitPane';
import { useFlightPath, FlightRoute } from './hooks/useFlightPath';
import { useElevationProfile } from './hooks/useElevationProfile';
import { ClimbConfig, BaseAltitudeSample, ClimbProfilePoint, ClimbPreset, computeClimbProfile } from './utils/climb';
import climbPresetData from './config/climbPresets.json';
import { GlobalUndoRedoProvider, useGlobalUndoRedo } from './contexts/GlobalUndoRedoContext';
import { findClimbsAnchoredToPoint, ClimbRequest, getClimbPositionFromAnchors, findAnchorPointsForClimb, removeClimbsOnSegment, getEffectiveEndDistance } from './utils/climbAnchors';
import { computeCumulativeDistances } from './utils/constraints';
import { 
  exportProject, 
  readProjectFile, 
  PROJECT_FILE_ACCEPT,
  PROJECT_FILE_EXTENSION,
  LocalDtmDescriptor,
  ProjectFileData,
  ProjectValidationError
} from './utils/projectSerializer';
import { generateKMLForRoute } from './utils/kmlGenerator';
import { debug } from './utils/debug';
import { importKmlFile } from './utils/importKmlFlow';
import KmlManagerModal, { KmlImport } from './components/KmlManagerModal';
import { calculateDistance } from './utils/geometry';
import './App.css';

export interface Coordinate {
  lng: number;
  lat: number;
  height?: number; // Optional flight height in meters (ASL - Above Sea Level)
  id?: string; // Stable ID for the point (used to anchor climb points)
}

export interface ElevationPoint {
  distance: number;
  elevation: number;
  longitude: number;
  latitude: number;
  flightHeight?: number; // Interpolated flight height (AGL - computed as plannedAltitude - elevation) at this point
  minElevation?: number; // Minimum elevation in DTM within radius
  maxElevation?: number; // Maximum elevation in DTM within radius
  plannedAltitude?: number;
  baseAltitude?: number;
  climbDelta?: number;
}

interface DTMInfo {
  path: string;
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  clippedId?: string;
}

const CLIMB_PRESETS = climbPresetData as ClimbPreset[];

const FALLBACK_CLIMB_CONFIG: ClimbConfig = {
  climbRatio: 4.08,
  descentRatio: 8.16,
  allowTurnsDuringClimb: false,
  linkRatios: false,
  vertexProximityMeters: 30,
  minClimb: 11,
  maxClimb: 50
};

function presetToConfig(preset?: ClimbPreset): ClimbConfig {
  const source = preset ?? FALLBACK_CLIMB_CONFIG;
  return {
    climbRatio: source.climbRatio,
    descentRatio: source.descentRatio,
    allowTurnsDuringClimb: source.allowTurnsDuringClimb,
    linkRatios: source.linkRatios,
    vertexProximityMeters: source.vertexProximityMeters,
    minClimb: source.minClimb ?? FALLBACK_CLIMB_CONFIG.minClimb,
    maxClimb: source.maxClimb ?? FALLBACK_CLIMB_CONFIG.maxClimb
  };
}

function AppContent() {
  // Get global undo/redo manager
  const globalUndoRedo = useGlobalUndoRedo();
  
  const [dtmSource, setDtmSource] = useState<string | null>(null);
  // @ts-ignore
  const [dtmInfo, setDtmInfo] = useState<DTMInfo | null>(null);
  const [activeClippedId, setActiveClippedId] = useState<string | null>(null);
  // Track original DTM file/metadata for project save/load
  const [localDtmFile, setLocalDtmFile] = useState<File | null>(null);
  const [dtmSourceType, setDtmSourceType] = useState<'local' | 'server' | null>(null);
  const [serverDtmId, setServerDtmId] = useState<string | null>(null);
  const [serverDtmMetadata, setServerDtmMetadata] = useState<{ displayName?: string; sizeBytes?: number; modifiedAt?: string } | null>(null);
  const [activeDtmName, setActiveDtmName] = useState<string | null>(null);
  const [aoiGeometry, setAoiGeometry] = useState<{ type: 'bbox' | 'polygon' | 'kml'; bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number }; polygon?: [number, number][] } | null>(null);
  // Project load state
  const [missingLocalDtmModal, setMissingLocalDtmModal] = useState<{ isOpen: boolean; descriptor: LocalDtmDescriptor | null }>({ isOpen: false, descriptor: null });
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [safetyHeight, setSafetyHeight] = useState<number>(140);
  const [resolutionHeight, setResolutionHeight] = useState<number>(270);
  const [safetySearchRadius, setSafetySearchRadius] = useState<number>(50);
  const resolutionSearchRadius = 50;
  const [overlapPercentage, setOverlapPercentage] = useState<number>(50);
  const [fovDegrees, setFovDegrees] = useState<number>(75);
  const [selectedPoint, setSelectedPoint] = useState<Coordinate | null>(null);
  const [editPointIndex, setEditPointIndex] = useState<number | null>(null);
  const [hoveredElevationPoint, setHoveredElevationPoint] = useState<ElevationPoint | null>(null);
  const [hoverSource, setHoverSource] = useState<'map' | 'profile' | 'overlap' | null>(null);
  const [showMetadata, setShowMetadata] = useState(true);
  const [showClimbLabels, setShowClimbLabels] = useState(true);
  const [showNextLineSuggestions, setShowNextLineSuggestions] = useState<boolean>(() => {
    // Load from localStorage on mount, default to true
    try {
      const stored = localStorage.getItem('showNextLineSuggestions');
      return stored !== null ? JSON.parse(stored) : true;
    } catch {
      return true;
    }
  });
  // DTM display settings (will be passed from MapPanel)
  const [dtmDisplaySettings, setDtmDisplaySettings] = useState<{
    palette: 'gray' | 'jet';
    inverted: boolean;
    opacity: number;
  }>({
    palette: 'gray',
    inverted: false,
    opacity: 0.1
  });

  const [selectedClimbPresetId, setSelectedClimbPresetId] = useState<string>(CLIMB_PRESETS[0]?.id ?? 'custom');
  const [climbConfig, setClimbConfig] = useState<ClimbConfig>(presetToConfig(CLIMB_PRESETS[0]));
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [flightHeightModal, setFlightHeightModal] = useState<{ isOpen: boolean; pointIndex: number; currentHeight: number } | null>(null);
  const [saveFileDialog, setSaveFileDialog] = useState<{
    isOpen: boolean;
    type: 'kml' | 'project';
    defaultFilename: string;
    fileContent: string | Blob;
    mimeType?: string;
    onSave?: (filename: string) => void; // Optional legacy callback
  } | null>(null);
  const [flightHeightInput, setFlightHeightInput] = useState<string>('');
  const [flightHeightError, setFlightHeightError] = useState<string | null>(null);
  const [successNotification, setSuccessNotification] = useState<{
    isOpen: boolean;
    message: string;
  }>({ isOpen: false, message: '' });
  const [importSummary, setImportSummary] = useState<{ points: number; polygons: number } | null>(null);
  const [zoomToBounds, setZoomToBounds] = useState<{ minLon: number; minLat: number; maxLon: number; maxLat: number } | null>(null);
  const [kmlImports, setKmlImports] = useState<KmlImport[]>([]);
  const [kmlManagerModalOpen, setKmlManagerModalOpen] = useState(false);
  
  // Queue system for height profile edits
  type EditOperation = 
    | { type: 'delete'; index: number }
    | { type: 'update'; index: number; point: Coordinate }
    | { type: 'setFlightHeight'; index: number; height: number }
    | { type: 'editPointRequest'; index: number };
  
  const [editQueue, setEditQueue] = useState<EditOperation[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState<boolean>(false);
  const processingTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  
  // Load climb requests from localStorage on mount
  const loadClimbRequestsFromStorage = React.useCallback(() => {
    try {
      const stored = localStorage.getItem('climbRequestsByRoute');
      if (stored) {
        return JSON.parse(stored) as Record<string, { endDistance: number; climbAmount: number }[]>;
      }
    } catch (error) {
      debug.error('Failed to load climb requests from localStorage:', error);
    }
    return {};
  }, []);
  
  // Track operation type to distinguish inserts from edits/deletes
  const isInsertOperationRef = React.useRef<boolean>(false);
  
  // Initialize with climb requests from localStorage
  const initialClimbRequestsByRoute = React.useMemo(() => loadClimbRequestsFromStorage(), [loadClimbRequestsFromStorage]);

  // @ts-ignore
  const {
    routes,
    activeRouteId,
    flightPath,
    nominalFlightHeight,
    setNominalFlightHeight,
    setRouteNominalFlightHeight,
    setRouteColor,
    setRouteLineWidth,
    climbRequestsByRoute,
    addRoute,
    setActiveRoute,
    renameRoute,
    toggleRouteVisibility,
    deleteRoute,
    showAllRoutes,
    hideNonActiveRoutes,
    addPoint,
    addPoints,
    updatePoint,
    deletePoint,
    insertPoints,
    setFlightPath,
    reverseFlightPath,
    resetToSingleRoute,
    importKML,
    importRoutes,
    setClimbRequestsByRoute,
    syncClimbRequestsByRoute,
    // Local undo/redo are registered with globalUndoRedo and called through it
    undo: _undo,
    redo: _redo,
    canUndo: _canUndo,
    canRedo: _canRedo
  } = useFlightPath({
    initialClimbRequestsByRoute,
    registerGlobalAction: globalUndoRedo.registerAction
  });
  
  // Save climb requests to localStorage whenever they change
  React.useEffect(() => {
    try {
      localStorage.setItem('climbRequestsByRoute', JSON.stringify(climbRequestsByRoute));
    } catch (error) {
      debug.error('Failed to save climb requests to localStorage:', error);
    }
  }, [climbRequestsByRoute]);

  // Save showNextLineSuggestions to localStorage whenever it changes
  React.useEffect(() => {
    try {
      localStorage.setItem('showNextLineSuggestions', JSON.stringify(showNextLineSuggestions));
    } catch (error) {
      debug.error('Failed to save showNextLineSuggestions to localStorage:', error);
    }
  }, [showNextLineSuggestions]);
  
  // Wrap insertPoints to mark it as an insert operation
  const insertPointsWrapped = React.useCallback((index: number, points: Coordinate[]) => {
    isInsertOperationRef.current = true;
    insertPoints(index, points);
  }, [insertPoints]);

  // Delete all climb points anchored to the direct segment between two waypoints.
  // Called when a U-turn arc is inserted between those waypoints, making the segment invalid.
  const handleDeleteClimbsOnSegment = React.useCallback((pointIdA: string, pointIdB: string) => {
    setClimbRequestsByRoute((prev) => {
      const current = prev[activeRouteId] || [];
      const next = removeClimbsOnSegment(current, pointIdA, pointIdB);
      if (next.length === current.length) return prev; // nothing changed, avoid re-render
      return { ...prev, [activeRouteId]: next };
    });
  }, [activeRouteId, setClimbRequestsByRoute]);
  
  // Calculate default entry height: (safetyHeight + outputHeight) / 2 + groundElevation
  const calculateDefaultEntryHeight = React.useCallback(async (
    point: Coordinate
  ): Promise<number | null> => {
    if (!dtmSource) {
      return null; // Can't calculate without DTM
    }

    try {
      const coordinates = [
        [point.lng, point.lat],
        [point.lng, point.lat] // Use same point for second coordinate
      ];

      const clippedIdMatch = dtmSource.match(/\/api\/dtm\/clipped\/([^/]+)/);
      const clippedId = clippedIdMatch ? clippedIdMatch[1] : activeClippedId || undefined;

      const response = await fetch('/api/elevation-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coordinates,
          dtmPath: dtmSource,
          safetyRadiusMeters: 50,
          resolutionRadiusMeters: 50,
          ...(clippedId && { clippedId })
        })
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      let groundElevation: number | null = null;

      if (data.profile && Array.isArray(data.profile) && data.profile.length > 0) {
        groundElevation = data.profile[0].elevation;
      } else if (data.elevations && Array.isArray(data.elevations) && data.elevations.length > 0) {
        groundElevation = data.elevations[0];
      } else if (data.elevation !== undefined) {
        groundElevation = data.elevation;
      }

      if (groundElevation === null || isNaN(groundElevation)) {
        return null;
      }

      // Calculate default: average of safety and output height + ground elevation
      const avgHeight = (safetyHeight + resolutionHeight) / 2;
      const calculatedHeight = avgHeight + groundElevation;
      // Round to 1 decimal place
      return Math.round(calculatedHeight * 10) / 10;
    } catch (error) {
      debug.error('Failed to calculate default entry height:', error);
      return null;
    }
  }, [dtmSource, activeClippedId, safetyHeight, resolutionHeight]);

  // Track previous first point per route to detect route-specific edits
  // We store both coordinates and id to distinguish actual edits from reordering (e.g. reverse)
  const previousRouteFirstPointsRef = React.useRef<Record<string, { lng: number; lat: number; id?: string }>>({});

  // Update entry height per route when that route's first point is added or edited
  React.useEffect(() => {
    const previousFirstPoints = previousRouteFirstPointsRef.current;
    const nextFirstPoints: Record<string, { lng: number; lat: number; id?: string }> = {};

    routes.forEach((route) => {
      if (route.points.length === 0) {
        return;
      }

      const firstPoint = route.points[0];
      nextFirstPoints[route.id] = { lng: firstPoint.lng, lat: firstPoint.lat, id: firstPoint.id };

      const previousFirstPoint = previousFirstPoints[route.id];
      const isFirstPointAdded = !previousFirstPoint;
      // Only treat as "edited" when the same waypoint (same id) moved, not when the
      // first waypoint changed because the route was reversed or reordered.
      const sameId = firstPoint.id && previousFirstPoint?.id
        ? firstPoint.id === previousFirstPoint.id
        : true; // no id tracking → fall back to old coordinate-change logic
      const isFirstPointEdited =
        !!previousFirstPoint &&
        sameId &&
        (previousFirstPoint.lng !== firstPoint.lng || previousFirstPoint.lat !== firstPoint.lat);

      // Update entry height when:
      // 1. First point is added and route entry height is still at default (250), OR
      // 2. First point is edited (coordinates changed for the same waypoint)
      // Skip when entrance height came from KML file - do not overwrite imported value
      if (route.entranceHeightFromFile) return;
      if (isFirstPointAdded || isFirstPointEdited) {
        calculateDefaultEntryHeight(firstPoint).then((defaultHeight) => {
          if (defaultHeight !== null && !isNaN(defaultHeight)) {
            setRouteNominalFlightHeight(route.id, defaultHeight);
          }
        });
      }
    });

    previousRouteFirstPointsRef.current = nextFirstPoints;
  }, [routes, calculateDefaultEntryHeight, setRouteNominalFlightHeight]);

  // Wrap addPoint and addPoints to mark them as insert operations
  const addPointWrapped = React.useCallback((point: Coordinate) => {
    isInsertOperationRef.current = true;
    addPoint(point);
  }, [addPoint]);

  const addPointsWrapped = React.useCallback((points: Coordinate[]) => {
    isInsertOperationRef.current = true;
    addPoints(points);
  }, [addPoints]);

  // Get climb requests for the active route and ensure they have anchor IDs
  const climbRequests = React.useMemo(() => {
    const requests = climbRequestsByRoute[activeRouteId] || [];
    
    // Assign anchor IDs to climb points that don't have them (for backward compatibility)
    if (flightPath.length >= 2 && requests.length > 0) {
      const updated = requests.map((climb: ClimbRequest) => {
        // If climb already has anchor IDs, keep it as is
        if (climb.anchorPointIdA && climb.anchorPointIdB) {
          return climb;
        }
        
        // Otherwise, try to find and assign anchor IDs and ratio
        const anchors = findAnchorPointsForClimb(climb.endDistance, flightPath);
        if (anchors) {
          return {
            ...climb,
            anchorPointIdA: anchors.anchorPointIdA,
            anchorPointIdB: anchors.anchorPointIdB,
            segmentRatio: anchors.segmentRatio
          };
        }
        
        // If we can't find anchors (points don't have IDs), return as is
        return climb;
      });
      
      return updated;
    }
    
    return requests;
  }, [climbRequestsByRoute, activeRouteId, flightPath]);

  // Silently sync the stored endDistance of each climb to the anchor-derived effective value
  // whenever the flight path changes (e.g. after a U-turn insertion). This keeps endDistance
  // accurate without adding a spurious undo entry, so ElevationProfile can continue to match
  // climbs by endDistance when the user edits or deletes them.
  React.useEffect(() => {
    if (flightPath.length < 2) return;
    syncClimbRequestsByRoute((prev) => {
      let changed = false;
      const updated: Record<string, ClimbRequest[]> = {};
      for (const [routeId, climbs] of Object.entries(prev)) {
        // Only sync the active route (we only have the flight path for the active route here)
        if (routeId !== activeRouteId) {
          updated[routeId] = climbs;
          continue;
        }
        const nextClimbs = climbs.map((c) => {
          const effective = getEffectiveEndDistance(c, flightPath);
          if (Math.abs(effective - c.endDistance) > 0.001) {
            changed = true;
            return { ...c, endDistance: effective };
          }
          return c;
        });
        updated[routeId] = nextClimbs;
      }
      return changed ? updated : prev;
    });
  }, [flightPath, activeRouteId]); // intentionally omit syncClimbRequestsByRoute (stable ref)

  // Derived climb requests with endDistance recomputed from anchor IDs + segmentRatio.
  // After the sync effect runs the stored values are already correct; this is kept as a
  // safety net for the first render after a path change (before the effect fires).
  const effectiveClimbRequests = React.useMemo(() =>
    climbRequests.map((c) => ({
      ...c,
      endDistance: getEffectiveEndDistance(c, flightPath)
    })),
    [climbRequests, flightPath]
  );

  // Set climb requests for the active route (now goes through undo/redo)
  const setClimbRequests = React.useCallback((updater: React.SetStateAction<ClimbRequest[]>) => {
    setClimbRequestsByRoute((prev) => {
      const current = prev[activeRouteId] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [activeRouteId]: next };
    });
  }, [activeRouteId, setClimbRequestsByRoute, flightPath]);

  const handleDeleteAllPoints = React.useCallback(() => {
    // Clear climb requests first so both start/end climb markers become invalid.
    setClimbRequestsByRoute((prev) => {
      return { ...prev, [activeRouteId]: [] };
    });
    // Then clear regular route points.
    setFlightPath([]);
  }, [activeRouteId, setClimbRequestsByRoute, setFlightPath]);
  
  // State for anchor point warning modal
  const [anchorWarningModal, setAnchorWarningModal] = useState<{
    isOpen: boolean;
    affectedClimbsCount: number;
    pendingAction: (() => void) | null;
  }>({
    isOpen: false,
    affectedClimbsCount: 0,
    pendingAction: null
  });

  // State for reverse warning modal
  const [reverseWarningOpen, setReverseWarningOpen] = useState(false);

  const { elevationProfile, loading, profileReady, profileError, calculateProfile, clearProfile } = useElevationProfile();

  // When the profile error pop-up is closed, keep showing the error in the profile panel (don't clear it).
  const [profileErrorModalDismissed, setProfileErrorModalDismissed] = useState(false);
  React.useEffect(() => {
    if (profileError) setProfileErrorModalDismissed(false);
  }, [profileError]);

  // Track last inputs so we can avoid expensive recalculation when only nominal height changes
  const lastProfileParamsRef = React.useRef<{
    flightPath: Coordinate[];
    dtmSource: string | null;
    safetySearchRadius: number;
    resolutionSearchRadius: number;
    nominalFlightHeight: number;
  } | null>(null);

  // Debounce timer for profile calculation to handle rapid point additions
  const profileCalculationTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const profileCallbackRef = React.useRef<((h: number) => void) | undefined>(undefined);
  profileCallbackRef.current = (() => {
    const activeRoute = routes.find((r) => r.id === activeRouteId);
    return activeRoute?.entranceHeightFromFile ? undefined : setNominalFlightHeight;
  })();

  React.useEffect(() => {
    const prev = lastProfileParamsRef.current;
    const baseChanged = !prev
      || prev.flightPath !== flightPath
      || prev.dtmSource !== dtmSource
      || prev.safetySearchRadius !== safetySearchRadius
      || prev.resolutionSearchRadius !== resolutionSearchRadius
      || prev.nominalFlightHeight !== nominalFlightHeight;

    const onDefaultEntryHeightCalculated = profileCallbackRef.current;

    if (baseChanged && profileCalculationTimeoutRef.current) {
      clearTimeout(profileCalculationTimeoutRef.current);
      profileCalculationTimeoutRef.current = null;
    }

    if (baseChanged) {
      if (flightPath.length === 0) {
        calculateProfile([], dtmSource || '', nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, safetyHeight, resolutionHeight, activeClippedId, onDefaultEntryHeightCalculated);
      } else if (flightPath.length === 1) {
        clearProfile();
      } else if (flightPath.length >= 2 && dtmSource) {
        profileCalculationTimeoutRef.current = setTimeout(() => {
          const cb = profileCallbackRef.current;
          calculateProfile(flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, safetyHeight, resolutionHeight, activeClippedId, cb);
          profileCalculationTimeoutRef.current = null;
        }, 300);
      }
    }

    lastProfileParamsRef.current = {
      flightPath,
      dtmSource,
      safetySearchRadius,
      resolutionSearchRadius,
      nominalFlightHeight
    };

    return () => {
      // Intentionally do NOT clear timeout on deps change - clearing here cancels the pending
      // profile calc when effect re-runs due to unrelated dep changes (e.g. calculateProfile
      // getting new ref when nominalFlightHeight updates). Timeout uses latest closure values
      // via profileCallbackRef.
    };
  }, [flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, safetyHeight, resolutionHeight, activeClippedId, calculateProfile, clearProfile, setNominalFlightHeight]);

  React.useEffect(() => {
    return () => {
      if (profileCalculationTimeoutRef.current) {
        clearTimeout(profileCalculationTimeoutRef.current);
        profileCalculationTimeoutRef.current = null;
      }
    };
  }, []);

  // NOTE: Old logic that removed climbs on segment changes has been removed.
  // Climb points are now anchored to specific point IDs and are only removed
  // when their anchor points are edited/deleted (with user confirmation via warning modal).

  // Calculate the full profile result
  const fullProfileResultInternal = React.useMemo(() => {
    if (elevationProfile.length === 0) return { points: [], warnings: [] };

    // 1. Calculate base altitude profile (entry height is now ASL, not AGL)
    // Entry height (nominalFlightHeight) is absolute altitude above sea level
    const constantAltitude = nominalFlightHeight;
    const baseAltitudeProfile: BaseAltitudeSample[] = elevationProfile.map((p) => ({
      distance: p.distance,
      baseAltitude: constantAltitude,
      ground: p.elevation
    }));

    // 2. Initial base plan
    const basePlanPoints: ClimbProfilePoint[] = baseAltitudeProfile.map((p) => ({
      ...p,
      plannedAltitude: p.baseAltitude,
      climbDelta: 0,
      isClimbPhase: false
    }));

    if (flightPath.length === 0) {
      return {
        points: elevationProfile.map((p, i) => ({
          ...p,
          plannedAltitude: basePlanPoints[i].plannedAltitude,
          baseAltitude: basePlanPoints[i].baseAltitude,
          climbDelta: basePlanPoints[i].climbDelta,
          flightHeight: basePlanPoints[i].plannedAltitude - p.elevation
        })),
        warnings: []
      };
    }

    // 3. Process climb requests sequentially.
    // effectiveClimbRequests has endDistance derived from anchor IDs + segmentRatio,
    // so positions are stable even when points are inserted/removed on the route.
    const sortedClimbs = [...effectiveClimbRequests].sort((a, b) => a.endDistance - b.endDistance);
    let currentBase = baseAltitudeProfile;
    let currentPlanned = basePlanPoints;
    const allWarnings: string[] = [];

    sortedClimbs.forEach((climb, idx) => {
      const activeRatio = climb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const requiredHorizontal = Math.abs(climb.climbAmount) * activeRatio;
      const startDistanceOfClimb = Math.max(0, climb.endDistance - requiredHorizontal);

      const res = computeClimbProfile(
        startDistanceOfClimb,
        climb.climbAmount,
        climbConfig.climbRatio,
        climbConfig.descentRatio,
        climbConfig.allowTurnsDuringClimb,
        flightPath,
        currentBase,
        climbConfig.vertexProximityMeters,
        climb.endDistance
      );

      allWarnings.push(...res.warnings.map(w => `עלייה ${idx + 1}: ${w}`));

      currentPlanned = res.points.map((p, i) => ({
        ...p,
        climbDelta: p.plannedAltitude - (basePlanPoints[i]?.baseAltitude ?? p.baseAltitude),
        isClimbPhase: p.plannedAltitude !== p.baseAltitude
      }));

      currentBase = res.points.map((p) => ({
        distance: p.distance,
        baseAltitude: p.plannedAltitude,
        ground: p.ground
      }));
    });

    // 4. Merge results into the final ElevationPoint array
    return {
      points: elevationProfile.map((p, i) => ({
        ...p,
        plannedAltitude: currentPlanned[i].plannedAltitude,
        baseAltitude: currentPlanned[i].baseAltitude,
        climbDelta: currentPlanned[i].climbDelta,
        flightHeight: currentPlanned[i].plannedAltitude - p.elevation
      })),
      warnings: allWarnings
    };
  }, [elevationProfile, nominalFlightHeight, flightPath, effectiveClimbRequests, climbConfig]);

  // Stable profile that only updates when queue is empty AND server confirms it's ready
  const [stableProfileResult, setStableProfileResult] = React.useState(() => fullProfileResultInternal);
  const profileLockedRef = React.useRef(false);

  const handleGroupMoveCommitted = React.useCallback((updatedPath: Coordinate[]) => {
    // Cancel pending debounced recalculation and run an immediate recalculation for group moves.
    if (profileCalculationTimeoutRef.current) {
      clearTimeout(profileCalculationTimeoutRef.current);
      profileCalculationTimeoutRef.current = null;
    }

    profileLockedRef.current = false;
    setStableProfileResult({ points: [], warnings: [] });

    const activeRoute = routes.find((r) => r.id === activeRouteId);
    const onDefaultEntryHeightCalculated = activeRoute?.entranceHeightFromFile ? undefined : setNominalFlightHeight;

    if (updatedPath.length === 0) {
      calculateProfile([], dtmSource || '', nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, safetyHeight, resolutionHeight, activeClippedId, onDefaultEntryHeightCalculated);
    } else if (updatedPath.length === 1) {
      clearProfile();
    } else if (dtmSource) {
      calculateProfile(updatedPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, safetyHeight, resolutionHeight, activeClippedId, onDefaultEntryHeightCalculated);
    }

    // Keep the effect's previous-value tracker in sync to avoid scheduling a duplicate debounce run.
    lastProfileParamsRef.current = {
      flightPath: updatedPath,
      dtmSource,
      safetySearchRadius,
      resolutionSearchRadius,
      nominalFlightHeight
    };
  }, [
    activeClippedId,
    activeRouteId,
    calculateProfile,
    clearProfile,
    dtmSource,
    nominalFlightHeight,
    resolutionHeight,
    routes,
    safetyHeight,
    resolutionSearchRadius,
    safetySearchRadius,
    setNominalFlightHeight
  ]);
  
  // Unlock profile when a new calculation starts
  React.useEffect(() => {
    if (loading) {
      profileLockedRef.current = false; // Unlock when new calculation starts
    }
  }, [loading]);
  
  // Unlock profile when edit queue changes (points are being added/deleted/updated)
  // This ensures the profile can be recalculated when the flight path changes
  // Also clear the stable profile for geometry-changing operations to prevent showing stale data
  React.useEffect(() => {
    if (editQueue.length > 0) {
      profileLockedRef.current = false; // Unlock when edits are queued
      
      // Check if any queued operations change the geometry (delete or update)
      const hasGeometryChange = editQueue.some(op => op.type === 'delete' || op.type === 'update');
      if (hasGeometryChange) {
        // Clear stable profile to show loading state instead of stale/invalid data
        // The profile will be updated once the new calculation completes
        setStableProfileResult({ points: [], warnings: [] });
      }
    }
  }, [editQueue]);
  
  // Clear stable profile when all points are deleted or only one point remains
  React.useEffect(() => {
    if (flightPath.length === 0 || flightPath.length === 1) {
      setStableProfileResult({ points: [], warnings: [] });
      profileLockedRef.current = false; // Unlock profile when cleared
    }
  }, [flightPath.length]);

  // Unlock profile when nominal height changes so it can be recalculated
  React.useEffect(() => {
    profileLockedRef.current = false;
  }, [nominalFlightHeight]);

  // Unlock profile when climb requests or climb config changes so it can be recalculated
  React.useEffect(() => {
    profileLockedRef.current = false;
  }, [climbRequests, climbConfig]);

  // Update stable profile only when:
  // 1. Queue is empty and processing is complete
  // 2. Server has confirmed profile is ready (profileReady)
  // 3. Profile is not locked (locked means it's already displayed and should not change)
  React.useEffect(() => {
    if (editQueue.length === 0 && !isProcessingQueue && profileReady && !profileLockedRef.current && flightPath.length >= 2) {
      setStableProfileResult(fullProfileResultInternal);
      profileLockedRef.current = true; // Lock the profile once displayed
    }
  }, [fullProfileResultInternal, editQueue.length, isProcessingQueue, profileReady, flightPath.length]);

  // Use stable profile - this ensures the profile only shows the final version when queue is empty and ready
  const fullProfileResult = stableProfileResult;

  const climbMarkers = React.useMemo(() => {
    if (!fullProfileResult.points.length || climbRequests.length === 0) return [];

    const markers: { lat: number; lng: number; label: string; type: 'start' | 'end' }[] = [];
    
    // Helper to convert distance to coordinate
    const distanceToCoordinate = (distance: number, route: Coordinate[], cumulativeDistances: number[]): Coordinate | null => {
      if (route.length === 0 || cumulativeDistances.length === 0) return null;
      if (distance <= 0) return route[0];
      if (distance >= cumulativeDistances[cumulativeDistances.length - 1]) {
        return route[route.length - 1];
      }

      // Find the segment containing this distance
      for (let i = 1; i < cumulativeDistances.length; i++) {
        if (distance <= cumulativeDistances[i]) {
          const prevDist = cumulativeDistances[i - 1];
          const segmentDist = cumulativeDistances[i] - prevDist;
          const t = segmentDist > 0 ? (distance - prevDist) / segmentDist : 0;

          const p1 = route[i - 1];
          const p2 = route[i];

          // Interpolate between points
          return {
            lng: p1.lng + (p2.lng - p1.lng) * t,
            lat: p1.lat + (p2.lat - p1.lat) * t
          };
        }
      }

      return route[route.length - 1];
    };

    effectiveClimbRequests.forEach((climb) => {
      // climb.endDistance is already the anchor-derived effective distance
      const activeRatio = climb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const requiredHorizontal = Math.abs(climb.climbAmount) * activeRatio;

      // Try to get position from anchor points first (for anchored climbs)
      let endCoord: Coordinate | null = null;
      if (climb.anchorPointIdA && climb.anchorPointIdB) {
        endCoord = getClimbPositionFromAnchors(climb, flightPath, climb.endDistance);
      }

      // Fallback to distance-based calculation if no anchors or anchors not found
      if (!endCoord) {
        const cumulativeDistances = computeCumulativeDistances(flightPath);
        endCoord = distanceToCoordinate(climb.endDistance, flightPath, cumulativeDistances);
      }
      
      if (!endCoord) {
        return;
      }

      // For start position, calculate based on segment ratio (not global distance)
      // This ensures the start position stays fixed relative to the anchor points
      let startCoord: Coordinate | null = null;
      if (climb.anchorPointIdA && climb.anchorPointIdB && climb.segmentRatio !== undefined) {
        // Find anchor points
        const pointA = flightPath.find(p => p.id === climb.anchorPointIdA);
        const pointB = flightPath.find(p => p.id === climb.anchorPointIdB);
        
        if (pointA && pointB) {
          // Find segment indices to calculate segment length
          let segmentStartIdx = -1;
          let segmentEndIdx = -1;
          
          for (let i = 0; i < flightPath.length; i++) {
            if (flightPath[i].id === climb.anchorPointIdA) segmentStartIdx = i;
            if (flightPath[i].id === climb.anchorPointIdB) segmentEndIdx = i;
          }
          
          if (segmentStartIdx !== -1 && segmentEndIdx !== -1 && segmentEndIdx === segmentStartIdx + 1) {
            // Calculate segment length using haversine distance between the two anchor points
            // This ensures the segment length is always relative to the current anchor positions
            const EARTH_RADIUS_M = 6371000;
            const dLat = ((pointB.lat - pointA.lat) * Math.PI) / 180;
            const dLon = ((pointB.lng - pointA.lng) * Math.PI) / 180;
            const lat1 = (pointA.lat * Math.PI) / 180;
            const lat2 = (pointB.lat * Math.PI) / 180;
            const a =
              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const segmentLength = EARTH_RADIUS_M * c;
            
            if (segmentLength > 0) {
              // Calculate start ratio: go back requiredHorizontal meters from the end position
              // The end is at segmentRatio, so we need to calculate how much ratio to go back
              const ratioToGoBack = requiredHorizontal / segmentLength;
              const startRatio = Math.max(0, Math.min(1, climb.segmentRatio - ratioToGoBack));
              
              startCoord = {
                lng: pointA.lng + (pointB.lng - pointA.lng) * startRatio,
                lat: pointA.lat + (pointB.lat - pointA.lat) * startRatio
              };
            } else {
              startCoord = { ...endCoord };
            }
          }
        }
      }
      
      // Fallback to distance-based calculation if anchor-based failed
      if (!startCoord) {
        const cumulativeDistances = computeCumulativeDistances(flightPath);
        const startDistance = Math.max(0, climb.endDistance - requiredHorizontal);
        startCoord = distanceToCoordinate(startDistance, flightPath, cumulativeDistances);
      }

      if (!startCoord) {
        return;
      }

      const sign = climb.climbAmount >= 0 ? '+' : '';
      const label = `${sign}${climb.climbAmount.toFixed(0)}m`;

      // Add start marker
      markers.push({
        lat: startCoord.lat,
        lng: startCoord.lng,
        label: '',
        type: 'start'
      });

      // Add end marker
      markers.push({
        lat: endCoord.lat,
        lng: endCoord.lng,
        label: label,
        type: 'end'
      });
    });

    return markers;
  }, [effectiveClimbRequests, fullProfileResult.points, climbConfig, flightPath]);

  const deleteDtmOnServer = useCallback(async (
    pathToDelete?: string,
    clippedIdToDelete?: string,
    keepalive: boolean = false,
    forceDelete: boolean = false
  ) => {
    const targetPath = pathToDelete || dtmSource;
    const targetClippedId = clippedIdToDelete || activeClippedId;

    // If we have a clipped ID, delete that first
    if (targetClippedId) {
      try {
        const response = await fetch(`/api/dtm/clipped/${targetClippedId}?force=${forceDelete}`, {
          method: 'DELETE',
          keepalive
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          debug.error(`Failed to delete clipped DTM: ${targetClippedId} - ${response.status} ${response.statusText}`, errorText);
        }
      } catch (error) {
        debug.error('Failed to delete clipped DTM on server:', error);
      }
    }

    // Also cleanup legacy uploaded files if applicable
    if (targetPath && !targetPath.includes('/api/dtm/clipped/')) {
      try {
        const response = await fetch('/api/dtm/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path: targetPath, force: forceDelete }),
          keepalive
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          debug.error(`Failed to delete legacy DTM: ${targetPath} - ${response.status} ${response.statusText}`, errorText);
        }
      } catch (error) {
        debug.error('Failed to delete DTM on server:', error);
      }
    }
  }, [dtmSource, activeClippedId]);

  const handlePathPointHover = useCallback((point: Coordinate | null, distance?: number) => {
    setSelectedPoint(point);
    if (point && fullProfileResult.points.length > 0) {
      if (distance !== undefined) {
        // Find the points in full profile to interpolate between
        let leftIdx = 0;
        let rightIdx = fullProfileResult.points.length - 1;

        // Find the segment containing this distance
        for (let i = 0; i < fullProfileResult.points.length - 1; i++) {
          if (distance >= fullProfileResult.points[i].distance && distance <= fullProfileResult.points[i + 1].distance) {
            leftIdx = i;
            rightIdx = i + 1;
            break;
          }
        }

        const p1 = fullProfileResult.points[leftIdx];
        const p2 = fullProfileResult.points[rightIdx];
        const distRange = p2.distance - p1.distance;
        const t = distRange > 0 ? (distance - p1.distance) / distRange : 0;

        const interpolatedElevation = p1.elevation + (p2.elevation - p1.elevation) * t;
        const interpolatedMin = (p1.minElevation !== undefined && p2.minElevation !== undefined)
          ? p1.minElevation + (p2.minElevation - p1.minElevation) * t : undefined;
        const interpolatedMax = (p1.maxElevation !== undefined && p2.maxElevation !== undefined)
          ? p1.maxElevation + (p2.maxElevation - p1.maxElevation) * t : undefined;

        const interpolatedPlanned = (p1.plannedAltitude !== undefined && p2.plannedAltitude !== undefined)
          ? p1.plannedAltitude + (p2.plannedAltitude - p1.plannedAltitude) * t : undefined;

        const interpolatedFlightHeight = (interpolatedPlanned !== undefined)
          ? interpolatedPlanned - interpolatedElevation : undefined;

        setHoveredElevationPoint({
          distance: distance,
          elevation: interpolatedElevation,
          longitude: point.lng,
          latitude: point.lat,
          minElevation: interpolatedMin,
          maxElevation: interpolatedMax,
          plannedAltitude: interpolatedPlanned,
          flightHeight: interpolatedFlightHeight
        });
      } else {
        // When hovering over a vertex, calculate distance along current flightPath
        // This ensures correct connection after route rotation
        if (flightPath.length >= 2) {
          // Find which vertex in flightPath matches the hovered point
          let vertexIndex = -1;
          let minDist = Infinity;
          
          for (let i = 0; i < flightPath.length; i++) {
            const dist = Math.pow(flightPath[i].lng - point.lng, 2) + Math.pow(flightPath[i].lat - point.lat, 2);
            if (dist < minDist) {
              minDist = dist;
              vertexIndex = i;
            }
          }

          // Calculate cumulative distance to this vertex
          let vertexDistance = 0;
          if (vertexIndex > 0) {
            for (let i = 1; i <= vertexIndex; i++) {
              vertexDistance += calculateDistance(flightPath[i - 1], flightPath[i]);
            }
          }

          // Find the points in full profile to interpolate between using the calculated distance
          let leftIdx = 0;
          let rightIdx = fullProfileResult.points.length - 1;

          // Find the segment containing this distance
          for (let i = 0; i < fullProfileResult.points.length - 1; i++) {
            if (vertexDistance >= fullProfileResult.points[i].distance && vertexDistance <= fullProfileResult.points[i + 1].distance) {
              leftIdx = i;
              rightIdx = i + 1;
              break;
            }
          }

          const p1 = fullProfileResult.points[leftIdx];
          const p2 = fullProfileResult.points[rightIdx];
          const distRange = p2.distance - p1.distance;
          const t = distRange > 0 ? (vertexDistance - p1.distance) / distRange : 0;

          const interpolatedElevation = p1.elevation + (p2.elevation - p1.elevation) * t;
          const interpolatedMin = (p1.minElevation !== undefined && p2.minElevation !== undefined)
            ? p1.minElevation + (p2.minElevation - p1.minElevation) * t : undefined;
          const interpolatedMax = (p1.maxElevation !== undefined && p2.maxElevation !== undefined)
            ? p1.maxElevation + (p2.maxElevation - p1.maxElevation) * t : undefined;

          const interpolatedPlanned = (p1.plannedAltitude !== undefined && p2.plannedAltitude !== undefined)
            ? p1.plannedAltitude + (p2.plannedAltitude - p1.plannedAltitude) * t : undefined;

          const interpolatedFlightHeight = (interpolatedPlanned !== undefined)
            ? interpolatedPlanned - interpolatedElevation : undefined;

          setHoveredElevationPoint({
            distance: vertexDistance,
            elevation: interpolatedElevation,
            longitude: point.lng,
            latitude: point.lat,
            minElevation: interpolatedMin,
            maxElevation: interpolatedMax,
            plannedAltitude: interpolatedPlanned,
            flightHeight: interpolatedFlightHeight
          });
        } else {
          // Fallback: find the closest point in full profile by coordinates (if flightPath is too short)
          let closest = fullProfileResult.points[0];
          let minSqDist = Math.pow(closest.longitude - point.lng, 2) + Math.pow(closest.latitude - point.lat, 2);

          for (const p of fullProfileResult.points) {
            const sqDist = Math.pow(p.longitude - point.lng, 2) + Math.pow(p.latitude - point.lat, 2);
            if (sqDist < minSqDist) {
              minSqDist = sqDist;
              closest = p;
            }
          }
          setHoveredElevationPoint(closest);
        }
      }
      setHoverSource('map');
    } else {
      setHoveredElevationPoint(null);
      setHoverSource(null);
    }
  }, [fullProfileResult.points, flightPath]);

  const handleElevationPointHover = useCallback((point: ElevationPoint | null) => {
    if (!point) {
      setHoveredElevationPoint(null);
      setHoverSource(null);
      return;
    }

    // Recalculate coordinates based on current flightPath using distance
    // This ensures the hover marker shows the correct point after route rotation
    if (flightPath.length >= 2) {
      // Calculate cumulative distances along the current flight path
      const cumulativeDistances: number[] = [0];
      let totalDist = 0;
      for (let i = 1; i < flightPath.length; i++) {
        const segDist = calculateDistance(flightPath[i - 1], flightPath[i]);
        totalDist += segDist;
        cumulativeDistances.push(totalDist);
      }

      // Find the segment and position where the distance matches
      const targetDistance = point.distance;
      let found = false;

      for (let i = 0; i < cumulativeDistances.length - 1; i++) {
        const segStartDist = cumulativeDistances[i];
        const segEndDist = cumulativeDistances[i + 1];

        if (targetDistance >= segStartDist && targetDistance <= segEndDist) {
          // Interpolate position within this segment
          const segLength = segEndDist - segStartDist;
          const t = segLength > 0 ? (targetDistance - segStartDist) / segLength : 0;

          const start = flightPath[i];
          const end = flightPath[i + 1];
          const newLat = start.lat + (end.lat - start.lat) * t;
          const newLng = start.lng + (end.lng - start.lng) * t;

          // Update the point with new coordinates while preserving other properties
          setHoveredElevationPoint({
            ...point,
            latitude: newLat,
            longitude: newLng
          });
          setHoverSource('profile');
          found = true;
          break;
        }
      }

      // If distance is beyond the path, use the last point
      if (!found && flightPath.length > 0) {
        const lastPoint = flightPath[flightPath.length - 1];
        setHoveredElevationPoint({
          ...point,
          latitude: lastPoint.lat,
          longitude: lastPoint.lng
        });
        setHoverSource('profile');
      }
    } else {
      // Fallback: use original coordinates if flight path is too short
      setHoveredElevationPoint(point);
      setHoverSource('profile');
    }
  }, [flightPath]);

  const handleOverlapGraphPointHover = useCallback((point: ElevationPoint | null) => {
    if (!point) {
      setHoveredElevationPoint(null);
      setHoverSource(null);
      return;
    }
    if (flightPath.length >= 2) {
      const cumulativeDistances: number[] = [0];
      let totalDist = 0;
      for (let i = 1; i < flightPath.length; i++) {
        const segDist = calculateDistance(flightPath[i - 1], flightPath[i]);
        totalDist += segDist;
        cumulativeDistances.push(totalDist);
      }
      const targetDistance = point.distance;
      let found = false;
      for (let i = 0; i < cumulativeDistances.length - 1; i++) {
        const segStartDist = cumulativeDistances[i];
        const segEndDist = cumulativeDistances[i + 1];
        if (targetDistance >= segStartDist && targetDistance <= segEndDist) {
          const segLength = segEndDist - segStartDist;
          const t = segLength > 0 ? (targetDistance - segStartDist) / segLength : 0;
          const start = flightPath[i];
          const end = flightPath[i + 1];
          const newLat = start.lat + (end.lat - start.lat) * t;
          const newLng = start.lng + (end.lng - start.lng) * t;
          setHoveredElevationPoint({ ...point, latitude: newLat, longitude: newLng });
          setHoverSource('overlap');
          found = true;
          break;
        }
      }
      if (!found && flightPath.length > 0) {
        const lastPoint = flightPath[flightPath.length - 1];
        setHoveredElevationPoint({ ...point, latitude: lastPoint.lat, longitude: lastPoint.lng });
        setHoverSource('overlap');
      }
    } else {
      setHoveredElevationPoint(point);
      setHoverSource('overlap');
    }
  }, [flightPath]);

  const handleDtmLoad = useCallback((source: string, info?: any, clippedId?: string, options?: {
    sourceType?: 'local' | 'server';
    originalFile?: File;
    serverId?: string;
    serverMetadata?: { displayName?: string; sizeBytes?: number; modifiedAt?: string };
    aoi?: { type: 'bbox' | 'polygon' | 'kml'; bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number }; polygon?: [number, number][] };
  }) => {
    const { sourceType, originalFile, serverId, serverMetadata, aoi } = options || {};
    // If loading a new DTM and we have an existing clippedId, delete the old one first
    if (activeClippedId && clippedId && activeClippedId !== clippedId) {
      deleteDtmOnServer(undefined, activeClippedId);
    }
    
    setDtmSource(source);
    if (clippedId) {
      setActiveClippedId(clippedId);
    }
    if (info) {
      setDtmInfo({
        path: source,
        bounds: info.bounds,
        clippedId: clippedId || info.clippedId
      });
    }
    
    // Track source type and metadata for project save/load
    if (sourceType) {
      setDtmSourceType(sourceType);
      if (sourceType === 'local' && originalFile) {
        setLocalDtmFile(originalFile);
        setServerDtmId(null);
        setServerDtmMetadata(null);
        setActiveDtmName(originalFile.name);
      } else if (sourceType === 'server' && serverId) {
        setServerDtmId(serverId);
        setServerDtmMetadata(serverMetadata || null);
        setLocalDtmFile(null);
        setActiveDtmName(serverMetadata?.displayName || null);
      }
    }

    if (aoi) {
      setAoiGeometry(aoi);
    }
  }, [activeClippedId, deleteDtmOnServer]);

  const handleDtmUnload = useCallback(() => {
    // Show warning confirmation dialog
    const confirmed = window.confirm(
      'האם אתה בטוח שברצונך להסיר את ה-DTM?\n\nפעולה זו תמחק את כל הנקודות והמסלולים ותנקה את פרופיל הגובה.\n\nלא ניתן לבטל פעולה זו.'
    );
    
    if (!confirmed) {
      return; // User cancelled, do nothing
    }

    if (dtmSource || activeClippedId) {
      deleteDtmOnServer(dtmSource || undefined, activeClippedId || undefined, false, true).catch((error) => {
        debug.error('Failed to clean up DTM cache:', error);
      });
    }
    setDtmSource(null);
    setDtmInfo(null);
    setActiveClippedId(null);
    setActiveDtmName(null);
    // Clear elevation profile when unloading DTM
    clearProfile();
    // Clear stable profile result
    setStableProfileResult({ points: [], warnings: [] });
    profileLockedRef.current = false; // Unlock profile
    // Clear routes when unloading DTM (keep only the first route)
    resetToSingleRoute();
  }, [dtmSource, activeClippedId, deleteDtmOnServer, resetToSingleRoute, clearProfile]);

  // Best-effort cleanup for browser refresh/close navigation events.
  // Uses sendBeacon when possible because async work is limited during unload.
  const triggerPageExitDtmCleanup = useCallback(() => {
    const targetPath = dtmSource || undefined;
    const targetClippedId = activeClippedId || undefined;
    if (!targetPath && !targetClippedId) return;

    const payload = {
      path: targetPath,
      clippedId: targetClippedId,
      force: true
    };

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const queued = navigator.sendBeacon('/api/dtm/cleanup', body);
        if (queued) return;
      }
    } catch (error) {
      debug.error('Failed to queue DTM cleanup with sendBeacon:', error);
    }

    fetch('/api/dtm/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch((error) => {
      debug.error('Failed to clean up DTM on page exit:', error);
    });
  }, [dtmSource, activeClippedId]);

  // Ensure DTM cleanup is attempted on refresh/close/tab close.
  React.useEffect(() => {
    let cleanupTriggered = false;

    const handlePageExit = () => {
      if (cleanupTriggered) return;
      cleanupTriggered = true;
      triggerPageExitDtmCleanup();
    };

    window.addEventListener('beforeunload', handlePageExit);
    window.addEventListener('pagehide', handlePageExit);
    
    return () => {
      window.removeEventListener('beforeunload', handlePageExit);
      window.removeEventListener('pagehide', handlePageExit);
    };
  }, [triggerPageExitDtmCleanup]);

  // Process the edit queue
  const processEditQueue = React.useCallback(() => {
    if (isProcessingQueue || editQueue.length === 0) return;
    
    setIsProcessingQueue(true);
    
    // Process all queued operations
    editQueue.forEach((operation) => {
      switch (operation.type) {
        case 'delete':
          deletePoint(operation.index);
          break;
        case 'update':
          updatePoint(operation.index, operation.point);
          break;
        case 'setFlightHeight':
          const point = flightPath[operation.index];
          if (point) {
            updatePoint(operation.index, {
              ...point,
              height: operation.height
            });
          }
          break;
        case 'editPointRequest':
          setEditPointIndex(operation.index);
          // Show alert when processing edit request
          alert(`מצב עריכה: נקודה ${operation.index + 1}. לחץ על המפה כדי להזיז.`);
          break;
      }
    });
    
    // Clear the queue after processing
    setEditQueue([]);
    
    // Reset processing flag after a short delay to allow state updates to propagate
    setTimeout(() => {
      setIsProcessingQueue(false);
    }, 100);
  }, [editQueue, isProcessingQueue, deletePoint, updatePoint, flightPath]);

  // Process queue immediately (synchronously) - used for undo/redo
  const processEditQueueImmediately = React.useCallback(() => {
    // Clear any pending timeout
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    
    // Get current queue and process it
    setEditQueue((currentQueue) => {
      if (currentQueue.length === 0) return currentQueue;
      
      // Process queue synchronously - operations execute immediately
      setIsProcessingQueue(true);
      
      // Process all operations
      currentQueue.forEach((operation) => {
        switch (operation.type) {
          case 'delete':
            deletePoint(operation.index);
            break;
          case 'update':
            updatePoint(operation.index, operation.point);
            break;
          case 'setFlightHeight':
            const point = flightPath[operation.index];
            if (point) {
              updatePoint(operation.index, {
                ...point,
                height: operation.height
              });
            }
            break;
          case 'editPointRequest':
            setEditPointIndex(operation.index);
            alert(`מצב עריכה: נקודה ${operation.index + 1}. לחץ על המפה כדי להזיז.`);
            break;
        }
      });
      
      // Reset processing flag after operations complete
      setTimeout(() => {
        setIsProcessingQueue(false);
      }, 50);
      
      return []; // Clear the queue
    });
  }, [deletePoint, updatePoint, flightPath]);

  // Process queue when it changes (debounced)
  React.useEffect(() => {
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    
    if (editQueue.length > 0 && !isProcessingQueue) {
      // Debounce queue processing to batch rapid edits
      processingTimeoutRef.current = setTimeout(() => {
        processEditQueue();
      }, 150);
    }
    
    return () => {
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }
    };
  }, [editQueue, isProcessingQueue, processEditQueue]);

  // Register queue processing callback with global undo/redo manager
  // This ensures pending edit operations are processed before any undo/redo
  React.useEffect(() => {
    globalUndoRedo.setBeforeUndoRedoCallback(processEditQueueImmediately);
    return () => {
      globalUndoRedo.setBeforeUndoRedoCallback(null);
    };
  }, [globalUndoRedo, processEditQueueImmediately]);

  // Wrapped undo/redo for button clicks - uses global manager directly
  // Queue processing is handled by the beforeUndoRedo callback
  const handleUndo = React.useCallback(() => {
    globalUndoRedo.undo();
  }, [globalUndoRedo]);

  const handleRedo = React.useCallback(() => {
    globalUndoRedo.redo();
  }, [globalUndoRedo]);

  const handleReverseFlightPath = React.useCallback(() => {
    const activeClimbs = climbRequestsByRoute[activeRouteId] ?? [];
    if (activeClimbs.length > 0) {
      setReverseWarningOpen(true);
    } else {
      reverseFlightPath();
    }
  }, [climbRequestsByRoute, activeRouteId, reverseFlightPath]);

  const handleImportKml = React.useCallback(() => {
    importKmlFile({
      onKmlImported: (kmlImport) => {
        // Add to KML imports array with timestamp
        // Polygons are just visual overlays, not AOI
        setKmlImports(prev => [...prev, {
          ...kmlImport,
          importedAt: Date.now()
        }]);
      },
      onError: (error: string) => {
        setSuccessNotification({ isOpen: true, message: error });
      },
      onSuccess: (message: string) => {
        setSuccessNotification({ isOpen: true, message });
      },
      onShowSummary: (summary: { points: number; polygons: number }) => {
        setImportSummary(summary);
        // Show summary briefly, then clear
        setTimeout(() => setImportSummary(null), 2000);
      },
      onZoomToBounds: (bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }) => {
        setZoomToBounds(bounds);
        // Clear after zoom (so it doesn't re-zoom on every render)
        setTimeout(() => setZoomToBounds(null), 100);
      }
    });
  }, []);

  const handleDeleteKml = React.useCallback((id: string) => {
    setKmlImports(prev => prev.filter(kml => kml.id !== id));
  }, []);

  const handleDeleteAllKml = React.useCallback(() => {
    setKmlImports([]);
  }, []);

  const handleKmlColorChange = React.useCallback((id: string, color: string) => {
    setKmlImports(prev => prev.map(kml => kml.id === id ? { ...kml, color } : kml));
  }, []);

  const handleKmlSymbolChange = React.useCallback((id: string, symbol: import('./components/KmlManagerModal').PointSymbol) => {
    setKmlImports(prev => prev.map(kml => kml.id === id ? { ...kml, symbol } : kml));
  }, []);

  const handleKmlVisibilityToggle = React.useCallback((id: string) => {
    setKmlImports(prev => prev.map(kml => kml.id === id ? { ...kml, visible: !kml.visible } : kml));
  }, []);

  const handleZoomToKml = React.useCallback((id: string) => {
    const kml = kmlImports.find(k => k.id === id);
    if (!kml) return;

    // Calculate bounds from points and polygons
    const allCoords: Array<{ lat: number; lng: number }> = [];
    
    // Add all point coordinates
    kml.points.forEach(point => {
      allCoords.push({ lat: point.lat, lng: point.lng });
    });
    
    // Add all polygon coordinates
    kml.polygons.forEach(polygon => {
      polygon.coordinates.forEach(([lon, lat]) => {
        allCoords.push({ lat, lng: lon });
      });
    });

    if (allCoords.length === 0) return;

    // Calculate bounds
    const lats = allCoords.map(c => c.lat);
    const lngs = allCoords.map(c => c.lng);
    const bounds = {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lngs),
      maxLon: Math.max(...lngs)
    };

    // Zoom to bounds
    setZoomToBounds(bounds);
    setTimeout(() => setZoomToBounds(null), 100);
  }, [kmlImports]);

  const handleSetFlightHeight = useCallback((pointIndex: number) => {
    if (pointIndex < 0 || pointIndex >= flightPath.length) return;
    const currentPoint = flightPath[pointIndex];
    const currentHeight = currentPoint.height ?? nominalFlightHeight;
    setFlightHeightModal({ isOpen: true, pointIndex, currentHeight });
    setFlightHeightInput(currentHeight.toString());
    setFlightHeightError(null);
  }, [flightPath, nominalFlightHeight]);

  const handleFlightHeightSubmit = useCallback(() => {
    if (!flightHeightModal) return;
    
    const height = parseFloat(flightHeightInput);
    if (isNaN(height) || height < 0 || height > 10000) {
      setFlightHeightError('הגובה חייב להיות מספר בין 0 ל-10000 מטרים');
      return;
    }
    
    // Queue the operation instead of executing immediately
    setEditQueue((prev) => [...prev, { type: 'setFlightHeight', index: flightHeightModal.pointIndex, height }]);
    setFlightHeightModal(null);
    setFlightHeightInput('');
    setFlightHeightError(null);
  }, [flightHeightModal, flightHeightInput]);

  const handleFlightHeightCancel = useCallback(() => {
    setFlightHeightModal(null);
    setFlightHeightInput('');
    setFlightHeightError(null);
  }, []);

  const handleEditPointRequest = useCallback((pointIndex: number) => {
    // Queue the operation instead of executing immediately
    setEditQueue((prev) => [...prev, { type: 'editPointRequest', index: pointIndex }]);
  }, []);

  // Check if a point is an anchor for any climb points
  const checkAnchorPointAndWarn = useCallback((
    pointId: string | undefined,
    action: () => void
  ): boolean => {
    console.log('[CHECK_ANCHOR] Checking point:', {
      pointId,
      climbRequestsCount: climbRequests.length,
      climbRequests: climbRequests.map(c => ({
        endDistance: c.endDistance,
        anchorPointIdA: c.anchorPointIdA,
        anchorPointIdB: c.anchorPointIdB
      }))
    });

    if (!pointId) {
      // If point has no ID, proceed (old points without IDs)
      console.log('[CHECK_ANCHOR] Point has no ID, proceeding');
      action();
      return true;
    }
    
    const affectedClimbs = findClimbsAnchoredToPoint(pointId, climbRequests);
    
    console.log('[CHECK_ANCHOR] Affected climbs:', {
      pointId,
      affectedCount: affectedClimbs.length,
      affectedClimbs: affectedClimbs.map(c => ({
        endDistance: c.endDistance,
        climbAmount: c.climbAmount,
        anchorPointIdA: c.anchorPointIdA,
        anchorPointIdB: c.anchorPointIdB
      }))
    });
    
    if (affectedClimbs.length > 0) {
      // Show warning modal
      console.log('[CHECK_ANCHOR] Showing warning modal for', affectedClimbs.length, 'climb(s)');
      setAnchorWarningModal({
        isOpen: true,
        affectedClimbsCount: affectedClimbs.length,
        pendingAction: () => {
          console.log('[CHECK_ANCHOR] User confirmed, deleting affected climbs and executing action');
          // Delete affected climb points and then execute the action
          setClimbRequests((prev) => {
            const affectedIds = new Set(affectedClimbs.map(c => 
              `${c.endDistance}-${c.climbAmount}`
            ));
            const filtered = prev.filter(c => 
              !affectedIds.has(`${c.endDistance}-${c.climbAmount}`)
            );
            console.log('[CHECK_ANCHOR] Deleted climbs, remaining:', filtered.length);
            return filtered;
          });
          action();
        }
      });
      return false; // Action deferred
    }
    
    // No affected climbs, proceed immediately
    console.log('[CHECK_ANCHOR] No affected climbs, proceeding immediately');
    action();
    return true;
  }, [climbRequests, setClimbRequests]);

  // Wrapped edit operations that queue instead of executing immediately
  const handleDeletePoint = useCallback((index: number) => {
    const point = flightPath[index];
    if (!point?.id) {
      // Old point without ID, proceed normally
    setEditQueue((prev) => [...prev, { type: 'delete', index }]);
      return;
    }
    
    checkAnchorPointAndWarn(point.id, () => {
      setEditQueue((prev) => [...prev, { type: 'delete', index }]);
    });
  }, [flightPath, checkAnchorPointAndWarn]);

  const handleUpdatePoint = useCallback((index: number, point: Coordinate) => {
    const oldPoint = flightPath[index];
    if (!oldPoint?.id) {
      // Old point without ID, proceed normally
    setEditQueue((prev) => [...prev, { type: 'update', index, point }]);
      return;
    }
    
    // Check if position actually changed
    const positionChanged = 
      Math.abs(point.lng - oldPoint.lng) > 1e-9 || 
      Math.abs(point.lat - oldPoint.lat) > 1e-9;
    
    if (positionChanged) {
      checkAnchorPointAndWarn(oldPoint.id, () => {
        setEditQueue((prev) => [...prev, { type: 'update', index, point }]);
      });
    } else {
      // Position didn't change, just update metadata (e.g., height)
      setEditQueue((prev) => [...prev, { type: 'update', index, point }]);
    }
  }, [flightPath, checkAnchorPointAndWarn]);

  const handleSelectClimbPreset = useCallback((presetId: string) => {
    const preset = CLIMB_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setClimbConfig(presetToConfig(preset));
      setSelectedClimbPresetId(presetId);
    } else {
      setSelectedClimbPresetId('custom');
    }
  }, []);

  // Save Project handler
  const handleSaveProject = useCallback(() => {
    try {
      // Generate project data first
      const projectData = exportProject({
        dtmSource,
        dtmInfo,
        activeClippedId,
        dtmSourceType,
        localDtmFile,
        serverDtmId,
        serverDtmMetadata,
        aoiGeometry: aoiGeometry || undefined,
        routes,
        activeRouteId,
        climbRequestsByRoute,
        general: {
          nominalFlightHeight,
          safetyRadius: safetySearchRadius,
          safetyHeight,
          outputHeight: resolutionHeight
        },
        mission: {
          overlapPercentage,
          fovDegrees
        },
        ascendDescend: {
          selectedPresetId: selectedClimbPresetId,
          climbConfig
        },
        display: {
          dtmPalette: dtmDisplaySettings.palette,
          dtmInverted: dtmDisplaySettings.inverted,
          dtmOpacity: dtmDisplaySettings.opacity,
          showMetadata,
          showClimbLabels,
          showNextLineSuggestions
        },
        kmlImports
      });
      
      // Show save dialog with project data
      const defaultFilename = `project_${new Date().toISOString().split('T')[0]}${PROJECT_FILE_EXTENSION}`;
      const projectJson = JSON.stringify(projectData, null, 2);
      
      setSaveFileDialog({
        isOpen: true,
        type: 'project',
        defaultFilename,
        fileContent: projectJson,
        mimeType: 'application/json'
      });
    } catch (error) {
      console.error('Failed to save project:', error);
      alert(`שגיאה בשמירת הפרויקט: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
    }
  }, [
    dtmSource, dtmInfo, activeClippedId, dtmSourceType, localDtmFile, serverDtmId, serverDtmMetadata, aoiGeometry,
    routes, activeRouteId, climbRequestsByRoute,
    nominalFlightHeight, safetySearchRadius, safetyHeight, resolutionHeight,
    overlapPercentage, fovDegrees,
    selectedClimbPresetId, climbConfig,
    showMetadata, showClimbLabels,
    dtmDisplaySettings, showNextLineSuggestions, kmlImports
  ]);

  // Ctrl+S / Cmd+S: save project
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform?.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      const isKeyS = e.code === 'KeyS' || e.key === 's' || e.key === 'S';
      if (!modifier || !isKeyS) return;
      const activeElement = document.activeElement;
      if (activeElement) {
        const tagName = activeElement.tagName.toLowerCase();
        const isEditable =
          tagName === 'input' ||
          tagName === 'textarea' ||
          (activeElement as HTMLElement).isContentEditable ||
          activeElement.getAttribute('contenteditable') === 'true';
        if (isEditable) return;
      }
      e.preventDefault();
      handleSaveProject();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleSaveProject]);

  // Migrate entry height from AGL to ASL for old projects
  const migrateEntryHeightIfNeeded = useCallback(async (
    projectData: ProjectFileData,
    dtmSource: string | null
  ): Promise<ProjectFileData> => {
    // Check if migration is needed
    if (!(projectData as any)._needsEntryHeightMigration) {
      return projectData;
    }

    // Migration requires DTM and at least one route
    if (!dtmSource || !projectData.routes || projectData.routes.length === 0) {
      console.warn('Project migration: Cannot migrate entry height - DTM or routes not available. Project will load with AGL values (may be incorrect).');
      return projectData;
    }

    try {
      // Get ground elevation at the first point of the first route
      const firstRoute = projectData.routes[0];
      if (!firstRoute.points || firstRoute.points.length === 0) {
        return projectData;
      }

      const firstPoint = firstRoute.points[0];
      const secondPoint = firstRoute.points[1] || firstPoint;
      const coordinates = [
        [firstPoint.lng, firstPoint.lat],
        [secondPoint.lng, secondPoint.lat]
      ];

      const clippedIdMatch = dtmSource.match(/\/api\/dtm\/clipped\/([^/]+)/);
      const clippedId = clippedIdMatch ? clippedIdMatch[1] : undefined;

      const response = await fetch('/api/elevation-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coordinates,
          dtmPath: dtmSource,
          safetyRadiusMeters: 50,
          resolutionRadiusMeters: 50,
          ...(clippedId && { clippedId })
        })
      });

      if (!response.ok) {
        console.warn('Project migration: Failed to query ground elevation for migration');
        return projectData;
      }

      const data = await response.json();
      let groundElevation: number | null = null;

      if (data.profile && Array.isArray(data.profile) && data.profile.length > 0) {
        groundElevation = data.profile[0].elevation;
      } else if (data.elevations && Array.isArray(data.elevations) && data.elevations.length > 0) {
        groundElevation = data.elevations[0];
      } else if (data.elevation !== undefined) {
        groundElevation = data.elevation;
      }

      if (groundElevation === null || isNaN(groundElevation)) {
        console.warn('Project migration: Could not extract ground elevation');
        return projectData;
      }

      // Convert AGL to ASL: newEntryHeight = oldEntryHeight (AGL) + groundElevation
      const oldEntryHeight = projectData.general.nominalFlightHeight;
      const newEntryHeight = oldEntryHeight + groundElevation;

      console.log('Project migration: Converting entry height from AGL to ASL', {
        oldEntryHeight,
        groundElevation,
        newEntryHeight
      });

      // Update project data
      const migratedData: ProjectFileData = {
        ...projectData,
        general: {
          ...projectData.general,
          nominalFlightHeight: newEntryHeight
        },
        routes: projectData.routes.map(route => ({
          ...route,
          nominalFlightHeight: route.nominalFlightHeight + groundElevation
        }))
      };

      // Remove migration flag
      delete (migratedData as any)._needsEntryHeightMigration;

      return migratedData;
    } catch (error) {
      console.error('Project migration: Error during migration', error);
      return projectData;
    }
  }, []);

  // Restore project routes and climb points
  const restoreProjectRoutes = useCallback(async (projectData: ProjectFileData) => {
    // Migrate entry height if needed (AGL -> ASL)
    const migratedData = await migrateEntryHeightIfNeeded(projectData, dtmSource);
    
    // Convert project routes to FlightRoute format
    const restoredRoutes: FlightRoute[] = migratedData.routes.map((routeData) => ({
      id: routeData.id,
      name: routeData.name,
      color: routeData.color,
      lineWidth: typeof routeData.lineWidth === 'number' && Number.isFinite(routeData.lineWidth)
        ? routeData.lineWidth
        : 3,
      visible: routeData.visible,
      points: routeData.points.map(p => ({
        lng: p.lng,
        lat: p.lat,
        height: p.height,
        id: p.id
      })),
      nominalFlightHeight: routeData.nominalFlightHeight,
      entranceHeightFromFile: routeData.entranceHeightFromFile ?? true
    }));
    
    // Update nominalFlightHeight if it was migrated
    if (migratedData.general.nominalFlightHeight !== projectData.general.nominalFlightHeight) {
      setNominalFlightHeight(migratedData.general.nominalFlightHeight);
    }
    
    // Use importRoutes to restore all routes at once
    importRoutes(restoredRoutes, migratedData.climbRequestsByRoute);
  }, [importRoutes, migrateEntryHeightIfNeeded, dtmSource, setNominalFlightHeight]);

  // Load Project handler
  const handleLoadProject = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = PROJECT_FILE_ACCEPT;
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setIsLoadingProject(true);
      try {
        const projectData = await readProjectFile(file);
        
        // Step 1: Restore settings (but don't trigger heavy computations yet)
        // Note: Entry height may be migrated later if it's an old project (AGL -> ASL)
        // We'll set it after migration if needed
        const initialEntryHeight = projectData.general.nominalFlightHeight;
        setNominalFlightHeight(initialEntryHeight);
        setSafetySearchRadius(projectData.general.safetyRadius);
        setSafetyHeight(projectData.general.safetyHeight);
        setResolutionHeight(projectData.general.outputHeight);
        setOverlapPercentage(projectData.mission.overlapPercentage);
        setFovDegrees(projectData.mission.fovDegrees);
        setSelectedClimbPresetId(projectData.ascendDescend.selectedPresetId);
        setClimbConfig(projectData.ascendDescend.climbConfig);
        setShowMetadata(projectData.display.showMetadata ?? true);
        setShowClimbLabels(projectData.display.showClimbLabels ?? true);
        setShowNextLineSuggestions(projectData.display.showNextLineSuggestions ?? true);
        setKmlImports(projectData.kmlImports || []);
        
        // Step 2: Restore DTM
        if (projectData.dtm) {
          if (projectData.dtm.sourceType === 'local') {
            // Local DTM - need to prompt user to select file
            setMissingLocalDtmModal({
              isOpen: true,
              descriptor: projectData.dtm
            });
            // Store project data for later restore after DTM is selected
            (window as any).__pendingProjectRestore = projectData;
            setIsLoadingProject(false);
            return;
          } else if (projectData.dtm.sourceType === 'server') {
            // Server DTM - re-fetch from server
            try {
              if (!projectData.dtm.dtmServerId) {
                throw new Error('Missing server DTM identifier in project file');
              }

              const savedAoi = projectData.dtm.aoi ? {
                type: projectData.dtm.aoi.type,
                bbox: projectData.dtm.aoi.bbox ? {
                  minLon: projectData.dtm.aoi.bbox[0],
                  minLat: projectData.dtm.aoi.bbox[1],
                  maxLon: projectData.dtm.aoi.bbox[2],
                  maxLat: projectData.dtm.aoi.bbox[3]
                } : undefined,
                polygon: projectData.dtm.aoi.polygon
              } : undefined;

              // Keep project AOI/metadata in state for later replacements and UI hints.
              setServerDtmId(projectData.dtm.dtmServerId);
              setServerDtmMetadata({
                displayName: projectData.dtm.displayName,
                sizeBytes: projectData.dtm.sizeBytes,
                modifiedAt: projectData.dtm.modifiedAt
              });
              if (savedAoi) {
                setAoiGeometry(savedAoi);
              }

              if (savedAoi) {
                // Always re-clip from source DTM; do not rely on old clipped cache IDs.
                const clipBbox = savedAoi.bbox
                  ? [savedAoi.bbox.minLon, savedAoi.bbox.minLat, savedAoi.bbox.maxLon, savedAoi.bbox.maxLat]
                  : savedAoi.polygon && savedAoi.polygon.length > 0
                    ? [
                        Math.min(...savedAoi.polygon.map(([lon]) => lon)),
                        Math.min(...savedAoi.polygon.map(([, lat]) => lat)),
                        Math.max(...savedAoi.polygon.map(([lon]) => lon)),
                        Math.max(...savedAoi.polygon.map(([, lat]) => lat))
                      ]
                    : null;

                if (!clipBbox) {
                  throw new Error('Project DTM AOI is missing a valid bbox/polygon');
                }

                const clipResponse = await fetch('/api/dtm/clip', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    dtmId: projectData.dtm.dtmServerId,
                    aoi: {
                      type: 'bbox',
                      crs: 'EPSG:4326',
                      bbox: clipBbox
                    }
                  })
                });

                if (!clipResponse.ok) {
                  const errorData = await clipResponse.json().catch(() => ({}));
                  throw new Error(errorData.detail || errorData.error || `Failed to clip DTM: ${clipResponse.status}`);
                }

                const clipResult = await clipResponse.json();
                handleDtmLoad(clipResult.dataUrl, {
                  bounds: {
                    minX: clipResult.raster.bbox[0],
                    minY: clipResult.raster.bbox[1],
                    maxX: clipResult.raster.bbox[2],
                    maxY: clipResult.raster.bbox[3]
                  },
                  resolution: {
                    width: clipResult.raster.width,
                    height: clipResult.raster.height
                  },
                  clippedId: clipResult.clippedId,
                  crs: clipResult.raster.crs
                }, clipResult.clippedId, {
                  sourceType: 'server',
                  serverId: projectData.dtm.dtmServerId,
                  serverMetadata: {
                    displayName: projectData.dtm.displayName,
                    sizeBytes: projectData.dtm.sizeBytes,
                    modifiedAt: projectData.dtm.modifiedAt
                  },
                  aoi: savedAoi
                });
              } else {
                // No AOI, just load the full server DTM directly.
                handleDtmLoad(
                  `/api/dtm/${projectData.dtm.dtmServerId}/data`,
                  {},
                  undefined,
                  {
                    sourceType: 'server',
                    serverId: projectData.dtm.dtmServerId,
                    serverMetadata: {
                      displayName: projectData.dtm.displayName,
                      sizeBytes: projectData.dtm.sizeBytes,
                      modifiedAt: projectData.dtm.modifiedAt
                    }
                  }
                );
              }
            } catch (error) {
              console.error('Failed to load server DTM:', error);
              alert(`שגיאה בטעינת DTM מהשרת: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}\n\nהאם ברצונך להמשיך ללא DTM?`);
            }
          }
        }
        
        // Step 3: Restore routes and points (after DTM is loaded or skipped)
        // This will be done after DTM loading completes
        // Migration (AGL -> ASL) will happen during route restoration if needed
        if (!projectData.dtm || projectData.dtm.sourceType === 'server') {
          // Restore routes immediately if no DTM or server DTM loaded
          // Migration will be attempted if DTM is available
          await restoreProjectRoutes(projectData);
        } else {
          // For local DTM, routes will be restored after file is selected
          (window as any).__pendingProjectRestore = projectData;
        }
        
        setIsLoadingProject(false);
      } catch (error) {
        console.error('Failed to load project:', error);
        setIsLoadingProject(false);
        if (error instanceof ProjectValidationError) {
          alert(`שגיאה בקובץ הפרויקט: ${error.message}`);
        } else {
          alert(`שגיאה בטעינת הפרויקט: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
        }
      }
    };
    input.click();
  }, [setNominalFlightHeight, setSafetySearchRadius, setSafetyHeight, setResolutionHeight, setOverlapPercentage, setFovDegrees, setSelectedClimbPresetId, setClimbConfig, setShowMetadata, setShowClimbLabels, handleDtmLoad, setServerDtmId, setServerDtmMetadata, setAoiGeometry, restoreProjectRoutes]);

  // Handle missing local DTM file selection
  const handleMissingLocalDtmSelected = useCallback(async (file: File) => {
    const pendingProject = (window as any).__pendingProjectRestore as ProjectFileData | undefined;
    if (!pendingProject) {
      alert('שגיאה: נתוני הפרויקט לא נמצאו');
      setMissingLocalDtmModal({ isOpen: false, descriptor: null });
      return;
    }

    try {
      // Upload the local DTM file
      const formData = new FormData();
      formData.append('dtm', file);
      
      const response = await fetch('/api/upload-dtm', {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Failed to upload DTM: ${response.status}`);
      }
      
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Upload failed');
      }
      
      // Load the DTM
      handleDtmLoad(data.path, data, undefined, {
        sourceType: 'local',
        originalFile: file
      });
      
      // Restore routes after DTM is loaded (migration will happen if needed)
      setTimeout(async () => {
        await restoreProjectRoutes(pendingProject);
        (window as any).__pendingProjectRestore = undefined;
      }, 500);
      
      setMissingLocalDtmModal({ isOpen: false, descriptor: null });
    } catch (error) {
      console.error('Failed to load local DTM:', error);
      alert(`שגיאה בטעינת קובץ DTM: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
    }
  }, [handleDtmLoad, restoreProjectRoutes]);

  // Keyboard shortcuts for undo/redo are now handled globally by GlobalUndoRedoContext
  // which properly excludes text inputs and uses the unified action history

  return (
    <div className="app-container">
      <div className="app-header">
        <div className="header-left-section">
          <div className="header-title-container">
            <img src="/favicon.png" alt="Logo" className="app-logo" />
            <h1>מתכנן משימות LiDAR</h1>
          </div>
        </div>
        <div className="header-actions">
          <button
            onClick={handleUndo}
            disabled={!globalUndoRedo.canUndo}
            className="btn btn-secondary btn-icon header-action-btn"
            type="button"
            aria-label="בטל"
            title="בטל פעולה אחרונה (Ctrl+Z)"
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 14l-4-4 4-4" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 10h8a6 6 0 0 1 6 6v2" />
            </svg>
          </button>
          <button
            onClick={handleRedo}
            disabled={!globalUndoRedo.canRedo}
            className="btn btn-secondary btn-icon header-action-btn"
            type="button"
            aria-label="בצע שוב"
            title="בצע שוב (Ctrl+Y או Ctrl+Shift+Z)"
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 6l4 4-4 4" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M19 10h-8a6 6 0 0 0-6 6v2" />
            </svg>
          </button>
          <button
            onClick={handleSaveProject}
            className="btn btn-secondary btn-icon header-action-btn"
            type="button"
            aria-label="שמור פרויקט"
            title="שמור פרויקט (Ctrl+S)"
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M17 21v-8H7v8" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M7 3v5h8" />
            </svg>
          </button>
          <button
            onClick={handleLoadProject}
            disabled={isLoadingProject}
            className="btn btn-secondary btn-icon header-action-btn"
            type="button"
            aria-label="טען פרויקט"
            title="טען פרויקט"
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M17 8l-5-5-5 5" />
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 3v12" />
            </svg>
          </button>
          <button
            onClick={() => setKmlManagerModalOpen(true)}
            className="btn btn-secondary btn-icon header-action-btn"
            type="button"
            aria-label="נהל קבצי KML"
            title={`נהל קבצי KML${kmlImports.length > 0 ? ` (${kmlImports.length})` : ''}`}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z" />
            </svg>
            {kmlImports.length > 0 && (
              <span className="kml-count-badge">{kmlImports.length}</span>
            )}
          </button>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="btn btn-secondary btn-icon settings-header-btn"
            type="button"
            aria-label="הגדרות"
            title="הגדרות"
          >
            <GearIcon />
          </button>
        </div>
      </div>
      <div className="app-panels">
        <SplitPane
          direction="horizontal"
          initialRatio={0.6}
          minSizeFirst="300px"
          minSizeSecond="400px"
          storageKey="mapElevationSplit"
          className="app-split-pane"
        >
          <MapPanel
            dtmSource={dtmSource}
            clippedId={activeClippedId}
            routes={routes}
            activeRouteId={activeRouteId}
            flightPath={flightPath}
            onPathPointHover={handlePathPointHover}
            onPathChange={setFlightPath}
            onGroupMoveCommitted={handleGroupMoveCommitted}
            onDeleteAllPoints={handleDeleteAllPoints}
            onReverseFlightPath={handleReverseFlightPath}
            onAddPoint={addPointWrapped}
            onAddPoints={addPointsWrapped}
            onInsertPoints={insertPointsWrapped}
            onDeleteClimbsOnSegment={handleDeleteClimbsOnSegment}
            onUpdatePoint={handleUpdatePoint}
            onDeletePoint={handleDeletePoint}
            onAddRoute={addRoute}
            onActiveRouteChange={setActiveRoute}
            onRenameRoute={renameRoute}
            onRouteNominalFlightHeightChange={setRouteNominalFlightHeight}
            onRouteColorChange={setRouteColor}
            onRouteLineWidthChange={setRouteLineWidth}
            onToggleRouteVisibility={toggleRouteVisibility}
            onDeleteRoute={(routeId) => {
              deleteRoute(routeId);
              // Climb requests are now automatically removed in deleteRoute via undo/redo
            }}
            onShowAllRoutes={showAllRoutes}
            onHideNonActiveRoutes={hideNonActiveRoutes}
            onResetToSingleRoute={resetToSingleRoute}
            onDtmLoad={handleDtmLoad}
            onDtmUnload={handleDtmUnload}
            onDisplaySettingsChange={setDtmDisplaySettings}
            initialDisplaySettings={dtmDisplaySettings}
            currentAoi={aoiGeometry}
            dtmSourceType={dtmSourceType}
            zoomToBounds={zoomToBounds}
            climbMarkers={climbMarkers}
            showClimbLabels={showClimbLabels}
            onShowClimbLabelsChange={setShowClimbLabels}
            kmlImports={kmlImports}
            nominalFlightHeight={nominalFlightHeight}
            safetyRadius={safetySearchRadius}
            safetyHeight={safetyHeight}
            overlapPercentage={overlapPercentage}
            fovDegrees={fovDegrees}
            resolutionHeight={resolutionHeight}
            onUndo={handleUndo}
            canUndo={globalUndoRedo.canUndo}
            editPointIndex={editPointIndex}
            onEditPointIndexChange={setEditPointIndex}
            hoveredElevationPoint={hoveredElevationPoint}
            hoverSource={hoverSource}
            onOverlapGraphPointHover={handleOverlapGraphPointHover}
            showMetadata={showMetadata}
            onShowMetadataChange={setShowMetadata}
            showNextLineSuggestions={showNextLineSuggestions}
            onShowNextLineSuggestionsChange={setShowNextLineSuggestions}
            climbRequests={effectiveClimbRequests}
            elevationProfile={fullProfileResult.points}
            climbConfig={climbConfig}
            onExportClick={() => {
              const routesWithPoints = routes.filter(route => route.points.length >= 2);
              if (routesWithPoints.length > 1) {
                setShowExportModal(true);
              } else {
                // Single route - generate KML content and show save dialog
                const activeRoute = routes.find(r => r.id === activeRouteId);
                if (!activeRoute || activeRoute.points.length < 2) {
                  alert('Nothing to export. Add at least 2 points.');
                  return;
                }
                
                const routeClimbRequests = climbRequestsByRoute 
                  ? (climbRequestsByRoute[activeRoute.id] || [])
                  : (climbRequests && activeRoute.id === activeRouteId ? climbRequests : []);
                
                const kmlContent = generateKMLForRoute(activeRoute, routeClimbRequests, activeRoute.nominalFlightHeight);
                const defaultFilename = `${activeRoute.name.toLowerCase().replace(/\s+/g, '-')}.kml`;
                
                setSaveFileDialog({
                  isOpen: true,
                  type: 'kml',
                  defaultFilename,
                  fileContent: kmlContent,
                  mimeType: 'application/vnd.google-earth.kml+xml'
                });
              }
            }}
            onImportKML={async (file: File) => {
              await importKML(file, dtmSource);
            }}
            canExport={flightPath.length >= 2}
          />
          <ElevationProfile
            elevationProfile={fullProfileResult.points}
            loading={flightPath.length >= 2 && dtmSource !== null && (loading || isProcessingQueue || editQueue.length > 0 || !profileReady)}
            nominalFlightHeight={nominalFlightHeight}
            safetyHeight={safetyHeight}
            safetyRadius={safetySearchRadius}
            resolutionHeight={resolutionHeight}
            overlapPercentage={overlapPercentage}
            selectedPoint={selectedPoint}
            flightPath={flightPath}
            onDeletePoint={handleDeletePoint}
            onUpdatePoint={handleUpdatePoint}
            onSetFlightHeight={handleSetFlightHeight}
            onEditPointRequest={handleEditPointRequest}
            onElevationPointHover={handleElevationPointHover}
            hoveredPoint={hoveredElevationPoint}
            hoverSource={hoverSource}
            climbPresets={CLIMB_PRESETS}
            selectedClimbPresetId={selectedClimbPresetId}
            climbConfig={climbConfig}
            climbRequests={effectiveClimbRequests}
            setClimbRequests={setClimbRequests}
            climbWarnings={fullProfileResult.warnings}
            showMetadata={showMetadata}
            activeRouteName={routes.find(r => r.id === activeRouteId)?.name}
            dtmName={activeDtmName || undefined}
            profileError={profileError}
          />
        </SplitPane>
      </div>
      {profileError !== null && !profileErrorModalDismissed && (
        <div className="quick-modal__backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-error-title" onClick={() => setProfileErrorModalDismissed(true)}>
          <div className="quick-modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="quick-modal__header">
              <div className="quick-modal__title" id="profile-error-title">שגיאה ביצירת פרופיל הגובה</div>
              <button
                type="button"
                className="quick-modal__close"
                onClick={() => setProfileErrorModalDismissed(true)}
                aria-label="סגור"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body">
              <p className="quick-modal__error">לא ניתן ליצור את פרופיל הגובה. פרטים בהמשך.</p>
            </div>
            <div className="quick-modal__actions">
              <button type="button" className="btn btn-primary" onClick={() => setProfileErrorModalDismissed(true)}>
                סגור
              </button>
            </div>
          </div>
        </div>
      )}
      <ExportSettingsModal
        isOpen={showExportModal}
        routes={routes}
        activeRouteId={activeRouteId}
        onClose={() => setShowExportModal(false)}
        onExport={async (selectedRouteIds) => {
          // Filter routes that have at least 2 points
          const routesToExport = routes.filter(r => 
            selectedRouteIds.includes(r.id) && r.points.length >= 2
          );
          
          if (routesToExport.length === 0) {
            alert('No routes with at least 2 points selected.');
            return;
          }
          
          // Close the export modal first
          setShowExportModal(false);
          
          // If only one route, show save dialog with name and location
          if (routesToExport.length === 1) {
            const route = routesToExport[0];
            const routeClimbRequests = climbRequestsByRoute 
              ? (climbRequestsByRoute[route.id] || [])
              : (climbRequests && route.id === activeRouteId ? climbRequests : []);
            
            const kmlContent = generateKMLForRoute(route, routeClimbRequests, route.nominalFlightHeight);
            const defaultFilename = `${route.name.toLowerCase().replace(/\s+/g, '-')}.kml`;
            
            setSaveFileDialog({
              isOpen: true,
              type: 'kml',
              defaultFilename,
              fileContent: kmlContent,
              mimeType: 'application/vnd.google-earth.kml+xml'
            });
            return;
          }
          
          // Multiple routes: export as a single ZIP file
          try {
            // Generate KML content for all routes
            const routesWithKml = routesToExport.map(route => {
              const routeClimbRequests = climbRequestsByRoute 
                ? (climbRequestsByRoute[route.id] || [])
                : (climbRequests && route.id === activeRouteId ? climbRequests : []);
              
              const kmlContent = generateKMLForRoute(route, routeClimbRequests, route.nominalFlightHeight);
              return { route, kmlContent };
            });

            // Generate unique, sanitized filenames for each route
            const routeNames = routesWithKml.map((r: { route: FlightRoute; kmlContent: string }) => r.route.name);
            const baseNames = generateUniqueFilenames(routeNames);
            const files = routesWithKml.map((r: { route: FlightRoute; kmlContent: string }, i: number) => ({
              filename: `${baseNames[i]}.kml`,
              content: r.kmlContent
            }));

            // Create ZIP blob
            const { createKmlZip } = await import('./utils/kmlZip');
            const zipBlob = await createKmlZip(files);

            // Show save dialog for ZIP file (user chooses name and location)
            const defaultZipName = `routes_${new Date().toISOString().split('T')[0]}.zip`;
            setSaveFileDialog({
              isOpen: true,
              type: 'kml', // Use 'kml' type for styling, but it's actually a ZIP
              defaultFilename: defaultZipName,
              fileContent: zipBlob,
              mimeType: 'application/zip'
            });
          } catch (error: any) {
            console.error('Error creating ZIP:', error);
            alert(`שגיאה ביצוא המסלולים: ${error.message || 'שגיאה לא ידועה'}`);
          }
        }}
      />
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        safetyRadius={safetySearchRadius}
        setSafetyRadius={setSafetySearchRadius}
        safetyHeight={safetyHeight}
        setSafetyHeight={setSafetyHeight}
        outputHeight={resolutionHeight}
        setOutputHeight={setResolutionHeight}
        overlapPercentage={overlapPercentage}
        setOverlapPercentage={setOverlapPercentage}
        fovDegrees={fovDegrees}
        setFovDegrees={setFovDegrees}
        climbPresets={CLIMB_PRESETS}
        selectedClimbPresetId={selectedClimbPresetId}
        onSelectClimbPreset={handleSelectClimbPreset}
        climbConfig={climbConfig}
        setClimbConfig={setClimbConfig}
      />
      <AnchorPointWarningModal
        isOpen={anchorWarningModal.isOpen}
        affectedClimbsCount={anchorWarningModal.affectedClimbsCount}
        onCancel={() => {
          setAnchorWarningModal({
            isOpen: false,
            affectedClimbsCount: 0,
            pendingAction: null
          });
        }}
        onContinue={() => {
          if (anchorWarningModal.pendingAction) {
            anchorWarningModal.pendingAction();
          }
          setAnchorWarningModal({
            isOpen: false,
            affectedClimbsCount: 0,
            pendingAction: null
          });
        }}
      />
      {flightHeightModal && flightHeightModal.isOpen && (
        <div className="quick-modal__backdrop" role="dialog" aria-modal="true" onClick={handleFlightHeightCancel}>
          <div className="quick-modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="quick-modal__header">
              <div className="quick-modal__title">הזן גובה טיסה (AGL במטרים) עבור נקודה {flightHeightModal.pointIndex + 1}</div>
              <button
                type="button"
                className="quick-modal__close"
                onClick={handleFlightHeightCancel}
                aria-label="סגור"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body">
              <label className="quick-modal__label" htmlFor="flight-height-input">גובה (מ')</label>
              <input
                id="flight-height-input"
                type="number"
                min="0"
                max="10000"
                step="0.1"
                required
                inputMode="decimal"
                aria-required="true"
                value={flightHeightInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setFlightHeightInput(value);
                  
                  // Real-time validation
                  if (value === '') {
                    setFlightHeightError(null);
                    return;
                  }
                  
                  const numValue = parseFloat(value);
                  if (Number.isNaN(numValue)) {
                    setFlightHeightError('ערך חייב להיות מספר');
                  } else if (numValue < 0) {
                    setFlightHeightError('גובה חייב להיות מספר חיובי');
                  } else if (numValue > 10000) {
                    setFlightHeightError('גובה לא יכול להיות גדול מ-10000 מטרים');
                  } else {
                    setFlightHeightError(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleFlightHeightSubmit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    handleFlightHeightCancel();
                  }
                }}
                className={`quick-modal__input ${flightHeightError ? 'error' : ''}`}
                autoFocus
              />
              {flightHeightError && (
                <div className="quick-modal__error" role="alert">{flightHeightError}</div>
              )}
            </div>
            <div className="quick-modal__actions">
              <button type="button" className="btn btn-tertiary" onClick={handleFlightHeightCancel}>
                ביטול
              </button>
              <button type="button" className="btn btn-primary" onClick={handleFlightHeightSubmit}>
                החל
              </button>
            </div>
          </div>
        </div>
      )}
      {missingLocalDtmModal.isOpen && missingLocalDtmModal.descriptor && (
        <MissingLocalDTMModal
          isOpen={missingLocalDtmModal.isOpen}
          descriptor={missingLocalDtmModal.descriptor}
          onFileSelected={handleMissingLocalDtmSelected}
          onCancel={() => {
            setMissingLocalDtmModal({ isOpen: false, descriptor: null });
            (window as any).__pendingProjectRestore = undefined;
          }}
        />
      )}
      {saveFileDialog && (
        <SaveFileDialog
          isOpen={saveFileDialog.isOpen}
          defaultFilename={saveFileDialog.defaultFilename}
          fileExtension={
            saveFileDialog.mimeType === 'application/zip' 
              ? '.zip' 
              : saveFileDialog.type === 'kml' 
                ? '.kml' 
                : PROJECT_FILE_EXTENSION
          }
          title={
            saveFileDialog.mimeType === 'application/zip'
              ? 'שמור קובץ ZIP'
              : saveFileDialog.type === 'kml' 
                ? 'שמור קובץ KML' 
                : 'שמור פרויקט'
          }
          description={
            saveFileDialog.mimeType === 'application/zip'
              ? 'הזן שם קובץ לשמירת כל המסלולים בקובץ ZIP'
              : saveFileDialog.type === 'kml' 
                ? 'הזן שם קובץ לשמירת מסלול הטיסה' 
                : 'הזן שם קובץ לשמירת הפרויקט'
          }
          fileContent={saveFileDialog.fileContent}
          mimeType={saveFileDialog.mimeType}
          onClose={() => setSaveFileDialog(null)}
          onSave={async (filename: string) => {
            // If it's a ZIP file, show success notification after save
            if (saveFileDialog.mimeType === 'application/zip') {
              setSuccessNotification({
                isOpen: true,
                message: `נשמרו כל המסלולים בקובץ ZIP`
              });
            }
            // Call legacy callback if provided
            if (saveFileDialog.onSave) {
              saveFileDialog.onSave(filename);
            }
          }}
        />
      )}
      <KmlManagerModal
        isOpen={kmlManagerModalOpen}
        kmlImports={kmlImports}
        onDelete={handleDeleteKml}
        onColorChange={handleKmlColorChange}
        onSymbolChange={handleKmlSymbolChange}
        onVisibilityToggle={handleKmlVisibilityToggle}
        onZoomToKml={handleZoomToKml}
        onDeleteAll={handleDeleteAllKml}
        onImport={handleImportKml}
        onClose={() => setKmlManagerModalOpen(false)}
      />
      {importSummary && (
        <div style={{
          position: 'fixed',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#3b82f6',
          color: 'white',
          padding: '12px 24px',
          borderRadius: '8px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          zIndex: 10001,
          direction: 'rtl'
        }}>
          זוהו: {importSummary.points} נקודות, {importSummary.polygons} מצולעים. מייבא...
        </div>
      )}
      <SuccessNotification
        isOpen={successNotification.isOpen}
        message={successNotification.message}
        onClose={() => setSuccessNotification({ isOpen: false, message: '' })}
        autoCloseDelay={3000}
      />
      <ReverseWarningModal
        isOpen={reverseWarningOpen}
        onCancel={() => setReverseWarningOpen(false)}
        onContinue={() => {
          setReverseWarningOpen(false);
          reverseFlightPath();
        }}
      />
    </div>
  );
}

// Main App component that wraps AppContent with GlobalUndoRedoProvider
function App() {
  return (
    <GlobalUndoRedoProvider>
      <AppContent />
    </GlobalUndoRedoProvider>
  );
}

export default App;

