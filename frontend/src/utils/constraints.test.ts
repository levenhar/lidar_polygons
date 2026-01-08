import {
  binarySearchLessOrEqual,
  binarySearchGreater,
  computeCumulativeDistances,
  buildConstraintsList,
  getNearestConstraints,
  getAllConstraintsForVisualization
} from './constraints';
import { ClimbConfig } from './climb';
import { Coordinate } from '../App';

/**
 * Unit tests for constraint computation utilities.
 * Run manually with: RUN_CONSTRAINT_TESTS=1 npm run build (or ts-node).
 */
export function runConstraintTests(): true {
  console.log('Running constraint computation tests...\n');

  // =====================
  // Binary Search Tests
  // =====================
  
  console.log('1. Testing binarySearchLessOrEqual...');
  {
    const arr = [10, 20, 30, 40, 50];
    
    // Test finding exact values
    if (binarySearchLessOrEqual(arr, 30) !== 2) {
      throw new Error('binarySearchLessOrEqual: should find exact value at index 2');
    }
    
    // Test finding values between elements
    if (binarySearchLessOrEqual(arr, 25) !== 1) {
      throw new Error('binarySearchLessOrEqual: should find 20 (index 1) for target 25');
    }
    
    // Test values smaller than all elements
    if (binarySearchLessOrEqual(arr, 5) !== -1) {
      throw new Error('binarySearchLessOrEqual: should return -1 for value smaller than all');
    }
    
    // Test values larger than all elements
    if (binarySearchLessOrEqual(arr, 60) !== 4) {
      throw new Error('binarySearchLessOrEqual: should find last element for large value');
    }
    
    // Test empty array
    if (binarySearchLessOrEqual([], 10) !== -1) {
      throw new Error('binarySearchLessOrEqual: should return -1 for empty array');
    }
    
    console.log('   ✓ binarySearchLessOrEqual passed');
  }

  console.log('2. Testing binarySearchGreater...');
  {
    const arr = [10, 20, 30, 40, 50];
    
    // Test finding values greater than target
    if (binarySearchGreater(arr, 25) !== 2) {
      throw new Error('binarySearchGreater: should find 30 (index 2) for target 25');
    }
    
    // Test exact value (should find next)
    if (binarySearchGreater(arr, 30) !== 3) {
      throw new Error('binarySearchGreater: should find 40 (index 3) for exact value 30');
    }
    
    // Test values larger than all elements
    if (binarySearchGreater(arr, 50) !== -1) {
      throw new Error('binarySearchGreater: should return -1 for value >= max');
    }
    
    // Test values smaller than all elements
    if (binarySearchGreater(arr, 5) !== 0) {
      throw new Error('binarySearchGreater: should find first element for small value');
    }
    
    // Test empty array
    if (binarySearchGreater([], 10) !== -1) {
      throw new Error('binarySearchGreater: should return -1 for empty array');
    }
    
    console.log('   ✓ binarySearchGreater passed');
  }

  // =====================
  // Cumulative Distance Tests
  // =====================
  
  console.log('3. Testing computeCumulativeDistances...');
  {
    // Test with simple path (approximately 11.1m between points at this latitude)
    const path: Coordinate[] = [
      { lng: 0, lat: 0 },
      { lng: 0.0001, lat: 0 },
      { lng: 0.0002, lat: 0 }
    ];
    
    const distances = computeCumulativeDistances(path);
    
    if (distances.length !== 3) {
      throw new Error('computeCumulativeDistances: should return same length as path');
    }
    
    if (distances[0] !== 0) {
      throw new Error('computeCumulativeDistances: first distance should be 0');
    }
    
    if (distances[1] <= 0 || distances[2] <= distances[1]) {
      throw new Error('computeCumulativeDistances: distances should be strictly increasing');
    }
    
    // Empty path
    if (computeCumulativeDistances([]).length !== 0) {
      throw new Error('computeCumulativeDistances: empty path should return empty array');
    }
    
    console.log('   ✓ computeCumulativeDistances passed');
  }

  // =====================
  // Build Constraints List Tests
  // =====================
  
  console.log('4. Testing buildConstraintsList...');
  {
    const vertexDistances = [0, 100, 200, 300]; // 3 vertices = 2 turns (excluding endpoints)
    const climbRequests = [
      { endDistance: 50, climbAmount: 10 },
      { endDistance: 150, climbAmount: -5 },
      { endDistance: 250, climbAmount: 15 }
    ];
    const s0 = 150; // Current point
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const result = buildConstraintsList(vertexDistances, climbRequests, s0, config);
    
    // Should have 2 turns (excluding first and last vertex)
    if (result.turnConstraints.length !== 2) {
      throw new Error(`buildConstraintsList: expected 2 turns, got ${result.turnConstraints.length}`);
    }
    
    // Should exclude current point (s0=150) from climb constraints
    if (result.climbPointConstraints.length !== 2) {
      throw new Error(`buildConstraintsList: expected 2 climb points (excluding s0), got ${result.climbPointConstraints.length}`);
    }
    
    // All constraints should be sorted by distance
    const allDistances = result.allConstraints.map(c => c.distance);
    const sortedDistances = [...allDistances].sort((a, b) => a - b);
    if (JSON.stringify(allDistances) !== JSON.stringify(sortedDistances)) {
      throw new Error('buildConstraintsList: allConstraints should be sorted by distance');
    }
    
    console.log('   ✓ buildConstraintsList passed');
  }

  // =====================
  // Get Nearest Constraints Tests
  // =====================
  
  console.log('5. Testing getNearestConstraints with no turns nearby...');
  {
    // Path with 2 turns far from s0
    const vertexDistances = [0, 500, 1000]; // Turn at 500m
    const climbRequests: { endDistance: number; climbAmount: number }[] = [];
    const s0 = 250; // Selected point at 250m
    const totalRouteLength = 1000;
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const result = getNearestConstraints(s0, config, vertexDistances, climbRequests, totalRouteLength);
    
    // With turn at 500m and s0 at 250m:
    // dL should be 250m (to route start)
    // dR should be 250m (to turn at 500m)
    if (Math.abs(result.dL - 250) > 1) {
      throw new Error(`getNearestConstraints (no turns nearby): expected dL=250, got ${result.dL}`);
    }
    if (Math.abs(result.dR - 250) > 1) {
      throw new Error(`getNearestConstraints (no turns nearby): expected dR=250, got ${result.dR}`);
    }
    
    // maxDeltaZ should be 250/4 = 62.5m
    if (Math.abs(result.maxDeltaZ - 62.5) > 0.5) {
      throw new Error(`getNearestConstraints (no turns nearby): expected maxDeltaZ=62.5, got ${result.maxDeltaZ}`);
    }
    
    console.log('   ✓ getNearestConstraints (no turns nearby) passed');
  }

  console.log('6. Testing getNearestConstraints with turn on one side only...');
  {
    // Turn on the right only
    const vertexDistances = [0, 150, 1000]; // Turn at 150m
    const climbRequests: { endDistance: number; climbAmount: number }[] = [];
    const s0 = 100; // Selected point at 100m
    const totalRouteLength = 1000;
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const result = getNearestConstraints(s0, config, vertexDistances, climbRequests, totalRouteLength);
    
    // dL = 100m (to start), dR = 50m (to turn at 150m)
    // Right side should be limiting
    if (Math.abs(result.dR - 50) > 1) {
      throw new Error(`getNearestConstraints (turn right): expected dR=50, got ${result.dR}`);
    }
    
    // maxDeltaZ should be min(100, 50)/4 = 12.5m
    if (Math.abs(result.maxDeltaZ - 12.5) > 0.5) {
      throw new Error(`getNearestConstraints (turn right): expected maxDeltaZ=12.5, got ${result.maxDeltaZ}`);
    }
    
    if (result.right?.type !== 'turn') {
      throw new Error('getNearestConstraints (turn right): right constraint should be a turn');
    }
    
    console.log('   ✓ getNearestConstraints (turn on one side) passed');
  }

  console.log('7. Testing getNearestConstraints with two climb points close to s0...');
  {
    // Two climb points close to s0
    const vertexDistances = [0, 500, 1000]; // Turn at 500m (far)
    const climbRequests = [
      { endDistance: 180, climbAmount: 10 },  // 20m to the left
      { endDistance: 230, climbAmount: -5 }   // 30m to the right
    ];
    const s0 = 200; // Selected point at 200m
    const totalRouteLength = 1000;
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: true, // Turns NOT limiting
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const result = getNearestConstraints(s0, config, vertexDistances, climbRequests, totalRouteLength);
    
    // With allowTurnsDuringClimb=true, only climb points are limiting
    // dL = 20m (to climb point at 180m), dR = 30m (to climb point at 230m)
    if (Math.abs(result.dL - 20) > 1) {
      throw new Error(`getNearestConstraints (climb points): expected dL=20, got ${result.dL}`);
    }
    if (Math.abs(result.dR - 30) > 1) {
      throw new Error(`getNearestConstraints (climb points): expected dR=30, got ${result.dR}`);
    }
    
    // maxDeltaZ should be min(20, 30)/4 = 5m
    if (Math.abs(result.maxDeltaZ - 5) > 0.5) {
      throw new Error(`getNearestConstraints (climb points): expected maxDeltaZ=5, got ${result.maxDeltaZ}`);
    }
    
    if (result.left?.type !== 'climbPoint' || result.right?.type !== 'climbPoint') {
      throw new Error('getNearestConstraints (climb points): both constraints should be climb points');
    }
    
    console.log('   ✓ getNearestConstraints (two climb points) passed');
  }

  console.log('8. Testing allowTurnsDuringClimb toggle...');
  {
    // Same setup but toggle allowTurnsDuringClimb
    const vertexDistances = [0, 150, 1000]; // Turn at 150m
    const climbRequests = [
      { endDistance: 50, climbAmount: 10 }  // Climb point at 50m
    ];
    const s0 = 100; // Selected point at 100m
    const totalRouteLength = 1000;
    
    // With allowTurnsDuringClimb=false: turn at 150m is limiting (dR=50)
    const configNoTurns: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const resultNoTurns = getNearestConstraints(s0, configNoTurns, vertexDistances, climbRequests, totalRouteLength);
    
    // Both climb point (50m left) and turn (50m right) should be limiting
    if (Math.abs(resultNoTurns.dL - 50) > 1 || Math.abs(resultNoTurns.dR - 50) > 1) {
      throw new Error('getNearestConstraints (noTurns): expected dL=50, dR=50');
    }
    
    // With allowTurnsDuringClimb=true: only climb point at 50m is limiting
    const configWithTurns: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: true,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const resultWithTurns = getNearestConstraints(s0, configWithTurns, vertexDistances, climbRequests, totalRouteLength);
    
    // Only climb point should be limiting (dL=50)
    // dR should be much larger (to route end)
    if (Math.abs(resultWithTurns.dL - 50) > 1) {
      throw new Error('getNearestConstraints (withTurns): expected dL=50');
    }
    if (resultWithTurns.dR < 100) {
      throw new Error('getNearestConstraints (withTurns): dR should be large (turn not limiting)');
    }
    
    // The limiting side should change
    if (resultWithTurns.limitingSide === resultNoTurns.limitingSide) {
      // This might be 'left' in both cases since climb point is on left
      // but the maxDeltaZ should be different
    }
    
    // maxDeltaZ should be different
    if (Math.abs(resultWithTurns.maxDeltaZ - resultNoTurns.maxDeltaZ) < 1) {
      throw new Error('getNearestConstraints: maxDeltaZ should differ when toggle changes');
    }
    
    console.log('   ✓ allowTurnsDuringClimb toggle test passed');
  }

  // =====================
  // Get All Constraints For Visualization Tests
  // =====================
  
  console.log('9. Testing getAllConstraintsForVisualization...');
  {
    const vertexDistances = [0, 100, 200, 300];
    const climbRequests = [
      { endDistance: 50, climbAmount: 10 },
      { endDistance: 250, climbAmount: -5 }
    ];
    const s0 = 150;
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30
    };
    
    const result = getAllConstraintsForVisualization(s0, vertexDistances, climbRequests, config);
    
    // Should find nearest turn on left (100m) and right (200m)
    if (result.nearestLeftTurn?.distance !== 100) {
      throw new Error(`getAllConstraintsForVisualization: expected left turn at 100, got ${result.nearestLeftTurn?.distance}`);
    }
    if (result.nearestRightTurn?.distance !== 200) {
      throw new Error(`getAllConstraintsForVisualization: expected right turn at 200, got ${result.nearestRightTurn?.distance}`);
    }
    
    // Should find nearest climb point on left (50m) and right (250m)
    if (result.nearestLeftClimbPoint?.distance !== 50) {
      throw new Error(`getAllConstraintsForVisualization: expected left climb at 50, got ${result.nearestLeftClimbPoint?.distance}`);
    }
    if (result.nearestRightClimbPoint?.distance !== 250) {
      throw new Error(`getAllConstraintsForVisualization: expected right climb at 250, got ${result.nearestRightClimbPoint?.distance}`);
    }
    
    console.log('   ✓ getAllConstraintsForVisualization passed');
  }

  console.log('\n✅ All constraint computation tests passed!\n');
  return true;
}

// Run tests if environment variable is set
if (typeof process !== 'undefined' && process.env.RUN_CONSTRAINT_TESTS === '1') {
  runConstraintTests();
}

