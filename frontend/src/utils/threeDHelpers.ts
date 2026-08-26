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

/** Metric dimensions and UTM projection info of the terrain */
export interface TerrainMetrics {
  widthMeters: number;
  heightMeters: number;
  centerEasting: number;
  centerNorthing: number;
  utmProjDef: string;
}

// ── Tile math ──────────────────────────────────────────────────────────

/** Compute tile x/y from lng/lat at a given zoom for Web Mercator (EPSG:3857) or CRS84/WGS84 (EPSG:4326). */
export function lngLatToTile(lng: number, lat: number, zoom: number, crs: string): { x: number; y: number } {
  if (crs === "EPSG:4326") {
    const nx = Math.pow(2, zoom + 1);
    const ny = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * nx);
    const y = Math.floor(((90 - lat) / 180) * ny);
    return { x, y };
  } else if (crs === "EPSG:3857") {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
  } 
  throw new Error(`Unsupported EPSG code: ${crs}. Only EPSG:4326 and EPSG:3857 are supported.`);
}

/** Fractional tile position from lng/lat at zoom (no floor). */
export function lngLatToTileFrac(lng: number, lat: number, zoom: number, crs: string): { x: number; y: number } {
  if (crs === "EPSG:4326") {
    const nx = Math.pow(2, zoom + 1);
    const ny = Math.pow(2, zoom);
    const x = ((lng + 180) / 360) * nx;
    const y = ((90 - lat) / 180) * ny;
    return { x, y };
  } else if (crs === "EPSG:3857") {
    const n = Math.pow(2, zoom);
    const x = ((lng + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
  } 
  throw new Error(`Unsupported EPSG code: ${crs}. Only EPSG:4326 and EPSG:3857 are supported.`);
}

/** Convert tile x index to the west longitude of that tile. */
export function tileToLng(tx: number, zoom: number, crs: string): number {
  if (crs === "EPSG:4326") {
    return (tx / Math.pow(2, zoom + 1)) * 360 - 180;
  } else if (crs === "EPSG:3857") {
    return (tx / Math.pow(2, zoom)) * 360 - 180;
  }
  throw new Error(`Unsupported EPSG code: ${crs}. Only EPSG:4326 and EPSG:3857 are supported.`);
}

/** Convert tile y index to the north latitude of that tile. */
export function tileToLat(ty: number, zoom: number, crs: string): number {
  if (crs === "EPSG:4326") {
    return 90 - (ty / Math.pow(2, zoom)) * 180;
  } else if (crs === "EPSG:3857") {
    const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  throw new Error(`Unsupported EPSG code: ${crs}. Only EPSG:4326 and EPSG:3857 are supported.`);
}

/** Compute tile bounds for given geographic bounds and target tile count per axis (~4-8). */
export function computeTileRange(bounds: GeoBounds, targetTilesPerAxis: number = 6, crs: string): {
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
    const tl = lngLatToTile(minLng, maxLat, z, crs);
    const br = lngLatToTile(maxLng, minLat, z, crs);
    const cols = br.x - tl.x + 1;
    const rows = br.y - tl.y + 1;
    if (Math.max(cols, rows) <= targetTilesPerAxis * 2) {
      bestZoom = z;
    }
    if (Math.max(cols, rows) >= targetTilesPerAxis) break;
  }

  const tl = lngLatToTile(minLng, maxLat, bestZoom, crs);
  const br = lngLatToTile(maxLng, minLat, bestZoom, crs);
  return {
    zoom: bestZoom,
    minTile: tl,
    maxTile: br,
    cols: br.x - tl.x + 1,
    rows: br.y - tl.y + 1,
  };
}


// ── Terrain mesh data ──────────────────────────────────────────────────

/** Convert WGS84 bounds to metric width/height and UTM center coordinates using proj4. */
export function boundsToMetric(bounds: GeoBounds): TerrainMetrics {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  // Determine UTM zone from center longitude
  const zone = Math.floor((centerLng + 180) / 6) + 1;
  const hem = centerLat >= 0 ? 'north' : 'south';
  const utmDef = `+proj=utm +zone=${zone} +${hem} +datum=WGS84 +units=m +no_defs`;

  const bl = proj4('EPSG:4326', utmDef, [minLng, minLat]);
  const br = proj4('EPSG:4326', utmDef, [maxLng, minLat]);
  const tl = proj4('EPSG:4326', utmDef, [minLng, maxLat]);
  const tr = proj4('EPSG:4326', utmDef, [maxLng, maxLat]);
  const minE = Math.min(bl[0], br[0], tl[0], tr[0]);
  const maxE = Math.max(bl[0], br[0], tl[0], tr[0]);
  const minN = Math.min(bl[1], br[1], tl[1], tr[1]);
  const maxN = Math.max(bl[1], br[1], tl[1], tr[1]);

  const [centerEasting, centerNorthing] = proj4('EPSG:4326', utmDef, [centerLng, centerLat]);

  return {
    widthMeters: Math.abs(maxE - minE),
    heightMeters: Math.abs(maxN - minN),
    centerEasting,
    centerNorthing,
    utmProjDef: utmDef,
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
 * Convert lng/lat directly to local 3D coordinates within the terrain mesh using pure UTM projection.
 * Returns { x, y } in mesh coordinate system (meters, centered at (0, 0)).
 */
export function geoToLocal(
  lng: number,
  lat: number,
  utmProjDefOrBounds: string | GeoBounds,
  centerEastingOrWidth: number,
  centerNorthingOrHeight?: number
): { x: number; y: number } {
  if (typeof utmProjDefOrBounds === 'string') {
    const utmProjDef = utmProjDefOrBounds;
    const centerEasting = centerEastingOrWidth;
    const centerNorthing = centerNorthingOrHeight ?? 0;
    const [easting, northing] = proj4('EPSG:4326', utmProjDef, [lng, lat]);
    return {
      x: easting - centerEasting,
      y: northing - centerNorthing,
    };
  }

  // Fallback if bounds array was passed:
  const bounds = utmProjDefOrBounds;
  const metrics = boundsToMetric(bounds);
  const [easting, northing] = proj4('EPSG:4326', metrics.utmProjDef, [lng, lat]);
  return {
    x: easting - metrics.centerEasting,
    y: northing - metrics.centerNorthing,
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
