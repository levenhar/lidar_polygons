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

    // Find all Placemarks (namespace-tolerant and case-insensitive)
    // Use getElementsByTagName which works with namespaces, or querySelector for default namespace
    const placemarks = doc.getElementsByTagName('Placemark');
    // Also check for namespaced versions
    const placemarksNS = doc.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'Placemark');
    // Check for lowercase version
    const placemarksLower = doc.getElementsByTagName('placemark');
    const placemarksNSLower = doc.getElementsByTagNameNS('http://www.opengis.net/kml/2.2', 'placemark');
    
    // Combine all collections (convert to array and deduplicate)
    const allPlacemarks: Element[] = [];
    const seen = new Set<Element>();
    const addPlacemarks = (collection: HTMLCollectionOf<Element>) => {
      for (let i = 0; i < collection.length; i++) {
        if (!seen.has(collection[i])) {
          allPlacemarks.push(collection[i]);
          seen.add(collection[i]);
        }
      }
    };
    addPlacemarks(placemarks);
    addPlacemarks(placemarksNS);
    addPlacemarks(placemarksLower);
    addPlacemarks(placemarksNSLower);

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
  const kmlNS = 'http://www.opengis.net/kml/2.2';
  
  // Find Point element (case-insensitive)
  const pointElement = findElementCaseInsensitive(placemark, 'Point', kmlNS);
  if (!pointElement) {
    return null;
  }

  // Parse coordinates (case-insensitive)
  const coordsElement = findElementCaseInsensitive(pointElement, 'coordinates', kmlNS);
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
  
  // Try ExtendedData first (our export format, case-insensitive)
  let extendedData = findElementCaseInsensitive(placemark, 'ExtendedData', kmlNS);
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    // Also check lowercase
    if (dataElements.length === 0) {
      const dataElementsLower = extendedData.getElementsByTagName('data');
      for (let i = 0; i < dataElementsLower.length; i++) {
        dataElements[i] = dataElementsLower[i];
      }
    }
    for (let i = 0; i < dataElements.length; i++) {
      const dataEl = dataElements[i];
      if (dataEl.getAttribute('name') === 'name') {
        const valueElement = findElementCaseInsensitive(dataEl, 'value', kmlNS);
        if (valueElement && valueElement.textContent) {
          label = valueElement.textContent.trim();
          break;
        }
      }
    }
  }

  // Fallback to <name> element if ExtendedData didn't have it (case-insensitive)
  if (label === `Point #${fallbackIndex + 1}`) {
    const nameElement = findElementCaseInsensitive(placemark, 'name', kmlNS);
    if (nameElement && nameElement.textContent) {
      label = nameElement.textContent.trim() || label;
    }
  }

  // Extract additional metadata from ExtendedData
  const metadata: Record<string, string> = {};
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    // Also check lowercase
    const dataElementsLower = extendedData.getElementsByTagName('data');
    const allDataElements: Element[] = [];
    for (let i = 0; i < dataElements.length; i++) {
      allDataElements.push(dataElements[i]);
    }
    for (let i = 0; i < dataElementsLower.length; i++) {
      allDataElements.push(dataElementsLower[i]);
    }
    for (const dataEl of allDataElements) {
      const name = dataEl.getAttribute('name');
      const valueElement = findElementCaseInsensitive(dataEl, 'value', kmlNS);
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
 * Helper function to find element by tag name (case-insensitive)
 */
function findElementCaseInsensitive(parent: Element, tagName: string, namespace?: string): Element | null {
  // Try exact match first (most common case)
  let element = parent.getElementsByTagName(tagName)[0];
  if (element) return element;
  
  if (namespace) {
    element = parent.getElementsByTagNameNS(namespace, tagName)[0];
    if (element) return element;
  }
  
  // Try lowercase
  const lowerTag = tagName.toLowerCase();
  if (lowerTag !== tagName) {
    element = parent.getElementsByTagName(lowerTag)[0];
    if (element) return element;
    
    if (namespace) {
      element = parent.getElementsByTagNameNS(namespace, lowerTag)[0];
      if (element) return element;
    }
  }
  
  // Try uppercase
  const upperTag = tagName.toUpperCase();
  if (upperTag !== tagName && upperTag !== lowerTag) {
    element = parent.getElementsByTagName(upperTag)[0];
    if (element) return element;
    
    if (namespace) {
      element = parent.getElementsByTagNameNS(namespace, upperTag)[0];
      if (element) return element;
    }
  }
  
  return null;
}

/**
 * Parse a Placemark containing a Polygon
 * Supports both standard Polygon format and LineString format (for polygon boundaries)
 * Handles case-insensitive tag names and both outerBoundaryIs and innerBoundaryIs
 */
function parsePolygonPlacemark(placemark: Element): ImportedPolygon | null {
  let coordsElement: Element | null = null;
  let coordsString: string | null = null;
  const kmlNS = 'http://www.opengis.net/kml/2.2';

  // First, try to find Polygon element (case-insensitive, standard KML format)
  let polygonElement = findElementCaseInsensitive(placemark, 'Polygon', kmlNS);

  if (polygonElement) {
    // Try outerBoundaryIs first (standard for main boundary)
    let boundary = findElementCaseInsensitive(polygonElement, 'outerBoundaryIs', kmlNS);
    
    // If no outerBoundaryIs, try innerBoundaryIs (sometimes used incorrectly for main boundary)
    if (!boundary) {
      boundary = findElementCaseInsensitive(polygonElement, 'innerBoundaryIs', kmlNS);
    }
    
    if (boundary) {
      // Find LinearRing (case-insensitive)
      let linearRing = findElementCaseInsensitive(boundary, 'LinearRing', kmlNS);
      
      if (linearRing) {
        // Find coordinates (case-insensitive)
        coordsElement = findElementCaseInsensitive(linearRing, 'coordinates', kmlNS);
      }
    }
  } else {
    // Try LineString format (alternative polygon format, case-insensitive)
    let lineStringElement = findElementCaseInsensitive(placemark, 'LineString', kmlNS);
    
    if (lineStringElement) {
      // Find coordinates directly in LineString (case-insensitive)
      coordsElement = findElementCaseInsensitive(lineStringElement, 'coordinates', kmlNS);
    }
  }

  if (!coordsElement || !coordsElement.textContent) {
    return null;
  }

  coordsString = coordsElement.textContent.trim();
  if (!coordsString) {
    return null;
  }

  const coords = parseCoordinates(coordsString);
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

  // Extract name - priority: ExtendedData "name" field > <name> element
  let name: string | undefined;
  
  // Try ExtendedData first (matches the user's format, case-insensitive)
  let extendedData = findElementCaseInsensitive(placemark, 'ExtendedData', kmlNS);
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    // Also check lowercase
    const dataElementsLower = extendedData.getElementsByTagName('data');
    const allDataElements: Element[] = [];
    for (let i = 0; i < dataElements.length; i++) {
      allDataElements.push(dataElements[i]);
    }
    for (let i = 0; i < dataElementsLower.length; i++) {
      allDataElements.push(dataElementsLower[i]);
    }
    for (const dataEl of allDataElements) {
      if (dataEl.getAttribute('name') === 'name') {
        const valueElement = findElementCaseInsensitive(dataEl, 'value', kmlNS);
        if (valueElement && valueElement.textContent) {
          name = valueElement.textContent.trim();
          break;
        }
      }
    }
  }

  // Fallback to <name> element if ExtendedData didn't have it (case-insensitive)
  if (!name) {
    const nameElement = findElementCaseInsensitive(placemark, 'name', kmlNS);
    if (nameElement && nameElement.textContent) {
      name = nameElement.textContent.trim();
    }
  }

  // Extract metadata from ExtendedData
  const metadata: Record<string, string> = {};
  if (extendedData) {
    const dataElements = extendedData.getElementsByTagName('Data');
    const dataElementsLower = extendedData.getElementsByTagName('data');
    const allDataElements: Element[] = [];
    for (let i = 0; i < dataElements.length; i++) {
      allDataElements.push(dataElements[i]);
    }
    for (let i = 0; i < dataElementsLower.length; i++) {
      allDataElements.push(dataElementsLower[i]);
    }
    for (const dataEl of allDataElements) {
      const dataName = dataEl.getAttribute('name');
      const valueElement = findElementCaseInsensitive(dataEl, 'value', kmlNS);
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
 * Handles any number of points (not limited to 4)
 */
export function parseCoordinates(coordsString: string): [number, number][] {
  const result: [number, number][] = [];

  if (!coordsString || typeof coordsString !== 'string') {
    return result;
  }

  // Normalize the string: trim and replace all types of whitespace with single space
  // This handles newlines, tabs, multiple spaces, etc.
  const normalized = coordsString.trim().replace(/\s+/g, ' ');

  // Split by space to get individual coordinate strings
  const parts = normalized.split(' ').filter(part => part.trim().length > 0);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Split by comma and filter out empty values
    const values = trimmed.split(',').map(v => v.trim()).filter(v => v.length > 0);
    
    // Need at least longitude and latitude (altitude is optional)
    if (values.length < 2) continue;

    const lng = parseFloat(values[0]);
    const lat = parseFloat(values[1]);

    // Validate that both are valid numbers
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

