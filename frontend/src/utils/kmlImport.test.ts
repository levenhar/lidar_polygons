/**
 * Unit tests for KML import utilities
 */

import { parseKml, parseCoordinates, calculateBounds, ImportedPoint, ImportedPolygon } from './kmlImport';

/**
 * Run KML import tests
 */
export function runKmlImportTests(): true {
  console.log('Running KML import tests...\n');

  // =====================
  // Coordinate Parsing Tests
  // =====================
  
  console.log('1. Testing parseCoordinates...');
  {
    // Test basic coordinate string
    const coords1 = parseCoordinates('34.5,31.2 34.6,31.3');
    if (coords1.length !== 2) {
      throw new Error('parseCoordinates: should parse 2 coordinates');
    }
    if (coords1[0][0] !== 34.5 || coords1[0][1] !== 31.2) {
      throw new Error('parseCoordinates: first coordinate incorrect');
    }
    if (coords1[1][0] !== 34.6 || coords1[1][1] !== 31.3) {
      throw new Error('parseCoordinates: second coordinate incorrect');
    }

    // Test with altitude (should be ignored)
    const coords2 = parseCoordinates('34.5,31.2,100 34.6,31.3,200');
    if (coords2.length !== 2) {
      throw new Error('parseCoordinates: should parse coordinates with altitude');
    }

    // Test multiline coordinates
    const coords3 = parseCoordinates('34.5,31.2\n34.6,31.3\n34.7,31.4');
    if (coords3.length !== 3) {
      throw new Error('parseCoordinates: should parse multiline coordinates');
    }

    // Test empty string
    const coords4 = parseCoordinates('');
    if (coords4.length !== 0) {
      throw new Error('parseCoordinates: should return empty array for empty string');
    }
  }
  console.log('✓ parseCoordinates tests passed\n');

  // =====================
  // Point Parsing Tests
  // =====================
  
  console.log('2. Testing point parsing from KML...');
  {
    const kmlWithPoint = `<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Test Point</name>
    <Point>
      <coordinates>34.5,31.2</coordinates>
    </Point>
  </Placemark>
</kml>`;

    const result = parseKml(kmlWithPoint);
    if (result.points.length !== 1) {
      throw new Error('parseKml: should parse 1 point');
    }
    if (result.points[0].lng !== 34.5 || result.points[0].lat !== 31.2) {
      throw new Error('parseKml: point coordinates incorrect');
    }
    if (result.points[0].label !== 'Test Point') {
      throw new Error('parseKml: point label should be from <name> element');
    }
  }
  console.log('✓ Point parsing tests passed\n');

  // =====================
  // Point with ExtendedData Tests
  // =====================
  
  console.log('3. Testing point with ExtendedData (our export format)...');
  {
    const kmlWithExtendedData = `<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Fallback Name</name>
    <ExtendedData>
      <Data name="name">
        <value>Extended Name</value>
      </Data>
      <Data name="index">
        <value>5</value>
      </Data>
      <Data name="graphicid">
        <value>12345</value>
      </Data>
    </ExtendedData>
    <Point>
      <coordinates>34.5,31.2</coordinates>
    </Point>
  </Placemark>
</kml>`;

    const result = parseKml(kmlWithExtendedData);
    if (result.points.length !== 1) {
      throw new Error('parseKml: should parse point with ExtendedData');
    }
    if (result.points[0].label !== 'Extended Name') {
      throw new Error('parseKml: should prefer ExtendedData name over <name> element');
    }
    if (result.points[0].index !== 5) {
      throw new Error('parseKml: should parse index from ExtendedData');
    }
    if (result.points[0].id !== '12345') {
      throw new Error('parseKml: should parse graphicid from ExtendedData');
    }
  }
  console.log('✓ ExtendedData parsing tests passed\n');

  // =====================
  // Polygon Parsing Tests
  // =====================
  
  console.log('4. Testing polygon parsing...');
  {
    const kmlWithPolygon = `<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Test Polygon</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>34.5,31.2 34.6,31.2 34.6,31.3 34.5,31.3 34.5,31.2</coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
</kml>`;

    const result = parseKml(kmlWithPolygon);
    if (result.polygons.length !== 1) {
      throw new Error('parseKml: should parse 1 polygon');
    }
    const polygon = result.polygons[0];
    if (polygon.coordinates.length < 4) {
      throw new Error('parseKml: polygon should have at least 4 coordinates');
    }
    // Check that polygon is closed (first == last)
    const first = polygon.coordinates[0];
    const last = polygon.coordinates[polygon.coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error('parseKml: polygon should be closed (first == last)');
    }
    // Check coordinate format [lon, lat]
    if (polygon.coordinates[0][0] !== 34.5 || polygon.coordinates[0][1] !== 31.2) {
      throw new Error('parseKml: polygon coordinates should be [lon, lat] format');
    }
    if (polygon.name !== 'Test Polygon') {
      throw new Error('parseKml: polygon name should be parsed');
    }
  }
  console.log('✓ Polygon parsing tests passed\n');

  // =====================
  // Mixed Content Tests
  // =====================
  
  console.log('5. Testing mixed points and polygons...');
  {
    const kmlMixed = `<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Point 1</name>
    <Point>
      <coordinates>34.5,31.2</coordinates>
    </Point>
  </Placemark>
  <Placemark>
    <name>Polygon 1</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>34.5,31.2 34.6,31.2 34.6,31.3 34.5,31.3 34.5,31.2</coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
  <Placemark>
    <name>Point 2</name>
    <Point>
      <coordinates>34.7,31.4</coordinates>
    </Point>
  </Placemark>
</kml>`;

    const result = parseKml(kmlMixed);
    if (result.points.length !== 2) {
      throw new Error('parseKml: should parse 2 points from mixed KML');
    }
    if (result.polygons.length !== 1) {
      throw new Error('parseKml: should parse 1 polygon from mixed KML');
    }
  }
  console.log('✓ Mixed content tests passed\n');

  // =====================
  // Error Handling Tests
  // =====================
  
  console.log('6. Testing error handling...');
  {
    // Invalid XML
    const invalidXml = '<not xml>';
    const result1 = parseKml(invalidXml);
    if (result1.errors.length === 0) {
      throw new Error('parseKml: should report error for invalid XML');
    }

    // Empty KML
    const emptyKml = '<?xml version="1.0"?><kml></kml>';
    const result2 = parseKml(emptyKml);
    if (result2.points.length !== 0 || result2.polygons.length !== 0) {
      throw new Error('parseKml: should return empty arrays for empty KML');
    }
    if (result2.errors.length === 0) {
      throw new Error('parseKml: should report error when no geometries found');
    }

    // Malformed placemark (should skip and continue)
    const malformedKml = `<?xml version="1.0"?>
<kml>
  <Placemark>
    <name>Valid Point</name>
    <Point>
      <coordinates>34.5,31.2</coordinates>
    </Point>
  </Placemark>
  <Placemark>
    <name>Invalid</name>
    <!-- Missing Point element -->
  </Placemark>
</kml>`;
    const result3 = parseKml(malformedKml);
    if (result3.points.length !== 1) {
      throw new Error('parseKml: should skip invalid placemarks and continue');
    }
  }
  console.log('✓ Error handling tests passed\n');

  // =====================
  // Bounds Calculation Tests
  // =====================
  
  console.log('7. Testing bounds calculation...');
  {
    const points: ImportedPoint[] = [
      { lng: 34.5, lat: 31.2, label: 'Point 1' },
      { lng: 34.7, lat: 31.4, label: 'Point 2' }
    ];
    const polygons: ImportedPolygon[] = [
      {
        coordinates: [[34.4, 31.1], [34.6, 31.1], [34.6, 31.3], [34.4, 31.3], [34.4, 31.1]]
      }
    ];

    const bounds = calculateBounds(points, polygons);
    if (!bounds) {
      throw new Error('calculateBounds: should return bounds');
    }
    if (bounds.minLon !== 34.4 || bounds.maxLon !== 34.7) {
      throw new Error('calculateBounds: longitude bounds incorrect');
    }
    if (bounds.minLat !== 31.1 || bounds.maxLat !== 31.4) {
      throw new Error('calculateBounds: latitude bounds incorrect');
    }

    // Test empty input
    const emptyBounds = calculateBounds([], []);
    if (emptyBounds !== null) {
      throw new Error('calculateBounds: should return null for empty input');
    }
  }
  console.log('✓ Bounds calculation tests passed\n');

  console.log('All KML import tests passed! ✓\n');
  return true;
}

// Export for manual testing
if (typeof window === 'undefined' && process.env.RUN_KML_IMPORT_TESTS === '1') {
  runKmlImportTests();
}

