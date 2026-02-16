import { sanitizeFilename, generateUniqueFilenames } from './filenameSanitizer';

describe('filenameSanitizer', () => {
  describe('sanitizeFilename', () => {
    it('returns string unchanged when valid', () => {
      expect(sanitizeFilename('Route 1')).toBe('Route 1');
    });
    it('removes invalid characters', () => {
      expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).not.toMatch(/[\\/:*?"<>|]/);
    });
    it('returns default for empty string', () => {
      expect(sanitizeFilename('')).toBe('route');
    });
    it('returns default for whitespace-only', () => {
      expect(sanitizeFilename('   ')).toBe('route');
    });
    it('returns default for non-string or nullish', () => {
      expect(sanitizeFilename((null as any))).toBe('route');
      expect(sanitizeFilename((undefined as any))).toBe('route');
    });
    it('collapses multiple spaces', () => {
      expect(sanitizeFilename('a    b')).toBe('a b');
    });
    it('trims leading/trailing dots and spaces', () => {
      expect(sanitizeFilename(' .  name  . ')).toBe('name');
    });
    it('limits length to 200', () => {
      const long = 'a'.repeat(250);
      expect(sanitizeFilename(long).length).toBe(200);
    });
  });

  describe('generateUniqueFilenames', () => {
    it('returns sanitized names for unique route names', () => {
      const names = ['Route A', 'Route B'];
      expect(generateUniqueFilenames(names)).toEqual(['Route A', 'Route B']);
    });
    it('appends suffix for duplicates', () => {
      const names = ['Route', 'Route', 'Route'];
      const result = generateUniqueFilenames(names);
      expect(result[0]).toBe('Route');
      expect(result[1]).toBe('Route_01');
      expect(result[2]).toBe('Route_02');
    });
    it('handles mixed unique and duplicate', () => {
      const names = ['A', 'B', 'A', 'B'];
      const result = generateUniqueFilenames(names);
      expect(result).toEqual(['A', 'B', 'A_01', 'B_01']);
    });
  });
});
