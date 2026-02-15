import React, { useCallback, useMemo } from 'react';
import { Coordinate } from '../App';
import { useUndoRedo, UndoRedoOptions } from './useUndoRedo';
import { computeCumulativeDistances } from '../utils/constraints';
import { ActionType } from '../contexts/GlobalUndoRedoContext';
import { ensurePointId, ClimbRequest } from '../utils/climbAnchors';

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
  lineWidth: number;
  visible: boolean;
  points: Coordinate[];
  // Nominal flight height (AGL) associated with this route
  nominalFlightHeight: number;
}

interface FlightRoutesState {
  routes: FlightRoute[];
  activeRouteId: string;
  climbRequestsByRoute: Record<string, ClimbRequest[]>;
}

const colorPalette = ['#ff4d4f', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

const DEFAULT_NOMINAL_FLIGHT_HEIGHT = 250;
const DEFAULT_ROUTE_LINE_WIDTH = 3;
const MIN_ROUTE_LINE_WIDTH = 1;
const MAX_ROUTE_LINE_WIDTH = 12;

function sanitizeRouteLineWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_ROUTE_LINE_WIDTH;
  return Math.min(MAX_ROUTE_LINE_WIDTH, Math.max(MIN_ROUTE_LINE_WIDTH, width));
}

function createRoute(index: number, nominalFlightHeight: number = DEFAULT_NOMINAL_FLIGHT_HEIGHT): FlightRoute {
  return {
    id: `route-${index}-${Date.now()}`,
    name: `מסלול ${index}`,
    color: colorPalette[(index - 1) % colorPalette.length],
    lineWidth: DEFAULT_ROUTE_LINE_WIDTH,
    visible: true,
    points: [],
    nominalFlightHeight
  };
}

export interface UseFlightPathOptions {
  initialClimbRequestsByRoute?: Record<string, ClimbRequest[]>;
  // Callback to register actions with the global undo/redo manager
  registerGlobalAction?: (
    type: ActionType,
    undo: () => void,
    redo: () => void,
    label?: string
  ) => number;
}

export function useFlightPath(
  initialClimbRequestsByRouteOrOptions?: Record<string, { endDistance: number; climbAmount: number }[]> | UseFlightPathOptions
) {
  // Handle both old signature (just initialClimbRequestsByRoute) and new signature (options object)
  const options: UseFlightPathOptions = 
    initialClimbRequestsByRouteOrOptions && 'registerGlobalAction' in initialClimbRequestsByRouteOrOptions
      ? initialClimbRequestsByRouteOrOptions
      : { initialClimbRequestsByRoute: initialClimbRequestsByRouteOrOptions as Record<string, { endDistance: number; climbAmount: number }[]> | undefined };
  
  const { initialClimbRequestsByRoute, registerGlobalAction } = options;
  
  const initialRoute = createRoute(1, DEFAULT_NOMINAL_FLIGHT_HEIGHT);
  
  // Determine action type based on what changed between previous and new state
  const determineActionType = (prevState: FlightRoutesState, newState: FlightRoutesState): ActionType => {
    const routesChanged = JSON.stringify(prevState.routes) !== JSON.stringify(newState.routes);
    const climbRequestsChanged = JSON.stringify(prevState.climbRequestsByRoute) !== JSON.stringify(newState.climbRequestsByRoute);
    
    if (routesChanged && climbRequestsChanged) {
      return 'combined';
    } else if (climbRequestsChanged) {
      return 'elevation';
    } else {
      return 'map';
    }
  };
  
  // Create undo/redo options that register with global manager
  const undoRedoOptions: UndoRedoOptions | undefined = registerGlobalAction ? {
    onActionRegistered: (previousState, newState, undoFn, redoFn) => {
      const actionType = determineActionType(previousState as FlightRoutesState, newState as FlightRoutesState);
      registerGlobalAction(actionType, undoFn, redoFn);
    }
  } : undefined;
  
  const { state, setState, undo, redo, canUndo, canRedo, resetHistory } = useUndoRedo<FlightRoutesState>(
    {
      routes: [initialRoute],
      activeRouteId: initialRoute.id,
      climbRequestsByRoute: initialClimbRequestsByRoute || {}
    },
    undoRedoOptions
  );

  const activeRoute = useMemo(
    () => state.routes.find((route) => route.id === state.activeRouteId) || state.routes[0],
    [state]
  );

  const flightPath = activeRoute?.points ?? [];
  const nominalFlightHeight = activeRoute?.nominalFlightHeight ?? DEFAULT_NOMINAL_FLIGHT_HEIGHT;

  const updateActiveRoute = useCallback(
    (updater: (route: FlightRoute) => FlightRoute) => {
      setState(
        (prevState) => {
          const prevActiveRoute =
            prevState.routes.find((route) => route.id === prevState.activeRouteId) || prevState.routes[0];
          if (!prevActiveRoute) return prevState;

          const nextRoutes = prevState.routes.map((route) =>
            route.id === prevActiveRoute.id ? updater(route) : route
          );

          return { ...prevState, routes: nextRoutes };
        },
        true
      );
    },
    [setState]
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
    const newRoute = createRoute(nextIndex, DEFAULT_NOMINAL_FLIGHT_HEIGHT);
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

  const setRouteColor = useCallback(
    (routeId: string, color: string) => {
      if (!routeId || !color) return;
      setState(
        (prevState) => {
          const hasRoute = prevState.routes.some((route) => route.id === routeId);
          if (!hasRoute) return prevState;
          return {
            ...prevState,
            routes: prevState.routes.map((route) =>
              route.id === routeId ? { ...route, color } : route
            )
          };
        },
        true
      );
    },
    [setState]
  );

  const setRouteLineWidth = useCallback(
    (routeId: string, width: number) => {
      if (!routeId) return;
      const safeWidth = sanitizeRouteLineWidth(width);
      setState(
        (prevState) => {
          const hasRoute = prevState.routes.some((route) => route.id === routeId);
          if (!hasRoute) return prevState;
          return {
            ...prevState,
            routes: prevState.routes.map((route) =>
              route.id === routeId ? { ...route, lineWidth: safeWidth } : route
            )
          };
        },
        true
      );
    },
    [setState]
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
      updateActiveRoute((route) => ({ ...route, points: [...route.points, ensurePointId(point)] }));
    },
    [updateActiveRoute]
  );

  const addPoints = useCallback(
    (points: Coordinate[]) => {
      updateActiveRoute((route) => {
        const nextPoints = [...route.points, ...points.map(ensurePointId)];
        return { ...route, points: nextPoints };
      });
    },
    [updateActiveRoute]
  );

  const updatePoint = useCallback(
    (index: number, point: Coordinate) => {
      console.log('[UPDATE_POINT] Called in useFlightPath:', {
        index,
        oldPoint: state.routes.find(r => r.id === state.activeRouteId)?.points[index],
        newPoint: point,
        routeId: state.activeRouteId
      });
      updateActiveRoute((route) => {
        const newPath = [...route.points];
        const oldPoint = newPath[index];
        // Preserve ID when updating
        const updatedPoint = ensurePointId({ ...point, id: oldPoint?.id || point.id });
        console.log('[UPDATE_POINT] Updating point:', {
          index,
          oldPoint: { id: oldPoint?.id, lng: oldPoint?.lng, lat: oldPoint?.lat },
          newPoint: { id: updatedPoint.id, lng: updatedPoint.lng, lat: updatedPoint.lat },
          idPreserved: oldPoint?.id === updatedPoint.id
        });
        newPath[index] = updatedPoint;
        return { ...route, points: newPath };
      });
    },
    [updateActiveRoute, state]
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
        newPath.splice(index, 0, ...points.map(ensurePointId));
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
    const newRoute = createRoute(1, DEFAULT_NOMINAL_FLIGHT_HEIGHT);
    resetHistory({
      routes: [newRoute],
      activeRouteId: newRoute.id,
      climbRequestsByRoute: {}
    });
  }, [resetHistory]);

  const setNominalFlightHeight = useCallback(
    (height: number) => {
      const safe = Number.isFinite(height) ? Math.max(0, height) : DEFAULT_NOMINAL_FLIGHT_HEIGHT;
      updateActiveRoute((route) => ({ ...route, nominalFlightHeight: safe }));
    },
    [updateActiveRoute]
  );

  const setRouteNominalFlightHeight = useCallback(
    (routeId: string, height: number) => {
      if (!routeId) return;
      const safe = Number.isFinite(height) ? Math.max(0, height) : DEFAULT_NOMINAL_FLIGHT_HEIGHT;
      setState(
        (prevState) => {
          const hasRoute = prevState.routes.some((route) => route.id === routeId);
          if (!hasRoute) return prevState;
          return {
            ...prevState,
            routes: prevState.routes.map((route) =>
              route.id === routeId ? { ...route, nominalFlightHeight: safe } : route
            )
          };
        },
        true
      );
    },
    [setState]
  );

  /**
   * Helper function to generate KML content for a single route
   */
  const generateKMLForRoute = useCallback((
    route: FlightRoute,
    routeClimbRequests: { endDistance: number; climbAmount: number }[],
    nominalFlightHeight?: number
  ): string => {
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
    }

    kmlContent += `  </Document>
</Folder>`;

    return kmlContent;
  }, []);

  /**
   * Helper function to download a KML file
   */
  const downloadKML = useCallback((kmlContent: string, filename: string) => {
    const blob = new Blob([kmlContent], {
      type: 'application/vnd.google-earth.kml+xml'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const exportKML = useCallback(
    (
      climbRequests?: { endDistance: number; climbAmount: number }[], 
      climbRequestsByRoute?: Record<string, { endDistance: number; climbAmount: number }[]>,
      selectedRouteIds?: string[],
      _nominalFlightHeight?: number,
      _firstTurnPointElevation?: number, // Unused parameter, kept for API compatibility
      filename?: string // Optional filename for single route export
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

      // If multiple routes, export each to a separate KML file
      // Note: filename parameter is ignored for multiple routes (each gets its own name)
      if (routesToExport.length > 1) {
        routesToExport.forEach((route, index) => {
          const routeClimbRequests = climbRequestsByRoute 
            ? (climbRequestsByRoute[route.id] || [])
            : (climbRequests && route.id === active?.id ? climbRequests : []);
          
          const kmlContent = generateKMLForRoute(route, routeClimbRequests, route.nominalFlightHeight);
          const filenameBase = route.name.toLowerCase().replace(/\s+/g, '-');
          // Use base timestamp + index to ensure unique filenames and add delay between downloads
          const timestamp = Date.now() + index;
          
          // Add a small delay between downloads to ensure browser handles them properly
          setTimeout(() => {
            downloadKML(kmlContent, `${filenameBase}-${timestamp}.kml`);
          }, index * 100); // 100ms delay between each download
        });
      } else {
        // Single route export - use existing logic
        const route = routesToExport[0];
        const routeClimbRequests = climbRequests && route.id === active?.id ? climbRequests : (climbRequestsByRoute ? (climbRequestsByRoute[route.id] || []) : []);
        
        const kmlContent = generateKMLForRoute(route, routeClimbRequests, route.nominalFlightHeight);
        // Use provided filename or generate default
        const finalFilename = filename || `${route.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.kml`;
        downloadKML(kmlContent, finalFilename);
      }
    },
    [activeRoute, state.routes, generateKMLForRoute, downloadKML]
  );

  const importKML = useCallback(
    async (file: File, dtmSource?: string | null): Promise<{ routes: FlightRoute[]; climbRequests: { endDistance: number; climbAmount: number }[]; nominalFlightHeight?: number } | null> => {
      try {
        // Validate file size (10MB limit for KML files)
        const MAX_KML_SIZE = 10 * 1024 * 1024; // 10MB
        if (file.size > MAX_KML_SIZE) {
          throw new Error(`KML file size (${(file.size / (1024 * 1024)).toFixed(2)}MB) exceeds maximum allowed size of ${MAX_KML_SIZE / (1024 * 1024)}MB`);
        }
        
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
        let nominalFlightHeight: number | undefined = undefined;
        let absoluteAltitudeInfo: { altitude: number; coord: Coordinate } | undefined = undefined;

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
                
                // Check if this is the entry height point (גובה כניסה)
                if (name.startsWith('גובה כניסה')) {
                  // Extract absolute altitude (sea level) from name (e.g., "גובה כניסה - 500")
                  // This is nominalFlightHeight + ground elevation at first turn point
                  const heightMatch = name.match(/גובה כניסה\s*-\s*(\d+)/);
                  if (heightMatch && heightMatch[1]) {
                    const absoluteAltitude = parseFloat(heightMatch[1]);
                    if (!isNaN(absoluteAltitude)) {
                      // Store the absolute altitude and coordinate for later calculation
                      // We'll subtract the ground elevation at first turn point to get nominalFlightHeight
                      absoluteAltitudeInfo = {
                        altitude: absoluteAltitude,
                        coord: { lng, lat }
                      };
                    }
                  }
                  // Don't add this as a climb request, it's just metadata
                  return;
                }
                
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

        // If we found absolute altitude in "גובה כניסה", use it directly as ASL
        // Entry height (nominalFlightHeight) is now ASL, matching the exported format
        // Legacy files (exported before this change) stored: ASL = AGL + ground elevation
        // New files (exported after this change) store: ASL = entry height directly
        // We handle both by using the imported value as ASL directly
        if (absoluteAltitudeInfo && routes.length > 0) {
          // TypeScript: absoluteAltitudeInfo is guaranteed to be defined here due to the if check
          const { altitude: absoluteAltitude } = absoluteAltitudeInfo as { altitude: number; coord: Coordinate };
          
          // Entry height is now ASL, so use the imported value directly
          // For legacy files that stored (AGL + ground), this will be incorrect, but we can't reliably
          // detect legacy vs new without a version marker. The user should re-export with the new format.
          console.log('KML import: Using entry height as ASL:', absoluteAltitude);
          nominalFlightHeight = Math.round(absoluteAltitude);
          
          // Optional: Try to detect legacy files by checking if DTM is available and value seems too high
          // This is a best-effort detection and may not be reliable
          if (dtmSource) {
            try {
              const firstRoute = routes[0];
              const p0 = firstRoute.points[0];
              const p1 = firstRoute.points[1] ?? firstRoute.points[0];
              const coordinates = [
                [p0.lng, p0.lat],
                [p1.lng, p1.lat]
              ];
              const clippedIdMatch = dtmSource.match(/\/api\/dtm\/clipped\/([^/]+)/);
              const clippedId = clippedIdMatch ? clippedIdMatch[1] : undefined;
              
              const response = await fetch('/api/elevation-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  coordinates,
                  dtmPath: dtmSource,
                  safetyRadiusMeters: 50,
                  resolutionRadiusMeters: 50,
                  ...(clippedId && { clippedId })
                })
              });
              
              if (response.ok) {
                const data = await response.json();
                let groundElevation: number | null = null;
                
                if (data.profile && Array.isArray(data.profile) && data.profile.length > 0) {
                  groundElevation = data.profile[0].elevation;
                } else if (data.elevations && Array.isArray(data.elevations) && data.elevations.length > 0) {
                  groundElevation = data.elevations[0];
                } else if (data.elevation !== undefined) {
                  groundElevation = data.elevation;
                } else if (Array.isArray(data) && data.length > 0) {
                  groundElevation = typeof data[0] === 'number' ? data[0] : data[0].elevation;
                }
                
                // Heuristic: If the imported value is much higher than ground + typical flight height (e.g., > 1000m),
                // it might be a legacy file. However, we can't be certain, so we'll use it as-is and log a warning.
                if (groundElevation !== null && !isNaN(groundElevation)) {
                  const estimatedAGL = absoluteAltitude - groundElevation;
                  if (estimatedAGL > 1000) {
                    console.warn('KML import: Imported entry height seems unusually high for AGL. If this is a legacy file (pre-ASL format), the value may be incorrect. Consider re-exporting with the new format.', {
                      importedASL: absoluteAltitude,
                      groundElevation,
                      estimatedAGL
                    });
                  }
                }
              }
            } catch (error) {
              // Ignore errors in legacy detection - use imported value as-is
              console.log('KML import: Could not check for legacy file format, using imported value as ASL');
            }
          }
        }
        
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

        // If we found nominal flight height, attach it to all imported routes
        const routesWithNominal = nominalFlightHeight !== undefined
          ? routes.map((r) => ({ ...r, nominalFlightHeight }))
          : routes;
        const routesWithStyleDefaults = routesWithNominal.map((route) => ({
          ...route,
          lineWidth: sanitizeRouteLineWidth(route.lineWidth)
        }));

        setState(
          (prevState) => {
            // If there is an existing route with no points, reuse it for the first imported route.
            // Otherwise, append imported routes as new routes.
            const emptyRouteIndex = prevState.routes.findIndex((r) => r.points.length === 0);

            const updatedClimbRequestsByRoute = { ...prevState.climbRequestsByRoute };
            const nextRoutes = [...prevState.routes];

            let nextActiveRouteId = routesWithStyleDefaults[0].id;

            if (emptyRouteIndex !== -1) {
              const existingEmpty = prevState.routes[emptyRouteIndex];
              const firstImported = routesWithStyleDefaults[0];

              // Keep the existing route identity (id/color/visibility), but inject imported geometry + metadata.
              nextRoutes[emptyRouteIndex] = {
                ...existingEmpty,
                name: firstImported.name || existingEmpty.name,
                points: firstImported.points,
                nominalFlightHeight: firstImported.nominalFlightHeight
              };

              nextActiveRouteId = existingEmpty.id;

              // Append any additional imported routes (if KML contains multiple LineStrings)
              if (routesWithStyleDefaults.length > 1) {
                nextRoutes.push(...routesWithStyleDefaults.slice(1));
              }
            } else {
              nextRoutes.push(...routesWithStyleDefaults);
            }

            // Attach climb requests to the first imported route (or the reused empty route)
            if (climbRequests.length > 0 && routesWithStyleDefaults.length > 0) {
              updatedClimbRequestsByRoute[nextActiveRouteId] = climbRequests;
            }

            return {
              ...prevState,
              routes: nextRoutes,
              activeRouteId: nextActiveRouteId,
              climbRequestsByRoute: updatedClimbRequestsByRoute
            };
          },
          true
        );

        return { routes: routesWithStyleDefaults, climbRequests, nominalFlightHeight };
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

  // Import routes directly (for project restore)
  const importRoutes = useCallback(
    (routesToImport: FlightRoute[], climbRequestsByRouteToImport?: Record<string, { endDistance: number; climbAmount: number; anchorPointIdA?: string; anchorPointIdB?: string; segmentRatio?: number }[]>) => {
      if (routesToImport.length === 0) return;
      const normalizedRoutesToImport = routesToImport.map((route) => ({
        ...route,
        lineWidth: sanitizeRouteLineWidth(route.lineWidth)
      }));
      
      setState(
        (prevState) => {
          // Find empty route to reuse, or append new routes
          const emptyRouteIndex = prevState.routes.findIndex((r) => r.points.length === 0);
          const nextRoutes = [...prevState.routes];
          let nextActiveRouteId = normalizedRoutesToImport[0]?.id || prevState.activeRouteId;
          const updatedClimbRequestsByRoute = climbRequestsByRouteToImport 
            ? { ...prevState.climbRequestsByRoute, ...climbRequestsByRouteToImport }
            : prevState.climbRequestsByRoute;

          if (emptyRouteIndex !== -1 && normalizedRoutesToImport.length > 0) {
            // Reuse empty route for first imported route
            const existingEmpty = prevState.routes[emptyRouteIndex];
            const firstImported = normalizedRoutesToImport[0];
            nextRoutes[emptyRouteIndex] = {
              ...existingEmpty,
              id: firstImported.id,
              name: firstImported.name || existingEmpty.name,
              color: firstImported.color || existingEmpty.color,
              lineWidth: sanitizeRouteLineWidth(firstImported.lineWidth),
              visible: firstImported.visible !== undefined ? firstImported.visible : existingEmpty.visible,
              points: firstImported.points,
              nominalFlightHeight: firstImported.nominalFlightHeight
            };
            nextActiveRouteId = firstImported.id;

            // Append additional routes
            if (normalizedRoutesToImport.length > 1) {
              nextRoutes.push(...normalizedRoutesToImport.slice(1));
            }
          } else {
            // No empty route, replace all routes
            nextRoutes.splice(0, nextRoutes.length, ...normalizedRoutesToImport);
            nextActiveRouteId = normalizedRoutesToImport[0]?.id || '';
          }

          return {
            ...prevState,
            routes: nextRoutes,
            activeRouteId: nextActiveRouteId,
            climbRequestsByRoute: updatedClimbRequestsByRoute
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
    nominalFlightHeight,
    setNominalFlightHeight,
    setRouteNominalFlightHeight,
    setRouteColor,
    setRouteLineWidth,
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
    importRoutes,
    setClimbRequestsByRoute,
    undo,
    redo,
    canUndo,
    canRedo
  };
}

