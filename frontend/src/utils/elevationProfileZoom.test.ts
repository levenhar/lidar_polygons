/**
 * Unit tests for elevation profile zoom utilities.
 */

import { clampWindow, zoomWindow, panWindow, isZoomed } from './elevationProfileZoom';

describe('elevationProfileZoom', () => {
  const totalDistance = 1000;
  const width = 800;

  describe('clampWindow', () => {
    it('returns same start/end when in range', () => {
      const [start, end] = clampWindow(100, 500, totalDistance);
      expect(start).toBe(100);
      expect(end).toBe(500);
    });
    it('clamps start to >= 0', () => {
      const [start] = clampWindow(-50, 500, totalDistance);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(1);
    });
    it('clamps end to totalDistance', () => {
      const [, end] = clampWindow(500, 1200, totalDistance);
      expect(end).toBeLessThanOrEqual(totalDistance);
      expect(end).toBeGreaterThanOrEqual(totalDistance - 1);
    });
    it('ensures minimum window size', () => {
      const [start, end] = clampWindow(100, 101, totalDistance);
      expect(end - start).toBeGreaterThanOrEqual(1);
    });
  });

  describe('zoomWindow', () => {
    it('zooms in (smaller window) for positive deltaY', () => {
      const [start, end] = zoomWindow(0, totalDistance, totalDistance, width / 2, width, 10, 0.1, 50);
      expect(end - start).toBeLessThan(totalDistance);
    });
    it('zooms out (larger window) for negative deltaY', () => {
      const [start, end] = zoomWindow(100, 500, totalDistance, width / 2, width, -10, 0.1, 50);
      expect(end - start).toBeGreaterThan(400);
    });
    it('preserves cursor position when zooming', () => {
      const cursorX = width * 0.25;
      const [start, end] = zoomWindow(0, totalDistance, totalDistance, cursorX, width, 20, 0.1, 50);
      const cursorDistance = start + (cursorX / width) * (end - start);
      const expectedCursorDistance = 0 + (cursorX / width) * totalDistance;
      expect(Math.abs(cursorDistance - expectedCursorDistance)).toBeLessThanOrEqual(10);
    });
  });

  describe('panWindow', () => {
    it('moves window left for positive dx', () => {
      const [start] = panWindow(200, 600, totalDistance, 100, width);
      expect(start).toBeLessThan(200);
    });
    it('moves window right for negative dx', () => {
      const [start] = panWindow(200, 600, totalDistance, -100, width);
      expect(start).toBeGreaterThan(200);
    });
    it('maintains window size', () => {
      const [start, end] = panWindow(200, 600, totalDistance, 50, width);
      const newSize = end - start;
      expect(Math.abs(newSize - 400)).toBeLessThanOrEqual(0.1);
    });
    it('clamps start to 0', () => {
      const [start] = panWindow(0, 400, totalDistance, -1000, width);
      expect(start).toBeGreaterThanOrEqual(0);
    });
    it('clamps end to totalDistance', () => {
      const [, end] = panWindow(600, totalDistance, totalDistance, 1000, width);
      expect(end).toBeLessThanOrEqual(totalDistance);
    });
  });

  describe('isZoomed', () => {
    it('returns true when window is smaller than total', () => {
      expect(isZoomed(0, 500, totalDistance)).toBe(true);
    });
    it('returns false for full window', () => {
      expect(isZoomed(0, totalDistance, totalDistance)).toBe(false);
    });
    it('returns false within tolerance', () => {
      expect(isZoomed(0, totalDistance - 0.05, totalDistance, 0.1)).toBe(false);
    });
  });
});
