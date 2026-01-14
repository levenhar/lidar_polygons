import React, { useCallback, useMemo } from 'react';
import { Coordinate } from '../App';
import { useUndoRedo } from './useUndoRedo';
import { computeCumulativeDistances } from '../utils/constraints';

export interface GeoJSONFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: number[][];
  };
  properties?: Record<string, any>;
}

export interface GeoJSON {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
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

export interface FlightRoute {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  points: Coordinate[];
}

interface FlightRoutesState {
  routes: FlightRoute[];
  activeRouteId: string;
  climbRequestsByRoute: Record<string, { endDistance: number; climbAmount: number }[]>;
}

const colorPalette = ['#ff4d4f', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

function createRoute(index: number): FlightRoute {
  return {
    id: `route-${index}-${Date.now()}`,
    name: `מסלול ${index}`,
    color: colorPalette[(index - 1) % colorPalette.length],
    visible: true,
    points: []
  };
}

export function useFlightPath(initialClimbRequestsByRoute?: Record<string, { endDistance: number; climbAmount: number }[]>) {
  const initialRoute = createRoute(1);
  const { state, setState, undo, redo, canUndo, canRedo, resetHistory } = useUndoRedo<FlightRoutesState>({
    routes: [initialRoute],
    activeRouteId: initialRoute.id,
    climbRequestsByRoute: initialClimbRequestsByRoute || {}
  });

  const activeRoute = useMemo(
    () => state.routes.find((route) => route.id === state.activeRouteId) || state.routes[0],
    [state]
  );

  const flightPath = activeRoute?.points ?? [];

  const updateActiveRoute = useCallback(
    (updater: (route: FlightRoute) => FlightRoute) => {
      if (!activeRoute) return;
      const nextRoutes = state.routes.map((route) =>
        route.id === activeRoute.id ? updater(route) : route
      );
      setState({ ...state, routes: nextRoutes }, true);
    },
    [activeRoute, setState, state]
  );

  const ensureActiveRoute = useCallback(
    (routeId: string | undefined) => {
      if (routeId && state.routes.some((route) => route.id === routeId)) {
        return routeId;
      }
      return state.routes[0]?.id ?? '';
    },
    [state.routes]
  );

  const addRoute = useCallback(() => {
    const nextIndex = state.routes.length + 1;
    const newRoute = createRoute(nextIndex);
    setState(
      {
        ...state,
        routes: [...state.routes, newRoute],
        activeRouteId: newRoute.id
      },
      true
    );
  }, [setState, state]);

  const setActiveRoute = useCallback(
    (routeId: string) => {
      const safeId = ensureActiveRoute(routeId);
      if (!safeId) return;
      if (safeId === state.activeRouteId) return;
      setState({ ...state, activeRouteId: safeId }, true);
    },
    [ensureActiveRoute, setState, state]
  );

  const renameRoute = useCallback(
    (routeId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setState(
        {
          ...state,
          routes: state.routes.map((route) =>
            route.id === routeId ? { ...route, name: trimmed } : route
          )
        },
        true
      );
    },
    [setState, state]
  );

  const toggleRouteVisibility = useCallback(
    (routeId: string) => {
      setState(
        {
          ...state,
          routes: state.routes.map((route) =>
            route.id === routeId
              ? {
                  ...route,
                  // Keep the active route visible to avoid editing hidden data
                  visible: route.id === state.activeRouteId ? true : !route.visible
                }
              : route
          )
        },
        true
      );
    },
    [setState, state]
  );

  const deleteRoute = useCallback(
    (routeId: string) => {
      if (state.routes.length <= 1) return; // keep at least one route

      const filtered = state.routes.filter((route) => route.id !== routeId);
      let nextActiveId = state.activeRouteId;

      if (state.activeRouteId === routeId) {
        // pick first remaining route as active
        nextActiveId = filtered[0]?.id ?? '';
      }

      // Remove climb requests for the deleted route
      const nextClimbRequestsByRoute = { ...state.climbRequestsByRoute };
      delete nextClimbRequestsByRoute[routeId];

      // if we somehow removed all, recreate one
      if (filtered.length === 0) {
        const newRoute = createRoute(1);
        setState({ 
          routes: [newRoute], 
          activeRouteId: newRoute.id,
          climbRequestsByRoute: nextClimbRequestsByRoute
        }, true);
        return;
      }

      setState({ 
        routes: filtered, 
        activeRouteId: nextActiveId,
        climbRequestsByRoute: nextClimbRequestsByRoute
      }, true);
    },
    [setState, state]
  );

  const showAllRoutes = useCallback(() => {
    setState(
      {
        ...state,
        routes: state.routes.map((route) => ({ ...route, visible: true }))
      },
      true
    );
  }, [setState, state]);

  const hideNonActiveRoutes = useCallback(() => {
    setState(
      {
        ...state,
        routes: state.routes.map((route) => ({
          ...route,
          visible: route.id === state.activeRouteId
        }))
      },
      true
    );
  }, [setState, state]);

  const addPoint = useCallback(
    (point: Coordinate) => {
      updateActiveRoute((route) => ({ ...route, points: [...route.points, point] }));
    },
    [updateActiveRoute]
  );

  const addPoints = useCallback(
    (points: Coordinate[]) => {
      updateActiveRoute((route) => ({ ...route, points: [...route.points, ...points] }));
    },
    [updateActiveRoute]
  );

  const updatePoint = useCallback(
    (index: number, point: Coordinate) => {
      updateActiveRoute((route) => {
        const newPath = [...route.points];
        newPath[index] = point;
        return { ...route, points: newPath };
      });
    },
    [updateActiveRoute]
  );

  const deletePoint = useCallback(
    (index: number) => {
      updateActiveRoute((route) => ({
        ...route,
        points: route.points.filter((_, i) => i !== index)
      }));
    },
    [updateActiveRoute]
  );

  const insertPoints = useCallback(
    (index: number, points: Coordinate[]) => {
      updateActiveRoute((route) => {
        const newPath = [...route.points];
        newPath.splice(index, 0, ...points);
        return { ...route, points: newPath };
      });
    },
    [updateActiveRoute]
  );

  const setFlightPath = useCallback(
    (path: Coordinate[]) => {
      updateActiveRoute((route) => ({ ...route, points: path }));
    },
    [updateActiveRoute]
  );

  const resetAllRoutes = useCallback(() => {
    const clearedRoutes = state.routes.map((route, idx) => ({
      ...route,
      points: [],
      visible: idx === 0 ? true : route.visible
    }));
    const nextActive = ensureActiveRoute(state.activeRouteId);
    resetHistory({ 
      routes: clearedRoutes, 
      activeRouteId: nextActive,
      climbRequestsByRoute: state.climbRequestsByRoute
    });
  }, [ensureActiveRoute, resetHistory, state]);

  const resetToSingleRoute = useCallback(() => {
    const newRoute = createRoute(1);
    resetHistory({
      routes: [newRoute],
      activeRouteId: newRoute.id,
      climbRequestsByRoute: {}
    });
  }, [resetHistory]);

  const exportKML = useCallback(
    (
      climbRequests?: { endDistance: number; climbAmount: number }[], 
      climbRequestsByRoute?: Record<string, { endDistance: number; climbAmount: number }[]>,
      selectedRouteIds?: string[]
    ) => {
      const active = activeRoute;
      const routesWithPoints = state.routes.filter((route) => route.points.length >= 2);

      // If selectedRouteIds is provided, use those routes
      let routesToExport: FlightRoute[];
      if (selectedRouteIds && selectedRouteIds.length > 0) {
        routesToExport = state.routes.filter(
          (route) => selectedRouteIds.includes(route.id) && route.points.length >= 2
        );
      } else {
        // Legacy behavior: show confirm dialog if multiple routes
        if (!active || active.points.length < 2) {
          if (routesWithPoints.length === 0) {
            alert('No routes have 2+ points to export.');
            return;
          }
        }

        let exportAll = false;
        if (routesWithPoints.length > 1) {
          exportAll = window.confirm(
            'Export all routes?\nOK: export routes with 2+ points. Cancel: active route only.'
          );
        }

        routesToExport = exportAll ? routesWithPoints : active ? [active] : [];
      }

      if (routesToExport.length === 0 || routesToExport.every((r) => r.points.length < 2)) {
        alert('Nothing to export. Add at least 2 points.');
        return;
      }

      const exportAll = selectedRouteIds ? selectedRouteIds.length > 1 : routesToExport.length > 1;

      // Get folder name from first route or default
      const folderName = routesToExport.length > 0 ? routesToExport[0].name : 'Flight Path';
      const folderId = escapeXml(folderName.replace(/\s+/g, '_'));

      // Build KML content with Folder structure
      let kmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Folder id="${folderId}" xmlns="http://www.opengis.net/kml/2.2">
  <name>${escapeXml(folderName)}</name>
  <Document id="Point">
    <name>Point</name>
`;

      // Collect all climb points first to generate styles
      const allClimbPoints: Array<{ route: FlightRoute; climb: { endDistance: number; climbAmount: number }; coord: Coordinate; index: number }> = [];
      routesToExport.forEach((route) => {
        const routeClimbRequests = exportAll && climbRequestsByRoute 
          ? (climbRequestsByRoute[route.id] || [])
          : (!exportAll && climbRequests && route.id === active?.id ? climbRequests : []);
        
        if (routeClimbRequests.length > 0) {
          const cumulativeDistances = computeCumulativeDistances(route.points);
          routeClimbRequests.forEach((climb, index) => {
            const coord = distanceToCoordinate(climb.endDistance, route.points, cumulativeDistances);
            if (coord) {
              allClimbPoints.push({ route, climb, coord, index });
            }
          });
        }
      });

      // Generate Point styles
      allClimbPoints.forEach((_, index) => {
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
      });

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
          const hex = routesToExport[0]?.color.slice(1) || '0000ff';
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

      // Export routes as polylines
      routesToExport.forEach((route) => {
        if (route.points.length < 2) return;

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
        <Data name="name">
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
      });

      kmlContent += `  </Document>
</Folder>`;

      const filenameBase =
        exportAll && routesToExport.length > 1
          ? 'routes-all'
          : (routesToExport[0]?.name || 'flight-path').toLowerCase().replace(/\s+/g, '-');

      const blob = new Blob([kmlContent], {
        type: 'application/vnd.google-earth.kml+xml'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenameBase}-${Date.now()}.kml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [activeRoute, state.routes]
  );

  const importKML = useCallback(
    async (file: File): Promise<{ routes: FlightRoute[]; climbRequests: { endDistance: number; climbAmount: number }[] } | null> => {
      try {
        const text = await file.text();
        const parser = new DOMParser();
        const kmlDoc = parser.parseFromString(text, 'text/xml');

        // Check for parsing errors
        const parseError = kmlDoc.querySelector('parsererror');
        if (parseError) {
          const errorText = parseError.textContent || 'Unknown parsing error';
          console.error('KML parsing error:', errorText);
          throw new Error(`Invalid KML file format: ${errorText}`);
        }

        const routes: FlightRoute[] = [];
        const climbRequests: { endDistance: number; climbAmount: number }[] = [];

        // Handle both old format (kml > Document) and new format (Folder > Document)
        let rootElement: Element | null = null;
        const folder = kmlDoc.querySelector('Folder');
        const document = kmlDoc.querySelector('Document');
        
        if (folder) {
          rootElement = folder;
        } else if (document) {
          rootElement = document;
        } else {
          // Try to find any container
          rootElement = kmlDoc.documentElement;
        }

        if (!rootElement) {
          throw new Error('Invalid KML structure');
        }

        // Find Document elements with id="Point" and id="PolyLine" (new format)
        // Use getElementsByTagName and filter by id attribute for better namespace handling
        const allDocuments = rootElement.getElementsByTagName('Document');
        let pointDocument: Element | null = null;
        let polylineDocument: Element | null = null;
        
        for (let i = 0; i < allDocuments.length; i++) {
          const doc = allDocuments[i];
          const id = doc.getAttribute('id');
          if (id === 'Point') {
            pointDocument = doc;
          } else if (id === 'PolyLine') {
            polylineDocument = doc;
          }
        }
        
        console.log('KML import: Found Point document:', !!pointDocument, 'PolyLine document:', !!polylineDocument);
        
        // If new format found (at least one of the Documents), use it; otherwise fall back to old format
        if (pointDocument || polylineDocument) {
          // New format: Parse Points from Point Document
          if (pointDocument) {
            const pointPlacemarks = pointDocument.querySelectorAll('Placemark');
            pointPlacemarks.forEach((placemark) => {
            const point = placemark.querySelector('Point');
            if (point) {
              const coordinatesText = point.querySelector('coordinates')?.textContent?.trim();
              if (coordinatesText) {
                const parts = coordinatesText.split(',');
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);

                // Extract climb amount from name (e.g., "+15", "-20", "+10")
                const name = placemark.querySelector('name')?.textContent?.trim() || '';
                // Try to parse the name as a number (handles +15, -20, etc.)
                const climbValue = parseFloat(name);
                
                if (!isNaN(climbValue) && !isNaN(lng) && !isNaN(lat)) {
                  climbRequests.push({
                    endDistance: 0, // Will be calculated after route is loaded
                    climbAmount: climbValue,
                    // Store coordinate for later distance calculation
                    _coord: { lng, lat }
                  } as any);
                }
              }
            }
          });
          }

          // Parse LineStrings from PolyLine Document
          if (polylineDocument) {
            const polylinePlacemarks = polylineDocument.querySelectorAll('Placemark');
          polylinePlacemarks.forEach((placemark) => {
            const lineString = placemark.querySelector('LineString');
            if (lineString) {
              const name = placemark.querySelector('name')?.textContent || '';
              const coordinatesText = lineString.querySelector('coordinates')?.textContent?.trim();
              if (coordinatesText) {
                // Handle both space-separated and newline-separated coordinates
                const coords = coordinatesText
                  .split(/[\s\n]+/)
                  .filter((c) => c.trim())
                  .map((coordStr) => {
                    const parts = coordStr.split(',');
                    const lng = parseFloat(parts[0]);
                    const lat = parseFloat(parts[1]);
                    const height = parts.length > 2 ? parseFloat(parts[2]) : undefined;
                    return { lng, lat, ...(height !== undefined && !isNaN(height) && { height }) };
                  })
                  .filter((c) => !isNaN(c.lng) && !isNaN(c.lat));

                if (coords.length >= 2) {
                  const nextIndex = state.routes.length + routes.length + 1;
                  const route = createRoute(nextIndex);
                  const newRoute = {
                    ...route,
                    name: name || route.name,
                    points: coords
                  };
                  console.log('KML import: Adding route', newRoute.name, 'with', coords.length, 'points. First point:', coords[0], 'Last point:', coords[coords.length - 1]);
                  routes.push(newRoute);
                } else {
                  console.warn('KML import: Skipping route with less than 2 points:', coords.length);
                }
              }
            }
          });
          }
        } else {
          // Old format: Find all Placemark elements anywhere in the document
          const placemarks = kmlDoc.querySelectorAll('Placemark');

          placemarks.forEach((placemark) => {
            const name = placemark.querySelector('name')?.textContent || '';
            const description = placemark.querySelector('description')?.textContent || '';

            // Check if it's a LineString (route)
            const lineString = placemark.querySelector('LineString');
            if (lineString) {
              const coordinatesText = lineString.querySelector('coordinates')?.textContent?.trim();
              if (coordinatesText) {
                const coords = coordinatesText
                  .split(/\s+/)
                  .filter((c) => c.trim())
                  .map((coordStr) => {
                    const parts = coordStr.split(',');
                    const lng = parseFloat(parts[0]);
                    const lat = parseFloat(parts[1]);
                    const height = parts.length > 2 ? parseFloat(parts[2]) : undefined;
                    return { lng, lat, ...(height !== undefined && !isNaN(height) && { height }) };
                  })
                  .filter((c) => !isNaN(c.lng) && !isNaN(c.lat));

                if (coords.length >= 2) {
                  const nextIndex = state.routes.length + routes.length + 1;
                  const route = createRoute(nextIndex);
                  routes.push({
                    ...route,
                    name: name || route.name,
                    points: coords
                  });
                }
              }
            }

            // Check if it's a Point (climb point)
            const point = placemark.querySelector('Point');
            if (point) {
              const coordinatesText = point.querySelector('coordinates')?.textContent?.trim();
              if (coordinatesText) {
                const parts = coordinatesText.split(',');
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);

                // Extract climb value from description (just the number)
                const climbValue = parseFloat(description.trim());
                if (!isNaN(climbValue) && !isNaN(lng) && !isNaN(lat)) {
                  const climbAmount = climbValue;
                  // We'll need to calculate the distance along the route later
                  // For now, store the coordinate and climb amount
                  // This will be processed after routes are loaded
                  climbRequests.push({
                    endDistance: 0, // Will be calculated after route is loaded
                    climbAmount,
                    // Store coordinate for later distance calculation
                    _coord: { lng, lat }
                  } as any);
                }
              }
            }
          });
        }

        console.log('KML import: Found', routes.length, 'routes and', climbRequests.length, 'climb points');
        
        if (routes.length === 0) {
          alert('No routes (LineString) found in KML file.');
          return null;
        }

        // Log route details before state update
        routes.forEach((route, idx) => {
          console.log(`KML import: Route ${idx + 1}:`, {
            id: route.id,
            name: route.name,
            pointsCount: route.points.length,
            visible: route.visible,
            color: route.color,
            firstPoint: route.points[0],
            lastPoint: route.points[route.points.length - 1]
          });
        });

        // Calculate distances for climb points if we have routes
        if (climbRequests.length > 0 && routes.length > 0) {
          const activeRoute = routes[0]; // Use first route for climb points
          const cumulativeDistances = computeCumulativeDistances(activeRoute.points);

          // Helper function to calculate haversine distance
          const haversineDist = (a: Coordinate, b: Coordinate): number => {
            const R = 6371000; // Earth radius in meters
            const dLat = ((b.lat - a.lat) * Math.PI) / 180;
            const dLon = ((b.lng - a.lng) * Math.PI) / 180;
            const lat1 = (a.lat * Math.PI) / 180;
            const lat2 = (b.lat * Math.PI) / 180;
            const h =
              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
            return R * c;
          };

          // Find nearest point on route for each climb point
          climbRequests.forEach((climb) => {
            const coord = (climb as any)._coord;
            if (!coord) return;

            // Find the closest point on the route
            let minDist = Infinity;
            let closestDistance = 0;

            for (let i = 0; i < activeRoute.points.length - 1; i++) {
              const p1 = activeRoute.points[i];
              const p2 = activeRoute.points[i + 1];

              // Calculate distance from climb point to line segment using haversine
              const segmentLength = haversineDist(p1, p2);
              if (segmentLength === 0) continue;

              // Project climb point onto the segment
              // Use simple interpolation for finding t, then calculate haversine distance
              const dx = p2.lng - p1.lng;
              const dy = p2.lat - p1.lat;
              const length2 = dx * dx + dy * dy;
              
              if (length2 === 0) continue;

              const t = Math.max(0, Math.min(1, ((coord.lng - p1.lng) * dx + (coord.lat - p1.lat) * dy) / length2));
              const projCoord: Coordinate = {
                lng: p1.lng + t * dx,
                lat: p1.lat + t * dy
              };

              const dist = haversineDist(coord, projCoord);

              if (dist < minDist) {
                minDist = dist;
                // Calculate distance along route
                const segmentDist = cumulativeDistances[i + 1] - cumulativeDistances[i];
                closestDistance = cumulativeDistances[i] + t * segmentDist;
              }
            }

            climb.endDistance = closestDistance;
            delete (climb as any)._coord;
          });
        }

        // Use functional update to ensure we have the latest state
        const newActiveRouteId = routes[0].id;
        
        setState(
          (prevState) => {
            const newRoutes = [...prevState.routes, ...routes];
            // Update climbRequestsByRoute to include climb requests for the first imported route
            const updatedClimbRequestsByRoute = { ...prevState.climbRequestsByRoute };
            if (climbRequests.length > 0 && routes.length > 0) {
              updatedClimbRequestsByRoute[newActiveRouteId] = climbRequests;
            }
            return {
              ...prevState,
              routes: newRoutes,
              activeRouteId: newActiveRouteId,
              climbRequestsByRoute: updatedClimbRequestsByRoute
            };
          },
          true
        );

        return { routes, climbRequests };
      } catch (error) {
        console.error('Error importing KML:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        alert(`Failed to import KML file: ${errorMessage}`);
        return null;
      }
    },
    [state, setState]
  );

  const setClimbRequestsByRoute = useCallback(
    (updater: React.SetStateAction<Record<string, { endDistance: number; climbAmount: number }[]>>) => {
      // Use functional update to ensure we have the latest state
      setState(
        (prevState) => {
          const next = typeof updater === 'function' ? updater(prevState.climbRequestsByRoute) : updater;
          return {
            ...prevState,
            climbRequestsByRoute: next
          };
        },
        true
      );
    },
    [setState]
  );

  return {
    routes: state.routes,
    activeRouteId: ensureActiveRoute(state.activeRouteId),
    flightPath,
    climbRequestsByRoute: state.climbRequestsByRoute,
    addRoute,
    setActiveRoute,
    toggleRouteVisibility,
    deleteRoute,
    renameRoute,
    addPoint,
    addPoints,
    updatePoint,
    deletePoint,
    insertPoints,
    setFlightPath,
    resetAllRoutes,
    resetToSingleRoute,
    showAllRoutes,
    hideNonActiveRoutes,
    exportKML,
    importKML,
    setClimbRequestsByRoute,
    undo,
    redo,
    canUndo,
    canRedo
  };
}

