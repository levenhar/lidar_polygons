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

describe('constraints', () => {
  describe('binarySearchLessOrEqual', () => {
    it('finds exact value at index', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchLessOrEqual(arr, 30)).toBe(2);
    });
    it('finds value between elements', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchLessOrEqual(arr, 25)).toBe(1);
    });
    it('returns -1 for value smaller than all', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchLessOrEqual(arr, 5)).toBe(-1);
    });
    it('finds last element for value larger than all', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchLessOrEqual(arr, 60)).toBe(4);
    });
    it('returns -1 for empty array', () => {
      expect(binarySearchLessOrEqual([], 10)).toBe(-1);
    });
  });

  describe('binarySearchGreater', () => {
    it('finds index for value greater than target', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchGreater(arr, 25)).toBe(2);
    });
    it('finds next index for exact value', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchGreater(arr, 30)).toBe(3);
    });
    it('returns -1 for value >= max', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchGreater(arr, 50)).toBe(-1);
    });
    it('finds first element for small value', () => {
      const arr = [10, 20, 30, 40, 50];
      expect(binarySearchGreater(arr, 5)).toBe(0);
    });
    it('returns -1 for empty array', () => {
      expect(binarySearchGreater([], 10)).toBe(-1);
    });
  });

  describe('computeCumulativeDistances', () => {
    it('returns same length as path with strictly increasing distances', () => {
      const path: Coordinate[] = [
        { lng: 0, lat: 0 },
        { lng: 0.0001, lat: 0 },
        { lng: 0.0002, lat: 0 }
      ];
      const distances = computeCumulativeDistances(path);
      expect(distances.length).toBe(3);
      expect(distances[0]).toBe(0);
      expect(distances[1]).toBeGreaterThan(0);
      expect(distances[2]).toBeGreaterThan(distances[1]);
    });
    it('returns empty array for empty path', () => {
      expect(computeCumulativeDistances([]).length).toBe(0);
    });
  });

  describe('buildConstraintsList', () => {
    it('builds turn and climb constraints sorted by distance', () => {
      const vertexDistances = [0, 100, 200, 300];
      const climbRequests = [
        { endDistance: 50, climbAmount: 10 },
        { endDistance: 150, climbAmount: -5 },
        { endDistance: 250, climbAmount: 15 }
      ];
      const s0 = 150;
      const config: ClimbConfig = {
        climbRatio: 4,
        descentRatio: 8,
        allowTurnsDuringClimb: false,
        linkRatios: false,
        vertexProximityMeters: 30,
        minClimb: 11,
        maxClimb: 50
      };
      const result = buildConstraintsList(vertexDistances, climbRequests, s0, config);
      expect(result.turnConstraints.length).toBe(2);
      expect(result.climbPointConstraints.length).toBe(2);
      const allDistances = result.allConstraints.map(c => c.distance);
      const sortedDistances = [...allDistances].sort((a, b) => a - b);
      expect(allDistances).toEqual(sortedDistances);
    });
  });

  describe('getNearestConstraints', () => {
    const config: ClimbConfig = {
      climbRatio: 4,
      descentRatio: 8,
      allowTurnsDuringClimb: false,
      linkRatios: false,
      vertexProximityMeters: 30,
      minClimb: 11,
      maxClimb: 50
    };

    it('computes dL and dR with no turns nearby', () => {
      const vertexDistances = [0, 500, 1000];
      const climbRequests: { endDistance: number; climbAmount: number }[] = [];
      const s0 = 250;
      const totalRouteLength = 1000;
      const result = getNearestConstraints(s0, config, vertexDistances, climbRequests, totalRouteLength);
      expect(Math.abs(result.dL - 250)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.dR - 250)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.maxDeltaZ - 62.5)).toBeLessThanOrEqual(0.5);
    });

    it('computes constraints with turn on one side', () => {
      const vertexDistances = [0, 150, 1000];
      const climbRequests: { endDistance: number; climbAmount: number }[] = [];
      const s0 = 100;
      const totalRouteLength = 1000;
      const result = getNearestConstraints(s0, config, vertexDistances, climbRequests, totalRouteLength);
      expect(Math.abs(result.dR - 50)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.maxDeltaZ - 12.5)).toBeLessThanOrEqual(0.5);
      expect(result.right?.type).toBe('turn');
    });

    it('computes constraints with two climb points close to s0', () => {
      const vertexDistances = [0, 500, 1000];
      const climbRequests = [
        { endDistance: 180, climbAmount: 10 },
        { endDistance: 230, climbAmount: -5 }
      ];
      const s0 = 200;
      const totalRouteLength = 1000;
      const configWithTurns: ClimbConfig = { ...config, allowTurnsDuringClimb: true };
      const result = getNearestConstraints(s0, configWithTurns, vertexDistances, climbRequests, totalRouteLength);
      expect(Math.abs(result.dL - 20)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.dR - 30)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.maxDeltaZ - 5)).toBeLessThanOrEqual(0.5);
      expect(result.left?.type).toBe('climbPoint');
      expect(result.right?.type).toBe('climbPoint');
    });

    it('respects allowTurnsDuringClimb toggle', () => {
      const vertexDistances = [0, 150, 1000];
      const climbRequests = [{ endDistance: 50, climbAmount: 10 }];
      const s0 = 100;
      const totalRouteLength = 1000;
      const configNoTurns: ClimbConfig = { ...config, allowTurnsDuringClimb: false };
      const resultNoTurns = getNearestConstraints(s0, configNoTurns, vertexDistances, climbRequests, totalRouteLength);
      expect(Math.abs(resultNoTurns.dL - 50)).toBeLessThanOrEqual(1);
      expect(Math.abs(resultNoTurns.dR - 50)).toBeLessThanOrEqual(1);

      const configWithTurns: ClimbConfig = { ...config, allowTurnsDuringClimb: true };
      const resultWithTurns = getNearestConstraints(s0, configWithTurns, vertexDistances, climbRequests, totalRouteLength);
      expect(Math.abs(resultWithTurns.dL - 50)).toBeLessThanOrEqual(1);
      expect(resultWithTurns.dR).toBeGreaterThanOrEqual(100);
    });
  });

  describe('getAllConstraintsForVisualization', () => {
    it('returns nearest left/right turns and climb points', () => {
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
        vertexProximityMeters: 30,
        minClimb: 11,
        maxClimb: 50
      };
      const result = getAllConstraintsForVisualization(s0, vertexDistances, climbRequests, config);
      expect(result.nearestLeftTurn?.distance).toBe(100);
      expect(result.nearestRightTurn?.distance).toBe(200);
      expect(result.nearestLeftClimbPoint?.distance).toBe(50);
      expect(result.nearestRightClimbPoint?.distance).toBe(250);
    });
  });
});
