/**
 * Three.js 3D terrain helpers — tile math, mesh building, coordinate conversion.
 */
import proj4 from 'proj4';

/** Slippy-map tile coordinates */
export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

/** Geographic bounds [minLng, minLat, maxLng, maxLat] */
export type GeoBounds = [number, number, number, number];

/** Metric dimensions of the terrain */
export interface TerrainMetrics {
  widthMeters: number;
  heightMeters: number;
}

// ── Tile math ──────────────────────────────────────────────────────────

/** Compute slippy-map tile x/y from lng/lat at a given zoom. */
export function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/** Fractional slippy-map tile position from lng/lat at zoom (no floor). */
export function lngLatToTileFrac(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

/** Convert tile x index to the west longitude of that tile. */
export function tileToLng(tx: number, zoom: number): number {
  return (tx / Math.pow(2, zoom)) * 360 - 180;
}

/** Convert tile y index to the north latitude of that tile (inverse Mercator). */
export function tileToLat(ty: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Compute tile bounds for given geographic bounds and target tile count per axis (~4-8). */
export function computeTileRange(bounds: GeoBounds, targetTilesPerAxis: number = 6): {
  zoom: number;
  minTile: { x: number; y: number };
  maxTile: { x: number; y: number };
  cols: number;
  rows: number;
} {
  const [minLng, minLat, maxLng, maxLat] = bounds;

  // Find zoom level that gives roughly targetTilesPerAxis tiles across the wider dimension
  let bestZoom = 1;
  for (let z = 1; z <= 18; z++) {
    const tl = lngLatToTile(minLng, maxLat, z);
    const br = lngLatToTile(maxLng, minLat, z);
    const cols = br.x - tl.x + 1;
    const rows = br.y - tl.y + 1;
    if (Math.max(cols, rows) <= targetTilesPerAxis * 2) {
      bestZoom = z;
    }
    if (Math.max(cols, rows) >= targetTilesPerAxis) break;
  }

  const tl = lngLatToTile(minLng, maxLat, bestZoom);
  const br = lngLatToTile(maxLng, minLat, bestZoom);
  return {
    zoom: bestZoom,
    minTile: tl,
    maxTile: br,
    cols: br.x - tl.x + 1,
    rows: br.y - tl.y + 1,
  };
}

/** Build a tile URL from a template like `https://…/{z}/{x}/{y}.png`. */
export function buildTileUrl(urlTemplate: string, x: number, y: number, z: number, token: string | null): string {
  let url = urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  if (token && token.trim()) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}token=${token}`;
  }
  return url;
}

// ── Terrain mesh data ──────────────────────────────────────────────────

/** Convert WGS84 bounds to metric width/height using proj4 UTM projection. */
export function boundsToMetric(bounds: GeoBounds): TerrainMetrics {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const centerLng = (minLng + maxLng) / 2;
  // Determine UTM zone from center longitude
  const zone = Math.floor((centerLng + 180) / 6) + 1;
  const hem = (minLat + maxLat) / 2 >= 0 ? 'north' : 'south';
  const utmDef = `+proj=utm +zone=${zone} +${hem} +datum=WGS84 +units=m +no_defs`;

  const bl = proj4('EPSG:4326', utmDef, [minLng, minLat]);
  const tr = proj4('EPSG:4326', utmDef, [maxLng, maxLat]);
  return {
    widthMeters: Math.abs(tr[0] - bl[0]),
    heightMeters: Math.abs(tr[1] - bl[1]),
  };
}

/**
 * Downsample raster data via bilinear interpolation.
 * Returns a flat Float32Array in row-major order (top-to-bottom, left-to-right).
 */
export function downsampleRaster(
  data: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  noDataValue: number | null
): Float32Array {
  const out = new Float32Array(dstWidth * dstHeight);
  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = (dy / (dstHeight - 1)) * (srcHeight - 1);
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(sy0 + 1, srcHeight - 1);
    const ty = sy - sy0;
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = (dx / (dstWidth - 1)) * (srcWidth - 1);
      const sx0 = Math.floor(sx);
      const sx1 = Math.min(sx0 + 1, srcWidth - 1);
      const tx = sx - sx0;

      const v00 = data[sy0 * srcWidth + sx0];
      const v10 = data[sy0 * srcWidth + sx1];
      const v01 = data[sy1 * srcWidth + sx0];
      const v11 = data[sy1 * srcWidth + sx1];

      // If any sample is nodata, use nearest valid neighbour or 0
      if (noDataValue !== null && (v00 === noDataValue || v10 === noDataValue || v01 === noDataValue || v11 === noDataValue)) {
        const candidates = [v00, v10, v01, v11].filter(v => v !== noDataValue && Number.isFinite(v));
        out[dy * dstWidth + dx] = candidates.length > 0 ? candidates[0] : 0;
      } else {
        out[dy * dstWidth + dx] =
          v00 * (1 - tx) * (1 - ty) +
          v10 * tx * (1 - ty) +
          v01 * (1 - tx) * ty +
          v11 * tx * ty;
      }
    }
  }
  return out;
}

/**
 * Convert lng/lat to local 3D coordinates within the terrain mesh.
 * Returns { x, y } in mesh coordinate system (centered at origin).
 */
export function geoToLocal(
  lng: number,
  lat: number,
  bounds: GeoBounds,
  widthMeters: number,
  heightMeters: number
): { x: number; y: number } {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const u = (lng - minLng) / (maxLng - minLng); // 0..1
  const v = (lat - minLat) / (maxLat - minLat); // 0..1
  return {
    x: (u - 0.5) * widthMeters,
    y: (v - 0.5) * heightMeters,
  };
}

/**
 * Create an elevation-based color for a height value (green-brown-white gradient).
 * Used as fallback texture while map tiles load.
 */
export function elevationToColor(elevation: number, minElev: number, maxElev: number): { r: number; g: number; b: number } {
  const range = maxElev - minElev || 1;
  const t = Math.max(0, Math.min(1, (elevation - minElev) / range));

  // Green (low) → Brown (mid) → White (high)
  if (t < 0.5) {
    const s = t / 0.5;
    return {
      r: Math.round(80 + s * 100),
      g: Math.round(160 - s * 60),
      b: Math.round(60 - s * 20),
    };
  } else {
    const s = (t - 0.5) / 0.5;
    return {
      r: Math.round(180 + s * 75),
      g: Math.round(100 + s * 155),
      b: Math.round(40 + s * 215),
    };
  }
}
