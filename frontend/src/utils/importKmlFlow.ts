/**
 * KML Import Flow
 * Handles file picker, parsing, and integration with app state
 */

import { parseKml, ImportedPoint, ImportedPolygon, calculateBounds } from './kmlImport';
import { Coordinate } from '../App';
import { PointSymbol } from '../components/KmlManagerModal';

export interface ImportKmlOptions {
  onKmlImported: (kmlImport: {
    id: string;
    name: string;
    points: Array<{ lng: number; lat: number; label: string }>;
    polygons: Array<{ coordinates: [number, number][]; name?: string }>;
    color: string;
    symbol: PointSymbol;
    visible: boolean;
  }) => void;
  onError: (error: string) => void;
  onSuccess: (message: string) => void;
  onShowSummary: (summary: { points: number; polygons: number }) => void;
  onZoomToBounds: (bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }) => void;
}

/**
 * Trigger file picker and import KML
 */
export async function importKmlFile(options: ImportKmlOptions): Promise<void> {
  return new Promise((resolve) => {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kml';
    input.style.display = 'none';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        resolve();
        return;
      }

      const fileName = file.name;

      try {
        // Read file
        const text = await file.text();

        // Parse KML
        const result = parseKml(text);

        // Check for errors
        if (result.errors.length > 0 && result.points.length === 0 && result.polygons.length === 0) {
          options.onError(result.errors[0] || 'Failed to import KML');
          resolve();
          return;
        }

        // Show summary
        options.onShowSummary({
          points: result.points.length,
          polygons: result.polygons.length
        });

        // Convert points and polygons to the format expected by the app
        const labeledPoints = result.points.map(point => ({
          lng: point.lng,
          lat: point.lat,
          label: point.label
        }));

        const polygons = result.polygons.map(polygon => ({
          coordinates: polygon.coordinates,
          name: polygon.name
        }));

        // Generate a default color from a palette (cycling through colors)
        const colorPalette = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#10b981', '#06b6d4'];
        // Use a simple hash of the filename to pick a color (consistent for same filename)
        const colorIndex = fileName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colorPalette.length;
        const defaultColor = colorPalette[colorIndex];

        // Default symbol is circle
        const defaultSymbol: PointSymbol = 'circle';

        // Create KML import object
        const kmlImport = {
          id: `kml-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: fileName,
          points: labeledPoints,
          polygons: polygons,
          color: defaultColor,
          symbol: defaultSymbol,
          visible: true
        };

        // Import everything as visual overlays (polygons are just for display, not AOI)
        finishImport(result, kmlImport, options);
      } catch (error) {
        options.onError(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        resolve();
      } finally {
        // Clean up
        document.body.removeChild(input);
      }
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      resolve();
    };

    // Trigger file picker
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Finish import process: add points and zoom to bounds
 */
function finishImport(
  result: { points: ImportedPoint[]; polygons: ImportedPolygon[] },
  kmlImport: { id: string; name: string; points: Array<{ lng: number; lat: number; label: string }>; polygons: Array<{ coordinates: [number, number][]; name?: string }>; color: string; symbol: PointSymbol; visible: boolean },
  options: ImportKmlOptions
): void {
  // Add the KML import to the app state
  options.onKmlImported(kmlImport);

  // Zoom to bounds
  const bounds = calculateBounds(result.points, result.polygons);
  if (bounds) {
    options.onZoomToBounds(bounds);
  }

  // Show success message
  const pointText = result.points.length === 1 ? 'point' : 'points';
  const polygonText = result.polygons.length === 1 ? 'polygon' : 'polygons';
  let message = '';
  if (result.points.length > 0 && result.polygons.length > 0) {
    message = `Imported ${result.points.length} ${pointText}, ${result.polygons.length} ${polygonText}`;
  } else if (result.points.length > 0) {
    message = `Imported ${result.points.length} ${pointText}`;
  } else if (result.polygons.length > 0) {
    message = `Imported ${result.polygons.length} ${polygonText}`;
  }
  if (message) {
    options.onSuccess(message);
  }
}

