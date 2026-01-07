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

  // Test climb (positive amount) -> should use climbRatio (2)
  const result = computeClimbProfile(0, 5, 2, 4, true, path, baseProfile);
  if (Math.abs(result.appliedClimb - 5) > 1e-3) {
    throw new Error(`expected full climb, got ${result.appliedClimb}`);
  }
  if (Math.abs(result.points[result.points.length - 1].plannedAltitude - 105) > 1e-3) {
    throw new Error('planned altitude should include the climb');
  }

  // Test descent (negative amount) -> should use descentRatio (4)
  const descentResult = computeClimbProfile(0, -2, 2, 4, true, path, baseProfile);
  if (Math.abs(descentResult.requiredHorizontal - 8) > 1e-3) { // 2m * 4 ratio = 8m
    throw new Error(`expected descent req horizontal 8, got ${descentResult.requiredHorizontal}`);
  }

  const pausedResult = computeClimbProfile(0, 5, 2, 4, false, path, baseProfile);
  if (pausedResult.requiredHorizontal !== 10) {
    throw new Error('climbRatio calculation mismatch');
  }

  // Regression test for "turn point only on user vertex"
  // Setup: 2 long legs (1000m each) with a 90 deg turn.
  // With new vertex proximity logic (30m default), climbing should work far from vertices.
  const longPath: Coordinate[] = [
    { lng: 0, lat: 0 },
    { lng: 0.01, lat: 0 }, // ~1111m East
    { lng: 0.01, lat: 0.01 } // ~1111m North (90 deg left turn)
  ];
  const longProfile: BaseAltitudeSample[] = [];
  // Sample every ~100m
  for (let i = 0; i <= 20; i++) {
    longProfile.push({ distance: i * 100, baseAltitude: 100, ground: 0 });
  }

  // Try to climb 10m (needs 20m horiz with ratio 2) starting at 500m (middle of first leg).
  // With 30m vertex proximity, this should succeed (500m is far from vertex at 0m and 1111m).
  const turnTest = computeClimbProfile(500, 10, 2, 4, false, longPath, longProfile, 30);

  const finalAlt = turnTest.points[turnTest.points.length - 1].plannedAltitude;
  // We started at 100. If we climbed 10m, we expect ~110.
  if (Math.abs(finalAlt - 110) < 1e-3) {
    console.log(`✓ Vertex proximity test passed: climb allowed far from vertex (final alt ${finalAlt}).`);
  } else {
    console.log(`✗ Vertex proximity test failed: climb blocked (final alt ${finalAlt}).`);
    throw new Error('Vertex proximity logic not working as expected');
  }

  // Test that climbing IS blocked near a vertex
  // Try to climb starting at 5m and ending at 35m (spans the vertex at 0m with 30m proximity)
  // This means the climb will encounter samples within 30m of vertex at 0m
  const nearVertexTest = computeClimbProfile(5, 5, 2, 4, false, longPath, longProfile, 30, 35);
  const nearVertexAlt = nearVertexTest.points[nearVertexTest.points.length - 1].plannedAltitude;
  // The climb should be partially blocked because samples near 0m vertex are within proximity
  // We expect less than full climb (which would be 105m)
  if (nearVertexAlt < 104) { // Should be less than full climb due to blocking
    console.log(`✓ Near vertex test passed: climb partially blocked near vertex (final alt ${nearVertexAlt}).`);
  } else {
    console.log(`✗ Near vertex test failed: climb not blocked near vertex (final alt ${nearVertexAlt}).`);
    throw new Error('Vertex proximity blocking not working');
  }

  // Test that climb start point validation works
  // Try to start a climb at 15m (within 30m of vertex at 0m)
  const invalidStartTest = computeClimbProfile(15, 10, 2, 4, false, longPath, longProfile, 30);
  if (invalidStartTest.warnings.length > 0 && invalidStartTest.appliedClimb === 0) {
    console.log(`✓ Start validation test passed: climb rejected when starting near vertex.`);
    console.log(`  Warning: ${invalidStartTest.warnings[0]}`);
  } else {
    console.log(`✗ Start validation test failed: climb allowed when starting near vertex.`);
    throw new Error('Climb start point validation not working');
  }

  return true;
}

if (typeof process !== 'undefined' && process.env.RUN_CLIMB_TESTS === '1') {
  runClimbProfileTests();
  console.log('✅ climb tests passed');
}

