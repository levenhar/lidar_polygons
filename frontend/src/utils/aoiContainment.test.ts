import { aoiContains, type AOIGeometry } from './aoiContainment';

describe('aoiContainment', () => {
  describe('aoiContains', () => {
    it('returns true when new bbox contains old bbox', () => {
      const newAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 }
      };
      const oldAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 2, minLat: 2, maxLon: 8, maxLat: 8 }
      };
      expect(aoiContains(newAOI, oldAOI)).toBe(true);
    });
    it('returns false when new bbox does not contain old bbox', () => {
      const newAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 0, minLat: 0, maxLon: 5, maxLat: 5 }
      };
      const oldAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 4, minLat: 4, maxLon: 10, maxLat: 10 }
      };
      expect(aoiContains(newAOI, oldAOI)).toBe(false);
    });
    it('returns true when new polygon contains old bbox', () => {
      const newAOI: AOIGeometry = {
        type: 'polygon',
        polygon: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
      };
      const oldAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 2, minLat: 2, maxLon: 8, maxLat: 8 }
      };
      expect(aoiContains(newAOI, oldAOI)).toBe(true);
    });
    it('returns true when new bbox contains old polygon', () => {
      const newAOI: AOIGeometry = {
        type: 'bbox',
        bbox: { minLon: 0, minLat: 0, maxLon: 10, maxLat: 10 }
      };
      const oldAOI: AOIGeometry = {
        type: 'polygon',
        polygon: [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
      };
      expect(aoiContains(newAOI, oldAOI)).toBe(true);
    });
    it('returns false when geometries cannot be compared', () => {
      const newAOI: AOIGeometry = { type: 'bbox' };
      const oldAOI: AOIGeometry = { type: 'bbox' };
      expect(aoiContains(newAOI, oldAOI)).toBe(false);
    });
  });
});
