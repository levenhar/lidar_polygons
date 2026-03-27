/**
 * Unit tests for KML import utilities
 */

import {
  parseKml,
  parseCoordinates,
  calculateBounds,
  type ImportedPoint,
  type ImportedPolygon
} from './kmlImport';

describe('kmlImport', () => {
  describe('parseCoordinates', () => {
    it('parses basic coordinate string', () => {
      const coords = parseCoordinates('34.5,31.2 34.6,31.3');
      expect(coords.length).toBe(2);
      expect(coords[0][0]).toBe(34.5);
      expect(coords[0][1]).toBe(31.2);
      expect(coords[1][0]).toBe(34.6);
      expect(coords[1][1]).toBe(31.3);
    });
    it('parses coordinates with altitude', () => {
      const coords = parseCoordinates('34.5,31.2,100 34.6,31.3,200');
      expect(coords.length).toBe(2);
    });
    it('parses multiline coordinates', () => {
      const coords = parseCoordinates('34.5,31.2\n34.6,31.3\n34.7,31.4');
      expect(coords.length).toBe(3);
    });
    it('returns empty array for empty string', () => {
      expect(parseCoordinates('').length).toBe(0);
    });
  });

  describe('parseKml', () => {
    it('parses point from KML', () => {
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
      expect(result.points.length).toBe(1);
      expect(result.points[0].lng).toBe(34.5);
      expect(result.points[0].lat).toBe(31.2);
      expect(result.points[0].label).toBe('Test Point');
    });

    it('parses point with ExtendedData', () => {
      const kml = `<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Fallback</name>
    <ExtendedData>
      <Data name="name"><value>Extended Name</value></Data>
      <Data name="index"><value>5</value></Data>
      <Data name="graphicid"><value>12345</value></Data>
    </ExtendedData>
    <Point><coordinates>34.5,31.2</coordinates></Point>
  </Placemark>
</kml>`;
      const result = parseKml(kml);
      expect(result.points.length).toBe(1);
      expect(result.points[0].label).toBe('Extended Name');
      expect(result.points[0].index).toBe(5);
      expect(result.points[0].id).toBe('12345');
    });

    it('parses polygon with closed ring', () => {
      const kml = `<?xml version="1.0" encoding="utf-8"?>
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
      const result = parseKml(kml);
      expect(result.polygons.length).toBe(1);
      const polygon = result.polygons[0];
      expect(polygon.coordinates.length).toBeGreaterThanOrEqual(4);
      const first = polygon.coordinates[0];
      const last = polygon.coordinates[polygon.coordinates.length - 1];
      expect(first[0]).toBe(last[0]);
      expect(first[1]).toBe(last[1]);
      expect(polygon.name).toBe('Test Polygon');
    });

    it('parses mixed points and polygons', () => {
      const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark><name>P1</name><Point><coordinates>34.5,31.2</coordinates></Point></Placemark>
  <Placemark><name>Poly</name><Polygon><outerBoundaryIs><LinearRing><coordinates>34.5,31.2 34.6,31.2 34.6,31.3 34.5,31.3 34.5,31.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>P2</name><Point><coordinates>34.7,31.4</coordinates></Point></Placemark>
</kml>`;
      const result = parseKml(kml);
      expect(result.points.length).toBe(2);
      expect(result.polygons.length).toBe(1);
    });

    it('reports error for invalid XML', () => {
      expect(parseKml('<not xml>').errors.length).toBeGreaterThan(0);
    });

    it('returns empty for empty KML', () => {
      const result = parseKml('<?xml version="1.0"?><kml></kml>');
      expect(result.points.length).toBe(0);
      expect(result.polygons.length).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('skips invalid placemarks', () => {
      const kml = `<?xml version="1.0"?><kml>
  <Placemark><name>Valid</name><Point><coordinates>34.5,31.2</coordinates></Point></Placemark>
  <Placemark><name>Invalid</name></Placemark>
</kml>`;
      expect(parseKml(kml).points.length).toBe(1);
    });
  });

  describe('calculateBounds', () => {
    it('returns bounds from points and polygons', () => {
      const points: ImportedPoint[] = [
        { lng: 34.5, lat: 31.2, label: 'P1' },
        { lng: 34.7, lat: 31.4, label: 'P2' }
      ];
      const polygons: ImportedPolygon[] = [
        { coordinates: [[34.4, 31.1], [34.6, 31.1], [34.6, 31.3], [34.4, 31.3], [34.4, 31.1]] }
      ];
      const bounds = calculateBounds(points, polygons);
      expect(bounds).not.toBeNull();
      expect(bounds!.minLon).toBe(34.4);
      expect(bounds!.maxLon).toBe(34.7);
      expect(bounds!.minLat).toBe(31.1);
      expect(bounds!.maxLat).toBe(31.4);
    });
    it('returns null for empty input', () => {
      expect(calculateBounds([], [])).toBeNull();
    });
  });
});
