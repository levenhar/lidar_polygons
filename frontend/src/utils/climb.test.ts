import { computeClimbProfile, BaseAltitudeSample } from './climb';
import { Coordinate } from '../App';

describe('climb', () => {
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

  it('applies full climb with climbRatio', () => {
    const result = computeClimbProfile(0, 5, 2, 4, true, path, baseProfile);
    expect(Math.abs(result.appliedClimb - 5)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(result.points[result.points.length - 1].plannedAltitude! - 105)).toBeLessThanOrEqual(1e-3);
  });

  it('computes descent requiredHorizontal with descentRatio', () => {
    const result = computeClimbProfile(0, -2, 2, 4, true, path, baseProfile);
    expect(Math.abs(result.requiredHorizontal - 8)).toBeLessThanOrEqual(1e-3);
  });

  it('computes requiredHorizontal when paused', () => {
    const result = computeClimbProfile(0, 5, 2, 4, false, path, baseProfile);
    expect(result.requiredHorizontal).toBe(10);
  });

  it('allows climb far from vertex with vertex proximity', () => {
    const longPath: Coordinate[] = [
      { lng: 0, lat: 0 },
      { lng: 0.01, lat: 0 },
      { lng: 0.01, lat: 0.01 }
    ];
    const longProfile: BaseAltitudeSample[] = [];
    for (let i = 0; i <= 20; i++) {
      longProfile.push({ distance: i * 100, baseAltitude: 100, ground: 0 });
    }
    const result = computeClimbProfile(500, 10, 2, 4, false, longPath, longProfile, 30);
    const finalAlt = result.points[result.points.length - 1].plannedAltitude!;
    expect(Math.abs(finalAlt - 110)).toBeLessThan(1e-3);
  });

  it('partially blocks climb near vertex', () => {
    const longPath: Coordinate[] = [
      { lng: 0, lat: 0 },
      { lng: 0.01, lat: 0 },
      { lng: 0.01, lat: 0.01 }
    ];
    const longProfile: BaseAltitudeSample[] = [];
    for (let i = 0; i <= 20; i++) {
      longProfile.push({ distance: i * 100, baseAltitude: 100, ground: 0 });
    }
    const result = computeClimbProfile(5, 5, 2, 4, false, longPath, longProfile, 30, 35);
    const nearVertexAlt = result.points[result.points.length - 1].plannedAltitude!;
    expect(nearVertexAlt).toBeLessThan(104);
  });

  it('rejects climb when starting near vertex', () => {
    const longPath: Coordinate[] = [
      { lng: 0, lat: 0 },
      { lng: 0.01, lat: 0 },
      { lng: 0.01, lat: 0.01 }
    ];
    const longProfile: BaseAltitudeSample[] = [];
    for (let i = 0; i <= 20; i++) {
      longProfile.push({ distance: i * 100, baseAltitude: 100, ground: 0 });
    }
    const result = computeClimbProfile(15, 10, 2, 4, false, longPath, longProfile, 30);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.appliedClimb).toBe(0);
  });
});
