import { latLngToUTM } from './coordinates';

describe('coordinates', () => {
  describe('latLngToUTM', () => {
    it('returns null for non-finite lat', () => {
      expect(latLngToUTM(NaN, 34)).toBeNull();
      expect(latLngToUTM(Infinity, 34)).toBeNull();
    });
    it('returns null for non-finite lng', () => {
      expect(latLngToUTM(31, NaN)).toBeNull();
    });
    it('returns object with zone and hemisphere for valid WGS84', () => {
      const result = latLngToUTM(31.2, 34.5);
      expect(result).not.toBeNull();
      expect(result!.zone).toBeGreaterThanOrEqual(1);
      expect(result!.zone).toBeLessThanOrEqual(60);
      expect(result!.hemisphere).toMatch(/^[NS]$/);
      expect(typeof result!.easting).toBe('number');
      expect(typeof result!.northing).toBe('number');
    });
    it('returns N hemisphere for positive lat', () => {
      const result = latLngToUTM(1, 34);
      expect(result!.hemisphere).toBe('N');
    });
    it('returns S hemisphere for negative lat', () => {
      const result = latLngToUTM(-1, 34);
      expect(result!.hemisphere).toBe('S');
    });
  });
});
