import proj4 from 'proj4';

export type UTMCoordinate = {
  easting: number;
  northing: number;
  zone: number;
  hemisphere: 'N' | 'S';
};

/**
 * Convert a WGS84 latitude/longitude pair to UTM (WGS84 datum).
 * Returns null if the conversion fails for any reason.
 */
export function latLngToUTM(lat: number, lng: number): UTMCoordinate | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const zone = Math.floor((lng + 180) / 6) + 1;
  const hemisphere: 'N' | 'S' = lat >= 0 ? 'N' : 'S';
  const utmProjString = `+proj=utm +zone=${zone} +${hemisphere === 'N' ? 'north' : 'south'} +datum=WGS84 +units=m +no_defs`;

  try {
    const [easting, northing] = proj4('EPSG:4326', utmProjString, [lng, lat]);
    return { easting, northing, zone, hemisphere };
  } catch (error) {
    console.error('Failed to convert lat/lng to UTM:', error);
    return null;
  }
}


