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
  
  // Store climb requests per route ID
  const [climbRequestsByRoute, setClimbRequestsByRoute] = useState<Record<string, { endDistance: number; climbAmount: number }[]>>(loadClimbRequestsFromStorage);
  // Track previous geometry per route ID to detect geometry changes for each route independently
  const prevGeometryByRouteRef = React.useRef<Record<string, { lat: number; lng: number }[]>>({});
  
  // Save climb requests to localStorage whenever they change
  React.useEffect(() => {
    try {
      localStorage.setItem('climbRequestsByRoute', JSON.stringify(climbRequestsByRoute));
    } catch (error) {
      console.error('Failed to save climb requests to localStorage:', error);
    }
  }, [climbRequestsByRoute]);

  // @ts-ignore
  const {
    routes,
    activeRouteId,
    flightPath,
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
    undo,
    redo,
    canUndo,
    canRedo
  } = useFlightPath();

  // Get climb requests for the active route
  const climbRequests = React.useMemo(() => {
    return climbRequestsByRoute[activeRouteId] || [];
  }, [climbRequestsByRoute, activeRouteId]);
  
  // Set climb requests for the active route
  const setClimbRequests = React.useCallback((updater: React.SetStateAction<{ endDistance: number; climbAmount: number }[]>) => {
    setClimbRequestsByRoute((prev) => {
      const current = prev[activeRouteId] || [];
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [activeRouteId]: next };
    });
  }, [activeRouteId]);

  const { elevationProfile, loading, calculateProfile, refreshFlightHeights } = useElevationProfile();

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

  // Clear climb requests for active route whenever the flight path geometry changes (point added/moved/removed)
  // Only clear if the geometry of the CURRENT active route actually changed
  React.useEffect(() => {
    const currentGeometry = flightPath.map((p) => ({ lat: p.lat, lng: p.lng }));
    const prevGeometry = prevGeometryByRouteRef.current[activeRouteId];

    if (prevGeometry) {
      const geometryChanged =
        prevGeometry.length !== currentGeometry.length ||
        prevGeometry.some((p, idx) => p.lat !== currentGeometry[idx]?.lat || p.lng !== currentGeometry[idx]?.lng);

      if (geometryChanged && climbRequests.length > 0) {
        setClimbRequests([]);
      }
    }

    // Update the stored geometry for this specific route
    prevGeometryByRouteRef.current[activeRouteId] = currentGeometry;
  }, [flightPath, activeRouteId, climbRequests.length, setClimbRequests]);

  const fullProfileResult = React.useMemo(() => {
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
        await fetch(`/api/dtm/clipped/${targetClippedId}`, {
          method: 'DELETE',
          keepalive
        });
        console.log(`Deleted clipped DTM: ${targetClippedId}`);
      } catch (error) {
        console.error('Failed to delete clipped DTM on server:', error);
      }
    }

    // Also cleanup legacy uploaded files if applicable
    if (targetPath && !targetPath.includes('/api/dtm/clipped/')) {
      try {
        await fetch('/api/dtm/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path: targetPath }),
          keepalive
        });
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
    if (dtmSource || activeClippedId) {
      deleteDtmOnServer(dtmSource || undefined, activeClippedId || undefined).catch((error) => {
        console.error('Failed to clean up DTM cache:', error);
      });
    }
    setDtmSource(null);
    setDtmInfo(null);
    setActiveClippedId(null);
    // Clear routes when unloading DTM (keep only the first route)
    resetToSingleRoute();
  }, [dtmSource, activeClippedId, deleteDtmOnServer, resetToSingleRoute]);

  // Warn users that refreshing will clear points and unload the DTM; only clean up on confirmed unload.
  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dtmSource && !activeClippedId && flightPath.length === 0) return;

      const warning = 'רענון ימחק את כל הנקודות ויפרוק את ה‑DTM. להמשיך?';
      event.preventDefault();
      event.returnValue = warning;
      return warning;
    };

    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      
      // Cleanup clipped DTM if exists
      if (activeClippedId) {
        const payload = JSON.stringify({ clippedId: activeClippedId });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/dtm/cleanup', blob);
      }
      
      // Cleanup legacy uploaded DTM if applicable
      if (dtmSource && !dtmSource.includes('/api/dtm/clipped/')) {
        const payload = JSON.stringify({ path: dtmSource });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/dtm/cleanup', blob);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [dtmSource, activeClippedId, flightPath.length]);

  const handleSetFlightHeight = useCallback((pointIndex: number) => {
    if (pointIndex < 0 || pointIndex >= flightPath.length) return;
    const currentPoint = flightPath[pointIndex];
    const currentHeight = currentPoint.height ?? nominalFlightHeight;
    const heightInput = prompt(`הזן גובה טיסה (AGL במטרים) עבור נקודה ${pointIndex + 1}:`, currentHeight.toString());

    if (heightInput !== null) {
      const height = parseFloat(heightInput);
      if (!isNaN(height) && height >= 0) {
        updatePoint(pointIndex, {
          ...currentPoint,
          height
        });
      } else {
        alert('הגובה חייב להיות חיובי.');
      }
    }
  }, [flightPath, nominalFlightHeight, updatePoint]);

  const handleEditPointRequest = useCallback((pointIndex: number) => {
    setEditPointIndex(pointIndex);
    alert(`מצב עריכה: נקודה ${pointIndex + 1}. לחץ על המפה כדי להזיז.`);
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
            undo();
          }
        } else if (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
          // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z: Redo
          e.preventDefault();
          if (canRedo) {
            redo();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [undo, redo, canUndo, canRedo]);

  return (
    <div className="app-container">
      <div className="app-header">
        <div className="header-title-container">
          <img src="/favicon.png" alt="Logo" className="app-logo" />
          <h1>מתכנן משימות LiDAR</h1>
        </div>
        <div className="header-controls">
          <div className="header-group">
            <div className="group-title">פרמטרי טיסה</div>
            <div className="group-inputs">
              <label>
                <span className="input-label">גובה נומינלי (מ')</span>
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
                <span className="input-label">גובה בטיחות (מ')</span>
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
                <span className="input-label">גובה רזולוציה (מ')</span>
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
                <span className="input-label">רדיוס בטיחות (מ')</span>
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
                <span className="input-label">רדיוס רזולוציה (מ')</span>
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
                <span className="input-label">חפיפה (%)</span>
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
                <span className="input-label">שדה ראייה (°)</span>
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
          <div className="header-group">
            <div className="group-title">ייצוא נתונים</div>
            <div className="group-columns">
              <div className="group-column">
                <button
                  onClick={() => {
                    const routesWithPoints = routes.filter(route => route.points.length >= 2);
                    if (routesWithPoints.length > 1) {
                      setShowExportModal(true);
                    } else {
                      exportKML(climbRequests, climbRequestsByRoute);
                    }
                  }}
                  className={`btn btn-secondary ${flightPath.length < 2 ? 'disabled' : ''}`}
                  disabled={flightPath.length < 2}
                  style={{
                    ...(flightPath.length < 2 ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}),
                    fontSize: '1rem',
                    fontWeight: 400,
                    fontFamily: 'inherit'
                  }}
                  title={flightPath.length < 2 ? 'שרטט לפחות 2 נקודות כדי לייצא מסלול' : 'ייצוא מסלול טיסה'}
                >
                  ייצוא מסלול
                </button>
                <input
                  type="file"
                  accept=".kml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const result = await importKML(file);
                      if (result) {
                        // Set climb requests for each imported route
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
                          // Save to localStorage
                          try {
                            localStorage.setItem('climbRequestsByRoute', JSON.stringify(next));
                          } catch (error) {
                            console.error('Failed to save climb requests to localStorage after import:', error);
                          }
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
                  className={`btn btn-secondary ${!dtmSource ? 'disabled' : ''}`}
                  style={{
                    ...(!dtmSource ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}),
                    fontSize: '1rem',
                    fontWeight: 400,
                    fontFamily: 'inherit'
                  }}
                  title={!dtmSource ? 'טען DTM לפני העלאת מסלול' : 'העלאת מסלול טיסה'}
                >
                  העלאת מסלול
                </label>
              </div>
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
          onAddPoint={addPoint}
          onAddPoints={addPoints}
          onInsertPoints={insertPoints}
          onUpdatePoint={updatePoint}
          onDeletePoint={deletePoint}
          onAddRoute={addRoute}
          onActiveRouteChange={setActiveRoute}
          onRenameRoute={renameRoute}
          onToggleRouteVisibility={toggleRouteVisibility}
          onDeleteRoute={(routeId) => {
            deleteRoute(routeId);
            // Remove climb requests for the deleted route
            setClimbRequestsByRoute((prev) => {
              const next = { ...prev };
              delete next[routeId];
              // Also remove from localStorage
              try {
                localStorage.setItem('climbRequestsByRoute', JSON.stringify(next));
              } catch (error) {
                console.error('Failed to update localStorage after route deletion:', error);
              }
              return next;
            });
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
          onUndo={undo}
          onRedo={redo}
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
          loading={loading}
          nominalFlightHeight={nominalFlightHeight}
          safetyHeight={safetyHeight}
          resolutionHeight={resolutionHeight}
          selectedPoint={selectedPoint}
          flightPath={flightPath}
          onDeletePoint={deletePoint}
          onUpdatePoint={updatePoint}
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

