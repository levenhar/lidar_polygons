/**
 * Utility functions for checking AOI containment
 */

export interface AOIGeometry {
  type: 'bbox' | 'polygon' | 'kml';
  bbox?: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  polygon?: [number, number][]; // [lon, lat] pairs
}

/**
 * Check if a bbox contains another bbox
 */
function bboxContainsBbox(
  outer: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  inner: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): boolean {
  return (
    outer.minLon <= inner.minLon &&
    outer.minLat <= inner.minLat &&
    outer.maxLon >= inner.maxLon &&
    outer.maxLat >= inner.maxLat
  );
}

/**
 * Check if a polygon contains a point using ray casting algorithm
 */
function polygonContainsPoint(polygon: [number, number][], point: [number, number]): boolean {
  let inside = false;
  const [x, y] = point;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    
    const intersect = 
      ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    
    if (intersect) inside = !inside;
  }
  
  return inside;
}

/**
 * Check if a polygon contains a bbox
 * This checks if all corners of the bbox are inside the polygon
 */
function polygonContainsBbox(
  polygon: [number, number][],
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): boolean {
  const corners: [number, number][] = [
    [bbox.minLon, bbox.minLat],
    [bbox.maxLon, bbox.minLat],
    [bbox.maxLon, bbox.maxLat],
    [bbox.minLon, bbox.maxLat]
  ];
  
  // All corners must be inside the polygon
  return corners.every(corner => polygonContainsPoint(polygon, corner));
}

/**
 * Check if a bbox contains a polygon
 * This checks if all vertices of the polygon are inside the bbox
 */
function bboxContainsPolygon(
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  polygon: [number, number][]
): boolean {
  return polygon.every(([lon, lat]) => {
    return (
      bbox.minLon <= lon &&
      bbox.minLat <= lat &&
      bbox.maxLon >= lon &&
      bbox.maxLat >= lat
    );
  });
}

/**
 * Check if a polygon contains another polygon
 * This checks if all vertices of the inner polygon are inside the outer polygon
 */
function polygonContainsPolygon(outer: [number, number][], inner: [number, number][]): boolean {
  return inner.every(vertex => polygonContainsPoint(outer, vertex));
}

/**
 * Check if newAOI fully contains oldAOI
 * Returns true if newAOI contains oldAOI, false otherwise
 */
export function aoiContains(
  newAOI: AOIGeometry,
  oldAOI: AOIGeometry
): boolean {
  // Both are bbox
  if (newAOI.type === 'bbox' && oldAOI.type === 'bbox' && newAOI.bbox && oldAOI.bbox) {
    return bboxContainsBbox(newAOI.bbox, oldAOI.bbox);
  }
  
  // New is polygon, old is bbox
  if (newAOI.type === 'polygon' && oldAOI.type === 'bbox' && newAOI.polygon && oldAOI.bbox) {
    return polygonContainsBbox(newAOI.polygon, oldAOI.bbox);
  }
  
  // New is bbox, old is polygon
  if (newAOI.type === 'bbox' && oldAOI.type === 'polygon' && newAOI.bbox && oldAOI.polygon) {
    return bboxContainsPolygon(newAOI.bbox, oldAOI.polygon);
  }
  
  // Both are polygon
  if (newAOI.type === 'polygon' && oldAOI.type === 'polygon' && newAOI.polygon && oldAOI.polygon) {
    return polygonContainsPolygon(newAOI.polygon, oldAOI.polygon);
  }
  
  // KML type - treat as polygon if polygon exists, otherwise as bbox
  if (newAOI.type === 'kml' || oldAOI.type === 'kml') {
    const newPoly = newAOI.polygon || (newAOI.bbox ? [
      [newAOI.bbox.minLon, newAOI.bbox.minLat],
      [newAOI.bbox.maxLon, newAOI.bbox.minLat],
      [newAOI.bbox.maxLon, newAOI.bbox.maxLat],
      [newAOI.bbox.minLon, newAOI.bbox.maxLat]
    ] : null);
    
    const oldPoly = oldAOI.polygon || (oldAOI.bbox ? [
      [oldAOI.bbox.minLon, oldAOI.bbox.minLat],
      [oldAOI.bbox.maxLon, oldAOI.bbox.minLat],
      [oldAOI.bbox.maxLon, oldAOI.bbox.maxLat],
      [oldAOI.bbox.minLon, oldAOI.bbox.maxLat]
    ] : null);
    
    if (newPoly && oldPoly) {
      return polygonContainsPolygon(newPoly, oldPoly);
    }
  }
  
  // If we can't determine, return false (fail safe)
  return false;
}

