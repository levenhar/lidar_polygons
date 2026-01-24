import { Coordinate } from '../App';
import { computeCumulativeDistances } from './constraints';

/**
 * Climb request with anchor point IDs
 */
export interface ClimbRequest {
  endDistance: number;
  climbAmount: number;
  anchorPointIdA?: string; // ID of the first anchor point (segment start)
  anchorPointIdB?: string; // ID of the second anchor point (segment end)
}

/**
 * Find which segment a climb point lies on and return the anchor point IDs
 * @param endDistance Distance along the route where the climb point is
 * @param flightPath Array of coordinates (must have IDs)
 * @returns Object with anchor point IDs, or null if not found
 */
export function findAnchorPointsForClimb(
  endDistance: number,
  flightPath: Coordinate[]
): { anchorPointIdA: string; anchorPointIdB: string } | null {
  if (flightPath.length < 2) return null;
  
  const cumulativeDistances = computeCumulativeDistances(flightPath);
  
  // Find the segment containing this distance
  for (let i = 1; i < cumulativeDistances.length; i++) {
    if (endDistance <= cumulativeDistances[i] + 0.1) {
      const pointA = flightPath[i - 1];
      const pointB = flightPath[i];
      
      // Ensure both points have IDs
      if (!pointA.id || !pointB.id) {
        console.warn('Points missing IDs, cannot anchor climb point');
        return null;
      }
      
      return {
        anchorPointIdA: pointA.id,
        anchorPointIdB: pointB.id
      };
    }
  }
  
  // If distance is beyond the route, use the last segment
  if (flightPath.length >= 2) {
    const pointA = flightPath[flightPath.length - 2];
    const pointB = flightPath[flightPath.length - 1];
    
    if (pointA.id && pointB.id) {
      return {
        anchorPointIdA: pointA.id,
        anchorPointIdB: pointB.id
      };
    }
  }
  
  return null;
}

/**
 * Find all climb points that are anchored to a given point ID
 * @param pointId The ID of the point to check
 * @param climbRequests Array of climb requests
 * @returns Array of climb requests that reference this point as an anchor
 */
export function findClimbsAnchoredToPoint(
  pointId: string,
  climbRequests: ClimbRequest[]
): ClimbRequest[] {
  return climbRequests.filter(
    (climb) =>
      climb.anchorPointIdA === pointId || climb.anchorPointIdB === pointId
  );
}

/**
 * Generate a stable ID for a coordinate if it doesn't have one
 * @param point The coordinate
 * @returns The point with an ID (generated if needed)
 */
export function ensurePointId(point: Coordinate): Coordinate {
  if (point.id) {
    return point;
  }
  return {
    ...point,
    id: `point-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  };
}

