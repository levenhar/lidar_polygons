import {
  PROJECT_FORMAT_NAME,
  PROJECT_SCHEMA_VERSION,
  PROJECT_FILE_EXTENSION,
  LEGACY_PROJECT_FILE_EXTENSION,
  validateProject,
  exportProject,
  ProjectValidationError
} from './projectSerializer';
import { FlightRoute } from '../hooks/useFlightPath';
import { ClimbConfig } from './climb';

const minimalClimbConfig: ClimbConfig = {
  climbRatio: 4,
  descentRatio: 8,
  allowTurnsDuringClimb: false,
  linkRatios: false,
  vertexProximityMeters: 30,
  minClimb: 11,
  maxClimb: 50
};

describe('projectSerializer', () => {
  describe('constants', () => {
    it('exports expected format name and schema version', () => {
      expect(PROJECT_FORMAT_NAME).toBe('nehorai');
      expect(PROJECT_SCHEMA_VERSION).toBe(4);
      expect(PROJECT_FILE_EXTENSION).toBe('.nehorai');
      expect(LEGACY_PROJECT_FILE_EXTENSION).toBe('.routeproj');
    });
  });

  describe('validateProject', () => {
    const minimalValid = {
      format: PROJECT_FORMAT_NAME,
      schemaVersion: 4,
      createdAt: new Date().toISOString(),
      projectId: 'test-id',
      dtm: null,
      routes: [{ id: 'r1', name: 'Route 1', color: '#ff0000', lineWidth: 3, visible: true, points: [], nominalFlightHeight: 100 }],
      activeRouteId: 'r1',
      climbRequestsByRoute: {},
      general: { nominalFlightHeight: 100, safetyRadius: 50, safetyHeight: 140, outputHeight: 270 },
      mission: { overlapPercentage: 50, fovDegrees: 75 },
      ascendDescend: { selectedPresetId: 'custom', climbConfig: minimalClimbConfig },
      display: { dtmPalette: 'gray', dtmInverted: false, dtmOpacity: 0.1 },
      kmlImports: []
    };

    it('returns data for valid minimal project', () => {
      const result = validateProject(minimalValid);
      expect(result.routes).toHaveLength(1);
      expect(result.activeRouteId).toBe('r1');
      expect(result.kmlImports).toEqual([]);
    });

    it('throws for non-object', () => {
      expect(() => validateProject(null)).toThrow(ProjectValidationError);
      expect(() => validateProject(undefined)).toThrow(ProjectValidationError);
    });

    it('throws for wrong format', () => {
      expect(() => validateProject({ ...minimalValid, format: 'other' })).toThrow(ProjectValidationError);
    });

    it('throws for missing schemaVersion', () => {
      const noVersion = { ...minimalValid };
      delete (noVersion as any).schemaVersion;
      expect(() => validateProject(noVersion)).toThrow(ProjectValidationError);
    });

    it('throws for future schema version', () => {
      expect(() => validateProject({ ...minimalValid, schemaVersion: 99 })).toThrow(ProjectValidationError);
    });

    it('throws for missing routes', () => {
      expect(() => validateProject({ ...minimalValid, routes: null })).toThrow(ProjectValidationError);
    });
  });

  describe('exportProject', () => {
    it('produces ProjectFileData with minimal params', () => {
      const routes: FlightRoute[] = [{
        id: 'r1',
        name: 'Route 1',
        color: '#ff4d4f',
        lineWidth: 3,
        visible: true,
        points: [{ lng: 34.5, lat: 31.2 }],
        nominalFlightHeight: 100
      }];
      const result = exportProject({
        dtmSource: null,
        dtmInfo: null,
        activeClippedId: null,
        dtmSourceType: null,
        routes,
        activeRouteId: 'r1',
        climbRequestsByRoute: {},
        general: { nominalFlightHeight: 100, safetyRadius: 50, safetyHeight: 140, outputHeight: 270 },
        mission: { overlapPercentage: 50, fovDegrees: 75 },
        ascendDescend: { selectedPresetId: 'custom', climbConfig: minimalClimbConfig },
        display: { dtmPalette: 'gray', dtmInverted: false, dtmOpacity: 0.1 }
      });
      expect(result.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].points).toHaveLength(1);
      expect(result.routes[0].points[0].lng).toBe(34.5);
      expect(result.activeRouteId).toBe('r1');
      expect(result.kmlImports).toEqual([]);
    });
  });
});
