import {
  findAnchorPointsForClimb,
  findClimbsAnchoredToPoint,
  getClimbPositionFromAnchors,
  type ClimbRequest
} from './climbAnchors';
import { Coordinate } from '../App';

describe('climbAnchors', () => {
  const pathWithIds: Coordinate[] = [
    { lng: 0, lat: 0, id: 'p0' },
    { lng: 0.0001, lat: 0, id: 'p1' },
    { lng: 0.0002, lat: 0, id: 'p2' }
  ];

  describe('findAnchorPointsForClimb', () => {
    it('returns null for path with fewer than 2 points', () => {
      expect(findAnchorPointsForClimb(0, [{ lng: 0, lat: 0, id: 'a' }])).toBeNull();
    });
    it('returns null when points lack ids', () => {
      const pathNoIds: Coordinate[] = [
        { lng: 0, lat: 0 },
        { lng: 0.0001, lat: 0 }
      ];
      expect(findAnchorPointsForClimb(5, pathNoIds)).toBeNull();
    });
    it('returns anchor ids and ratio for distance within segment', () => {
      const result = findAnchorPointsForClimb(5, pathWithIds);
      expect(result).not.toBeNull();
      expect(result!.anchorPointIdA).toBeDefined();
      expect(result!.anchorPointIdB).toBeDefined();
      expect(result!.segmentRatio).toBeGreaterThanOrEqual(0);
      expect(result!.segmentRatio).toBeLessThanOrEqual(1);
    });
  });

  describe('findClimbsAnchoredToPoint', () => {
    it('returns climbs that reference the point as anchor A or B', () => {
      const climbs: ClimbRequest[] = [
        { endDistance: 10, climbAmount: 5, anchorPointIdA: 'p0', anchorPointIdB: 'p1' },
        { endDistance: 20, climbAmount: -3, anchorPointIdA: 'p1', anchorPointIdB: 'p2' },
        { endDistance: 30, climbAmount: 2 }
      ];
      expect(findClimbsAnchoredToPoint('p0', climbs).length).toBe(1);
      expect(findClimbsAnchoredToPoint('p1', climbs).length).toBe(2);
      expect(findClimbsAnchoredToPoint('p2', climbs).length).toBe(1);
      expect(findClimbsAnchoredToPoint('missing', climbs).length).toBe(0);
    });
  });

  describe('getClimbPositionFromAnchors', () => {
    it('returns null when climb has no anchor IDs', () => {
      const climb: ClimbRequest = { endDistance: 10, climbAmount: 5 };
      expect(getClimbPositionFromAnchors(climb, pathWithIds, 10)).toBeNull();
    });
    it('returns null when anchors not found in path', () => {
      const climb: ClimbRequest = {
        endDistance: 10,
        climbAmount: 5,
        anchorPointIdA: 'x',
        anchorPointIdB: 'y'
      };
      expect(getClimbPositionFromAnchors(climb, pathWithIds, 10)).toBeNull();
    });
    it('returns interpolated position when anchors are consecutive with segmentRatio', () => {
      const climb: ClimbRequest = {
        endDistance: 10,
        climbAmount: 5,
        anchorPointIdA: 'p0',
        anchorPointIdB: 'p1',
        segmentRatio: 0.5
      };
      const pos = getClimbPositionFromAnchors(climb, pathWithIds, 10);
      expect(pos).not.toBeNull();
      expect(pos!.lng).toBeCloseTo(0.00005, 5);
      expect(pos!.lat).toBe(0);
    });
  });
});
