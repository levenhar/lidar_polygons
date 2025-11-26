import { useState, useCallback } from 'react';
import { Coordinate } from '../App';

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
  const [flightPath, setFlightPathState] = useState<Coordinate[]>([]);

  const addPoint = useCallback((point: Coordinate) => {
    setFlightPathState(prev => [...prev, point]);
  }, []);

  const updatePoint = useCallback((index: number, point: Coordinate) => {
    setFlightPathState(prev => {
      const newPath = [...prev];
      newPath[index] = point;
      return newPath;
    });
  }, []);

  const deletePoint = useCallback((index: number) => {
    setFlightPathState(prev => prev.filter((_, i) => i !== index));
  }, []);

  const insertPoints = useCallback((index: number, points: Coordinate[]) => {
    setFlightPathState(prev => {
      const newPath = [...prev];
      newPath.splice(index, 0, ...points);
      return newPath;
    });
  }, []);

  const setFlightPath = useCallback((path: Coordinate[]) => {
    setFlightPathState(path);
  }, []);

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

      setFlightPathState(coordinates);
    } catch (error) {
      console.error('Error importing GeoJSON:', error);
      alert('Failed to import GeoJSON file');
    }
  }, []);

  return {
    flightPath,
    addPoint,
    updatePoint,
    deletePoint,
    insertPoints,
    setFlightPath,
    exportGeoJSON,
    importGeoJSON
  };
}


