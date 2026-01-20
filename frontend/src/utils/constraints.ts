import { Coordinate } from '../App';
import { ClimbConfig } from './climb';

/**
 * Types of constraints that limit climb/descent
 */
export type ConstraintType = 'turn' | 'climbPoint';

/**
 * A constraint along the route that limits altitude changes
 */
export interface Constraint {
  type: ConstraintType;
  /** Distance along the route (s-coordinate) in meters */
  distance: number;
  /** For climb points: the climb amount, undefined for turns */
  climbAmount?: number;
  /** Index in the original array (vertex index for turns, request index for climb points) */
  index: number;
}

/**
 * Result from getNearestConstraints
 */
export interface NearestConstraintsResult {
  /** Nearest limiting constraint on the left (lower s), or null if none */
  left: Constraint | null;
  /** Nearest limiting constraint on the right (higher s), or null if none */
  right: Constraint | null;
  /** Available horizontal distance to left constraint */
  dL: number;
  /** Available horizontal distance to right constraint */
  dR: number;
  /** Maximum achievable vertical change (magnitude) based on constraints */
  maxDeltaZ: number;
  /** Which side(s) limit the climb: 'left', 'right', 'both', or 'none' */
  limitingSide: 'left' | 'right' | 'both' | 'none';
  /** Human-readable reason(s) for the limit */
  limitingReasons: string[];
}

const EARTH_RADIUS_M = 6371000;

/**
 * Calculate haversine distance between two coordinates
 */
function haversineDistance(a: Coordinate, b: Coordinate): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

/**
 * Compute cumulative distances along a path
 * @param path Array of coordinates
 * @returns Array of cumulative distances where distances[i] is the distance from start to path[i]
 */
export function computeCumulativeDistances(path: Coordinate[]): number[] {
  if (path.length === 0) return [];
  const distances = [0];
  for (let i = 1; i < path.length; i++) {
    distances.push(distances[i - 1] + haversineDistance(path[i - 1], path[i]));
  }
  return distances;
}

/**
 * Binary search to find the index of the largest value <= target
 * @param sortedArr Sorted array of numbers (ascending)
 * @param target Target value to search for
 * @returns Index of largest value <= target, or -1 if all values > target
 */
export function binarySearchLessOrEqual(sortedArr: number[], target: number): number {
  if (sortedArr.length === 0) return -1;
  
  let left = 0;
  let right = sortedArr.length - 1;
  let result = -1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (sortedArr[mid] <= target) {
      result = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  
  return result;
}

/**
 * Binary search to find the index of the smallest value > target
 * @param sortedArr Sorted array of numbers (ascending)
 * @param target Target value to search for
 * @returns Index of smallest value > target, or -1 if all values <= target
 */
export function binarySearchGreater(sortedArr: number[], target: number): number {
  if (sortedArr.length === 0) return -1;
  
  let left = 0;
  let right = sortedArr.length - 1;
  let result = -1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (sortedArr[mid] > target) {
      result = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  
  return result;
}

/**
 * Build a sorted list of constraints from path vertices (turns) and existing climb points
 * @param vertexDistances Cumulative distances at each vertex
 * @param climbRequests Existing climb requests { endDistance, climbAmount }[]
 * @param s0 Current selected point distance (to exclude from climb point constraints)
 * @param config Climb configuration
 * @returns Object with allConstraints sorted by distance, and separate arrays for filtering
 */
export function buildConstraintsList(
  vertexDistances: number[],
  climbRequests: { endDistance: number; climbAmount: number }[],
  s0: number,
  _config: ClimbConfig
): {
  allConstraints: Constraint[];
  turnConstraints: Constraint[];
  climbPointConstraints: Constraint[];
} {
  // Build turn constraints from all vertices (except first and last which are route endpoints)
  const turnConstraints: Constraint[] = vertexDistances
    .slice(1, -1) // exclude first and last points - they're endpoints, not turns
    .map((distance, idx) => ({
      type: 'turn' as ConstraintType,
      distance,
      index: idx + 1 // +1 because we sliced off index 0
    }));

  // Build climb point constraints from existing climb requests
  // Exclude the current point (within small tolerance)
  const climbPointConstraints: Constraint[] = climbRequests
    .filter(req => Math.abs(req.endDistance - s0) > 0.1) // Exclude current point
    .map((req, idx) => ({
      type: 'climbPoint' as ConstraintType,
      distance: req.endDistance,
      climbAmount: req.climbAmount,
      index: idx
    }));

  // Combine and sort by distance
  const allConstraints = [...turnConstraints, ...climbPointConstraints]
    .sort((a, b) => a.distance - b.distance);

  return { allConstraints, turnConstraints, climbPointConstraints };
}

/**
 * Get the nearest limiting constraints from both directions along the route
 * Uses binary search for efficiency with large constraint sets
 * 
 * @param s0 Distance of the selected climb point along the route
 * @param config Climb configuration (climbRatio, allowTurnsDuringClimb, etc.)
 * @param vertexDistances Cumulative distances at each vertex (precomputed)
 * @param climbRequests Existing climb requests
 * @param totalRouteLength Total length of the route in meters
 * @returns NearestConstraintsResult with computed limits
 */
export function getNearestConstraints(
  s0: number,
  config: ClimbConfig,
  vertexDistances: number[],
  climbRequests: { endDistance: number; climbAmount: number }[],
  totalRouteLength: number
): NearestConstraintsResult {
  const { allConstraints, climbPointConstraints } = buildConstraintsList(
    vertexDistances,
    climbRequests,
    s0,
    config
  );

  // Determine which constraints are "active" (limiting)
  // - Climb points are ALWAYS limiting
  // - Turns are limiting only if allowTurnsDuringClimb is false
  const activeConstraints = config.allowTurnsDuringClimb
    ? climbPointConstraints
    : allConstraints;

  // Sort active constraints by distance for binary search
  const sortedDistances = activeConstraints.map(c => c.distance).sort((a, b) => a - b);
  const sortedConstraints = [...activeConstraints].sort((a, b) => a.distance - b.distance);

  // Find nearest constraints using binary search
  let leftConstraint: Constraint | null = null;
  let rightConstraint: Constraint | null = null;

  // Find largest distance < s0 (constraint on the left)
  const leftIdx = binarySearchLessOrEqual(sortedDistances, s0 - 0.001); // Small offset to exclude exact match
  if (leftIdx >= 0) {
    leftConstraint = sortedConstraints[leftIdx];
  }

  // Find smallest distance > s0 (constraint on the right)
  const rightIdx = binarySearchGreater(sortedDistances, s0 + 0.001);
  if (rightIdx >= 0) {
    rightConstraint = sortedConstraints[rightIdx];
  }

  // Calculate available horizontal distances
  const dL = leftConstraint ? s0 - leftConstraint.distance : s0; // Distance to start of route
  const dR = rightConstraint ? rightConstraint.distance - s0 : totalRouteLength - s0; // Distance to end

  // Use the minimum available distance
  const dAvail = Math.min(dL, dR);

  // Calculate max achievable vertical change
  // Using climbRatio for consistency (assuming climb = descent ratio for max computation)
  // The climbRatio represents: meters horizontal per 1 meter vertical
  // So: maxDeltaZ = dAvail / climbRatio
  const climbRatio = config.climbRatio;
  const maxDeltaZ = dAvail / climbRatio;

  // Determine limiting side(s)
  let limitingSide: 'left' | 'right' | 'both' | 'none';
  const limitingReasons: string[] = [];

  const tolerance = 0.1; // 10cm tolerance for floating point comparison
  const leftLimits = Math.abs(dL - dAvail) < tolerance;
  const rightLimits = Math.abs(dR - dAvail) < tolerance;

  if (leftLimits && rightLimits && leftConstraint && rightConstraint) {
    limitingSide = 'both';
    const leftType = leftConstraint.type === 'turn' ? 'פנייה' : 'נקודת עלייה';
    const rightType = rightConstraint.type === 'turn' ? 'פנייה' : 'נקודת עלייה';
    limitingReasons.push(`מוגבל על ידי ${leftType} משמאל ב-${dL.toFixed(1)} מ'`);
    limitingReasons.push(`מוגבל על ידי ${rightType} מימין ב-${dR.toFixed(1)} מ'`);
  } else if (leftLimits && leftConstraint) {
    limitingSide = 'left';
    const leftType = leftConstraint.type === 'turn' ? 'פנייה' : 'נקודת עלייה';
    limitingReasons.push(`מוגבל על ידי ${leftType} משמאל ב-${dL.toFixed(1)} מ'`);
  } else if (rightLimits && rightConstraint) {
    limitingSide = 'right';
    const rightType = rightConstraint.type === 'turn' ? 'פנייה' : 'נקודת עלייה';
    limitingReasons.push(`מוגבל על ידי ${rightType} מימין ב-${dR.toFixed(1)} מ'`);
  } else {
    // Edge case: limited by route boundary
    limitingSide = 'none';
    if (dL <= dR) {
      limitingReasons.push(`מוגבל על ידי התחלת המסלול ב-${dL.toFixed(1)} מ'`);
    } else {
      limitingReasons.push(`מוגבל על ידי סיום המסלול ב-${dR.toFixed(1)} מ'`);
    }
  }

  return {
    left: leftConstraint,
    right: rightConstraint,
    dL,
    dR,
    maxDeltaZ,
    limitingSide,
    limitingReasons
  };
}

/**
 * Get all constraints (including non-limiting) for visualization purposes
 * Returns turns and climb points separately for display
 */
export function getAllConstraintsForVisualization(
  s0: number,
  vertexDistances: number[],
  climbRequests: { endDistance: number; climbAmount: number }[],
  config: ClimbConfig
): {
  turns: Constraint[];
  climbPoints: Constraint[];
  nearestLeftTurn: Constraint | null;
  nearestRightTurn: Constraint | null;
  nearestLeftClimbPoint: Constraint | null;
  nearestRightClimbPoint: Constraint | null;
} {
  const { turnConstraints, climbPointConstraints } = buildConstraintsList(
    vertexDistances,
    climbRequests,
    s0,
    config
  );

  // Find nearest turn on each side
  const sortedTurns = [...turnConstraints].sort((a, b) => a.distance - b.distance);
  const turnDistances = sortedTurns.map(c => c.distance);
  
  const leftTurnIdx = binarySearchLessOrEqual(turnDistances, s0 - 0.001);
  const rightTurnIdx = binarySearchGreater(turnDistances, s0 + 0.001);

  // Find nearest climb point on each side
  const sortedClimbPoints = [...climbPointConstraints].sort((a, b) => a.distance - b.distance);
  const climbDistances = sortedClimbPoints.map(c => c.distance);
  
  const leftClimbIdx = binarySearchLessOrEqual(climbDistances, s0 - 0.001);
  const rightClimbIdx = binarySearchGreater(climbDistances, s0 + 0.001);

  return {
    turns: turnConstraints,
    climbPoints: climbPointConstraints,
    nearestLeftTurn: leftTurnIdx >= 0 ? sortedTurns[leftTurnIdx] : null,
    nearestRightTurn: rightTurnIdx >= 0 ? sortedTurns[rightTurnIdx] : null,
    nearestLeftClimbPoint: leftClimbIdx >= 0 ? sortedClimbPoints[leftClimbIdx] : null,
    nearestRightClimbPoint: rightClimbIdx >= 0 ? sortedClimbPoints[rightClimbIdx] : null
  };
}

