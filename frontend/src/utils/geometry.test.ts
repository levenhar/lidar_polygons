import { calculateDistance, calculateBearing, calculateDestination, generateUTurnPoints, generateUTurnPointsBetween } from './geometry';
import { Coordinate } from '../App';

describe('geometry', () => {
  describe('calculateDistance', () => {
    it('returns 0 for same point', () => {
      const c: Coordinate = { lng: 34.5, lat: 31.2 };
      expect(calculateDistance(c, c)).toBe(0);
    });
    it('returns positive distance for two distinct points', () => {
      const a: Coordinate = { lng: 34.5, lat: 31.2 };
      const b: Coordinate = { lng: 34.6, lat: 31.2 };
      const d = calculateDistance(a, b);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(20000);
    });
    it('is symmetric', () => {
      const a: Coordinate = { lng: 0, lat: 0 };
      const b: Coordinate = { lng: 0.001, lat: 0.001 };
      expect(calculateDistance(a, b)).toBe(calculateDistance(b, a));
    });
  });

  describe('calculateBearing', () => {
    it('returns value in [-PI, PI] for northward direction', () => {
      const a: Coordinate = { lng: 0, lat: 0 };
      const b: Coordinate = { lng: 0, lat: 1 };
      const bearing = calculateBearing(a, b);
      expect(bearing).toBeGreaterThanOrEqual(-Math.PI);
      expect(bearing).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(bearing)).toBeLessThanOrEqual(Math.PI);
    });
  });

  describe('calculateDestination', () => {
    it('returns start when distance is 0', () => {
      const start: Coordinate = { lng: 34.5, lat: 31.2 };
      const result = calculateDestination(start, 0, 0);
      expect(result.lng).toBeCloseTo(start.lng, 10);
      expect(result.lat).toBeCloseTo(start.lat, 10);
    });
    it('moves point by given distance and bearing', () => {
      const start: Coordinate = { lng: 34.5, lat: 31.2 };
      const bearing = 0;
      const distance = 1000;
      const result = calculateDestination(start, bearing, distance);
      const d = calculateDistance(start, result);
      expect(Math.abs(d - distance)).toBeLessThan(1);
    });
  });

  describe('generateUTurnPoints', () => {
    const canonicalPrev: Coordinate = { lng: 0, lat: 0 };
    const canonicalStart: Coordinate = { lng: 0.0001, lat: 0 };

    it('returns empty array for numPoints <= 0', () => {
      expect(generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 0)).toEqual([]);
    });
    it('returns empty array for invalid radius', () => {
      expect(generateUTurnPoints(canonicalPrev, canonicalStart, 0, 80, 5)).toEqual([]);
    });
    it('returns numPoints points for valid inputs', () => {
      const points = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'R');
      expect(points.length).toBe(10);
      expect(points.every(p => typeof p.lng === 'number' && typeof p.lat === 'number')).toBe(true);
    });

    it('places last point on perpendicular to last leg at given chord distance (R)', () => {
      const inboundBearing = calculateBearing(canonicalPrev, canonicalStart);
      const rightPerpBearing = inboundBearing + Math.PI / 2;
      const chordLength = Math.min(80, 50 * 2);
      const expectedEnd = calculateDestination(canonicalStart, rightPerpBearing, chordLength);
      const points = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'R');
      expect(points.length).toBe(10);
      expect(points[9].lng).toBeCloseTo(expectedEnd.lng, 10);
      expect(points[9].lat).toBeCloseTo(expectedEnd.lat, 10);
    });

    it('places last point on perpendicular to last leg at given chord distance (L)', () => {
      const inboundBearing = calculateBearing(canonicalPrev, canonicalStart);
      const leftPerpBearing = inboundBearing - Math.PI / 2;
      const chordLength = Math.min(80, 50 * 2);
      const expectedEnd = calculateDestination(canonicalStart, leftPerpBearing, chordLength);
      const points = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'L');
      expect(points.length).toBe(10);
      expect(points[9].lng).toBeCloseTo(expectedEnd.lng, 10);
      expect(points[9].lat).toBeCloseTo(expectedEnd.lat, 10);
    });

    it('is deterministic: same inputs produce same output', () => {
      const a = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'R');
      const b = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'R');
      expect(a).toEqual(b);
      expect(a.length).toBe(10);
    });

    it('returns frozen U-turn path for canonical R inputs (regression: do not change)', () => {
      const points = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'R');
      const coords = points.map(p => [p.lng, p.lat]);
      expect(coords).toMatchInlineSnapshot(`
        [
          [
            0.00028017992828662,
            0.00008091147276214861,
          ],
          [
            0.00047765047484476587,
            0.00007680583954872218,
          ],
          [
            0.0006543116714520281,
            -0.000011524758747047586,
          ],
          [
            0.0007760785059694416,
            -0.0001670378160561885,
          ],
          [
            0.0008194572847491647,
            -0.000359728642339132,
          ],
          [
            0.0007760785059979921,
            -0.0005524194686287091,
          ],
          [
            0.000654311671494329,
            -0.0007079325259542673,
          ],
          [
            0.000477650474880896,
            -0.0007962631242680785,
          ],
          [
            0.00028017992830402027,
            -0.0008003687574935758,
          ],
          [
            0.00009999999999936183,
            -0.0007194572847358352,
          ],
        ]
      `);
    });

    it('returns frozen U-turn path for canonical L inputs (regression: do not change)', () => {
      const points = generateUTurnPoints(canonicalPrev, canonicalStart, 50, 80, 10, 'L');
      const coords = points.map(p => [p.lng, p.lat]);
      expect(coords).toMatchInlineSnapshot(`
        [
          [
            0.0002801799282866199,
            -0.00008091147276214861,
          ],
          [
            0.00047765047484476587,
            -0.00007680583954872212,
          ],
          [
            0.000654311671452028,
            0.000011524758747047635,
          ],
          [
            0.0007760785059694414,
            0.00016703781605618864,
          ],
          [
            0.0008194572847491643,
            0.00035972864233913205,
          ],
          [
            0.0007760785059979921,
            0.0005524194686287091,
          ],
          [
            0.0006543116714943288,
            0.0007079325259542673,
          ],
          [
            0.0004776504748808955,
            0.0007962631242680785,
          ],
          [
            0.0002801799283040202,
            0.0008003687574935758,
          ],
          [
            0.00009999999999936179,
            0.0007194572847358353,
          ],
        ]
      `);
    });
  });

  describe('generateUTurnPointsBetween', () => {
    const start: Coordinate = { lng: 0, lat: 0 };
    const end: Coordinate = { lng: 0.0001, lat: 0 };

    it('returns empty array for numPoints <= 0', () => {
      expect(generateUTurnPointsBetween(start, end, 50, 0)).toEqual([]);
    });
    it('returns empty array for invalid radius', () => {
      expect(generateUTurnPointsBetween(start, end, 0, 10)).toEqual([]);
    });
    it('returns empty array when chord > 2*radius', () => {
      const farEnd: Coordinate = { lng: 0.001, lat: 0 };
      expect(generateUTurnPointsBetween(start, farEnd, 10, 10)).toEqual([]);
    });
    it('returns empty array for same start and end', () => {
      expect(generateUTurnPointsBetween(start, start, 50, 10)).toEqual([]);
    });
    it('returns numPoints interior points for valid inputs', () => {
      const points = generateUTurnPointsBetween(start, end, 50, 10, 'R');
      expect(points.length).toBe(10);
      expect(points.every(p => typeof p.lng === 'number' && typeof p.lat === 'number')).toBe(true);
    });
    it('is deterministic: same inputs produce same output', () => {
      const a = generateUTurnPointsBetween(start, end, 50, 10, 'R');
      const b = generateUTurnPointsBetween(start, end, 50, 10, 'R');
      expect(a).toEqual(b);
    });
  });
});
