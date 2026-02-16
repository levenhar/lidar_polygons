import { generateKMLForRoute } from './kmlGenerator';
import { FlightRoute } from '../hooks/useFlightPath';

describe('kmlGenerator', () => {
  const minimalRoute: FlightRoute = {
    id: 'r1',
    name: 'Test Route',
    color: '#ff0000',
    lineWidth: 3,
    visible: true,
    points: [
      { lng: 34.5, lat: 31.2 },
      { lng: 34.6, lat: 31.3 }
    ],
    nominalFlightHeight: 100
  };

  describe('generateKMLForRoute', () => {
    it('returns a non-empty string', () => {
      const kml = generateKMLForRoute(minimalRoute, []);
      expect(typeof kml).toBe('string');
      expect(kml.length).toBeGreaterThan(0);
    });
    it('includes XML declaration and Folder', () => {
      const kml = generateKMLForRoute(minimalRoute, []);
      expect(kml).toContain('<?xml');
      expect(kml).toContain('<Folder');
      expect(kml).toContain('http://www.opengis.net/kml/2.2');
    });
    it('escapes route name in Folder name', () => {
      const kml = generateKMLForRoute({ ...minimalRoute, name: 'Test Route' }, []);
      expect(kml).toContain('Test Route');
    });
    it('includes coordinates for route points', () => {
      const kml = generateKMLForRoute(minimalRoute, []);
      expect(kml).toContain('34.5');
      expect(kml).toContain('31.2');
      expect(kml).toContain('34.6');
      expect(kml).toContain('31.3');
    });
    it('handles route with climb requests', () => {
      const kml = generateKMLForRoute(minimalRoute, [{ endDistance: 100, climbAmount: 10 }], 100);
      expect(kml.length).toBeGreaterThan(0);
      expect(kml).toContain('<Folder');
    });
  });
});
