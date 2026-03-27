/**
 * Unit tests for elevation profile zoom utilities.
 */

import { clampWindow, zoomWindow, panWindow, isZoomed, clampZoomTransform } from './elevationProfileZoom';

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

  describe('clampZoomTransform', () => {
    const w = 800;
    const h = 400;

    it('returns identity unchanged at scale 1', () => {
      const result = clampZoomTransform(0, 0, 1, w, h);
      expect(result).toEqual({ x: 0, y: 0, k: 1 });
    });

    it('keeps valid transform unchanged when within bounds', () => {
      // At k=2, x can be [-(2-1)*800, 0] = [-800, 0], y can be [-400, 0]
      const result = clampZoomTransform(-400, -200, 2, w, h);
      expect(result).toEqual({ x: -400, y: -200, k: 2 });
    });

    it('clamps positive x to 0 (prevents panning past left edge)', () => {
      const result = clampZoomTransform(100, 0, 2, w, h);
      expect(result.x).toBe(0);
    });

    it('clamps positive y to 0 (prevents panning past top edge)', () => {
      const result = clampZoomTransform(0, 50, 2, w, h);
      expect(result.y).toBe(0);
    });

    it('clamps x past right edge to -(k-1)*width', () => {
      // At k=2, min x = -(2-1)*800 = -800
      const result = clampZoomTransform(-1000, 0, 2, w, h);
      expect(result.x).toBe(-800);
    });

    it('clamps y past bottom edge to -(k-1)*height', () => {
      // At k=2, min y = -(2-1)*400 = -400
      const result = clampZoomTransform(0, -600, 2, w, h);
      expect(result.y).toBe(-400);
    });

    it('clamps both axes simultaneously', () => {
      const result = clampZoomTransform(50, -900, 3, w, h);
      // x: min(0, max(50, -(3-1)*800)) = min(0, max(50, -1600)) = min(0, 50) = 0
      expect(result.x).toBe(0);
      // y: min(0, max(-900, -(3-1)*400)) = min(0, max(-900, -800)) = min(0, -800) = -800
      expect(result.y).toBe(-800);
    });

    it('preserves scale factor unchanged', () => {
      const result = clampZoomTransform(-9999, 9999, 5, w, h);
      expect(result.k).toBe(5);
    });

    it('at scale 1, clamps any translation to 0,0', () => {
      const result = clampZoomTransform(-100, 50, 1, w, h);
      expect(result.x + 0).toBe(0); // +0 to normalize -0
      expect(result.y + 0).toBe(0);
    });

    it('at high zoom, allows large negative translations', () => {
      // At k=10, x can be [-(10-1)*800, 0] = [-7200, 0]
      const result = clampZoomTransform(-5000, -2000, 10, w, h);
      expect(result.x).toBe(-5000);
      expect(result.y).toBe(-2000);
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
