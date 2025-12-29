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

function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a <= -Math.PI) a += twoPi;
  if (a > Math.PI) a -= twoPi;
  return a;
}

/**
 * Generate a U-turn arc where:
 * - Start point is the current last point.
 * - End point lies on the line perpendicular to the inbound leg, at the requested chord length
 *   (clamped to 2R). This matches the user's sketch: both start/end on the perpendicular line.
 * - Returns `numPoints` points along the arc (does NOT include the start point).
 * - Side 'R' means the arc turns to the RIGHT of travel; 'L' turns to the LEFT.
 */
export function generateUTurnPoints(
  prev: Coordinate,
  start: Coordinate,
  radiusMeters: number,
  startEndDistanceMeters: number,
  numPoints: number = 10,
  side: UTurnSide = 'R'
): Coordinate[] {
  if (numPoints <= 0) return [];
  if (!(radiusMeters > 0)) return [];
  if (!(startEndDistanceMeters > 0)) return [];

  // Clamp chord length to maximum of 2R
  const chordLength = Math.min(startEndDistanceMeters, radiusMeters * 2);

  // Bearings for inbound and its right-perpendicular (used to place the end point)
  const inboundBearing = calculateBearing(prev, start);
  const rightPerpBearing = inboundBearing + Math.PI / 2;
  const leftPerpBearing = inboundBearing - Math.PI / 2;

  // Place end point along the perpendicular line (direction depends on side)
  const perpBearing = side === 'R' ? rightPerpBearing : leftPerpBearing;
  const endPoint = calculateDestination(start, perpBearing, chordLength);

  // Chord midpoint
  const midPoint = calculateDestination(start, perpBearing, chordLength / 2);

  // Circle geometry from chord
  const halfChord = chordLength / 2;
  const height = Math.sqrt(Math.max(0, radiusMeters * radiusMeters - halfChord * halfChord));

  // Two possible centers: offset from midpoint by ± normal to the chord
  const chordNormalBearing1 = perpBearing + Math.PI / 2;
  const chordNormalBearing2 = perpBearing - Math.PI / 2;
  const center1 = calculateDestination(midPoint, chordNormalBearing1, height);
  const center2 = calculateDestination(midPoint, chordNormalBearing2, height);

  // Pick center on the intended turning side (dot with right vector)
  const rightVectorBearing = rightPerpBearing;
  const bearingStartToC1 = calculateBearing(start, center1);
  const bearingStartToC2 = calculateBearing(start, center2);
  const diff1 = Math.abs(normalizeAngle(bearingStartToC1 - rightVectorBearing));
  const diff2 = Math.abs(normalizeAngle(bearingStartToC2 - rightVectorBearing));

  const center =
    side === 'R'
      ? (diff1 <= diff2 ? center1 : center2)
      : (diff1 >= diff2 ? center1 : center2);

  // Bearings from center to start/end
  const startAngle = calculateBearing(center, start);
  const endAngle = calculateBearing(center, endPoint);

  // Determine sweep direction consistent with side (R = CCW long way, L = CW long way)
  let delta = normalizeAngle(endAngle - startAngle);
  const direction = side === 'R' ? 1 : -1; // flipped to take the other long direction
  if (direction === -1 && delta > 0) delta -= Math.PI * 2;
  if (direction === 1 && delta < 0) delta += Math.PI * 2;

  // Use the long arc (major arc) instead of the short one
  const theta = Math.abs(delta);
  if (theta < Math.PI) {
    delta = direction === -1 ? -(2 * Math.PI - theta) : (2 * Math.PI - theta);
  }

  const step = delta / numPoints;

  const pts: Coordinate[] = [];
  for (let i = 1; i <= numPoints; i++) {
    const angle = startAngle + step * i;
    pts.push(calculateDestination(center, angle, radiusMeters));
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
