import { Coordinate } from '../App';

/**
 * Calculate the distance between two coordinates in meters using Haversine formula
 */
export function calculateDistance(coord1: Coordinate, coord2: Coordinate): number {
  const R = 6371000; // Earth radius in meters
  const φ1 = (coord1.lat * Math.PI) / 180;
  const φ2 = (coord2.lat * Math.PI) / 180;
  const Δφ = ((coord2.lat - coord1.lat) * Math.PI) / 180;
  const Δλ = ((coord2.lng - coord1.lng) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculate bearing (direction) from point1 to point2 in radians
 */
export function calculateBearing(point1: Coordinate, point2: Coordinate): number {
  const φ1 = (point1.lat * Math.PI) / 180;
  const φ2 = (point2.lat * Math.PI) / 180;
  const Δλ = ((point2.lng - point1.lng) * Math.PI) / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);

  return θ;
}

/**
 * Calculate a new point at a given distance and bearing from a starting point
 */
export function calculateDestination(
  start: Coordinate,
  bearing: number,
  distanceMeters: number
): Coordinate {
  const R = 6371000; // Earth radius in meters
  const φ1 = (start.lat * Math.PI) / 180;
  const λ1 = (start.lng * Math.PI) / 180;

  const d = distanceMeters / R;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(bearing)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(φ1),
      Math.cos(d) - Math.sin(φ1) * Math.sin(φ2)
    );

  return {
    lng: (λ2 * 180) / Math.PI,
    lat: (φ2 * 180) / Math.PI
  };
}

export type UTurnSide = 'L' | 'R';

/**
 * Generate a U-turn arc (semi-circle) starting at `start`, tangent-aligned to the inbound segment
 * defined by `prev -> start`.
 *
 * - Returns `numPoints` points along the arc (does NOT include the start point).
 * - Side 'R' means the U-turn ends offset to the RIGHT of travel direction; 'L' ends to the LEFT.
 */
export function generateUTurnPoints(
  prev: Coordinate,
  start: Coordinate,
  radiusMeters: number,
  numPoints: number = 10,
  side: UTurnSide = 'R'
): Coordinate[] {
  if (numPoints <= 0) return [];
  if (!(radiusMeters > 0)) return [];

  const inboundBearing = calculateBearing(prev, start);
  const rightPerp = inboundBearing + Math.PI / 2;
  const leftPerp = inboundBearing - Math.PI / 2;

  // To keep the start tangent aligned with inboundBearing:
  // - Side 'R' (end on right offset): center is to the RIGHT, arc is CCW (+π)
  // - Side 'L' (end on left offset): center is to the LEFT, arc is CW (-π)
  const centerBearingFromStart = side === 'R' ? rightPerp : leftPerp;
  const center = calculateDestination(start, centerBearingFromStart, radiusMeters);

  const radiusBearingStart = calculateBearing(center, start);
  const step = Math.PI / numPoints;
  const direction = side === 'R' ? 1 : -1;

  const pts: Coordinate[] = [];
  for (let i = 1; i <= numPoints; i++) {
    const radiusBearing = radiusBearingStart + direction * step * i;
    pts.push(calculateDestination(center, radiusBearing, radiusMeters));
  }

  return pts;
}

/**
 * Calculate parallel line to a given line segment
 * @param start Starting point of the line segment
 * @param end Ending point of the line segment
 * @param offsetDistance Distance in meters to offset (positive = right side, negative = left side)
 * @returns Array of two points representing the parallel line segment
 */
export function calculateParallelLine(
  start: Coordinate,
  end: Coordinate,
  offsetDistance: number
): [Coordinate, Coordinate] {
  // Calculate bearing of the original line
  const bearing = calculateBearing(start, end);

  // Calculate perpendicular bearing (90 degrees to the right)
  const perpendicularBearing = bearing + Math.PI / 2;

  // Offset both endpoints perpendicular to the line
  const parallelStart = calculateDestination(start, perpendicularBearing, offsetDistance);
  const parallelEnd = calculateDestination(end, perpendicularBearing, offsetDistance);

  return [parallelStart, parallelEnd];
}

/**
 * Find the closest point on a line segment to a given point
 * @param point The point to find closest point for
 * @param lineStart Start of line segment
 * @param lineEnd End of line segment
 * @returns Object with segmentIndex and distance
 */
export function findClosestPointOnLine(
  point: { lng: number; lat: number },
  lineStart: Coordinate,
  lineEnd: Coordinate
): { t: number; distance: number } {
  // Convert to radians for calculations
  const φ1 = (lineStart.lat * Math.PI) / 180;
  const λ1 = (lineStart.lng * Math.PI) / 180;
  const φ2 = (lineEnd.lat * Math.PI) / 180;
  const λ2 = (lineEnd.lng * Math.PI) / 180;
  const φp = (point.lat * Math.PI) / 180;
  const λp = (point.lng * Math.PI) / 180;

  // Calculate vector components
  const dx = λ2 - λ1;
  const dy = φ2 - φ1;

  // Handle degenerate case (start == end)
  if (Math.abs(dx) < 1e-10 && Math.abs(dy) < 1e-10) {
    return { t: 0, distance: calculateDistance(lineStart, point) };
  }

  // Calculate parameter t (0 to 1) along the line segment
  const t =
    ((λp - λ1) * dx + (φp - φ1) * dy) / (dx * dx + dy * dy);

  // Clamp t to [0, 1] to stay within segment
  const clampedT = Math.max(0, Math.min(1, t));

  // Calculate closest point on line segment
  const closestLng = λ1 + clampedT * dx;
  const closestLat = φ1 + clampedT * dy;

  // Calculate distance to closest point
  const R = 6371000; // Earth radius in meters
  const Δφ = φp - closestLat;
  const Δλ = λp - closestLng;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(closestLat) * Math.cos(φp) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return { t: clampedT, distance };
}
