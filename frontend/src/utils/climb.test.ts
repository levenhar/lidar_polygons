import { computeClimbProfile, BaseAltitudeSample } from './climb';
import { Coordinate } from '../App';

/**
 * Minimal, dependency-free smoke tests for computeClimbProfile.
 * Run manually with: RUN_CLIMB_TESTS=1 npm run build (or ts-node).
 */
export function runClimbProfileTests(): true {
  const path: Coordinate[] = [
    { lng: 0, lat: 0 },
    { lng: 0, lat: 0.0001 },
    { lng: 0, lat: 0.0002 }
  ];

  const baseProfile: BaseAltitudeSample[] = [
    { distance: 0, baseAltitude: 100, ground: 0 },
    { distance: 11.1, baseAltitude: 100, ground: 0 },
    { distance: 22.2, baseAltitude: 100, ground: 0 }
  ];

  const result = computeClimbProfile(0, 5, 2, true, path, baseProfile);
  if (Math.abs(result.appliedClimb - 5) > 1e-3) {
    throw new Error(`expected full climb, got ${result.appliedClimb}`);
  }
  if (Math.abs(result.points[result.points.length - 1].plannedAltitude - 105) > 1e-3) {
    throw new Error('planned altitude should include the climb');
  }

  const pausedResult = computeClimbProfile(0, 5, 2, false, path, baseProfile);
  if (pausedResult.requiredHorizontal !== 10) {
    throw new Error('hvRatio calculation mismatch');
  }

  return true;
}

if (typeof process !== 'undefined' && process.env.RUN_CLIMB_TESTS === '1') {
  runClimbProfileTests();
  console.log('✅ climb tests passed');
}

