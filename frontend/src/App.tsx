import React, { useState, useCallback } from 'react';
import MapPanel from './components/MapPanel';
import ElevationProfile from './components/ElevationProfile';
import ExportSettingsModal from './components/ExportSettingsModal';
import { useFlightPath } from './hooks/useFlightPath';
import { useElevationProfile } from './hooks/useElevationProfile';
import { ClimbConfig, BaseAltitudeSample, ClimbProfilePoint, ClimbPreset, computeClimbProfile } from './utils/climb';
import climbPresetData from './config/climbPresets.json';
import './App.css';

export interface Coordinate {
  lng: number;
  lat: number;
  height?: number; // Optional flight height in meters (AGL - Above Ground Level)
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
  vertexProximityMeters: 30
};

function presetToConfig(preset?: ClimbPreset): ClimbConfig {
  const source = preset ?? FALLBACK_CLIMB_CONFIG;
  return {
    climbRatio: source.climbRatio,
    descentRatio: source.descentRatio,
    allowTurnsDuringClimb: source.allowTurnsDuringClimb,
    linkRatios: source.linkRatios,
    vertexProximityMeters: source.vertexProximityMeters
  };
}

function App() {
  const [dtmSource, setDtmSource] = useState<string | null>(null);
  // @ts-ignore
  const [dtmInfo, setDtmInfo] = useState<DTMInfo | null>(null);
  const [activeClippedId, setActiveClippedId] = useState<string | null>(null);
  const [nominalFlightHeight, setNominalFlightHeight] = useState<number>(250);
  const [safetyHeight, setSafetyHeight] = useState<number>(140);
  const [resolutionHeight, setResolutionHeight] = useState<number>(270);
  const [safetySearchRadius, setSafetySearchRadius] = useState<number>(50);
  const [resolutionSearchRadius, setResolutionSearchRadius] = useState<number>(50);
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
    undo,
    redo,
    canUndo,
    canRedo
  } = useFlightPath(initialClimbRequestsByRoute);
  
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
  const setClimbRequests = React.useCallback((updater: React.SetStateAction<{ endDistance: number; climbAmount: number }[]>) => {
    setClimbRequestsByRoute((prev) => {
      const current = prev[activeRouteId] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [activeRouteId]: next };
    });
  }, [activeRouteId, setClimbRequestsByRoute]);

  const { elevationProfile, loading, profileReady, calculateProfile, refreshFlightHeights, clearProfile } = useElevationProfile();

  // Track last inputs so we can avoid expensive recalculation when only nominal height changes
  const lastProfileParamsRef = React.useRef<{
    flightPath: Coordinate[];
    dtmSource: string | null;
    safetySearchRadius: number;
    resolutionSearchRadius: number;
    nominalFlightHeight: number;
  } | null>(null);

  React.useEffect(() => {
    const prev = lastProfileParamsRef.current;
    const baseChanged = !prev
      || prev.flightPath !== flightPath
      || prev.dtmSource !== dtmSource
      || prev.safetySearchRadius !== safetySearchRadius
      || prev.resolutionSearchRadius !== resolutionSearchRadius;
    const nominalChanged = !prev || prev.nominalFlightHeight !== nominalFlightHeight;

    if (baseChanged) {
      if (flightPath.length === 0) {
        // Clear profile when flight path is empty
        calculateProfile([], dtmSource || '', nominalFlightHeight, safetySearchRadius, resolutionSearchRadius);
      } else if (flightPath.length >= 2 && dtmSource) {
        calculateProfile(flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius);
      }
    } else if (nominalChanged) {
      // Fast update: adjust flight heights without reloading elevations
      refreshFlightHeights(flightPath, nominalFlightHeight);
    }

    lastProfileParamsRef.current = {
      flightPath,
      dtmSource,
      safetySearchRadius,
      resolutionSearchRadius,
      nominalFlightHeight
    };
  }, [flightPath, dtmSource, nominalFlightHeight, safetySearchRadius, resolutionSearchRadius, calculateProfile, refreshFlightHeights]);

  // Clear climb requests only for segments that were edited (deleted or moved)
  // Don't clear climbs when points are inserted (new segments added)
  React.useEffect(() => {
    const currentGeometry = flightPath.map((p) => ({ lat: p.lat, lng: p.lng }));
    const prevGeometry = prevGeometryByRouteRef.current[activeRouteId];

    // If this is an insert operation, don't remove any climbs
    const isInsert = isInsertOperationRef.current;
    if (isInsert) {
      // Reset the flag after checking it
      isInsertOperationRef.current = false;
      prevGeometryByRouteRef.current[activeRouteId] = currentGeometry;
      return;
    }

    if (prevGeometry && climbRequests.length > 0) {
      const geometryChanged =
        prevGeometry.length !== currentGeometry.length ||
        prevGeometry.some((p, idx) => p.lat !== currentGeometry[idx]?.lat || p.lng !== currentGeometry[idx]?.lng);

      if (geometryChanged) {
        // Calculate which segments were affected
        const affectedSegments = new Set<number>();
        
        // Helper to compute cumulative distances
        const computeDistances = (path: Coordinate[]): number[] => {
          if (path.length === 0) return [];
          const distances = [0];
          for (let i = 1; i < path.length; i++) {
            const R = 6371000; // Earth radius in meters
            const dLat = ((path[i].lat - path[i - 1].lat) * Math.PI) / 180;
            const dLon = ((path[i].lng - path[i - 1].lng) * Math.PI) / 180;
            const a =
              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos((path[i - 1].lat * Math.PI) / 180) *
                Math.cos((path[i].lat * Math.PI) / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const dist = R * c;
            distances.push(distances[i - 1] + dist);
          }
          return distances;
        };
        
        // Helper to compare coordinates with tolerance
        const coordsEqual = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean => {
          return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
        };
        
        // Determine which segments were affected
        if (prevGeometry.length !== currentGeometry.length) {
          // Point was deleted or added - identify which one
          if (prevGeometry.length > currentGeometry.length) {
            // Point was deleted - find the deleted index by comparing sequences
            for (let i = 0; i < prevGeometry.length; i++) {
              // Check if removing point i would match current geometry
              let matches = true;
              for (let j = 0; j < currentGeometry.length; j++) {
                const prevIdx = j < i ? j : j + 1;
                if (prevIdx >= prevGeometry.length || !coordsEqual(currentGeometry[j], prevGeometry[prevIdx])) {
                  matches = false;
                  break;
                }
              }
              
              if (matches) {
                // Point at index i was deleted
                // Segments i-1 and i are affected (if they exist)
                if (i > 0 && i - 1 < prevGeometry.length - 1) affectedSegments.add(i - 1);
                if (i < prevGeometry.length - 1) affectedSegments.add(i);
                break;
              }
            }
            
            // If we couldn't identify the deleted point, don't remove any climbs
            // (be conservative - better to keep climbs than remove incorrectly)
          }
        } else {
          // Same length - points were moved
          // Find which points changed
          for (let i = 0; i < prevGeometry.length; i++) {
            if (!coordsEqual(prevGeometry[i], currentGeometry[i])) {
              // Point at index i was moved
              // Segments i-1 and i are affected (if they exist)
              if (i > 0 && i - 1 < prevGeometry.length - 1) affectedSegments.add(i - 1);
              if (i < prevGeometry.length - 1) affectedSegments.add(i);
            }
          }
        }
        
        // If we have affected segments, remove climbs on those segments
        if (affectedSegments.size > 0 && flightPath.length >= 2 && prevGeometry.length >= 2) {
          // Convert geometry to coordinates for distance calculation
          const prevPath: Coordinate[] = prevGeometry.map(p => ({ lat: p.lat, lng: p.lng }));
          const prevDistances = computeDistances(prevPath);
          
          // Filter out climbs that are on affected segments
          const climbsToKeep = climbRequests.filter((climb) => {
            // Find which segment this climb is on in the previous path
            let segmentIndex = -1;
            for (let i = 1; i < prevDistances.length; i++) {
              // Use tolerance for floating point comparison
              if (climb.endDistance >= prevDistances[i - 1] - 0.1 && 
                  climb.endDistance <= prevDistances[i] + 0.1) {
                segmentIndex = i - 1;
                break;
              }
            }
            
            // If climb is on an affected segment, remove it
            return segmentIndex === -1 || !affectedSegments.has(segmentIndex);
          });
          
          if (climbsToKeep.length !== climbRequests.length) {
            setClimbRequests(climbsToKeep);
          }
        } else if (affectedSegments.size === 0 && prevGeometry.length === currentGeometry.length) {
          // No segments were affected (maybe just metadata change), don't remove climbs
        }
      }
    }

    // Update the stored geometry for this specific route
    prevGeometryByRouteRef.current[activeRouteId] = currentGeometry;
  }, [flightPath, activeRouteId, climbRequests, setClimbRequests]);

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
  
  // Clear stable profile when all points are deleted
  React.useEffect(() => {
    if (flightPath.length === 0) {
      setStableProfileResult({ points: [], warnings: [] });
      profileLockedRef.current = false; // Unlock profile when cleared
    }
  }, [flightPath.length]);

  // Update stable profile only when:
  // 1. Queue is empty and processing is complete
  // 2. Server has confirmed profile is ready (profileReady)
  // 3. Profile is not locked (locked means it's already displayed and should not change)
  React.useEffect(() => {
    // Only update the stable profile when:
    // - Queue is completely empty and not processing
    // - Server has sent ready flag
    // - Profile is not locked (or we're starting a new calculation)
    // - Flight path is not empty (empty case is handled above)
    if (editQueue.length === 0 && !isProcessingQueue && profileReady && !profileLockedRef.current && flightPath.length > 0) {
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
      'האם אתה בטוח שברצונך לפרוק את ה-DTM?\n\nפעולה זו תמחק את כל הנקודות והמסלולים ותנקה את פרופיל הגובה.\n\nלא ניתן לבטל פעולה זו.'
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

  // Warn users that refreshing will clear points and unload the DTM; only clean up on confirmed unload.
  React.useEffect(() => {
    const cleanupDtm = () => {
      // Cleanup clipped DTM if exists - use direct DELETE endpoint
      if (activeClippedId) {
        try {
          // Use fetch with keepalive for reliable cleanup on page unload
          // sendBeacon only supports POST, so we use fetch with keepalive for DELETE
          fetch(`/api/dtm/clipped/${activeClippedId}`, {
            method: 'DELETE',
            keepalive: true
          }).catch(() => {
            // Ignore errors during cleanup - page might be unloading
          });
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
      
      // Cleanup legacy uploaded DTM if applicable
      if (dtmSource && !dtmSource.includes('/api/dtm/clipped/')) {
        try {
          const payload = JSON.stringify({ path: dtmSource });
          // Use sendBeacon for POST requests (more reliable during page unload)
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('/api/dtm/cleanup', blob);
          
          // Also try fetch with keepalive as fallback
          fetch('/api/dtm/cleanup', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: payload,
            keepalive: true
          }).catch(() => {
            // Ignore errors during cleanup
          });
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dtmSource && !activeClippedId && flightPath.length === 0) return;

      // Trigger cleanup before unload
      cleanupDtm();

      const warning = 'רענון ימחק את כל הנקודות ויפרוק את ה‑DTM. להמשיך?';
      event.preventDefault();
      event.returnValue = warning;
      return warning;
    };

    const handlePageHide = (event: PageTransitionEvent) => {
      // Only cleanup if page is not being cached (e.g., back/forward navigation)
      if (!event.persisted) {
        cleanupDtm();
      }
    };

    const handleVisibilityChange = () => {
      // Cleanup when page becomes hidden (user switching tabs, closing window, etc.)
      if (document.visibilityState === 'hidden') {
        cleanupDtm();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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

  // Wrapped undo/redo that processes queue first
  const handleUndo = React.useCallback(() => {
    // Process any pending queue first, then undo
    processEditQueueImmediately();
    // Use setTimeout to ensure queue processing completes before undo
    setTimeout(() => {
      undo();
    }, 100);
  }, [processEditQueueImmediately, undo]);

  const handleRedo = React.useCallback(() => {
    // Process any pending queue first, then redo
    processEditQueueImmediately();
    // Use setTimeout to ensure queue processing completes before redo
    setTimeout(() => {
      redo();
    }, 100);
  }, [processEditQueueImmediately, redo]);

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

  // Wrapped edit operations that queue instead of executing immediately
  const handleDeletePoint = useCallback((index: number) => {
    setEditQueue((prev) => [...prev, { type: 'delete', index }]);
  }, []);

  const handleUpdatePoint = useCallback((index: number, point: Coordinate) => {
    setEditQueue((prev) => [...prev, { type: 'update', index, point }]);
  }, []);

  const handleSelectClimbPreset = useCallback((presetId: string) => {
    const preset = CLIMB_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setClimbConfig(presetToConfig(preset));
      setSelectedClimbPresetId(presetId);
    } else {
      setSelectedClimbPresetId('custom');
    }
  }, []);

  // Handle keyboard shortcuts for undo/redo
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Ctrl+Z (undo) or Ctrl+Y / Ctrl+Shift+Z (redo)
      if (e.ctrlKey || e.metaKey) {
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          // Ctrl+Z or Cmd+Z: Undo
          e.preventDefault();
          if (canUndo) {
            handleUndo();
          }
        } else if (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
          // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z: Redo
          e.preventDefault();
          if (canRedo) {
            handleRedo();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleUndo, handleRedo, canUndo, canRedo]);

  return (
    <div className="app-container">
      <div className="app-header">
        <div className="header-left-section">
          <div className="header-title-container">
            <img src="/favicon.png" alt="Logo" className="app-logo" />
            <h1>מתכנן משימות LiDAR</h1>
          </div>
          <div className="header-parameters">
            <div className="header-group">
              <div className="group-title">פרמטרי טיסה</div>
              <div className="group-inputs">
                <label>
                  <span className="input-label">גובה נומינלי (מ'):</span>
                  <input
                    type="number"
                    value={nominalFlightHeight}
                    onChange={(e) => setNominalFlightHeight(Number(e.target.value))}
                    min="0"
                    step="10"
                    className="modern-input"
                  />
                </label>
                <label>
                  <span className="input-label">גובה בטיחות (מ'):</span>
                  <input
                    type="number"
                    value={safetyHeight}
                    onChange={(e) => setSafetyHeight(Number(e.target.value))}
                    min="0"
                    step="10"
                    className="modern-input"
                  />
                </label>
                <label>
                  <span className="input-label">גובה רזולוציה (מ'):</span>
                  <input
                    type="number"
                    value={resolutionHeight}
                    onChange={(e) => setResolutionHeight(Number(e.target.value))}
                    min="0"
                    step="10"
                    className="modern-input"
                  />
                </label>
                <label>
                  <span className="input-label">רדיוס בטיחות (מ'):</span>
                  <input
                    type="number"
                    value={safetySearchRadius}
                    onChange={(e) => setSafetySearchRadius(Number(e.target.value))}
                    min="1"
                    step="5"
                    className="modern-input"
                  />
                </label>
                <label>
                  <span className="input-label">רדיוס רזולוציה (מ'):</span>
                  <input
                    type="number"
                    value={resolutionSearchRadius}
                    onChange={(e) => setResolutionSearchRadius(Number(e.target.value))}
                    min="1"
                    step="5"
                    className="modern-input"
                  />
                </label>
              </div>
            </div>
            <div className="header-group">
              <div className="group-title">פרמטרי משימה</div>
              <div className="group-inputs">
                <label>
                  <span className="input-label">חפיפה (%):</span>
                  <input
                    type="number"
                    value={overlapPercentage}
                    onChange={(e) => setOverlapPercentage(Number(e.target.value))}
                    min="0"
                    max="99.9"
                    step="1"
                    className="modern-input"
                  />
                </label>
                <label>
                  <span className="input-label">שדה ראייה (°):</span>
                  <input
                    type="number"
                    value={fovDegrees}
                    onChange={(e) => setFovDegrees(Number(e.target.value))}
                    min="1"
                    max="179"
                    step="1"
                    className="modern-input"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
        <div className="header-controls">
          <div className="header-group">
            <div className="group-title">ייצוא מסלולים</div>
            <div className="group-columns export-controls-row">
              <button
                onClick={() => {
                  const routesWithPoints = routes.filter(route => route.points.length >= 2);
                  if (routesWithPoints.length > 1) {
                    setShowExportModal(true);
                  } else {
                    exportKML(climbRequests, climbRequestsByRoute);
                  }
                }}
                className={`btn btn-secondary btn-icon ${flightPath.length < 2 ? 'disabled' : ''}`}
                disabled={flightPath.length < 2}
                style={{
                  ...(flightPath.length < 2 ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}),
                  fontSize: '1rem',
                  fontWeight: 400,
                  fontFamily: 'inherit'
                }}
                title={flightPath.length < 2 ? 'שרטט לפחות 2 נקודות כדי לייצא מסלול' : 'ייצוא מסלול טיסה'}
                data-tooltip={flightPath.length < 2 ? 'שרטט לפחות 2 נקודות כדי לייצא מסלול' : 'ייצוא מסלול טיסה'}
              >
                <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 12.5L6 8.5H9V2H11V8.5H14L10 12.5ZM5 15H15V13H17V15C17 16.1 16.1 17 15 17H5C3.9 17 3 16.1 3 15V13H5V15Z" fill="currentColor"/>
                </svg>
              </button>
              <input
                type="file"
                accept=".kml"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const result = await importKML(file);
                    if (result) {
                      // Set climb requests for each imported route (now goes through undo/redo)
                      setClimbRequestsByRoute((prev) => {
                        const next = { ...prev };
                        result.routes.forEach((route) => {
                          // Associate climb requests with the first route (as per current importKML logic)
                          // If we have climb requests and this is the first route, assign them
                          if (result.climbRequests.length > 0 && route.id === result.routes[0]?.id) {
                            next[route.id] = result.climbRequests;
                          } else if (!next[route.id]) {
                            next[route.id] = [];
                          }
                        });
                        return next;
                      });
                    }
                    // Reset input so same file can be imported again
                    e.target.value = '';
                  }
                }}
                style={{ display: 'none' }}
                id="import-kml"
                disabled={!dtmSource}
              />
              <label
                htmlFor="import-kml"
                className={`btn btn-secondary btn-icon ${!dtmSource ? 'disabled' : ''}`}
                style={{
                  ...(!dtmSource ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}),
                  fontSize: '1rem',
                  fontWeight: 400,
                  fontFamily: 'inherit'
                }}
                title={!dtmSource ? 'טען DTM לפני העלאת מסלול' : 'העלאת מסלול טיסה'}
                data-tooltip={!dtmSource ? 'טען DTM לפני העלאת מסלול' : 'העלאת מסלול טיסה'}
              >
                <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 7.5L14 11.5H11V18H9V11.5H6L10 7.5ZM5 5H15V7H17V5C17 3.9 16.1 3 15 3H5C3.9 3 3 3.9 3 5V7H5V5Z" fill="currentColor"/>
                </svg>
              </label>
            </div>
          </div>
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
          onRedo={handleRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          editPointIndex={editPointIndex}
          onEditPointIndexChange={setEditPointIndex}
          hoveredElevationPoint={hoveredElevationPoint}
          hoverSource={hoverSource}
          showMetadata={showMetadata}
          onShowMetadataChange={setShowMetadata}
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
          onSelectClimbPreset={handleSelectClimbPreset}
          climbConfig={climbConfig}
          setClimbConfig={setClimbConfig}
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
          exportKML(climbRequests, climbRequestsByRoute, selectedRouteIds);
        }}
      />
    </div>
  );
}

export default App;

