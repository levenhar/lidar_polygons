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
  const [nominalFlightHeight, setNominalFlightHeight] = useState<number>(100);
  const [selectedPoint, setSelectedPoint] = useState<Coordinate | null>(null);
  
  const {
    flightPath,
    addPoint,
    updatePoint,
    deletePoint,
    insertPoints,
    setFlightPath,
    exportGeoJSON,
    importGeoJSON
  } = useFlightPath();

  const { elevationProfile, loading, calculateProfile } = useElevationProfile();

  // Calculate elevation profile when flight path changes
  React.useEffect(() => {
    if (flightPath.length === 0) {
      // Clear profile when flight path is empty
      calculateProfile([], dtmSource || '', nominalFlightHeight);
    } else if (flightPath.length >= 2 && dtmSource) {
      calculateProfile(flightPath, dtmSource, nominalFlightHeight);
    }
  }, [flightPath, dtmSource, nominalFlightHeight, calculateProfile]);

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
          onUpdatePoint={updatePoint}
          onDeletePoint={deletePoint}
          onDtmLoad={handleDtmLoad}
          nominalFlightHeight={nominalFlightHeight}
        />
        <ElevationProfile
          elevationProfile={elevationProfile}
          loading={loading}
          nominalFlightHeight={nominalFlightHeight}
          selectedPoint={selectedPoint}
          flightPath={flightPath}
        />
      </div>
    </div>
  );
}

export default App;

