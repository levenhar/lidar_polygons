import { Coordinate } from '../App';

export interface ClimbConfig {
  climbRatio: number; // horizontal meters required per 1m climb (up)
  descentRatio: number; // horizontal meters required per 1m descent (down)
  allowTurnsDuringClimb: boolean;
  linkRatios: boolean;
  vertexProximityMeters: number; // distance from vertex where climbing is paused
}

export interface ClimbPreset extends ClimbConfig {
  id: string;
  name: string;
  description?: string;
}

export interface BaseAltitudeSample {
  distance: number;
  baseAltitude: number;
  ground: number;
}

export interface ClimbProfilePoint extends BaseAltitudeSample {
  plannedAltitude: number;
  climbDelta: number;
  isClimbPhase: boolean;
}

export interface ClimbProfileResult {
  points: ClimbProfilePoint[];
  appliedClimb: number;
  requiredHorizontal: number;
  availableHorizontal: number;
  startDistance: number;
  completionDistance: number;
  warnings: string[];
}

const EARTH_RADIUS_M = 6371000;

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

function cumulativeDistances(path: Coordinate[]): number[] {
  if (path.length === 0) return [];
  const distances = [0];
  for (let i = 1; i < path.length; i++) {
    distances.push(distances[i - 1] + haversineDistance(path[i - 1], path[i]));
  }
  return distances;
}

/**
 * Compute a gradual climb profile starting at a distance along track.
 * Climb progresses at climbRatio (if > 0) or descentRatio (if < 0) meters horizontal per 1 meter vertical.
 * When allowTurnsDuringClimb is false, horizontal distance inside turn segments
 * does not advance the climb ("pause during turns").
 */
export function computeClimbProfile(
  startDistance: number,
  climbAmount: number,
  climbRatio: number,
  descentRatio: number,
  allowTurnsDuringClimb: boolean,
  pathGeometry: Coordinate[],
  baseProfile: BaseAltitudeSample[],
  vertexProximityMeters?: number,
  endDistance?: number
): ClimbProfileResult {
  const warnings: string[] = [];

  if (!Number.isFinite(startDistance) || baseProfile.length === 0) {
    return {
      points: baseProfile.map((p) => ({
        ...p,
        plannedAltitude: p.baseAltitude,
        climbDelta: 0,
        isClimbPhase: false
      })),
      appliedClimb: 0,
      requiredHorizontal: 0,
      availableHorizontal: 0,
      startDistance,
      completionDistance: startDistance,
      warnings
    };
  }

  if (!Number.isFinite(climbAmount) || climbAmount === 0) {
    warnings.push('כמות העלייה חייבת להיות שונה מאפס.');
    return {
      points: baseProfile.map((p) => ({
        ...p,
        plannedAltitude: p.baseAltitude,
        climbDelta: 0,
        isClimbPhase: false
      })),
      appliedClimb: 0,
      requiredHorizontal: 0,
      availableHorizontal: 0,
      startDistance,
      completionDistance: startDistance,
      warnings
    };
  }

  if (!Number.isFinite(climbRatio) || climbRatio <= 0 || !Number.isFinite(descentRatio) || descentRatio <= 0) {
    warnings.push('היחסים חייבים להיות > 0.');
    return {
      points: baseProfile.map((p) => ({
        ...p,
        plannedAltitude: p.baseAltitude,
        climbDelta: 0,
        isClimbPhase: false
      })),
      appliedClimb: 0,
      requiredHorizontal: 0,
      availableHorizontal: 0,
      startDistance,
      completionDistance: startDistance,
      warnings
    };
  }

  const lastDistance = baseProfile[baseProfile.length - 1].distance;
  const climbEnd = endDistance !== undefined ? Math.min(endDistance, lastDistance) : lastDistance;
  const availableHorizontal = Math.max(0, climbEnd - startDistance);
  const climbDirection = Math.sign(climbAmount);
  // Choose ratio based on direction: increasing altitude (positive) vs decreasing (negative)
  const activeRatio = climbAmount > 0 ? climbRatio : descentRatio;

  const requiredHorizontal = Math.abs(climbAmount) * activeRatio;
  const appliedMagnitude = Math.min(Math.abs(climbAmount), availableHorizontal / activeRatio);
  const appliedClimb = appliedMagnitude * climbDirection;

  if (Math.abs(appliedClimb) < Math.abs(climbAmount)) {
    warnings.push(
      `אין מספיק מרחק להשלמת העלייה. מיושם ${appliedClimb.toFixed(
        1
      )} מ' מתוך ${climbAmount.toFixed(1)} מ'.`
    );
  }

  // Pre-compute vertex distances (pause climb near vertices when disabled)
  const cumulative = cumulativeDistances(pathGeometry);
  const vertexProximity = vertexProximityMeters || 30; // Default 30m if not provided

  // Validate that climb start point is outside vertex proximity zones
  if (!allowTurnsDuringClimb) {
    for (const vertexDist of cumulative) {
      if (Math.abs(startDistance - vertexDist) < vertexProximity) {
        warnings.push(
          `תחילת העלייה (${startDistance.toFixed(1)}מ') נמצאת בטווח של ${vertexProximity}מ' מהקודקוד ב-${vertexDist.toFixed(1)}מ'. ` +
          `מרחק מינימלי נדרש: ${vertexProximity}מ'.`
        );
        // Return early with no climb applied
        return {
          points: baseProfile.map((p) => ({
            ...p,
            plannedAltitude: p.baseAltitude,
            climbDelta: 0,
            isClimbPhase: false
          })),
          appliedClimb: 0,
          requiredHorizontal,
          availableHorizontal,
          startDistance,
          completionDistance: startDistance,
          warnings
        };
      }
    }
  }

  let climbed = 0;
  let completionDistance = startDistance;
  let lastDistanceUsed = startDistance;
  let encounteredTurnDuringClimb = false;

  const points: ClimbProfilePoint[] = baseProfile.map((sample) => {
    const planned = { ...sample, plannedAltitude: sample.baseAltitude, climbDelta: 0, isClimbPhase: false };

    if (sample.distance <= startDistance || appliedMagnitude <= 0) {
      lastDistanceUsed = sample.distance;
      return planned;
    }

    const cappedDistance = Math.min(sample.distance, climbEnd);
    const deltaHorizontal = Math.max(0, cappedDistance - lastDistanceUsed);

    // Check if the distance interval [lastDistanceUsed, cappedDistance] intersects any vertex proximity zone
    let nearVertex = false;
    if (!allowTurnsDuringClimb) {
      for (const vertexDist of cumulative) {
        // Check if vertex proximity zone [vertexDist - proximity, vertexDist + proximity] 
        // intersects with our interval [lastDistanceUsed, cappedDistance]
        const zoneStart = vertexDist - vertexProximity;
        const zoneEnd = vertexDist + vertexProximity;
        const intervalStart = lastDistanceUsed;
        const intervalEnd = cappedDistance;

        // Intervals intersect if: intervalStart < zoneEnd AND intervalEnd > zoneStart
        if (intervalStart < zoneEnd && intervalEnd > zoneStart) {
          nearVertex = true;
          break;
        }
      }
    }

    const effectiveHorizontal = nearVertex ? 0 : deltaHorizontal;
    if (nearVertex && appliedMagnitude > 0) {
      encounteredTurnDuringClimb = true;
    }

    const potentialClimb = (effectiveHorizontal / activeRatio) * climbDirection;
    const targetClimb =
      climbDirection > 0
        ? Math.min(appliedClimb, climbed + potentialClimb)
        : Math.max(appliedClimb, climbed + potentialClimb);
    const nextClimbed = targetClimb;

    planned.plannedAltitude = sample.baseAltitude + nextClimbed;
    planned.climbDelta = nextClimbed;
    planned.isClimbPhase = nextClimbed !== climbed;

    climbed = nextClimbed;
    lastDistanceUsed = sample.distance;

    if (
      (climbDirection > 0 && climbed >= appliedClimb) ||
      (climbDirection < 0 && climbed <= appliedClimb)
    ) {
      completionDistance = Math.max(completionDistance, sample.distance);
    }

    return planned;
  });

  if (encounteredTurnDuringClimb) {
    warnings.push('העלייה חוצה אזור קרבה לקודקוד.');
  }

  return {
    points,
    appliedClimb,
    requiredHorizontal,
    availableHorizontal,
    startDistance,
    completionDistance,
    warnings
  };
}


