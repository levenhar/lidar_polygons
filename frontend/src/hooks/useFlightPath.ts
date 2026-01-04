import { useCallback, useMemo } from 'react';
import { Coordinate } from '../App';
import { useUndoRedo } from './useUndoRedo';

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
}

const colorPalette = ['#ff4d4f', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

function createRoute(index: number): FlightRoute {
  return {
    id: `route-${index}-${Date.now()}`,
    name: `Route ${index}`,
    color: colorPalette[(index - 1) % colorPalette.length],
    visible: true,
    points: []
  };
}

export function useFlightPath() {
  const initialRoute = createRoute(1);
  const { state, setState, undo, redo, canUndo, canRedo, resetHistory } = useUndoRedo<FlightRoutesState>({
    routes: [initialRoute],
    activeRouteId: initialRoute.id
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
        routes: [...state.routes, newRoute],
        activeRouteId: newRoute.id
      },
      true
    );
  }, [setState, state.routes]);

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

      // if we somehow removed all, recreate one
      if (filtered.length === 0) {
        const newRoute = createRoute(1);
        setState({ routes: [newRoute], activeRouteId: newRoute.id }, true);
        return;
      }

      setState({ routes: filtered, activeRouteId: nextActiveId }, true);
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
    resetHistory({ routes: clearedRoutes, activeRouteId: nextActive });
  }, [ensureActiveRoute, resetHistory, state.activeRouteId, state.routes]);

  const resetToSingleRoute = useCallback(() => {
    const newRoute = createRoute(1);
    resetHistory({
      routes: [newRoute],
      activeRouteId: newRoute.id
    });
  }, [resetHistory]);

  const exportGeoJSON = useCallback(() => {
    const active = activeRoute;
    const routesWithPoints = state.routes.filter((route) => route.points.length >= 2);

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

    const features: GeoJSONFeature[] = [];

    const addRouteFeature = (route: FlightRoute) => {
      if (route.points.length < 2) return;
      const coordinates = route.points.map((p) => [p.lng, p.lat]);
      const heights = route.points.map((p) => p.height);
      const hasHeights = heights.some((h) => h !== undefined);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates
        },
        properties: {
          name: route.name,
          routeId: route.id,
          createdAt: new Date().toISOString(),
          ...(hasHeights && { heights })
        }
      });
    };

    if (exportAll) {
      routesWithPoints.forEach(addRouteFeature);
    } else if (active) {
      addRouteFeature(active);
    }

    if (features.length === 0) {
      alert('Nothing to export. Add at least 2 points.');
      return;
    }

    const geoJSON: GeoJSON = {
      type: 'FeatureCollection',
      features
    };

    const filenameBase =
      exportAll && routesWithPoints.length > 1
        ? 'routes-all'
        : (active?.name || 'flight-path').toLowerCase().replace(/\s+/g, '-');

    const blob = new Blob([JSON.stringify(geoJSON, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenameBase}-${Date.now()}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeRoute, state.routes]);

  const importGeoJSON = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const geoJSON: GeoJSON = JSON.parse(text);

        const lineStringFeature = geoJSON.features.find((f) => f.geometry.type === 'LineString');

        if (!lineStringFeature) {
          alert('No LineString in GeoJSON.');
          return;
        }

        const heights = lineStringFeature.properties?.heights as number[] | undefined;

        const coordinates = lineStringFeature.geometry.coordinates.map((coord, index) => ({
          lng: coord[0],
          lat: coord[1],
          ...(heights && heights[index] !== undefined && { height: heights[index] })
        }));

        updateActiveRoute((route) => ({ ...route, points: coordinates }));
      } catch (error) {
        console.error('Error importing GeoJSON:', error);
        alert('Failed to import GeoJSON.');
      }
    },
    [updateActiveRoute]
  );

  return {
    routes: state.routes,
    activeRouteId: ensureActiveRoute(state.activeRouteId),
    flightPath,
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
    exportGeoJSON,
    importGeoJSON,
    undo,
    redo,
    canUndo,
    canRedo
  };
}

