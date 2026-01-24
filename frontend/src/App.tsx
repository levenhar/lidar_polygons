import React, { useState, useCallback } from 'react';
import MapPanel from './components/MapPanel';
import ElevationProfile from './components/ElevationProfile';
import ExportSettingsModal from './components/ExportSettingsModal';
import SettingsModal, { GearIcon } from './components/SettingsModal';
import AnchorPointWarningModal from './components/AnchorPointWarningModal';
import { useFlightPath } from './hooks/useFlightPath';
import { useElevationProfile } from './hooks/useElevationProfile';
import { ClimbConfig, BaseAltitudeSample, ClimbProfilePoint, ClimbPreset, computeClimbProfile } from './utils/climb';
import climbPresetData from './config/climbPresets.json';
import { GlobalUndoRedoProvider, useGlobalUndoRedo } from './contexts/GlobalUndoRedoContext';
import { findClimbsAnchoredToPoint, ClimbRequest } from './utils/climbAnchors';
import './App.css';

export interface Coordinate {
  lng: number;
  lat: number;
  height?: number; // Optional flight height in meters (AGL - Above Ground Level)
  id?: string; // Stable ID for the point (used to anchor climb points)
}

export interface ElevationPoint {
  distance: number;
  elevation: number;
  longitude: number;
  latitude: number;
  flightHeight?: number; // Interpolated flight height (AGL) at this point
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

  const [selectedClimbPresetId, setSelectedClimbPresetId] = useState<string>(CLIMB_PRESETS[0]?.id ?? 'custom');
  const [climbConfig, setClimbConfig] = useState<ClimbConfig>(presetToConfig(CLIMB_PRESETS[0]));
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  
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
  
  // Track previous geometry per route ID to detect geometry changes for each route independently
  const prevGeometryByRouteRef = React.useRef<Record<string, { lat: number; lng: number }[]>>({});
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

  // Get climb requests for the active route
  const climbRequests = React.useMemo(() => {
    return climbRequestsByRoute[activeRouteId] || [];
  }, [climbRequestsByRoute, activeRouteId]);
  
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

    // 1. Calculate base altitude profile (nominal height above first point)
    const startElevation = elevationProfile[0].elevation;
    const constantAltitude = startElevation + nominalFlightHeight;
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
    if (!fullProfileResult.points.length || climbRequests.length === 0) return [];

    const markers: { lat: number; lng: number; label: string; type: 'start' | 'end' }[] = [];

    climbRequests.forEach((climb) => {
      // Calculate start distance
      const activeRatio = climb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const requiredHorizontal = Math.abs(climb.climbAmount) * activeRatio;
      const startDistance = Math.max(0, climb.endDistance - requiredHorizontal);

      // Find the closest profile point to the climb start distance
      let closestStart = fullProfileResult.points[0];
      let minDeltaStart = Math.abs(closestStart.distance - startDistance);
      for (const p of fullProfileResult.points) {
        const delta = Math.abs(p.distance - startDistance);
        if (delta < minDeltaStart) {
          minDeltaStart = delta;
          closestStart = p;
        }
      }

      // Find the closest profile point to the climb end distance
      let closestEnd = fullProfileResult.points[0];
      let minDeltaEnd = Math.abs(closestEnd.distance - climb.endDistance);
      for (const p of fullProfileResult.points) {
        const delta = Math.abs(p.distance - climb.endDistance);
        if (delta < minDeltaEnd) {
          minDeltaEnd = delta;
          closestEnd = p;
        }
      }

      const sign = climb.climbAmount >= 0 ? '+' : '';
      const label = `${sign}${climb.climbAmount.toFixed(0)}m`;

      // Add start marker
      markers.push({
        lat: closestStart.latitude,
        lng: closestStart.longitude,
        label: '',
        type: 'start'
      });

      // Add end marker
      markers.push({
        lat: closestEnd.latitude,
        lng: closestEnd.longitude,
        label: label,
        type: 'end'
      });
    });

    return markers;
  }, [climbRequests, fullProfileResult.points, climbConfig]);

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

  const handleDtmLoad = useCallback((source: string, info?: any, clippedId?: string) => {
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
    const heightInput = prompt(`הזן גובה טיסה (AGL במטרים) עבור נקודה ${pointIndex + 1}:`, currentHeight.toString());

    if (heightInput !== null) {
      const height = parseFloat(heightInput);
      if (!isNaN(height) && height >= 0) {
        // Queue the operation instead of executing immediately
        setEditQueue((prev) => [...prev, { type: 'setFlightHeight', index: pointIndex, height }]);
      } else {
        alert('הגובה חייב להיות חיובי.');
      }
    }
  }, [flightPath, nominalFlightHeight]);

  const handleEditPointRequest = useCallback((pointIndex: number) => {
    // Queue the operation instead of executing immediately
    setEditQueue((prev) => [...prev, { type: 'editPointRequest', index: pointIndex }]);
  }, []);

  // Check if a point is an anchor for any climb points
  const checkAnchorPointAndWarn = useCallback((
    pointId: string | undefined,
    action: () => void
  ): boolean => {
    if (!pointId) {
      // If point has no ID, proceed (old points without IDs)
      action();
      return true;
    }
    
    const affectedClimbs = findClimbsAnchoredToPoint(pointId, climbRequests);
    
    if (affectedClimbs.length > 0) {
      // Show warning modal
      setAnchorWarningModal({
        isOpen: true,
        affectedClimbsCount: affectedClimbs.length,
        pendingAction: () => {
          // Delete affected climb points and then execute the action
          setClimbRequests((prev) => {
            const affectedIds = new Set(affectedClimbs.map(c => 
              `${c.endDistance}-${c.climbAmount}`
            ));
            return prev.filter(c => 
              !affectedIds.has(`${c.endDistance}-${c.climbAmount}`)
            );
          });
          action();
        }
      });
      return false; // Action deferred
    }
    
    // No affected climbs, proceed immediately
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
          climbRequests={climbRequests}
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

