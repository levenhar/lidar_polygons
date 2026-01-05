import { Coordinate } from '../App';

export interface ClimbConfig {
  hvRatio: number; // horizontal meters required per 1m climb
  allowTurnsDuringClimb: boolean;
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

function bearingDegrees(a: Coordinate, b: Coordinate): number {
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return ((brng * 180) / Math.PI + 360) % 360;
}

function angleDelta(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function cumulativeDistances(path: Coordinate[]): number[] {
  if (path.length === 0) return [];
  const distances = [0];
  for (let i = 1; i < path.length; i++) {
    distances.push(distances[i - 1] + haversineDistance(path[i - 1], path[i]));
  }
  return distances;
}

function findSegmentIndex(target: number, cumulative: number[]): number {
  if (cumulative.length < 2) return 0;
  for (let i = 0; i < cumulative.length - 1; i++) {
    if (target >= cumulative[i] && target <= cumulative[i + 1]) {
      return i;
    }
  }
  return cumulative.length - 2;
}

/**
 * Compute a gradual climb profile starting at a distance along track.
 * Climb progresses at hvRatio meters horizontal per 1 meter vertical.
 * When allowTurnsDuringClimb is false, horizontal distance inside turn segments
 * does not advance the climb ("pause during turns").
 */
export function computeClimbProfile(
  startDistance: number,
  climbAmount: number,
  hvRatio: number,
  allowTurnsDuringClimb: boolean,
  pathGeometry: Coordinate[],
  baseProfile: BaseAltitudeSample[],
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
    warnings.push('Climb amount must be non-zero.');
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

  if (!Number.isFinite(hvRatio) || hvRatio <= 0) {
    warnings.push('Horizontal-to-vertical ratio must be > 0.');
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
  const requiredHorizontal = Math.abs(climbAmount) * hvRatio;
  const appliedMagnitude = Math.min(Math.abs(climbAmount), availableHorizontal / hvRatio);
  const appliedClimb = appliedMagnitude * climbDirection;

  if (Math.abs(appliedClimb) < Math.abs(climbAmount)) {
    warnings.push(
      `Not enough distance to complete the climb. Applying ${appliedClimb.toFixed(
        1
      )} m out of ${climbAmount.toFixed(1)} m.`
    );
  }

  // Pre-compute turn segments (pause climb during turns when disabled)
  const turnThresholdDeg = 10; // small wiggle allowed
  const cumulative = cumulativeDistances(pathGeometry);
  const segmentBearings =
    pathGeometry.length >= 2
      ? pathGeometry.slice(0, -1).map((_, idx) => bearingDegrees(pathGeometry[idx], pathGeometry[idx + 1]))
      : [];
  const isTurnSegment: boolean[] = segmentBearings.map(() => false);

  for (let i = 1; i < segmentBearings.length; i++) {
    if (angleDelta(segmentBearings[i - 1], segmentBearings[i]) > turnThresholdDeg) {
      isTurnSegment[i] = true;
      isTurnSegment[i - 1] = true;
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
    const segmentIdx = cumulative.length > 1 ? findSegmentIndex(sample.distance, cumulative) : 0;
    const effectiveHorizontal =
      !allowTurnsDuringClimb && isTurnSegment[segmentIdx] ? 0 : deltaHorizontal;
    if (!allowTurnsDuringClimb && isTurnSegment[segmentIdx] && appliedMagnitude > 0) {
      encounteredTurnDuringClimb = true;
    }

    const potentialClimb = (effectiveHorizontal / hvRatio) * climbDirection;
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
    warnings.push('Climb intersects a turn while turns are disabled.');
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


