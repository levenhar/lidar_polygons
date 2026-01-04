import React, { useState, useCallback } from 'react';
import MapPanel from './components/MapPanel';
import ElevationProfile from './components/ElevationProfile';
import { useFlightPath } from './hooks/useFlightPath';
import { useElevationProfile } from './hooks/useElevationProfile';
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
}

interface DTMInfo {
  path: string;
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

function App() {
  const [dtmSource, setDtmSource] = useState<string | null>(null);
  // @ts-ignore
  const [dtmInfo, setDtmInfo] = useState<DTMInfo | null>(null);
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
    exportGeoJSON,
    importGeoJSON,
    undo,
    redo,
    canUndo,
    canRedo
  } = useFlightPath();

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

  const deleteDtmOnServer = useCallback(async (pathToDelete?: string, keepalive: boolean = false) => {
    const target = pathToDelete || dtmSource;
    if (!target) return;

    try {
      await fetch('/api/dtm/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: target }),
        keepalive
      });
    } catch (error) {
      console.error('Failed to delete DTM on server:', error);
    }
  }, [dtmSource]);

  const handlePathPointHover = useCallback((point: Coordinate | null) => {
    setSelectedPoint(point);
  }, []);

  const handleElevationPointHover = useCallback((point: ElevationPoint | null) => {
    setHoveredElevationPoint(point);
  }, []);

  const handleDtmLoad = useCallback((source: string, info?: any) => {
    setDtmSource(source);
    if (info) {
      setDtmInfo({
        path: source,
        bounds: info.bounds
      });
    }
  }, []);

  const handleDtmUnload = useCallback(() => {
    if (dtmSource) {
      deleteDtmOnServer(dtmSource).catch((error) => {
        console.error('Failed to clean up DTM cache:', error);
      });
    }
    setDtmSource(null);
    setDtmInfo(null);
    // Clear routes when unloading DTM (keep only the first route)
    resetToSingleRoute();
  }, [dtmSource, deleteDtmOnServer, resetToSingleRoute]);

  // Warn users that refreshing will clear points and unload the DTM; only clean up on confirmed unload.
  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dtmSource && flightPath.length === 0) return;

      const warning = 'Refreshing will delete all points and unload the DTM. Continue?';
      event.preventDefault();
      event.returnValue = warning;
      return warning;
    };

    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      if (!dtmSource) return;

      const payload = JSON.stringify({ path: dtmSource });
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/dtm/cleanup', blob);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [dtmSource, flightPath.length]);

  const handleSetFlightHeight = useCallback((pointIndex: number) => {
    if (pointIndex < 0 || pointIndex >= flightPath.length) return;
    const currentPoint = flightPath[pointIndex];
    const currentHeight = currentPoint.height ?? nominalFlightHeight;
    const heightInput = prompt(`Enter flight height (AGL in meters) for point ${pointIndex + 1}:`, currentHeight.toString());
    
    if (heightInput !== null) {
      const height = parseFloat(heightInput);
      if (!isNaN(height) && height >= 0) {
        updatePoint(pointIndex, {
          ...currentPoint,
          height
        });
      } else {
        alert('Height must be positive.');
      }
    }
  }, [flightPath, nominalFlightHeight, updatePoint]);

  const handleEditPointRequest = useCallback((pointIndex: number) => {
    setEditPointIndex(pointIndex);
    alert(`Editing point ${pointIndex + 1}. Click the map to move it.`);
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
        <h1>LiDAR Mission Planner</h1>
        <div className="header-controls">
          <div className="header-group">
            <div className="group-title">Flight Parameters</div>
            <div className="group-inputs">
              <label>
                <span className="input-label">Nominal Height (m)</span>
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
                <span className="input-label">Safety (m)</span>
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
                <span className="input-label">Resolution (m)</span>
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
                <span className="input-label">Safety Radius (m)</span>
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
                <span className="input-label">Resolution Radius (m)</span>
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
            <div className="group-title">Mission Parameters</div>
            <div className="group-inputs">
              <label>
                <span className="input-label">Overlap (%)</span>
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
                <span className="input-label">FOV (°)</span>
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
            <div className="group-title">Data Export</div>
            <div className="group-columns">
              <div className="group-column">
                <button 
                  onClick={exportGeoJSON} 
                  className="btn btn-secondary"
                  disabled={flightPath.length < 2}
                  title={flightPath.length < 2 ? 'Draw at least 2 points to export GeoJSON' : 'Export flight path as GeoJSON'}
                >
                  Export GeoJSON
                </button>
                <input
                  type="file"
                  accept=".geojson,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      importGeoJSON(file);
                    }
                  }}
                  style={{ display: 'none' }}
                  id="import-geojson"
                  disabled={!dtmSource}
                />
                <label 
                  htmlFor="import-geojson" 
                  className={`btn btn-secondary ${!dtmSource ? 'disabled' : ''}`}
                  style={!dtmSource ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
                  title={!dtmSource ? 'Load a DTM first to import GeoJSON' : 'Import flight path from GeoJSON file'}
                >
                  Import GeoJSON
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="app-panels">
        <MapPanel
          dtmSource={dtmSource}
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
          onDeleteRoute={deleteRoute}
          onShowAllRoutes={showAllRoutes}
          onHideNonActiveRoutes={hideNonActiveRoutes}
          onResetToSingleRoute={resetToSingleRoute}
          onDtmLoad={handleDtmLoad}
          onDtmUnload={handleDtmUnload}
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
        />
        <ElevationProfile
          elevationProfile={elevationProfile}
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
        />
      </div>
    </div>
  );
}

export default App;

