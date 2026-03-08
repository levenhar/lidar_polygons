import { describe, it, expect } from 'vitest';
import { buildViewshedTrajectory } from './viewshedTrajectory';
import { Coordinate, ElevationPoint } from '../App';

// Two waypoints ~95 m apart at a realistic location
const WP0: Coordinate = { lng: 34.5, lat: 31.0 };
const WP1: Coordinate = { lng: 34.501, lat: 31.0 };

/** Profile samples that span the full path distance */
function makeProfile(samples: Partial<ElevationPoint>[]): ElevationPoint[] {
  return samples.map((s) => ({
    distance: 0,
    elevation: 100,
    longitude: 34.5,
    latitude: 31.0,
    ...s,
  }));
}

describe('viewshedTrajectory', () => {
  describe('buildViewshedTrajectory', () => {
    it('uses plannedAltitude from elevation profile instead of nominalFlightHeight', () => {
      const profile = makeProfile([
        { distance: 0, plannedAltitude: 500 },
        { distance: 200, plannedAltitude: 500 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 1000);

      expect(result[0].height).toBeCloseTo(500, 0);
      expect(result[1].height).toBeCloseTo(500, 0);
      // Must NOT use nominalFlightHeight (1000)
      expect(result[0].height).not.toBeCloseTo(1000, 0);
    });

    it('interpolates plannedAltitude between profile samples', () => {
      // Profile rises from 1000 at d=0 to 2000 at d=1000
      const profile = makeProfile([
        { distance: 0, plannedAltitude: 1000 },
        { distance: 1000, plannedAltitude: 2000 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 50);

      // WP0 is at d=0 → exactly 1000
      expect(result[0].height).toBeCloseTo(1000, 0);
      // WP1 is ~95 m along → between 1000 and 2000
      expect(result[1].height).toBeGreaterThan(1000);
      expect(result[1].height).toBeLessThan(2000);
    });

    it('falls back to nominalFlightHeight when elevationProfile is empty', () => {
      const result = buildViewshedTrajectory([WP0, WP1], [], 300);

      expect(result[0].height).toBe(300);
      expect(result[1].height).toBe(300);
    });

    it('falls back to point.height when elevationProfile is empty', () => {
      const wp0: Coordinate = { ...WP0, height: 750 };
      const wp1: Coordinate = { ...WP1, height: 800 };

      const result = buildViewshedTrajectory([wp0, wp1], [], 300);

      expect(result[0].height).toBe(750);
      expect(result[1].height).toBe(800);
    });

    it('clamps height to 0 when planned altitude would be negative', () => {
      // Profile has a negative planned altitude
      const profile = makeProfile([
        { distance: 0, plannedAltitude: -50 },
        { distance: 200, plannedAltitude: -50 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 1000);

      expect(result[0].height).toBe(0);
      expect(result[1].height).toBe(0);
    });

    it('uses baseAltitude as fallback when plannedAltitude is absent', () => {
      const profile = makeProfile([
        { distance: 0, baseAltitude: 600 },
        { distance: 200, baseAltitude: 600 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 1000);

      expect(result[0].height).toBeCloseTo(600, 0);
      expect(result[1].height).toBeCloseTo(600, 0);
    });

    it('returns correct lng/lat for each waypoint', () => {
      const profile = makeProfile([
        { distance: 0, plannedAltitude: 200 },
        { distance: 200, plannedAltitude: 200 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 200);

      expect(result[0].lng).toBe(WP0.lng);
      expect(result[0].lat).toBe(WP0.lat);
      expect(result[1].lng).toBe(WP1.lng);
      expect(result[1].lat).toBe(WP1.lat);
    });

    it('each waypoint gets its own height when profile varies along route', () => {
      // Profile: rises from 1000 at d=0 to 1500 at d=200
      const profile = makeProfile([
        { distance: 0, plannedAltitude: 1000 },
        { distance: 200, plannedAltitude: 1500 },
      ]);
      const result = buildViewshedTrajectory([WP0, WP1], profile, 50);

      // First waypoint at d=0 → 1000
      expect(result[0].height).toBeCloseTo(1000, 0);
      // Second waypoint at ~95 m → higher than first but lower than 1500
      expect(result[1].height).toBeGreaterThan(result[0].height);
      expect(result[1].height).toBeLessThan(1500);
    });

    it('returns empty array for empty flightPath', () => {
      const result = buildViewshedTrajectory([], [], 500);
      expect(result).toHaveLength(0);
    });
  });
});
