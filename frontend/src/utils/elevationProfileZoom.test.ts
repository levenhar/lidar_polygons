/**
 * Unit tests for elevation profile zoom utilities.
 * Run manually with: RUN_ZOOM_TESTS=1 npm run build (or ts-node).
 */

import { clampWindow, zoomWindow, panWindow, isZoomed } from './elevationProfileZoom';

export function runZoomTests(): true {
  const totalDistance = 1000; // 1000 meters
  const width = 800; // 800 pixels

  // Test clampWindow
  console.log('Testing clampWindow...');
  
  // Normal case
  let [start, end] = clampWindow(100, 500, totalDistance);
  if (start !== 100 || end !== 500) {
    throw new Error(`Expected [100, 500], got [${start}, ${end}]`);
  }
  
  // Clamp start to 0
  [start, end] = clampWindow(-50, 500, totalDistance);
  if (start < 0 || start > 1) {
    throw new Error(`Expected start >= 0, got ${start}`);
  }
  
  // Clamp end to totalDistance
  [start, end] = clampWindow(500, 1200, totalDistance);
  if (end > totalDistance || end < totalDistance - 1) {
    throw new Error(`Expected end <= ${totalDistance}, got ${end}`);
  }
  
  // Window too small
  [start, end] = clampWindow(100, 101, totalDistance);
  if (end - start < 1) {
    throw new Error(`Window too small: ${end - start}`);
  }
  
  console.log('✓ clampWindow tests passed');

  // Test zoomWindow
  console.log('Testing zoomWindow...');
  
  // Zoom in (negative deltaY)
  [start, end] = zoomWindow(0, totalDistance, totalDistance, width / 2, width, -10, 0.1, 50);
  const windowSize = end - start;
  if (windowSize >= totalDistance) {
    throw new Error(`Expected zoomed in (window < ${totalDistance}), got ${windowSize}`);
  }
  
  // Zoom out (positive deltaY) from zoomed state
  [start, end] = zoomWindow(100, 500, totalDistance, width / 2, width, 10, 0.1, 50);
  const windowSize2 = end - start;
  if (windowSize2 <= 400) {
    throw new Error(`Expected zoomed out (window > 400), got ${windowSize2}`);
  }
  
  // Zoom at cursor position should keep cursor position fixed
  const cursorX = width * 0.25; // 25% from left
  [start, end] = zoomWindow(0, totalDistance, totalDistance, cursorX, width, -20, 0.1, 50);
  const cursorDistance = start + (cursorX / width) * (end - start);
  const expectedCursorDistance = 0 + (cursorX / width) * totalDistance;
  if (Math.abs(cursorDistance - expectedCursorDistance) > 10) {
    throw new Error(`Cursor position not preserved: expected ~${expectedCursorDistance}, got ${cursorDistance}`);
  }
  
  console.log('✓ zoomWindow tests passed');

  // Test panWindow
  console.log('Testing panWindow...');
  
  // Pan right (positive dx) should move window left
  [start, end] = panWindow(200, 600, totalDistance, 100, width);
  if (start >= 200) {
    throw new Error(`Pan right should decrease start, got ${start} (expected < 200)`);
  }
  
  // Pan left (negative dx) should move window right
  [start, end] = panWindow(200, 600, totalDistance, -100, width);
  if (start <= 200) {
    throw new Error(`Pan left should increase start, got ${start} (expected > 200)`);
  }
  
  // Pan should maintain window size
  const originalSize = 600 - 200;
  [start, end] = panWindow(200, 600, totalDistance, 50, width);
  const newSize = end - start;
  if (Math.abs(newSize - originalSize) > 0.1) {
    throw new Error(`Window size changed during pan: ${originalSize} -> ${newSize}`);
  }
  
  // Pan should clamp to boundaries
  [start, end] = panWindow(0, 400, totalDistance, -1000, width);
  if (start < 0) {
    throw new Error(`Pan should clamp start to 0, got ${start}`);
  }
  
  [start, end] = panWindow(600, totalDistance, totalDistance, 1000, width);
  if (end > totalDistance) {
    throw new Error(`Pan should clamp end to ${totalDistance}, got ${end}`);
  }
  
  console.log('✓ panWindow tests passed');

  // Test isZoomed
  console.log('Testing isZoomed...');
  
  if (!isZoomed(0, 500, totalDistance)) {
    throw new Error('Expected zoomed state for window [0, 500]');
  }
  
  if (isZoomed(0, totalDistance, totalDistance)) {
    throw new Error('Expected not zoomed for full window');
  }
  
  if (isZoomed(0, totalDistance - 0.05, totalDistance, 0.1)) {
    throw new Error('Expected not zoomed within tolerance');
  }
  
  console.log('✓ isZoomed tests passed');

  console.log('All zoom utility tests passed!');
  return true;
}

// Auto-run if RUN_ZOOM_TESTS is set
if (typeof process !== 'undefined' && process.env.RUN_ZOOM_TESTS === '1') {
  runZoomTests();
}

