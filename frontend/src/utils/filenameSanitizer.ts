/**
 * Sanitize a route name to be a valid filename
 * @param routeName Original route name
 * @returns Sanitized filename (without extension)
 */
export function sanitizeFilename(routeName: string): string {
  if (!routeName || typeof routeName !== 'string') {
    return 'route';
  }

  // Remove invalid characters for Windows/macOS: \ / : * ? " < > | and control chars
  let sanitized = routeName
    .replace(/[\\/:*?"<>|]/g, '') // Remove invalid characters
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim(); // Trim whitespace

  // Collapse multiple spaces to one
  sanitized = sanitized.replace(/\s+/g, ' ');

  // If empty after sanitization, use default
  if (!sanitized || sanitized.length === 0) {
    return 'route';
  }

  // Remove leading/trailing dots and spaces (Windows doesn't allow these)
  sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');

  // If still empty, use default
  if (!sanitized || sanitized.length === 0) {
    return 'route';
  }

  // Limit length (Windows has 255 char limit for full path, be conservative)
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  return sanitized;
}

/**
 * Generate unique filenames for multiple routes, handling duplicates
 * @param routeNames Array of route names
 * @returns Array of sanitized filenames with duplicates handled
 */
export function generateUniqueFilenames(routeNames: string[]): string[] {
  const sanitized = routeNames.map(sanitizeFilename);
  const counts: Record<string, number> = {};
  const result: string[] = [];

  for (let i = 0; i < sanitized.length; i++) {
    const baseName = sanitized[i];
    let finalName = baseName;

    if (counts[baseName] !== undefined) {
      // Duplicate found, append suffix
      counts[baseName]++;
      finalName = `${baseName}_${String(counts[baseName]).padStart(2, '0')}`;
    } else {
      counts[baseName] = 0;
    }

    result.push(finalName);
  }

  return result;
}

