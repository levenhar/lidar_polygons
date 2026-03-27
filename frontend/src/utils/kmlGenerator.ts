import { Coordinate } from '../App';
import { FlightRoute } from '../hooks/useFlightPath';
import { computeCumulativeDistances } from './constraints';

/**
 * Escape XML special characters
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert distance along route to coordinate
 */
function distanceToCoordinate(
  distance: number,
  route: Coordinate[],
  cumulativeDistances: number[]
): Coordinate | null {
  if (route.length === 0 || cumulativeDistances.length === 0) return null;
  if (distance <= 0) return route[0];
  if (distance >= cumulativeDistances[cumulativeDistances.length - 1]) {
    return route[route.length - 1];
  }

  // Find the segment containing this distance
  for (let i = 1; i < cumulativeDistances.length; i++) {
    if (distance <= cumulativeDistances[i]) {
      const prevDist = cumulativeDistances[i - 1];
      const segmentDist = cumulativeDistances[i] - prevDist;
      const t = segmentDist > 0 ? (distance - prevDist) / segmentDist : 0;

      const p1 = route[i - 1];
      const p2 = route[i];

      // Interpolate between points
      return {
        lng: p1.lng + (p2.lng - p1.lng) * t,
        lat: p1.lat + (p2.lat - p1.lat) * t
      };
    }
  }

  return route[route.length - 1];
}

/**
 * Generate KML content for a route
 */
export function generateKMLForRoute(
  route: FlightRoute,
  routeClimbRequests: { endDistance: number; climbAmount: number }[],
  nominalFlightHeight?: number
): string {
  const folderName = route.name;
  const folderId = escapeXml(folderName.replace(/\s+/g, '_'));

  // Build KML content with Folder structure
  let kmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Folder id="${folderId}" xmlns="http://www.opengis.net/kml/2.2">
  <name>${escapeXml(folderName)}</name>
  <Document id="Point">
    <name>Point</name>
`;

  // Collect climb points for this route
  const allClimbPoints: Array<{ climb: { endDistance: number; climbAmount: number }; coord: Coordinate; index: number }> = [];
  if (routeClimbRequests.length > 0) {
    const cumulativeDistances = computeCumulativeDistances(route.points);
    routeClimbRequests.forEach((climb, index) => {
      const coord = distanceToCoordinate(climb.endDistance, route.points, cumulativeDistances);
      if (coord) {
        allClimbPoints.push({ climb, coord, index });
      }
    });
  }

  // Always add entry point (גובה כניסה) at the first point with nominal flight height
  const entryPointIndex = allClimbPoints.length;
  const hasEntryPoint = nominalFlightHeight !== undefined && nominalFlightHeight !== null && route.points.length >= 1;
  
  // Generate Point styles (including entry point style if needed)
  const totalPoints = allClimbPoints.length + (hasEntryPoint ? 1 : 0);
  for (let index = 0; index < totalPoints; index++) {
    kmlContent += `    <Style id="PointStyle${index}">
      <IconStyle>
        <color>ffff0000</color>
        <colorMode>normal</colorMode>
      </IconStyle>
      <LabelStyle>
        <color>ffffffff</color>
        <scale>1</scale>
      </LabelStyle>
    </Style>
`;
  }

  // Export climb points
  allClimbPoints.forEach(({ climb, coord, index }) => {
    const climbName = climb.climbAmount >= 0 ? `+${Math.round(climb.climbAmount)}` : `${Math.round(climb.climbAmount)}`;
    kmlContent += `    <Placemark>
      <name>${escapeXml(climbName)}</name>
      <description />
      <styleUrl>#PointStyle${index}</styleUrl>
      <ExtendedData>
        <Data name="name">
          <value>${escapeXml(climbName)}</value>
        </Data>
        <Data name="drawingmode">
          <value>Point</value>
        </Data>
        <Data name="marker">
          <value>Point</value>
        </Data>
        <Data name="color">
          <value>Blue</value>
        </Data>
        <Data name="style">
          <value>Circle</value>
        </Data>
        <Data name="width">
          <value>14</value>
        </Data>
        <Data name="fontcolor">
          <value>Black</value>
        </Data>
        <Data name="fontsize">
          <value>18</value>
        </Data>
        <Data name="showname">
          <value>True</value>
        </Data>
        <Data name="showmeasure">
          <value>False</value>
        </Data>
        <Data name="isvisible">
          <value>True</value>
        </Data>
        <Data name="description">
          <value />
        </Data>
        <Data name="size">
          <value>14</value>
        </Data>
        <Data name="Symbol_Color">
          <value>Blue</value>
        </Data>
        <Data name="Symbol_Size">
          <value>14</value>
        </Data>
        <Data name="Symbol_Style">
          <value>Circle</value>
        </Data>
        <Data name="PointStyle">
          <value>Circle</value>
        </Data>
        <Data name="Symbol_Opacity">
          <value>1</value>
        </Data>
        <Data name="Opacity">
          <value>1</value>
        </Data>
        <Data name="drawmode">
          <value>Point</value>
        </Data>
        <Data name="isitalic">
          <value>False</value>
        </Data>
        <Data name="isunderline">
          <value>False</value>
        </Data>
        <Data name="visible">
          <value>True</value>
        </Data>
        <Data name="graphicid">
          <value>${Date.now() + index}</value>
        </Data>
        <Data name="graphicColor">
          <value>Blue</value>
        </Data>
        <Data name="index">
          <value>${index + 1}</value>
        </Data>
        <Data name="showlabel">
          <value>True</value>
        </Data>
        <Data name="shpindex">
          <value>0</value>
        </Data>
      </ExtendedData>
      <Point>
        <coordinates>${coord.lng},${coord.lat}</coordinates>
      </Point>
    </Placemark>
`;
  });

  // Always add entry point (גובה כניסה) at the first point (number 1)
  // Entry height (nominalFlightHeight) is now ASL, so save it directly without adding ground elevation
  if (hasEntryPoint) {
    const firstPoint = route.points[0];
    const absoluteAltitude = Math.round(nominalFlightHeight!);
    const entryPointName = `גובה כניסה - ${absoluteAltitude}`;
    kmlContent += `    <Placemark>
      <name>${escapeXml(entryPointName)}</name>
      <description />
      <styleUrl>#PointStyle${entryPointIndex}</styleUrl>
      <ExtendedData>
        <Data name="name">
          <value>${escapeXml(entryPointName)}</value>
        </Data>
        <Data name="drawingmode">
          <value>Point</value>
        </Data>
        <Data name="marker">
          <value>Point</value>
        </Data>
        <Data name="color">
          <value>Blue</value>
        </Data>
        <Data name="style">
          <value>Circle</value>
        </Data>
        <Data name="width">
          <value>14</value>
        </Data>
        <Data name="fontcolor">
          <value>Black</value>
        </Data>
        <Data name="fontsize">
          <value>18</value>
        </Data>
        <Data name="showname">
          <value>True</value>
        </Data>
        <Data name="showmeasure">
          <value>False</value>
        </Data>
        <Data name="isvisible">
          <value>True</value>
        </Data>
        <Data name="description">
          <value />
        </Data>
        <Data name="size">
          <value>14</value>
        </Data>
        <Data name="Symbol_Color">
          <value>Blue</value>
        </Data>
        <Data name="Symbol_Size">
          <value>14</value>
        </Data>
        <Data name="Symbol_Style">
          <value>Circle</value>
        </Data>
        <Data name="PointStyle">
          <value>Circle</value>
        </Data>
        <Data name="Symbol_Opacity">
          <value>1</value>
        </Data>
        <Data name="Opacity">
          <value>1</value>
        </Data>
        <Data name="drawmode">
          <value>Point</value>
        </Data>
        <Data name="isitalic">
          <value>False</value>
        </Data>
        <Data name="isunderline">
          <value>False</value>
        </Data>
        <Data name="visible">
          <value>True</value>
        </Data>
        <Data name="graphicid">
          <value>${Date.now() + entryPointIndex}</value>
        </Data>
        <Data name="graphicColor">
          <value>Blue</value>
        </Data>
        <Data name="index">
          <value>1</value>
        </Data>
        <Data name="showlabel">
          <value>True</value>
        </Data>
        <Data name="shpindex">
          <value>0</value>
        </Data>
      </ExtendedData>
      <Point>
        <coordinates>${firstPoint.lng},${firstPoint.lat}</coordinates>
      </Point>
    </Placemark>
`;
  }

  kmlContent += `  </Document>
  <Document id="PolyLine">
    <name>PolyLine</name>
    <Style id="PolylineStyle0">
      <LabelStyle>
        <color>ffffffff</color>
        <scale>1</scale>
      </LabelStyle>
      <LineStyle>
        <color>${(() => {
          // Convert #RRGGBB to AABBGGRR format for KML
          const hex = route.color.slice(1);
          const r = hex.slice(0, 2);
          const g = hex.slice(2, 4);
          const b = hex.slice(4, 6);
          return `ff${b}${g}${r}`;
        })()}</color>
        <width>2</width>
        <physicalWidth xmlns="http://www.google.com/kml/ext/2.2">2</physicalWidth>
      </LineStyle>
    </Style>
`;

  // Export route as polyline
  if (route.points.length >= 2) {
    // Format coordinates with newlines between them
    const coordinates = route.points
      .map((p) => `${p.lng},${p.lat}${p.height !== undefined ? `,${p.height}` : ''}`)
      .join('\n');

    // Convert route color to KML format
    const hex = route.color.slice(1);
    const r = hex.slice(0, 2);
    const g = hex.slice(2, 4);
    const b = hex.slice(4, 6);
    const colorKml = `ff${b}${g}${r}`;

    kmlContent += `    <Placemark>
      <name>${escapeXml(route.name)}</name>
      <description />
      <styleUrl>#PolylineStyle0</styleUrl>
      <ExtendedData>
        ${nominalFlightHeight !== undefined && nominalFlightHeight !== null ? `<Data name="entranceHeight">
          <value>${Math.round(nominalFlightHeight)}</value>
        </Data>
        ` : ''}<Data name="name">
          <value>${escapeXml(route.name)}</value>
        </Data>
        <Data name="drawingmode">
          <value>Polyline</value>
        </Data>
        <Data name="isvisible">
          <value>True</value>
        </Data>
        <Data name="style">
          <value>Solid</value>
        </Data>
        <Data name="color">
          <value>${colorKml}</value>
        </Data>
        <Data name="width">
          <value>2</value>
        </Data>
        <Data name="fontcolor">
          <value>Black</value>
        </Data>
        <Data name="fontsize">
          <value>18</value>
        </Data>
        <Data name="showname">
          <value>True</value>
        </Data>
        <Data name="opacity">
          <value>255</value>
        </Data>
        <Data name="showmeasure">
          <value>True</value>
        </Data>
        <Data name="description">
          <value />
        </Data>
        <Data name="Symbol_LineOpacity">
          <value>255</value>
        </Data>
        <Data name="Symbol_SolidBrushColor">
          <value>Color [A=255, R=${parseInt(r, 16)}, G=${parseInt(g, 16)}, B=${parseInt(b, 16)}]</value>
        </Data>
        <Data name="Symbol_LineWidth">
          <value>2</value>
        </Data>
        <Data name="drawmode">
          <value>Polyline</value>
        </Data>
        <Data name="isitalic">
          <value>False</value>
        </Data>
        <Data name="isunderline">
          <value>False</value>
        </Data>
        <Data name="visible">
          <value>True</value>
        </Data>
        <Data name="graphicid">
          <value>${Date.now()}</value>
        </Data>
        <Data name="graphicColor">
          <value>${colorKml}</value>
        </Data>
        <Data name="index">
          <value>0</value>
        </Data>
        <Data name="showlabel">
          <value>True</value>
        </Data>
        <Data name="shpindex">
          <value>0</value>
        </Data>
      </ExtendedData>
      <LineString>
        <coordinates>${coordinates}
</coordinates>
      </LineString>
    </Placemark>
`;
  }

  kmlContent += `  </Document>
</Folder>`;

  return kmlContent;
}


