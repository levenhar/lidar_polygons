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
  segmentRatio?: number; // Ratio along the segment (0 = at pointA, 1 = at pointB) - stored to preserve position
}

/**
 * Find which segment a climb point lies on and return the anchor point IDs and ratio
 * @param endDistance Distance along the route where the climb point is
 * @param flightPath Array of coordinates (must have IDs)
 * @returns Object with anchor point IDs and ratio, or null if not found
 */
export function findAnchorPointsForClimb(
  endDistance: number,
  flightPath: Coordinate[]
): { anchorPointIdA: string; anchorPointIdB: string; segmentRatio: number } | null {
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
      
      // Calculate ratio along the segment
      const segmentStartDist = cumulativeDistances[i - 1];
      const segmentEndDist = cumulativeDistances[i];
      const segmentLength = segmentEndDist - segmentStartDist;
      const ratio = segmentLength > 0 
        ? Math.max(0, Math.min(1, (endDistance - segmentStartDist) / segmentLength))
        : 0;
      
      return {
        anchorPointIdA: pointA.id,
        anchorPointIdB: pointB.id,
        segmentRatio: ratio
      };
    }
  }
  
  // If distance is beyond the route, use the last segment
  if (flightPath.length >= 2) {
    const pointA = flightPath[flightPath.length - 2];
    const pointB = flightPath[flightPath.length - 1];
    
    if (pointA.id && pointB.id) {
      const segmentStartDist = cumulativeDistances[cumulativeDistances.length - 2];
      const segmentEndDist = cumulativeDistances[cumulativeDistances.length - 1];
      const segmentLength = segmentEndDist - segmentStartDist;
      const ratio = segmentLength > 0 
        ? Math.max(0, Math.min(1, (endDistance - segmentStartDist) / segmentLength))
        : 1;
      
      return {
        anchorPointIdA: pointA.id,
        anchorPointIdB: pointB.id,
        segmentRatio: ratio
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
 * Remove all climb points that are anchored to the specific segment between two points.
 * Used when a U-turn is inserted between two consecutive waypoints, replacing their direct
 * connection with a curve — any climb point that lived on that segment becomes invalid.
 * @param climbRequests Current list of climb requests
 * @param pointIdA ID of the segment start waypoint
 * @param pointIdB ID of the segment end waypoint
 * @returns New array with the matching climb requests removed
 */
export function removeClimbsOnSegment(
  climbRequests: ClimbRequest[],
  pointIdA: string,
  pointIdB: string
): ClimbRequest[] {
  return climbRequests.filter(
    (c) => !(c.anchorPointIdA === pointIdA && c.anchorPointIdB === pointIdB)
  );
}

/**
 * Derive the true endDistance for a climb from its anchor IDs and segmentRatio.
 *
 * When points are inserted into the path (e.g. a U-turn arc), the cumulative
 * distances of all subsequent waypoints shift. The stored `endDistance` becomes
 * stale. This function recomputes it from the stable anchor IDs + segmentRatio
 * so the climb position on the elevation profile stays correct regardless of
 * insertions elsewhere on the route.
 *
 * Falls back to `climb.endDistance` for legacy climbs that have no anchor IDs
 * or whose anchors cannot be found in the current path.
 *
 * @param climb Climb request with optional anchor IDs and segmentRatio
 * @param flightPath Current flight path (must have IDs on points)
 * @returns Effective distance from route start to the climb's position
 */
export function getEffectiveEndDistance(
  climb: ClimbRequest,
  flightPath: Coordinate[]
): number {
  if (!climb.anchorPointIdA || !climb.anchorPointIdB || climb.segmentRatio === undefined) {
    return climb.endDistance;
  }

  const cumulativeDistances = computeCumulativeDistances(flightPath);

  let segmentStartIdx = -1;
  let segmentEndIdx = -1;
  for (let i = 0; i < flightPath.length; i++) {
    if (flightPath[i].id === climb.anchorPointIdA) segmentStartIdx = i;
    if (flightPath[i].id === climb.anchorPointIdB) segmentEndIdx = i;
  }

  if (
    segmentStartIdx === -1 ||
    segmentEndIdx === -1 ||
    segmentEndIdx !== segmentStartIdx + 1
  ) {
    // Anchors not found or no longer consecutive — fall back to stored value
    return climb.endDistance;
  }

  const segmentStartDist = cumulativeDistances[segmentStartIdx];
  const segmentEndDist = cumulativeDistances[segmentEndIdx];
  const segmentLength = segmentEndDist - segmentStartDist;

  return segmentStartDist + climb.segmentRatio * segmentLength;
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

/**
 * Calculate the position of a climb point based on its anchor points and stored segment ratio
 * This preserves the position relative to anchor points even when unrelated points move
 * @param climb The climb request with anchor IDs and segmentRatio
 * @param flightPath Current flight path
 * @param targetDistance The distance to calculate position for (used if segmentRatio not available)
 * @returns Coordinate of the climb point, or null if anchors not found
 */
export function getClimbPositionFromAnchors(
  climb: ClimbRequest,
  flightPath: Coordinate[],
  targetDistance: number
): Coordinate | null {
  console.log('[GET_CLIMB_POS] Called with:', {
    endDistance: climb.endDistance,
    targetDistance,
    anchorPointIdA: climb.anchorPointIdA,
    anchorPointIdB: climb.anchorPointIdB,
    segmentRatio: climb.segmentRatio,
    flightPathLength: flightPath.length
  });

  // If no anchor IDs, fall back to distance-based calculation
  if (!climb.anchorPointIdA || !climb.anchorPointIdB) {
    console.log('[GET_CLIMB_POS] No anchor IDs, returning null');
    return null;
  }
  
  // Find anchor points in current flight path
  const pointA = flightPath.find(p => p.id === climb.anchorPointIdA);
  const pointB = flightPath.find(p => p.id === climb.anchorPointIdB);
  
  console.log('[GET_CLIMB_POS] Anchor points search:', {
    searchingForA: climb.anchorPointIdA,
    searchingForB: climb.anchorPointIdB,
    foundA: pointA ? { id: pointA.id, lng: pointA.lng, lat: pointA.lat } : null,
    foundB: pointB ? { id: pointB.id, lng: pointB.lng, lat: pointB.lat } : null,
    flightPathIds: flightPath.map(p => p.id)
  });
  
  if (!pointA || !pointB) {
    // Anchors not found (might have been deleted)
    console.log('[GET_CLIMB_POS] Anchor points not found, returning null');
    return null;
  }
  
  // Find which segment contains the anchor points
  let segmentStartIdx = -1;
  let segmentEndIdx = -1;
  
  for (let i = 0; i < flightPath.length; i++) {
    if (flightPath[i].id === climb.anchorPointIdA) {
      segmentStartIdx = i;
    }
    if (flightPath[i].id === climb.anchorPointIdB) {
      segmentEndIdx = i;
    }
  }
  
  console.log('[GET_CLIMB_POS] Segment indices:', {
    segmentStartIdx,
    segmentEndIdx,
    consecutive: segmentEndIdx === segmentStartIdx + 1
  });
  
  if (segmentStartIdx === -1 || segmentEndIdx === -1 || segmentEndIdx !== segmentStartIdx + 1) {
    // Anchors are not consecutive, can't calculate position
    console.log('[GET_CLIMB_POS] Anchors not consecutive, returning null');
    return null;
  }
  
  // Use stored segmentRatio if available (preserves exact position)
  // Otherwise calculate ratio from targetDistance (fallback for old climb points)
  let ratio: number;
  if (climb.segmentRatio !== undefined) {
    ratio = climb.segmentRatio;
    console.log('[GET_CLIMB_POS] Using stored segmentRatio:', ratio);
  } else {
    // Fallback: calculate ratio from targetDistance
    console.log('[GET_CLIMB_POS] No stored ratio, calculating from targetDistance');
    const cumulativeDistances = computeCumulativeDistances(flightPath);
    const segmentStartDist = cumulativeDistances[segmentStartIdx];
    const segmentEndDist = cumulativeDistances[segmentEndIdx];
    const segmentLength = segmentEndDist - segmentStartDist;
    
    console.log('[GET_CLIMB_POS] Calculated distances:', {
      segmentStartDist,
      segmentEndDist,
      segmentLength,
      targetDistance,
      distanceAlongSegment: targetDistance - segmentStartDist
    });
    
    if (segmentLength === 0) {
      // Degenerate segment
      console.log('[GET_CLIMB_POS] Degenerate segment, returning pointA');
      return { ...pointA };
    }
    
    const distanceAlongSegment = targetDistance - segmentStartDist;
    ratio = Math.max(0, Math.min(1, distanceAlongSegment / segmentLength));
    console.log('[GET_CLIMB_POS] Calculated ratio:', ratio);
  }
  
  // Interpolate position using the ratio
  const result = {
    lng: pointA.lng + (pointB.lng - pointA.lng) * ratio,
    lat: pointA.lat + (pointB.lat - pointA.lat) * ratio
  };
  
  console.log('[GET_CLIMB_POS] Final position:', {
    ...result,
    ratio,
    pointA: { lng: pointA.lng, lat: pointA.lat },
    pointB: { lng: pointB.lng, lat: pointB.lat }
  });
  
  return result;
}

