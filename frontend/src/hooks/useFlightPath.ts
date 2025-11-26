import { useCallback } from 'react';
import { Coordinate } from '../App';
import { useUndoRedo } from './useUndoRedo';

export interface GeoJSONFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: number[][];
  };
  properties?: Record<string, any>;
}

export interface GeoJSON {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

export function useFlightPath() {
  const { state: flightPath, setState: setFlightPathState, undo, redo, canUndo, canRedo, resetHistory } = useUndoRedo<Coordinate[]>([]);

  const addPoint = useCallback((point: Coordinate) => {
    setFlightPathState([...flightPath, point], true);
  }, [flightPath, setFlightPathState]);

  const addPoints = useCallback((points: Coordinate[]) => {
    setFlightPathState([...flightPath, ...points], true);
  }, [flightPath, setFlightPathState]);

  const updatePoint = useCallback((index: number, point: Coordinate) => {
    const newPath = [...flightPath];
    newPath[index] = point;
    setFlightPathState(newPath, true);
  }, [flightPath, setFlightPathState]);

  const deletePoint = useCallback((index: number) => {
    setFlightPathState(flightPath.filter((_, i) => i !== index), true);
  }, [flightPath, setFlightPathState]);

  const insertPoints = useCallback((index: number, points: Coordinate[]) => {
    const newPath = [...flightPath];
    newPath.splice(index, 0, ...points);
    setFlightPathState(newPath, true);
  }, [flightPath, setFlightPathState]);

  const setFlightPath = useCallback((path: Coordinate[]) => {
    setFlightPathState(path, true);
  }, [setFlightPathState]);

  const exportGeoJSON = useCallback(() => {
    if (flightPath.length < 2) {
      alert('Flight path must have at least 2 points');
      return;
    }

    const coordinates = flightPath.map(p => [p.lng, p.lat]);
    const heights = flightPath.map(p => p.height);
    const hasHeights = heights.some(h => h !== undefined);
    
    const geoJSON: GeoJSON = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates
          },
          properties: {
            name: 'Flight Path',
            createdAt: new Date().toISOString(),
            ...(hasHeights && { heights })
          }
        }
      ]
    };

    const blob = new Blob([JSON.stringify(geoJSON, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flight-path-${Date.now()}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [flightPath]);

  const importGeoJSON = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const geoJSON: GeoJSON = JSON.parse(text);
      
      // Find the first LineString feature
      const lineStringFeature = geoJSON.features.find(
        f => f.geometry.type === 'LineString'
      );

      if (!lineStringFeature) {
        alert('No LineString feature found in GeoJSON');
        return;
      }

      const heights = lineStringFeature.properties?.heights as number[] | undefined;
      
      const coordinates = lineStringFeature.geometry.coordinates.map((coord, index) => ({
        lng: coord[0],
        lat: coord[1],
        ...(heights && heights[index] !== undefined && { height: heights[index] })
      }));

      resetHistory(coordinates);
    } catch (error) {
      console.error('Error importing GeoJSON:', error);
      alert('Failed to import GeoJSON file');
    }
  }, [resetHistory]);

  return {
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
  };
}


