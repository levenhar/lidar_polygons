/**
 * KML Import utilities
 * Parses KML files to extract points and polygons
 */

export interface ImportedPoint {
  lng: number;
  lat: number;
  label: string;
  id?: string;
  index?: number;
  // Additional metadata from ExtendedData
  metadata?: Record<string, string>;
}

export interface ImportedPolygon {
  coordinates: [number, number][]; // [lon, lat] pairs (matching our internal format)
  name?: string;
  metadata?: Record<string, string>;
}

export interface KmlImportResult {
  points: ImportedPoint[];
  polygons: ImportedPolygon[];
  errors: string[];
}

/**
 * Parse KML XML string and extract points and polygons
 */
export function parseKml(xmlString: string): KmlImportResult {
  const result: KmlImportResult = {
    points: [],
    polygons: [],
    errors: []
  };

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    // Check for parsing errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      result.errors.push('Invalid XML format');
      return result;
    }

    // Find all Placemarks (namespace-tolerant)
    // Use getElementsByTagName which works with namespaces, or querySelector for default namespace
    const placemarks = doc.getElementsByTagName('Placemark');
    // Also check for namespaced versions
    const placemarksNS = doc.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Placemark');
    
    // Combine both collections (convert to array and deduplicate)
    const allPlacemarks: Element[] = [];
    const seen = new Set<Element>();
    for (let i = 0; i < placemarks.length; i++) {
      if (!seen.has(placemarks[i])) {
        allPlacemarks.push(placemarks[i]);
        seen.add(placemarks[i]);
      }
    }
    for (let i = 0; i < placemarksNS.length; i++) {
      if (!seen.has(placemarksNS[i])) {
        allPlacemarks.push(placemarksNS[i]);
        seen.add(placemarksNS[i]);
      }
    }

    allPlacemarks.forEach((placemark, index) => {
      try {
        // Try to parse as point
        const point = parsePointPlacemark(placemark, index);
        if (point) {
          result.points.push(point);
          return;
        }

        // Try to parse as polygon
        const polygon = parsePolygonPlacemark(placemark);
        if (polygon) {
          result.polygons.push(polygon);
          return;
        }
      } catch (error) {
        result.errors.push(`Error parsing Placemark ${index + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });

    // If no supported geometries found
    if (result.points.length === 0 && result.polygons.length === 0 && result.errors.length === 0) {
      result.errors.push('No supported points or polygons found in this KML');
    }
  } catch (error) {
    result.errors.push(`Failed to parse KML: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return result;
}

/**
 * Parse a Placemark containing a Point
 */
function parsePointPlacemark(placemark: Element, fallbackIndex: number): ImportedPoint | null {
  // Find Point element (namespace-tolerant)
  let pointElement = placemark.getElementsByTagName('Point')[0];
  if (!pointElement) {
    pointElement = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Point')[0];
  }
  if (!pointElement) {
    return null;
  }

  // Parse coordinates
  let coordsElement = pointElement.getElementsByTagName('coordinates')[0];
  if (!coordsElement) {
    coordsElement = pointElement.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'coordinates')[0];
  }
  if (!coordsElement || !coordsElement.textContent) {
    return null;
  }

  const coords = parseCoordinates(coordsElement.textContent.trim());
  if (coords.length === 0) {
    return null;
  }

  const [lng, lat] = coords[0];

  // Extract label - priority: ExtendedData "name" field > <name> element > fallback
  let label = `Point #${fallbackIndex + 1}`;
  
  // Try ExtendedData first (our export format)
  let extendedData = placemark.getElementsByTagName('ExtendedData')[0];
  if (!extendedData) {
    extendedData = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'ExtendedData')[0];
  }
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    for (let i = 0; i < dataElements.length; i++) {
      const dataEl = dataElements[i];
      if (dataEl.getAttribute('name') === 'name') {
        const valueElement = dataEl.getElementsByTagName('value')[0];
        if (valueElement && valueElement.textContent) {
          label = valueElement.textContent.trim();
          break;
        }
      }
    }
  }

  // Fallback to <name> element if ExtendedData didn't have it
  if (label === `Point #${fallbackIndex + 1}`) {
    let nameElement = placemark.getElementsByTagName('name')[0];
    if (!nameElement) {
      nameElement = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'name')[0];
    }
    if (nameElement && nameElement.textContent) {
      label = nameElement.textContent.trim() || label;
    }
  }

  // Extract additional metadata from ExtendedData
  const metadata: Record<string, string> = {};
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    for (let i = 0; i < dataElements.length; i++) {
      const dataEl = dataElements[i];
      const name = dataEl.getAttribute('name');
      const valueElement = dataEl.getElementsByTagName('value')[0];
      if (name && valueElement && valueElement.textContent) {
        metadata[name] = valueElement.textContent.trim();
      }
    }
  }

  // Extract index if present
  let index: number | undefined;
  if (metadata.index) {
    const parsedIndex = parseInt(metadata.index, 10);
    if (!isNaN(parsedIndex)) {
      index = parsedIndex;
    }
  }

  return {
    lng,
    lat,
    label,
    id: metadata.graphicid || metadata.id,
    index,
    metadata
  };
}

/**
 * Parse a Placemark containing a Polygon
 */
function parsePolygonPlacemark(placemark: Element): ImportedPolygon | null {
  // Find Polygon element (namespace-tolerant)
  let polygonElement = placemark.getElementsByTagName('Polygon')[0];
  if (!polygonElement) {
    polygonElement = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Polygon')[0];
  }
  if (!polygonElement) {
    return null;
  }

  // Find outerBoundaryIs
  let outerBoundary = polygonElement.getElementsByTagName('outerBoundaryIs')[0];
  if (!outerBoundary) {
    outerBoundary = polygonElement.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'outerBoundaryIs')[0];
  }
  if (!outerBoundary) {
    return null;
  }

  // Find LinearRing
  let linearRing = outerBoundary.getElementsByTagName('LinearRing')[0];
  if (!linearRing) {
    linearRing = outerBoundary.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'LinearRing')[0];
  }
  if (!linearRing) {
    return null;
  }

  // Find coordinates
  let coordsElement = linearRing.getElementsByTagName('coordinates')[0];
  if (!coordsElement) {
    coordsElement = linearRing.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'coordinates')[0];
  }
  if (!coordsElement || !coordsElement.textContent) {
    return null;
  }

  const coords = parseCoordinates(coordsElement.textContent.trim());
  if (coords.length < 3) {
    return null; // Need at least 3 points for a polygon
  }

  // Convert to [lon, lat] format (matching our internal format)
  const coordinates: [number, number][] = coords.map(([lng, lat]) => [lng, lat]);

  // Ensure polygon is closed (first point == last point)
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coordinates.push([first[0], first[1]]);
  }

  // Extract name
  let name: string | undefined;
  let nameElement = placemark.getElementsByTagName('name')[0];
  if (!nameElement) {
    nameElement = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'name')[0];
  }
  if (nameElement && nameElement.textContent) {
    name = nameElement.textContent.trim();
  }

  // Extract metadata from ExtendedData
  const metadata: Record<string, string> = {};
  let extendedData = placemark.getElementsByTagName('ExtendedData')[0];
  if (!extendedData) {
    extendedData = placemark.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'ExtendedData')[0];
  }
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    for (let i = 0; i < dataElements.length; i++) {
      const dataEl = dataElements[i];
      const dataName = dataEl.getAttribute('name');
      const valueElement = dataEl.getElementsByTagName('value')[0];
      if (dataName && valueElement && valueElement.textContent) {
        metadata[dataName] = valueElement.textContent.trim();
      }
    }
  }

  return {
    coordinates,
    name,
    metadata
  };
}

/**
 * Parse KML coordinates string
 * Format: "lon,lat,alt lon,lat,alt ..." or multiline
 * Returns array of [lng, lat] pairs (altitude ignored)
 */
export function parseCoordinates(coordsString: string): [number, number][] {
  const result: [number, number][] = [];

  // Split by whitespace (handles both space-separated and newline-separated)
  const parts = coordsString.trim().split(/\s+/);

  for (const part of parts) {
    if (!part.trim()) continue;

    // Split by comma
    const values = part.split(',').map(v => v.trim()).filter(v => v);
    if (values.length < 2) continue;

    const lng = parseFloat(values[0]);
    const lat = parseFloat(values[1]);

    if (isNaN(lng) || isNaN(lat)) continue;

    result.push([lng, lat]);
  }

  return result;
}

/**
 * Calculate bounds from imported geometries
 */
export function calculateBounds(
  points: ImportedPoint[],
  polygons: ImportedPolygon[]
): { minLon: number; minLat: number; maxLon: number; maxLat: number } | null {
  const allCoords: [number, number][] = [];

  // Collect all point coordinates (as [lat, lon] for bounds calculation)
  points.forEach(point => {
    allCoords.push([point.lat, point.lng]);
  });

  // Collect all polygon coordinates (convert from [lon, lat] to [lat, lon] for bounds)
  polygons.forEach(polygon => {
    polygon.coordinates.forEach(([lon, lat]) => {
      allCoords.push([lat, lon]);
    });
  });

  if (allCoords.length === 0) {
    return null;
  }

  let minLat = allCoords[0][0];
  let maxLat = allCoords[0][0];
  let minLon = allCoords[0][1];
  let maxLon = allCoords[0][1];

  allCoords.forEach(([lat, lon]) => {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  });

  return { minLon, minLat, maxLon, maxLat };
}

