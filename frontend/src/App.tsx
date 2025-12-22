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
  const [searchRadius, setSearchRadius] = useState<number>(50);
  const [selectedPoint, setSelectedPoint] = useState<Coordinate | null>(null);
  
  // @ts-ignore
  const {flightPath, addPoint, addPoints,updatePoint, deletePoint, insertPoints, setFlightPath, exportGeoJSON,importGeoJSON,undo, redo, canUndo, canRedo
  } = useFlightPath();

  const { elevationProfile, loading, calculateProfile } = useElevationProfile();

  // Calculate elevation profile when flight path changes
  React.useEffect(() => {
    if (flightPath.length === 0) {
      // Clear profile when flight path is empty
      calculateProfile([], dtmSource || '', nominalFlightHeight, searchRadius);
    } else if (flightPath.length >= 2 && dtmSource) {
      calculateProfile(flightPath, dtmSource, nominalFlightHeight, searchRadius);
    }
  }, [flightPath, dtmSource, nominalFlightHeight, searchRadius, calculateProfile]);

  const handlePathPointHover = useCallback((point: Coordinate | null) => {
    setSelectedPoint(point);
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
    setDtmSource(null);
    setDtmInfo(null);
    // Clear all flight path points when unloading DTM
    setFlightPath([]);
  }, [setFlightPath]);

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
                <span className="input-label">Search Radius (m)</span>
                <input
                  type="number"
                  value={searchRadius}
                  onChange={(e) => setSearchRadius(Number(e.target.value))}
                  min="1"
                  step="5"
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
          flightPath={flightPath}
          onPathPointHover={handlePathPointHover}
          onPathChange={setFlightPath}
          onAddPoint={addPoint}
          onAddPoints={addPoints}
          onUpdatePoint={updatePoint}
          onDeletePoint={deletePoint}
          onDtmLoad={handleDtmLoad}
          onDtmUnload={handleDtmUnload}
          nominalFlightHeight={nominalFlightHeight}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
        />
        <ElevationProfile
          elevationProfile={elevationProfile}
          loading={loading}
          nominalFlightHeight={nominalFlightHeight}
          safetyHeight={safetyHeight}
          resolutionHeight={resolutionHeight}
          selectedPoint={selectedPoint}
          flightPath={flightPath}
        />
      </div>
    </div>
  );
}

export default App;

