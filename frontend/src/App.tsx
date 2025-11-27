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
  const [dtmInfo, setDtmInfo] = useState<DTMInfo | null>(null);
  const [nominalFlightHeight, setNominalFlightHeight] = useState<number>(250);
  const [safetyHeight, setSafetyHeight] = useState<number>(140);
  const [resolutionHeight, setResolutionHeight] = useState<number>(270);
  const [searchRadius, setSearchRadius] = useState<number>(50);
  const [selectedPoint, setSelectedPoint] = useState<Coordinate | null>(null);
  
  const {
    flightPath,
    addPoint,
    addPoints,
    updatePoint,
    deletePoint,
    insertPoints,
    setFlightPath,
    exportGeoJSON,
    importGeoJSON,
    undo,
    redo,
    canUndo,
    canRedo
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
  }, []);

  // Handle keyboard shortcuts for undo/redo
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Ctrl+Z (undo) or Ctrl+Y (redo)
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          // Prevent default browser undo behavior
          e.preventDefault();
          if (canUndo) {
            undo();
          }
        } else if (e.key === 'y' || e.key === 'Y') {
          // Prevent default browser redo behavior
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
          <label>
            Nominal Flight Height (m):
            <input
              type="number"
              value={nominalFlightHeight}
              onChange={(e) => setNominalFlightHeight(Number(e.target.value))}
              min="0"
              step="10"
            />
          </label>
          <label>
            Safety Height (m):
            <input
              type="number"
              value={safetyHeight}
              onChange={(e) => setSafetyHeight(Number(e.target.value))}
              min="0"
              step="10"
            />
          </label>
          <label>
            Resolution Height (m):
            <input
              type="number"
              value={resolutionHeight}
              onChange={(e) => setResolutionHeight(Number(e.target.value))}
              min="0"
              step="10"
            />
          </label>
          <label>
            Search Radius (m):
            <input
              type="number"
              value={searchRadius}
              onChange={(e) => setSearchRadius(Number(e.target.value))}
              min="1"
              step="5"
            />
          </label>
          <button onClick={exportGeoJSON}>Export GeoJSON</button>
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
          />
          <label htmlFor="import-geojson" className="button-label">
            Import GeoJSON
          </label>
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

