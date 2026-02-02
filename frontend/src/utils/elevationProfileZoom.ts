/**
 * Utility functions for managing the view window in the elevation profile.
 * These functions handle panning and zooming with proper boundary clamping.
 */

/**
 * Clamps a view window to ensure it stays within valid bounds.
 * @param viewStart - Start of the view window in meters
 * @param viewEnd - End of the view window in meters
 * @param totalDistance - Total distance of the route in meters
 * @returns Clamped view window [viewStart, viewEnd]
 */
export function clampWindow(
  viewStart: number,
  viewEnd: number,
  totalDistance: number
): [number, number] {
  const windowSize = viewEnd - viewStart;
  
  // Ensure window size is at least 1 meter
  const minWindowSize = Math.max(1, windowSize);
  
  // Clamp start to [0, totalDistance - minWindowSize]
  let clampedStart = Math.max(0, Math.min(viewStart, totalDistance - minWindowSize));
  
  // Clamp end to [minWindowSize, totalDistance]
  let clampedEnd = Math.max(minWindowSize, Math.min(viewEnd, totalDistance));
  
  // If window is too small, adjust to minimum size
  if (clampedEnd - clampedStart < minWindowSize) {
    if (clampedStart === 0) {
      clampedEnd = minWindowSize;
    } else if (clampedEnd === totalDistance) {
      clampedStart = totalDistance - minWindowSize;
    } else {
      // Center the window
      const center = (clampedStart + clampedEnd) / 2;
      clampedStart = Math.max(0, center - minWindowSize / 2);
      clampedEnd = Math.min(totalDistance, clampedStart + minWindowSize);
      clampedStart = clampedEnd - minWindowSize;
    }
  }
  
  return [clampedStart, clampedEnd];
}

/**
 * Zooms the view window around a cursor position.
 * @param viewStart - Current start of the view window in meters
 * @param viewEnd - Current end of the view window in meters
 * @param totalDistance - Total distance of the route in meters
 * @param cursorX - X position of cursor in pixels
 * @param width - Width of the chart in pixels
 * @param deltaY - Wheel delta (positive = zoom out, negative = zoom in)
 * @param zoomSensitivity - Sensitivity factor (default: 0.1)
 * @param minWindowSize - Minimum window size in meters (default: 50)
 * @returns New view window [viewStart, viewEnd]
 */
export function zoomWindow(
  viewStart: number,
  viewEnd: number,
  totalDistance: number,
  cursorX: number,
  width: number,
  deltaY: number,
  zoomSensitivity: number = 0.1,
  minWindowSize: number = 50
): [number, number] {
  const currentWindowSize = viewEnd - viewStart;
  
  // Calculate zoom factor (negative deltaY = zoom in)
  const zoomFactor = 1 - (deltaY * zoomSensitivity);
  
  // Calculate new window size
  let newWindowSize = currentWindowSize * zoomFactor;
  
  // Clamp to min/max window sizes
  newWindowSize = Math.max(minWindowSize, Math.min(newWindowSize, totalDistance));
  
  // Calculate the distance under the cursor before zoom
  const cursorRatio = cursorX / width;
  const xCursorMeters = viewStart + cursorRatio * currentWindowSize;
  
  // Calculate new start position to keep cursor position fixed
  let newStart = xCursorMeters - cursorRatio * newWindowSize;
  let newEnd = newStart + newWindowSize;
  
  // Clamp the window
  return clampWindow(newStart, newEnd, totalDistance);
}

/**
 * Pans the view window by a pixel delta.
 * @param viewStart - Current start of the view window in meters
 * @param viewEnd - Current end of the view window in meters
 * @param totalDistance - Total distance of the route in meters
 * @param dx - Pixel delta in X direction (positive = drag right)
 * @param width - Width of the chart in pixels
 * @returns New view window [viewStart, viewEnd]
 */
export function panWindow(
  viewStart: number,
  viewEnd: number,
  totalDistance: number,
  dx: number,
  width: number
): [number, number] {
  const currentWindowSize = viewEnd - viewStart;
  
  // Convert pixel delta to distance delta
  // Note: dx is positive when dragging right, which should move the window left (decrease start)
  const pixelsPerMeter = width / currentWindowSize;
  const distanceDelta = -dx / pixelsPerMeter;
  
  // Apply pan
  let newStart = viewStart + distanceDelta;
  let newEnd = viewEnd + distanceDelta;
  
  // Clamp the window
  return clampWindow(newStart, newEnd, totalDistance);
}

/**
 * Checks if the profile is currently zoomed (view window is smaller than full range).
 * @param viewStart - Start of the view window in meters
 * @param viewEnd - End of the view window in meters
 * @param totalDistance - Total distance of the route in meters
 * @param tolerance - Tolerance for considering "fully zoomed out" (default: 0.1 meters)
 * @returns True if zoomed in
 */
export function isZoomed(
  viewStart: number,
  viewEnd: number,
  totalDistance: number,
  tolerance: number = 0.1
): boolean {
  const windowSize = viewEnd - viewStart;
  return windowSize < totalDistance - tolerance;
}

