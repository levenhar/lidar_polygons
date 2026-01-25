import React, { useState, useCallback } from 'react';
import MapPanel from './components/MapPanel';
import ElevationProfile from './components/ElevationProfile';
import ExportSettingsModal from './components/ExportSettingsModal';
import SettingsModal, { GearIcon } from './components/SettingsModal';
import AnchorPointWarningModal from './components/AnchorPointWarningModal';
import MissingLocalDTMModal from './components/MissingLocalDTMModal';
import { useFlightPath, FlightRoute } from './hooks/useFlightPath';
import { useElevationProfile } from './hooks/useElevationProfile';
import { ClimbConfig, BaseAltitudeSample, ClimbProfilePoint, ClimbPreset, computeClimbProfile } from './utils/climb';
import climbPresetData from './config/climbPresets.json';
import { GlobalUndoRedoProvider, useGlobalUndoRedo } from './contexts/GlobalUndoRedoContext';
import { findClimbsAnchoredToPoint, ClimbRequest, getClimbPositionFromAnchors, findAnchorPointsForClimb } from './utils/climbAnchors';
import { computeCumulativeDistances } from './utils/constraints';
import { 
  exportProject, 
  readProjectFile, 
  downloadProjectFile, 
  PROJECT_FILE_EXTENSION,
  LocalDtmDescriptor,
  ProjectFileData,
  ProjectValidationError
} from './utils/projectSerializer';
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
  const [aoiGeometry, setAoiGeometry] = useState<{ type: 'bbox' | 'polygon' | 'kml'; bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number }; polygon?: [number, number][] } | null>(null);
  // Project load state
  const [missingLocalDtmModal, setMissingLocalDtmModal] = useState<{ isOpen: boolean; descriptor: LocalDtmDescriptor | null }>({ isOpen: false, descriptor: null });
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [safetyHeight, setSafetyHeight] = useState<number>(140);
  const [resolutionHeight, setResolutionHeight] = useState<number>(270);
  const [safetySearchRadius, setSafetySearchRadius] = useState<number>(50);
  const resolutionSearchRadius = 50;
  const [overlapPercentage, setOverlapPercentage] = useState<number>(50);
  const [fovDegrees, setFovDegrees] = useState<number>(100);
  const [selectedPoint, setSelectedPoint] = useState<Coordinate | null>(null);
  const [editPointIndex, setEditPointIndex] = useState<number | null>(null);
  const [hoveredElevationPoint, setHoveredElevationPoint] = useState<ElevationPoint | null>(null);
  const [hoverSource, setHoverSource] = useState<'map' | 'profile' | null>(null);
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
  const [flightHeightInput, setFlightHeightInput] = useState<string>('');
  const [flightHeightError, setFlightHeightError] = useState<string | null>(null);
  
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
      console.error('Failed to load climb requests from localStorage:', error);
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
    resetToSingleRoute,
    exportKML,
    importKML,
    importRoutes,
    setClimbRequestsByRoute,
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
      console.error('Failed to save climb requests to localStorage:', error);
    }
  }, [climbRequestsByRoute]);

  // Save showNextLineSuggestions to localStorage whenever it changes
  React.useEffect(() => {
    try {
      localStorage.setItem('showNextLineSuggestions', JSON.stringify(showNextLineSuggestions));
    } catch (error) {
      console.error('Failed to save showNextLineSuggestions to localStorage:', error);
    }
  }, [showNextLineSuggestions]);
  
  // Wrap insertPoints to mark it as an insert operation
  const insertPointsWrapped = React.useCallback((index: number, points: Coordinate[]) => {
    isInsertOperationRef.current = true;
    insertPoints(index, points);
  }, [insertPoints]);
  
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
    
    console.log('[CLIMB_REQUESTS] Processing requests:', {
      activeRouteId,
      requestsCount: requests.length,
      flightPathLength: flightPath.length,
      requests: requests.map((r: any) => ({
        endDistance: r.endDistance,
        climbAmount: r.climbAmount,
        anchorPointIdA: r.anchorPointIdA,
        anchorPointIdB: r.anchorPointIdB,
        segmentRatio: r.segmentRatio
      })),
      flightPathIds: flightPath.map(p => p.id)
    });
    
    // Assign anchor IDs to climb points that don't have them (for backward compatibility)
    if (flightPath.length >= 2 && requests.length > 0) {
      const updated = requests.map((climb: ClimbRequest, index: number) => {
        // If climb already has anchor IDs, keep it as is
        if (climb.anchorPointIdA && climb.anchorPointIdB) {
          console.log(`[CLIMB_REQUESTS] Climb ${index} already has anchors:`, {
            anchorPointIdA: climb.anchorPointIdA,
            anchorPointIdB: climb.anchorPointIdB,
            segmentRatio: climb.segmentRatio
          });
          return climb;
        }
        
        // Otherwise, try to find and assign anchor IDs and ratio
        console.log(`[CLIMB_REQUESTS] Climb ${index} missing anchors, finding them...`);
        const anchors = findAnchorPointsForClimb(climb.endDistance, flightPath);
        if (anchors) {
          console.log(`[CLIMB_REQUESTS] Climb ${index} assigned anchors:`, anchors);
          return {
            ...climb,
            anchorPointIdA: anchors.anchorPointIdA,
            anchorPointIdB: anchors.anchorPointIdB,
            segmentRatio: anchors.segmentRatio
          };
        }
        
        // If we can't find anchors (points don't have IDs), return as is
        console.log(`[CLIMB_REQUESTS] Climb ${index} cannot find anchors (points may not have IDs)`);
        return climb;
      });
      
      console.log('[CLIMB_REQUESTS] Final processed requests:', updated.map((r: ClimbRequest) => ({
        endDistance: r.endDistance,
        anchorPointIdA: r.anchorPointIdA,
        anchorPointIdB: r.anchorPointIdB,
        segmentRatio: r.segmentRatio
      })));
      
      return updated;
    }
    
    return requests;
  }, [climbRequestsByRoute, activeRouteId, flightPath]);
  
  // Set climb requests for the active route (now goes through undo/redo)
  const setClimbRequests = React.useCallback((updater: React.SetStateAction<ClimbRequest[]>) => {
    setClimbRequestsByRoute((prev) => {
      const current = prev[activeRouteId] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [activeRouteId]: next };
    });
  }, [activeRouteId, setClimbRequestsByRoute, flightPath]);
  
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

  const { elevationProfile, loading, profileReady, calculateProfile, clearProfile } = useElevationProfile();

  // Log flight path changes
  React.useEffect(() => {
    console.log('[FLIGHT_PATH_CHANGE] Flight path updated:', {
      length: flightPath.length,
      points: flightPath.map((p, i) => ({
        index: i,
        id: p.id,
        lng: p.lng,
        lat: p.lat,
        height: p.height
      }))
    });
  }, [flightPath]);

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

  React.useEffect(() => {
    const prev = lastProfileParamsRef.current;
    const baseChanged = !prev
      || prev.flightPath !== flightPath
      || prev.dtmSource !== dtmSource
      || prev.safetySearchRadius !== safetySearchRadius
      || prev.resolutionSearchRadius !== resolutionSearchRadius;

    // Clear any pending debounce timer
    if (profileCalculationTimeoutRef.current) {
      clearTimeout(profileCalculationTimeoutRef.current);
      profileCalculationTimeoutRef.current = null;
    }

    if (baseChanged) {
      if (flightPath.length === 0) {
        // Clear profile immediately when flight path is empty
        calculateProfile([], dtmSource || '', nominalFlightHeight, safetySearchRadius, resolutionSearchRadius);
      } else if (flightPath.length === 1) {
        // Clear profile immediately when only one point remains
        clearProfile();
      } else if (flightPath.length >= 2 && dtmSource) {
        // Debounce profile calculation to wait for user to finish adding points
        // This prevents sending too many requests when points are added quickly
        profileCalculationTimeoutRef.current = setTimeout(() => {
          calculateProfile(flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius);
          profileCalculationTimeoutRef.current = null;
        }, 300); // Wait 300ms after the last change
      }
    }
    // Note: When only nominal height changes, fullProfileResultInternal will recalculate
    // automatically via its useMemo dependency, and the profile lock is unlocked to allow updates

    lastProfileParamsRef.current = {
      flightPath,
      dtmSource,
      safetySearchRadius,
      resolutionSearchRadius,
      nominalFlightHeight
    };

    // Cleanup: cancel pending calculation if component unmounts or dependencies change
    return () => {
      if (profileCalculationTimeoutRef.current) {
        clearTimeout(profileCalculationTimeoutRef.current);
        profileCalculationTimeoutRef.current = null;
      }
    };
  }, [flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, calculateProfile, clearProfile]);

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

    // 3. Process climb requests sequentially
    const sortedClimbs = [...climbRequests].sort((a, b) => a.endDistance - b.endDistance);
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
  }, [elevationProfile, nominalFlightHeight, flightPath, climbRequests, climbConfig]);

  // Stable profile that only updates when queue is empty AND server confirms it's ready
  const [stableProfileResult, setStableProfileResult] = React.useState(() => fullProfileResultInternal);
  const profileLockedRef = React.useRef(false);
  
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
    // Only update the stable profile when:
    // - Queue is completely empty and not processing
    // - Server has sent ready flag
    // - Profile is not locked (or we're starting a new calculation)
    // - Flight path has at least 2 points (empty/1 point cases are handled above)
    if (editQueue.length === 0 && !isProcessingQueue && profileReady && !profileLockedRef.current && flightPath.length >= 2) {
      setStableProfileResult(fullProfileResultInternal);
      profileLockedRef.current = true; // Lock the profile once displayed
    }
  }, [fullProfileResultInternal, editQueue.length, isProcessingQueue, profileReady, flightPath.length]);

  // Use stable profile - this ensures the profile only shows the final version when queue is empty and ready
  const fullProfileResult = stableProfileResult;

  const climbMarkers = React.useMemo(() => {
    console.log('[CLIMB_MARKERS] Calculating markers:', {
      profilePointsCount: fullProfileResult.points.length,
      climbRequestsCount: climbRequests.length,
      flightPathLength: flightPath.length,
      climbRequests: climbRequests.map(c => ({
        endDistance: c.endDistance,
        climbAmount: c.climbAmount,
        anchorPointIdA: c.anchorPointIdA,
        anchorPointIdB: c.anchorPointIdB,
        segmentRatio: c.segmentRatio
      }))
    });

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

    climbRequests.forEach((climb, index) => {
      console.log(`[CLIMB_MARKERS] Processing climb ${index}:`, {
        endDistance: climb.endDistance,
        climbAmount: climb.climbAmount,
        anchorPointIdA: climb.anchorPointIdA,
        anchorPointIdB: climb.anchorPointIdB,
        segmentRatio: climb.segmentRatio,
        hasAnchors: !!(climb.anchorPointIdA && climb.anchorPointIdB)
      });

      // Calculate required horizontal distance for the climb
      const activeRatio = climb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const requiredHorizontal = Math.abs(climb.climbAmount) * activeRatio;

      // Try to get position from anchor points first (for anchored climbs)
      let endCoord: Coordinate | null = null;
      let endCoordMethod = 'none';
      if (climb.anchorPointIdA && climb.anchorPointIdB) {
        console.log(`[CLIMB_MARKERS] Climb ${index}: Attempting anchor-based positioning for end`);
        endCoord = getClimbPositionFromAnchors(climb, flightPath, climb.endDistance);
        if (endCoord) {
          endCoordMethod = 'anchors';
          console.log(`[CLIMB_MARKERS] Climb ${index}: End position from anchors:`, {
            lat: endCoord.lat,
            lng: endCoord.lng,
            anchorPointIdA: climb.anchorPointIdA,
            anchorPointIdB: climb.anchorPointIdB,
            segmentRatio: climb.segmentRatio
          });
        } else {
          console.log(`[CLIMB_MARKERS] Climb ${index}: Anchor-based positioning failed, falling back to distance`);
        }
      }
      
      // Fallback to distance-based calculation if no anchors or anchors not found
      if (!endCoord) {
        endCoordMethod = 'distance';
        const cumulativeDistances = computeCumulativeDistances(flightPath);
        endCoord = distanceToCoordinate(climb.endDistance, flightPath, cumulativeDistances);
        console.log(`[CLIMB_MARKERS] Climb ${index}: End position from distance:`, {
          lat: endCoord?.lat,
          lng: endCoord?.lng,
          endDistance: climb.endDistance,
          cumulativeDistances: cumulativeDistances
        });
      }
      
      if (!endCoord) {
        console.warn(`[CLIMB_MARKERS] Climb ${index}: Cannot calculate end position, skipping`);
        return;
      }

      // For start position, calculate based on segment ratio (not global distance)
      // This ensures the start position stays fixed relative to the anchor points
      let startCoord: Coordinate | null = null;
      let startCoordMethod = 'none';
      if (climb.anchorPointIdA && climb.anchorPointIdB && climb.segmentRatio !== undefined) {
        console.log(`[CLIMB_MARKERS] Climb ${index}: Attempting anchor-based positioning for start`);
        // Find anchor points
        const pointA = flightPath.find(p => p.id === climb.anchorPointIdA);
        const pointB = flightPath.find(p => p.id === climb.anchorPointIdB);
        
        console.log(`[CLIMB_MARKERS] Climb ${index}: Anchor points found:`, {
          pointA: pointA ? { id: pointA.id, lng: pointA.lng, lat: pointA.lat } : null,
          pointB: pointB ? { id: pointB.id, lng: pointB.lng, lat: pointB.lat } : null
        });
        
        if (pointA && pointB) {
          // Find segment indices to calculate segment length
          let segmentStartIdx = -1;
          let segmentEndIdx = -1;
          
          for (let i = 0; i < flightPath.length; i++) {
            if (flightPath[i].id === climb.anchorPointIdA) segmentStartIdx = i;
            if (flightPath[i].id === climb.anchorPointIdB) segmentEndIdx = i;
          }
          
          console.log(`[CLIMB_MARKERS] Climb ${index}: Segment indices:`, {
            segmentStartIdx,
            segmentEndIdx,
            consecutive: segmentEndIdx === segmentStartIdx + 1
          });
          
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
            
            console.log(`[CLIMB_MARKERS] Climb ${index}: Segment info:`, {
              segmentLength,
              requiredHorizontal,
              endSegmentRatio: climb.segmentRatio
            });
            
            if (segmentLength > 0) {
              // Calculate start ratio: go back requiredHorizontal meters from the end position
              // The end is at segmentRatio, so we need to calculate how much ratio to go back
              const ratioToGoBack = requiredHorizontal / segmentLength;
              const startRatio = Math.max(0, Math.min(1, climb.segmentRatio - ratioToGoBack));
              
              startCoord = {
                lng: pointA.lng + (pointB.lng - pointA.lng) * startRatio,
                lat: pointA.lat + (pointB.lat - pointA.lat) * startRatio
              };
              startCoordMethod = 'anchors';
              console.log(`[CLIMB_MARKERS] Climb ${index}: Start position from anchors:`, {
                lat: startCoord.lat,
                lng: startCoord.lng,
                startRatio,
                ratioToGoBack,
                endSegmentRatio: climb.segmentRatio
              });
            } else {
              console.log(`[CLIMB_MARKERS] Climb ${index}: Segment length is zero, using end position for start`);
              startCoord = { ...endCoord };
              startCoordMethod = 'anchors';
            }
          } else {
            console.log(`[CLIMB_MARKERS] Climb ${index}: Anchors not consecutive, cannot use anchor-based positioning for start`);
          }
        } else {
          console.log(`[CLIMB_MARKERS] Climb ${index}: Anchor points not found in flightPath`);
        }
      }
      
      // Fallback to distance-based calculation if anchor-based failed
      if (!startCoord) {
        startCoordMethod = 'distance';
        const cumulativeDistances = computeCumulativeDistances(flightPath);
        const startDistance = Math.max(0, climb.endDistance - requiredHorizontal);
        startCoord = distanceToCoordinate(startDistance, flightPath, cumulativeDistances);
        console.log(`[CLIMB_MARKERS] Climb ${index}: Start position from distance:`, {
          lat: startCoord?.lat,
          lng: startCoord?.lng,
          startDistance
        });
      }

      if (!startCoord) {
        return;
      }

      const sign = climb.climbAmount >= 0 ? '+' : '';
      const label = `${sign}${climb.climbAmount.toFixed(0)}m`;

      console.log(`[CLIMB_MARKERS] Climb ${index}: Final positions:`, {
        start: { lat: startCoord.lat, lng: startCoord.lng, method: startCoordMethod },
        end: { lat: endCoord.lat, lng: endCoord.lng, method: endCoordMethod },
        climbData: {
          endDistance: climb.endDistance,
          climbAmount: climb.climbAmount,
          anchorPointIdA: climb.anchorPointIdA,
          anchorPointIdB: climb.anchorPointIdB,
          segmentRatio: climb.segmentRatio
        }
      });

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

    console.log('[CLIMB_MARKERS] Final markers:', markers);
    return markers;
  }, [climbRequests, fullProfileResult.points, climbConfig, flightPath]);

  const deleteDtmOnServer = useCallback(async (pathToDelete?: string, clippedIdToDelete?: string, keepalive: boolean = false) => {
    const targetPath = pathToDelete || dtmSource;
    const targetClippedId = clippedIdToDelete || activeClippedId;

    // If we have a clipped ID, delete that first
    if (targetClippedId) {
      try {
        console.log(`Attempting to delete clipped DTM: ${targetClippedId}`);
        const response = await fetch(`/api/dtm/clipped/${targetClippedId}`, {
          method: 'DELETE',
          keepalive
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Failed to delete clipped DTM: ${targetClippedId} - ${response.status} ${response.statusText}`, errorText);
        } else {
          const result = await response.json().catch(() => ({}));
          console.log(`Successfully deleted clipped DTM: ${targetClippedId}`, result);
        }
      } catch (error) {
        console.error('Failed to delete clipped DTM on server:', error);
      }
    }

    // Also cleanup legacy uploaded files if applicable
    if (targetPath && !targetPath.includes('/api/dtm/clipped/')) {
      try {
        console.log(`Attempting to delete legacy DTM: ${targetPath}`);
        const response = await fetch('/api/dtm/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path: targetPath }),
          keepalive
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Failed to delete legacy DTM: ${targetPath} - ${response.status} ${response.statusText}`, errorText);
        } else {
          const result = await response.json().catch(() => ({}));
          console.log(`Successfully deleted legacy DTM: ${targetPath}`, result);
        }
      } catch (error) {
        console.error('Failed to delete DTM on server:', error);
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
        // Fallback: find the closest point in full profile by coordinates
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
      setHoverSource('map');
    } else {
      setHoveredElevationPoint(null);
      setHoverSource(null);
    }
  }, [fullProfileResult.points]);

  const handleElevationPointHover = useCallback((point: ElevationPoint | null) => {
    setHoveredElevationPoint(point);
    setHoverSource(point ? 'profile' : null);
  }, []);

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
      } else if (sourceType === 'server' && serverId) {
        setServerDtmId(serverId);
        setServerDtmMetadata(serverMetadata || null);
        setLocalDtmFile(null);
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
      deleteDtmOnServer(dtmSource || undefined, activeClippedId || undefined).catch((error) => {
        console.error('Failed to clean up DTM cache:', error);
      });
    }
    setDtmSource(null);
    setDtmInfo(null);
    setActiveClippedId(null);
    // Clear elevation profile when unloading DTM
    clearProfile();
    // Clear stable profile result
    setStableProfileResult({ points: [], warnings: [] });
    profileLockedRef.current = false; // Unlock profile
    // Clear routes when unloading DTM (keep only the first route)
    resetToSingleRoute();
  }, [dtmSource, activeClippedId, deleteDtmOnServer, resetToSingleRoute, clearProfile]);

  // Warn users that refreshing will clear points and unload the DTM
  // NOTE: We do NOT cleanup on page events anymore because:
  // 1. The lease protection system will handle cleanup when leases expire
  // 2. Aggressive cleanup can delete DTMs that are still in use
  // 3. If user refreshes, they may want to keep using the same DTM
  //
  // The lease protection system now handles cleanup:
  // - If client stops using DTM, lease expires after 2-5 minutes
  // - DTM can then be cleaned up by scheduled jobs
  // - But it won't be deleted while actively in use
  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dtmSource && !activeClippedId && flightPath.length === 0) return;

      const warning = 'רענון ימחק את כל הנקודות ויסיר את ה‑DTM. להמשיך?';
      event.preventDefault();
      event.returnValue = warning;
      return warning;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [dtmSource, activeClippedId, flightPath.length]);

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
        }
      });
      
      const filename = `project_${new Date().toISOString().split('T')[0]}${PROJECT_FILE_EXTENSION}`;
      downloadProjectFile(projectData, filename);
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
    dtmDisplaySettings
  ]);

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
      visible: routeData.visible,
      points: routeData.points.map(p => ({
        lng: p.lng,
        lat: p.lat,
        height: p.height,
        id: p.id
      })),
      nominalFlightHeight: routeData.nominalFlightHeight
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
    input.accept = PROJECT_FILE_EXTENSION;
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
              // If it was a clipped DTM, we need to re-clip it
              if (projectData.dtm.clippedId) {
                // Try to use the existing clipped DTM
                handleDtmLoad(
                  `/api/dtm/clipped/${projectData.dtm.clippedId}/data`,
                  { clippedId: projectData.dtm.clippedId },
                  projectData.dtm.clippedId,
                  {
                    sourceType: 'server',
                    serverId: projectData.dtm.dtmServerId,
                    serverMetadata: {
                      displayName: projectData.dtm.displayName,
                      sizeBytes: projectData.dtm.sizeBytes,
                      modifiedAt: projectData.dtm.modifiedAt
                    },
                    aoi: projectData.dtm.aoi ? {
                      type: projectData.dtm.aoi.type,
                      bbox: projectData.dtm.aoi.bbox ? {
                        minLon: projectData.dtm.aoi.bbox[0],
                        minLat: projectData.dtm.aoi.bbox[1],
                        maxLon: projectData.dtm.aoi.bbox[2],
                        maxLat: projectData.dtm.aoi.bbox[3]
                      } : undefined,
                      polygon: projectData.dtm.aoi.polygon
                    } : undefined
                  }
                );
              } else {
                // Regular server DTM - need to re-clip if AOI was used
                if (projectData.dtm.aoi) {
                  // Re-clip the DTM
                  // This will be handled by MapPanel's DTM loading flow
                  setServerDtmId(projectData.dtm.dtmServerId);
                  setServerDtmMetadata({
                    displayName: projectData.dtm.displayName,
                    sizeBytes: projectData.dtm.sizeBytes,
                    modifiedAt: projectData.dtm.modifiedAt
                  });
                  setAoiGeometry({
                    type: projectData.dtm.aoi.type,
                    bbox: projectData.dtm.aoi.bbox ? {
                      minLon: projectData.dtm.aoi.bbox[0],
                      minLat: projectData.dtm.aoi.bbox[1],
                      maxLon: projectData.dtm.aoi.bbox[2],
                      maxLat: projectData.dtm.aoi.bbox[3]
                    } : undefined,
                    polygon: projectData.dtm.aoi.polygon
                  });
                  // Store project data for later restore after DTM is loaded
                  (window as any).__pendingProjectRestore = projectData;
                  setIsLoadingProject(false);
                  alert('בחר DTM מהשרת ואזור עבודה כדי להמשיך את שחזור הפרויקט.');
                  return;
                } else {
                  // No AOI, just load the DTM directly
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
            title="שמור פרויקט"
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
        <MapPanel
          dtmSource={dtmSource}
          clippedId={activeClippedId}
          routes={routes}
          activeRouteId={activeRouteId}
          flightPath={flightPath}
          onPathPointHover={handlePathPointHover}
          onPathChange={setFlightPath}
          onAddPoint={addPointWrapped}
          onAddPoints={addPointsWrapped}
          onInsertPoints={insertPointsWrapped}
          onUpdatePoint={handleUpdatePoint}
          onDeletePoint={handleDeletePoint}
          onAddRoute={addRoute}
          onActiveRouteChange={setActiveRoute}
          onRenameRoute={renameRoute}
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
          climbMarkers={climbMarkers}
          showClimbLabels={showClimbLabels}
          onShowClimbLabelsChange={setShowClimbLabels}
          nominalFlightHeight={nominalFlightHeight}
          overlapPercentage={overlapPercentage}
          fovDegrees={fovDegrees}
          onUndo={handleUndo}
          canUndo={globalUndoRedo.canUndo}
          editPointIndex={editPointIndex}
          onEditPointIndexChange={setEditPointIndex}
          hoveredElevationPoint={hoveredElevationPoint}
          hoverSource={hoverSource}
          showMetadata={showMetadata}
          onShowMetadataChange={setShowMetadata}
          showNextLineSuggestions={showNextLineSuggestions}
          onShowNextLineSuggestionsChange={setShowNextLineSuggestions}
          climbRequests={climbRequests}
          elevationProfile={fullProfileResult.points}
          onExportClick={() => {
            const routesWithPoints = routes.filter(route => route.points.length >= 2);
            if (routesWithPoints.length > 1) {
              setShowExportModal(true);
            } else {
              const firstTurnPointElevation = elevationProfile.length > 0 ? elevationProfile[0]?.elevation : undefined;
              exportKML(climbRequests, climbRequestsByRoute, undefined, nominalFlightHeight, firstTurnPointElevation);
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
          resolutionHeight={resolutionHeight}
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
          climbRequests={climbRequests}
          setClimbRequests={setClimbRequests}
          climbWarnings={fullProfileResult.warnings}
          showMetadata={showMetadata}
        />
      </div>
      <ExportSettingsModal
        isOpen={showExportModal}
        routes={routes}
        activeRouteId={activeRouteId}
        onClose={() => setShowExportModal(false)}
        onExport={(selectedRouteIds) => {
          // Get elevation at first point (index 0) from elevation profile
          const firstTurnPointElevation = elevationProfile.length > 0 ? elevationProfile[0]?.elevation : undefined;
          exportKML(climbRequests, climbRequestsByRoute, selectedRouteIds, nominalFlightHeight, firstTurnPointElevation);
        }}
      />
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        nominalFlightHeight={nominalFlightHeight}
        setNominalFlightHeight={setNominalFlightHeight}
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

