import { Coordinate, ElevationPoint } from '../App';
import { computeCumulativeDistances } from './constraints';

export interface ViewshedPoint {
  lng: number;
  lat: number;
  height: number; // ASL meters, always >= 0
}

/**
 * Build the trajectory sent to the viewshed API.
 *
 * Heights are resolved in priority order:
 *  1. elevationProfile[i].plannedAltitude — climb-corrected ASL altitude
 *  2. elevationProfile[i].baseAltitude — base plan without climb
 *  3. point.height — manually overridden waypoint height
 *  4. nominalFlightHeight — flat nominal entry height
 *
 * Heights are always clamped to >= 0.
 */
export function buildViewshedTrajectory(
  flightPath: Coordinate[],
  elevationProfile: ElevationPoint[],
  nominalFlightHeight: number
): ViewshedPoint[] {
  const cumulativeDistances = computeCumulativeDistances(flightPath);

  return flightPath.map((point, i) => {
    const distanceAlongPath = cumulativeDistances[i];

    let heightASL: number;

    if (elevationProfile.length > 0) {
      heightASL = interpolatePlannedAltitude(
        elevationProfile,
        distanceAlongPath,
        point.height ?? nominalFlightHeight
      );
    } else {
      heightASL = point.height ?? nominalFlightHeight;
    }

    return { lng: point.lng, lat: point.lat, height: Math.max(0, heightASL) };
  });
}

export function interpolatePlannedAltitude(
  profile: ElevationPoint[],
  distance: number,
  fallback: number
): number {
  for (let j = 0; j < profile.length - 1; j++) {
    const p1 = profile[j];
    const p2 = profile[j + 1];
    if (p1.distance <= distance && p2.distance >= distance) {
      const range = p2.distance - p1.distance;
      const t = range > 0 ? (distance - p1.distance) / range : 0;
      const alt1 = p1.plannedAltitude ?? p1.baseAltitude ?? fallback;
      const alt2 = p2.plannedAltitude ?? p2.baseAltitude ?? fallback;
      return alt1 + (alt2 - alt1) * t;
    }
  }
  // Distance outside profile range — use closest endpoint
  let closest = profile[0];
  let minDelta = Math.abs(closest.distance - distance);
  for (const p of profile) {
    const delta = Math.abs(p.distance - distance);
    if (delta < minDelta) {
      minDelta = delta;
      closest = p;
    }
  }
  return closest.plannedAltitude ?? closest.baseAltitude ?? fallback;
}
