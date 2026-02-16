import { calculateDistance, calculateBearing, calculateDestination, generateUTurnPoints } from './geometry';
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
    it('returns empty array for numPoints <= 0', () => {
      const prev: Coordinate = { lng: 0, lat: 0 };
      const start: Coordinate = { lng: 0.0001, lat: 0 };
      expect(generateUTurnPoints(prev, start, 50, 80, 0)).toEqual([]);
    });
    it('returns empty array for invalid radius', () => {
      const prev: Coordinate = { lng: 0, lat: 0 };
      const start: Coordinate = { lng: 0.0001, lat: 0 };
      expect(generateUTurnPoints(prev, start, 0, 80, 5)).toEqual([]);
    });
    it('returns numPoints points for valid inputs', () => {
      const prev: Coordinate = { lng: 0, lat: 0 };
      const start: Coordinate = { lng: 0.0001, lat: 0 };
      const points = generateUTurnPoints(prev, start, 50, 80, 10, 'R');
      expect(points.length).toBe(10);
      expect(points.every(p => typeof p.lng === 'number' && typeof p.lat === 'number')).toBe(true);
    });
  });
});
