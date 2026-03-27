import {
  findAnchorPointsForClimb,
  findClimbsAnchoredToPoint,
  getClimbPositionFromAnchors,
  getEffectiveEndDistance,
  removeClimbsOnSegment,
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

  describe('getEffectiveEndDistance', () => {
    it('returns stored endDistance when climb has no anchor IDs', () => {
      const climb: ClimbRequest = { endDistance: 99, climbAmount: 5 };
      expect(getEffectiveEndDistance(climb, pathWithIds)).toBe(99);
    });

    it('returns stored endDistance when segmentRatio is missing', () => {
      const climb: ClimbRequest = {
        endDistance: 99,
        climbAmount: 5,
        anchorPointIdA: 'p0',
        anchorPointIdB: 'p1'
        // segmentRatio omitted
      };
      expect(getEffectiveEndDistance(climb, pathWithIds)).toBe(99);
    });

    it('returns stored endDistance when anchors are not consecutive', () => {
      const climb: ClimbRequest = {
        endDistance: 99,
        climbAmount: 5,
        anchorPointIdA: 'p0',
        anchorPointIdB: 'p2', // not consecutive with p0
        segmentRatio: 0.5
      };
      expect(getEffectiveEndDistance(climb, pathWithIds)).toBe(99);
    });

    it('derives endDistance from anchor start + ratio × segment length', () => {
      // pathWithIds: p0=(0,0), p1=(0.0001,0), p2=(0.0002,0)
      // Each segment is ~11.132m long (0.0001° of longitude at equator)
      // Climb at ratio=0.5 on p0→p1: effective = 0 + 0.5 * segmentLength ≈ 5.566m
      const climb: ClimbRequest = {
        endDistance: 999, // stale/wrong stored value
        climbAmount: 5,
        anchorPointIdA: 'p0',
        anchorPointIdB: 'p1',
        segmentRatio: 0.5
      };
      const result = getEffectiveEndDistance(climb, pathWithIds);
      // Should be ~half the first segment length, not 999
      expect(result).not.toBeCloseTo(999, 0);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(20); // well within the first segment
    });

    it('correctly handles climb on the second segment (cumulative offset)', () => {
      // Climb at ratio=0 on p1→p2: effective = cumulativeDist(p1) + 0 * segmentLength = segLen(p0→p1)
      const climb: ClimbRequest = {
        endDistance: 999,
        climbAmount: 3,
        anchorPointIdA: 'p1',
        anchorPointIdB: 'p2',
        segmentRatio: 0
      };
      const seg0End = getEffectiveEndDistance(
        { endDistance: 999, climbAmount: 0, anchorPointIdA: 'p0', anchorPointIdB: 'p1', segmentRatio: 1 },
        pathWithIds
      );
      const result = getEffectiveEndDistance(climb, pathWithIds);
      expect(result).toBeCloseTo(seg0End, 1);
    });
  });

  describe('removeClimbsOnSegment', () => {
    const climbs: ClimbRequest[] = [
      { endDistance: 10, climbAmount: 5, anchorPointIdA: 'p0', anchorPointIdB: 'p1' },
      { endDistance: 20, climbAmount: 3, anchorPointIdA: 'p1', anchorPointIdB: 'p2' },
      { endDistance: 30, climbAmount: 2, anchorPointIdA: 'p0', anchorPointIdB: 'p2' },
      { endDistance: 40, climbAmount: 1 }
    ];

    it('removes only the climb anchored to the exact segment A→B', () => {
      const result = removeClimbsOnSegment(climbs, 'p0', 'p1');
      expect(result).toHaveLength(3);
      expect(result.find(c => c.anchorPointIdA === 'p0' && c.anchorPointIdB === 'p1')).toBeUndefined();
    });

    it('keeps climbs on the reverse direction B→A untouched', () => {
      const result = removeClimbsOnSegment(climbs, 'p1', 'p0');
      expect(result).toHaveLength(4); // p0→p1 is NOT the same as p1→p0
    });

    it('keeps climbs that share only one anchor point', () => {
      const result = removeClimbsOnSegment(climbs, 'p0', 'p1');
      expect(result.find(c => c.anchorPointIdA === 'p1' && c.anchorPointIdB === 'p2')).toBeDefined();
      expect(result.find(c => c.anchorPointIdA === 'p0' && c.anchorPointIdB === 'p2')).toBeDefined();
    });

    it('keeps climbs with no anchor IDs', () => {
      const result = removeClimbsOnSegment(climbs, 'p0', 'p1');
      expect(result.find(c => c.endDistance === 40)).toBeDefined();
    });

    it('returns the same array reference when nothing is removed', () => {
      const result = removeClimbsOnSegment(climbs, 'x', 'y');
      expect(result).toHaveLength(4);
    });

    it('returns empty array when all climbs are on the target segment', () => {
      const single: ClimbRequest[] = [
        { endDistance: 10, climbAmount: 5, anchorPointIdA: 'a', anchorPointIdB: 'b' }
      ];
      expect(removeClimbsOnSegment(single, 'a', 'b')).toHaveLength(0);
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
