/**
 * KML Import Flow
 * Handles file picker, parsing, and integration with app state
 */

import { parseKml, calculateBounds } from './kmlImport';
import { KmlImport, PointSymbol } from '../components/KmlManagerModal';

export interface ImportKmlOptions {
  onKmlImported: (kmlImport: Omit<KmlImport, 'importedAt'>) => void;
  onError: (error: string) => void;
  onSuccess: (message: string) => void;
  onShowSummary: (summary: { points: number; polygons: number }) => void;
  onZoomToBounds: (bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }) => void;
}

/**
 * Trigger file picker and import one or more KML files
 */
export async function importKmlFile(options: ImportKmlOptions): Promise<void> {
  return new Promise((resolve) => {
    // Create file input - allow multiple KML files
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kml';
    input.multiple = true;
    input.style.display = 'none';

    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files?.length) {
        document.body.removeChild(input);
        resolve();
        return;
      }

      const fileArray = Array.from(files);
      const allBounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }[] = [];
      let totalPoints = 0;
      let totalPolygons = 0;
      let successCount = 0;
      const errors: string[] = [];

      try {
        for (let i = 0; i < fileArray.length; i++) {
          const file = fileArray[i];
          const fileName = file.name;

          try {
            const text = await file.text();
            const result = parseKml(text);

            if (result.errors.length > 0 && result.points.length === 0 && result.polygons.length === 0) {
              errors.push(`${fileName}: ${result.errors[0] || 'Failed to import KML'}`);
              continue;
            }

            options.onShowSummary({
              points: result.points.length,
              polygons: result.polygons.length
            });

            const labeledPoints = result.points.map(point => ({
              lng: point.lng,
              lat: point.lat,
              label: point.label
            }));

            const polygons = result.polygons.map(polygon => ({
              coordinates: polygon.coordinates,
              name: polygon.name
            }));

            const colorPalette = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#10b981', '#06b6d4'];
            const colorIndex = (fileName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) + i) % colorPalette.length;
            const defaultColor = colorPalette[colorIndex];
            const defaultSymbol: PointSymbol = 'circle';

            const kmlImport = {
              id: `kml-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
              name: fileName,
              points: labeledPoints,
              polygons: polygons,
              color: defaultColor,
              symbol: defaultSymbol,
              visible: true,
              rawKml: text
            };

            options.onKmlImported(kmlImport);

            const bounds = calculateBounds(result.points, result.polygons);
            if (bounds) allBounds.push(bounds);

            totalPoints += result.points.length;
            totalPolygons += result.polygons.length;
            successCount++;
          } catch (err) {
            errors.push(`${fileName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        }

        if (errors.length > 0) {
          options.onError(errors.join('\n'));
        }

        if (successCount > 0) {
          if (allBounds.length > 0) {
            const combined = allBounds.reduce((acc, b) => ({
              minLon: Math.min(acc.minLon, b.minLon),
              minLat: Math.min(acc.minLat, b.minLat),
              maxLon: Math.max(acc.maxLon, b.maxLon),
              maxLat: Math.max(acc.maxLat, b.maxLat)
            }), allBounds[0]);
            options.onZoomToBounds(combined);
          }

          const pointText = totalPoints === 1 ? 'point' : 'points';
          const polygonText = totalPolygons === 1 ? 'polygon' : 'polygons';
          const message = successCount === 1
            ? (totalPoints > 0 && totalPolygons > 0
                ? `Imported ${totalPoints} ${pointText}, ${totalPolygons} ${polygonText}`
                : totalPoints > 0
                  ? `Imported ${totalPoints} ${pointText}`
                  : totalPolygons > 0
                    ? `Imported ${totalPolygons} ${polygonText}`
                    : 'Imported 1 file')
            : `Imported ${successCount} KML files (${totalPoints} ${pointText}, ${totalPolygons} ${polygonText})`;
          options.onSuccess(message);
        }
      } finally {
        document.body.removeChild(input);
        resolve();
      }
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      resolve();
    };

    document.body.appendChild(input);
    input.click();
  });
}


