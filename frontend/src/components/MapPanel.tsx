import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { Coordinate, ElevationPoint } from '../App';
import { FlightRoute } from '../hooks/useFlightPath';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination, generateUTurnPoints, UTurnSide } from '../utils/geometry';
import './MapPanel.css';
import { TileLayerOptions } from 'leaflet';


type TileLayerOptionsWithAgent = TileLayerOptions & {
  httpsAgent?: any;
};

type IconName =
  | 'upload'
  | 'eject'
  | 'trash'
  | 'pencil'
  | 'parallel'
  | 'compass'
  | 'crosshair'
  | 'uturn'
  | 'undo'
  | 'redo'
  | 'fit'
  | 'home';

const Icon: React.FC<{ name: IconName }> = ({ name }) => {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  };
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };

  switch (name) {
    case 'upload':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 16V4" />
          <path {...stroke} d="M7 8l5-4 5 4" />
          <path {...stroke} d="M4 20h16" />
        </svg>
      );
    case 'eject':
      return (
        <svg {...common}>
          <path {...stroke} d="M10 14l-2 2m0 0l2 2m-2-2h8" />
          <path {...stroke} d="M14 10l2-2m0 0l-2-2m2 2H8" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 6h18" />
          <path {...stroke} d="M8 6V4h8v2" />
          <path {...stroke} d="M19 6l-1 14H6L5 6" />
          <path {...stroke} d="M10 11v6" />
          <path {...stroke} d="M14 11v6" />
        </svg>
      );
    case 'pencil':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 20h9" />
          <path {...stroke} d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z" />
        </svg>
      );
    case 'parallel':
      return (
        <svg {...common}>
          <path {...stroke} d="M6 4l12 16" />
          <path {...stroke} d="M10 4l12 16" />
        </svg>
      );
    case 'compass':
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="9" />
          <path {...stroke} d="M14.5 9.5l-2 5-5 2 2-5 5-2z" />
        </svg>
      );
    case 'crosshair':
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="6" />
          <path {...stroke} d="M12 2v4" />
          <path {...stroke} d="M12 18v4" />
          <path {...stroke} d="M2 12h4" />
          <path {...stroke} d="M18 12h4" />
        </svg>
      );
    case 'uturn':
      return (
        <svg {...common}>
          <path {...stroke} d="M16 7V6a4 4 0 0 0-8 0v10" />
          <path {...stroke} d="M8 16l-3-3m3 3l3-3" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...common}>
          <path {...stroke} d="M9 14l-4-4 4-4" />
          <path {...stroke} d="M5 10h8a6 6 0 0 1 6 6v2" />
        </svg>
      );
    case 'redo':
      return (
        <svg {...common}>
          <path {...stroke} d="M15 6l4 4-4 4" />
          <path {...stroke} d="M19 10H11a6 6 0 0 0-6 6v2" />
        </svg>
      );
    case 'fit':
      return (
        <svg {...common}>
          <path {...stroke} d="M4 9V4h5" />
          <path {...stroke} d="M20 9V4h-5" />
          <path {...stroke} d="M4 15v5h5" />
          <path {...stroke} d="M20 15v5h-5" />
        </svg>
      );
    case 'home':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 11l9-8 9 8" />
          <path {...stroke} d="M5 10v10h14V10" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path {...stroke} d="M12 12h0" />
        </svg>
      );
  }
};

interface BaseMapConfig {
  id: string;
  name: string;
  url: string;
}

interface BaseMapPreviewConfig {
  zoom?: number;
  x?: number;
  y?: number;
}

interface BaseMapPreviewResponse {
  defaults: {
    zoom: number;
    x: number;
    y: number;
  };
  overrides: Record<string, BaseMapPreviewConfig>;
}

// Fix for default marker icons in Leaflet with webpack/vite
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

interface MapPanelProps {
  dtmSource: string | null;
  routes: FlightRoute[];
  activeRouteId: string;
  flightPath: Coordinate[];
  onPathPointHover: (point: Coordinate | null) => void;
  onPathChange: (path: Coordinate[]) => void;
  onAddPoint: (point: Coordinate) => void;
  onAddPoints: (points: Coordinate[]) => void;
  onInsertPoints: (index: number, points: Coordinate[]) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onDeletePoint: (index: number) => void;
  onAddRoute: () => void;
  onActiveRouteChange: (routeId: string) => void;
  onRenameRoute: (routeId: string, name: string) => void;
  onToggleRouteVisibility: (routeId: string) => void;
  onDeleteRoute: (routeId: string) => void;
  onShowAllRoutes: () => void;
  onHideNonActiveRoutes: () => void;
  onResetToSingleRoute: () => void;
  onDtmLoad: (source: string, info?: any) => void;
  onDtmUnload: () => void;
  nominalFlightHeight: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  editPointIndex?: number | null;
  onEditPointIndexChange?: (index: number | null) => void;
  hoveredElevationPoint?: ElevationPoint | null;
}

const MapPanel: React.FC<MapPanelProps> = ({
  dtmSource,
  routes,
  activeRouteId,
  flightPath,
  onPathPointHover,
  onPathChange,
  onAddPoint,
  onAddPoints,
  onInsertPoints,
  onUpdatePoint,
  onDeletePoint,
  onAddRoute,
  onActiveRouteChange,
  onRenameRoute,
  onToggleRouteVisibility,
  onDeleteRoute,
  onShowAllRoutes,
  onHideNonActiveRoutes,
  onResetToSingleRoute,
  onDtmLoad,
  onDtmUnload,
  nominalFlightHeight,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  editPointIndex: externalEditPointIndex,
  onEditPointIndexChange,
  hoveredElevationPoint
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const tileLayerOptionsRef = useRef<TileLayerOptionsWithAgent | null>(null);
  const mapTokenRef = useRef<string | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isParallelLineMode, setIsParallelLineMode] = useState(false);
  const [dtmLoaded, setDtmLoaded] = useState(false);
  const [dtmBounds, setDtmBounds] = useState<number[] | null>(null);
  const [dtmOpacity, setDtmOpacity] = useState<number>(0.1); // Default 90% transparency (10% opacity)
  const markersRef = useRef<L.Marker[]>([]);
  const flightPathLineRef = useRef<L.Polyline | null>(null);
  const flightPathClickableLineRef = useRef<L.Polyline | null>(null);
  const hoveredPointRef = useRef<number | null>(null);
  const dtmImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const dtmBoundaryRef = useRef<L.Rectangle | null>(null);
  const dtmTransparencyControlRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hoveredElevationMarkerRef = useRef<L.Marker | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isDtmProcessing, setIsDtmProcessing] = useState<boolean>(false);
  const [baseMaps, setBaseMaps] = useState<BaseMapConfig[]>([]);
  const [activeBaseMapId, setActiveBaseMapId] = useState<string | null>(null);
  const [previewConfig, setPreviewConfig] = useState<BaseMapPreviewResponse | null>(null);
  const passiveRouteLinesRef = useRef<Record<string, L.Polyline>>({});
  const [isRoutesPanelOpen, setIsRoutesPanelOpen] = useState<boolean>(false);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editingRouteName, setEditingRouteName] = useState<string>('');
  const [dialog, setDialog] = useState<{
    type: 'height' | 'azimuthDistance' | 'coordinates' | 'uTurn' | 'parallelOffset';
    title: string;
  } | null>(null);
  const [dialogValues, setDialogValues] = useState<Record<string, string>>({});
  const [dialogError, setDialogError] = useState<string | null>(null);

  const resetDialog = () => {
    setDialog(null);
    setDialogValues({});
    setDialogError(null);
  };

  const activeRoute = routes.find((route) => route.id === activeRouteId) || routes[0];
  const activeRouteColor = activeRoute?.color || '#ff0000';

  // Helper function to check if a point is within DTM bounds
  const isPointWithinBounds = useCallback((lng: number, lat: number): boolean => {
    if (!dtmBounds || dtmBounds.length !== 4) {
      return false;
    }
    const [minLng, minLat, maxLng, maxLat] = dtmBounds;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  }, [dtmBounds]);

  // Helper to read numeric preview values per basemap from backend-provided config
  const getPreviewNumericValue = useCallback((baseMapId: string, key: 'ZOOM' | 'X' | 'Y'): number => {
    const keyLower = key.toLowerCase() as 'zoom' | 'x' | 'y';
    const defaultValue = previewConfig?.defaults?.[keyLower] ?? 0;
    const overrideValue = previewConfig?.overrides?.[baseMapId]?.[keyLower];
    const rawValue = overrideValue ?? defaultValue;
    const parsed = Number(rawValue);
    const safeValue = Number.isFinite(parsed) ? parsed : 0;
    if (key === 'ZOOM') {
      // Clamp zoom to a sane Leaflet zoom range
      return Math.min(22, Math.max(0, safeValue));
    }
    return safeValue;
  }, [previewConfig]);

  // Helper function to get preview tile URL (0/0/0 tile)
  const getPreviewTileUrl = useCallback((baseMap: BaseMapConfig): string => {
    const previewZoom = getPreviewNumericValue(baseMap.id, 'ZOOM').toString();
    const previewX = getPreviewNumericValue(baseMap.id, 'X').toString();
    const previewY = getPreviewNumericValue(baseMap.id, 'Y').toString();
    // Replace Leaflet tile placeholders with preview zoom/coords
    let previewUrl = baseMap.url
      .replace('{z}', previewZoom)
      .replace('{x}', previewX)
      .replace('{y}', previewY)
      .replace('{s}', 'a'); // Use 'a' subdomain for OSM-style tiles
    
    // Add token if available
    if (mapTokenRef.current && mapTokenRef.current.trim() !== '') {
      const separator = previewUrl.includes('?') ? '&' : '?';
      previewUrl = `${previewUrl}${separator}token=${mapTokenRef.current}`;
    }
    
    return previewUrl;
  }, [getPreviewNumericValue]);

  const switchBaseMap = useCallback((nextBaseMapId: string) => {
    if (!map.current || !tileLayerOptionsRef.current) {
      console.warn('⚠️ Cannot switch basemap - missing dependencies');
      return;
    }
    const nextBaseMap = baseMaps.find((entry) => entry.id === nextBaseMapId);
    if (!nextBaseMap) {
      console.warn('⚠️ Basemap not found:', nextBaseMapId);
      return;
    }
    if (nextBaseMap.id === activeBaseMapId) {
      console.log('ℹ️ Already on basemap:', nextBaseMapId);
      return;
    }

    console.log('🔄 Switching basemap to:', nextBaseMap.name);

    if (baseLayerRef.current) {
      baseLayerRef.current.remove();
    }

    let urlWithToken = nextBaseMap.url;
    
    // Only append token if it's not empty
    if (mapTokenRef.current && mapTokenRef.current.trim() !== '') {
      const separator = nextBaseMap.url.includes('?') ? '&' : '?';
      urlWithToken = `${nextBaseMap.url}${separator}token=${mapTokenRef.current}`;
    }
    
    console.log('🗺️ New basemap URL:', urlWithToken);
    baseLayerRef.current = L.tileLayer(urlWithToken, tileLayerOptionsRef.current).addTo(map.current);
    setActiveBaseMapId(nextBaseMap.id);
    console.log('✅ Basemap switched successfully');
  }, [activeBaseMapId, baseMaps]);

  const handleCycleBaseMap = useCallback(() => {
    if (baseMaps.length < 2) return;
    const currentIndex = baseMaps.findIndex((entry) => entry.id === activeBaseMapId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % baseMaps.length : 0;
    switchBaseMap(baseMaps[nextIndex].id);
  }, [activeBaseMapId, baseMaps, switchBaseMap]);

  const handleBaseMapButtonClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handleCycleBaseMap();
  }, [handleCycleBaseMap]);

  // Initialize map
  useEffect(() => {
    async function initializeHttpAgent() {
      if (typeof window !== 'undefined') {
        // We are in the browser no need for agent
        return null
      } else {
        // We are in a Node.js env
        try {
          const httpsModule = await import('node:https');
          const httpsagent_f = new httpsModule.Agent({
              rejectUnauthorized: false,
          });
          return httpsagent_f
        } catch (error) {
          console.error("Failed to import node:https:", error);
          return null // or undefined
        }
      }
    }
    if (!mapContainer.current || map.current) return;

    initializeHttpAgent().then(async(httpsAgent_f) => {
      const response_crs = await fetch('/api/crs')

      if (!response_crs.ok){
        const errorData = await response_crs.json().catch(() => ({error: 'Unknown error'}));
        throw new Error(errorData.error || 'Failed to get CRS for maps ${response.status}');
      }
      const crsResponse = await response_crs.json();
      const crsString = crsResponse.crs;

      // Map CRS string from env to Leaflet CRS object
      let leafletCrs: L.CRS;
      if (!crsString) {
        // Default to EPSG3857 if not specified
        leafletCrs = L.CRS.EPSG3857;
      } else {
        // Normalize the CRS string (handle both "EPSG4326" and "EPSG:4326" formats)
        const normalizedCrs = crsString.replace(':', '').toUpperCase();
        
        // Map common CRS strings to Leaflet CRS objects
        // Use type assertion to access CRS dynamically, with fallback
        const crsKey = normalizedCrs as keyof typeof L.CRS;
        if (L.CRS[crsKey]) {
          leafletCrs = L.CRS[crsKey];
        } else {
          console.warn(`Unknown CRS: ${crsString}. Defaulting to EPSG3857.`);
          leafletCrs = L.CRS.EPSG3857;
        }
      }

      if (mapContainer.current) {
        map.current = L.map(mapContainer.current, {
          center: [31.50, 35.02], // israel defulat
          zoom: 7 ,
          crs: leafletCrs
          // crs: L.CRS.EPSG4326
        });
      }

      // Create option *after* httpsAgent_f is define
      const options: TileLayerOptionsWithAgent = {
        maxZoom:19,
        httpsAgent:httpsAgent_f,
        noWrap: true // prevent repeated world copies when zoomed out
      };
      tileLayerOptionsRef.current = options;

      const response_token = await fetch('/api/token')

      if (!response_token.ok){
        const errorData = await response_token.json().catch(() => ({error: 'Unknown error'}));
        throw new Error(errorData.error || 'Failed to get token for maps ${response.status}');
      }
      const MAPS_TOKEN = await response_token.json();
      mapTokenRef.current = MAPS_TOKEN.token || '';


      const response_url = await fetch('/api/url')

      if (!response_url.ok){
        const errorData = await response_url.json().catch(() => ({error: 'Unknown error'}));
        throw new Error(errorData.error || 'Failed to get token for maps ${response.status}');
      }
      const raw_url = await response_url.json();
      const primaryUrl = raw_url?.url;
      const alternateUrl = raw_url?.altUrl;

      const response_preview = await fetch('/api/map-preview');
      if (!response_preview.ok) {
        const errorData = await response_preview.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || 'Failed to get preview configuration for maps');
      }
      const previewData: BaseMapPreviewResponse = await response_preview.json();
      setPreviewConfig(previewData);

      console.log('🗺️ Map URLs received:', { primaryUrl, alternateUrl });

      const availableBaseMaps: BaseMapConfig[] = [];
      if (primaryUrl) {
        availableBaseMaps.push({
          id: 'primary',
          name: 'OSM',
          url: primaryUrl
        });
      }
      if (alternateUrl) {
        availableBaseMaps.push({
          id: 'alternate',
          name: 'Satellite',
          url: alternateUrl
        });
      }

      console.log('🗺️ Available basemaps:', availableBaseMaps);
      
      console.log('🔍 Checking dependencies:', {
        mapExists: !!map.current,
        baseMapsCount: availableBaseMaps.length,
        tileOptionsExists: !!tileLayerOptionsRef.current,
        token: mapTokenRef.current || '(empty)'
      });

      if (map.current && availableBaseMaps.length > 0 && tileLayerOptionsRef.current) {
        const initialBaseMap = availableBaseMaps[0];
        let initialUrl = initialBaseMap.url;
        
        // Only append token if it's not empty
        if (mapTokenRef.current && mapTokenRef.current.trim() !== '') {
          const separator = initialBaseMap.url.includes('?') ? '&' : '?';
          initialUrl = `${initialBaseMap.url}${separator}token=${mapTokenRef.current}`;
        }
        
        console.log('🗺️ Initializing basemap:', { id: initialBaseMap.id, url: initialUrl });
        baseLayerRef.current = L.tileLayer(initialUrl, tileLayerOptionsRef.current).addTo(map.current);
        setActiveBaseMapId(initialBaseMap.id);
        console.log('✅ Basemap layer added to map');
      } else {
        console.error('❌ Cannot add basemap - missing dependencies');
      }
      
      setBaseMaps(availableBaseMaps);
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
      baseLayerRef.current = null;
      tileLayerOptionsRef.current = null;
      mapTokenRef.current = null;
    };
  }, []);

  // Set up click handler for adding points, editing points, and parallel line creation
  useEffect(() => {
    if (!map.current) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      // If editing a point, move it to the new location
      const currentEditingIndex = externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex;
      if (currentEditingIndex !== null && dtmLoaded) {
        const lng = e.latlng.lng;
        const lat = e.latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('Point must stay within DTM bounds.');
          return;
        }
        
        const currentPoint = flightPath[currentEditingIndex];
        onUpdatePoint(currentEditingIndex, {
          lng,
          lat,
          height: currentPoint.height // Preserve height
        });
        setEditingPointIndex(null);
        if (onEditPointIndexChange) {
          onEditPointIndexChange(null);
        }
        return;
      }

      // If in parallel line mode, handle line segment selection
      if (isParallelLineMode && dtmLoaded && flightPath.length >= 2 && map.current) {
        // Find which segment was clicked by calculating distance to each segment
        const clickPoint = { lng: e.latlng.lng, lat: e.latlng.lat };
        let closestSegmentIndex = -1;
        let closestDistance = Infinity;
        
        for (let i = 0; i < flightPath.length - 1; i++) {
          const result = findClosestPointOnLine(clickPoint, flightPath[i], flightPath[i + 1]);
          
          // Check if click is close enough to the segment (100 meters threshold)
          if (result.distance < 100) {
            if (result.distance < closestDistance) {
              closestDistance = result.distance;
              closestSegmentIndex = i;
            }
          }
        }
        
        if (closestSegmentIndex >= 0) {
          setDialog({
            type: 'parallelOffset',
            title: 'Parallel offset'
          });
          setDialogValues({
            segmentIndex: closestSegmentIndex.toString(),
            offset: '50'
          });
          setDialogError(null);
              } else {
          alert('Click closer to a line segment.');
        }
        return;
      }

      // Otherwise, add new point if drawing
      if (isDrawing && dtmLoaded) {
        const lng = e.latlng.lng;
        const lat = e.latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('Point must be inside DTM bounds.');
          return;
        }
        
        const newPoint: Coordinate = {
          lng,
          lat
        };
        onAddPoint(newPoint);
      }
    };

    map.current.on('click', handleClick);

    return () => {
      if (map.current) {
        map.current.off('click', handleClick);
      }
    };
  }, [isDrawing, isParallelLineMode, dtmLoaded, onAddPoint, onUpdatePoint, isPointWithinBounds, editingPointIndex, flightPath, onAddPoints]);

  // Update flight path on map
  useEffect(() => {
    if (!map.current) return;

    // Remove existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Remove existing flight path lines
    if (flightPathLineRef.current) {
      map.current.removeLayer(flightPathLineRef.current);
      flightPathLineRef.current = null;
    }
    if (flightPathClickableLineRef.current) {
      map.current.removeLayer(flightPathClickableLineRef.current);
      flightPathClickableLineRef.current = null;
    }

    if (flightPath.length === 0) return;

    // Convert coordinates to Leaflet format (lat, lng)
    const latlngs = flightPath.map(p => [p.lat, p.lng] as [number, number]);

    // Add invisible clickable line for line segment selection (wide stroke)
    flightPathClickableLineRef.current = L.polyline(latlngs, {
      color: 'transparent',
      weight: 20, // Wide invisible line for easier clicking
      opacity: 0,
      interactive: true
    }).addTo(map.current);

    // Allow inserting a new vertex by clicking on a line segment.
    // This works even in drawing mode, and stops propagation to avoid double-adding points.
    const handleClickableLineClick = (e: L.LeafletMouseEvent) => {
      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent && originalEvent.button !== 0) return; // left-click only
      if (!dtmLoaded) return;
      if (isParallelLineMode) return;

      // If editing a point via "click to move", don't insert
      const currentEditingIndex =
        externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex;
      if (currentEditingIndex !== null) return;

      if (flightPath.length < 2) return;

      const clickPoint = { lng: e.latlng.lng, lat: e.latlng.lat };
      let closestSegmentIndex = -1;
      let closestDistance = Infinity;
      let closestT = 0;

      for (let i = 0; i < flightPath.length - 1; i++) {
        const result = findClosestPointOnLine(clickPoint, flightPath[i], flightPath[i + 1]);
        if (result.distance < 100 && result.distance < closestDistance) {
          closestDistance = result.distance;
          closestSegmentIndex = i;
          closestT = result.t;
        }
      }

      if (closestSegmentIndex < 0) return;

      // Avoid inserting directly on an existing vertex
      if (closestT <= 1e-4 || closestT >= 1 - 1e-4) return;

      const start = flightPath[closestSegmentIndex];
      const end = flightPath[closestSegmentIndex + 1];

      const lng = start.lng + closestT * (end.lng - start.lng);
      const lat = start.lat + closestT * (end.lat - start.lat);

      if (!isPointWithinBounds(lng, lat)) {
        alert('Point must be inside DTM bounds.');
        return;
      }

      const startHasHeight = start.height !== undefined;
      const endHasHeight = end.height !== undefined;
      const shouldSetHeight = startHasHeight || endHasHeight;
      const startHeight = start.height ?? nominalFlightHeight;
      const endHeight = end.height ?? nominalFlightHeight;

      const newPoint: Coordinate = {
        lng,
        lat,
        ...(shouldSetHeight ? { height: startHeight + (endHeight - startHeight) * closestT } : {})
      };

      onInsertPoints(closestSegmentIndex + 1, [newPoint]);

      // Prevent map click handler from also firing (especially in drawing mode)
      L.DomEvent.stop(e);
    };

    flightPathClickableLineRef.current.on('click', handleClickableLineClick);

    // Add flight path line (will be on top)
    flightPathLineRef.current = L.polyline(latlngs, {
      color: activeRouteColor,
      weight: 3,
      opacity: 0.8
    }).addTo(map.current);

    // Update cursor style for clickable line layer when in parallel line mode
    if (isParallelLineMode && flightPathClickableLineRef.current) {
      map.current.getContainer().style.cursor = 'crosshair';
    }

    // Add markers for each point
    flightPath.forEach((point, index) => {
      const el = document.createElement('div');
      el.className = 'flight-point-marker';
      el.innerHTML = `${index + 1}`;
      el.style.cursor = 'pointer';
      el.style.backgroundColor = activeRouteColor;

      const icon = L.divIcon({
        className: 'flight-point-marker-container',
        html: el,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const marker = L.marker([point.lat, point.lng], {
        icon: icon,
        draggable: false // Disable default dragging
      }).addTo(map.current!);

      // Store the last valid position for this marker
      let lastValidPosition: [number, number] = [point.lat, point.lng];
      let isDraggingWithLeftClick = false;

      // Handle marker left-click to start dragging
      el.addEventListener('mousedown', (e) => {
        // Only handle left mouse button (button 0)
        if (e.button !== 0) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        // Start left-click drag mode
        isDraggingWithLeftClick = true;
        lastValidPosition = [point.lat, point.lng];
        el.style.cursor = 'grabbing';
        el.classList.add('is-dragging');
        marker.setZIndexOffset(1000);
        
        // Prevent all map interactions while dragging
        if (map.current) {
          map.current.dragging.disable();
          map.current.touchZoom.disable();
          map.current.doubleClickZoom.disable();
          map.current.scrollWheelZoom.disable();
          map.current.boxZoom.disable();
          map.current.keyboard.disable();
        }
      });

      // Re-add context menu for right-click
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        setContextMenu({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          pointIndex: index
        });
      });

      // Handle mouse move to update marker position during drag
      const handleMouseMove = (e: MouseEvent) => {
        if (!isDraggingWithLeftClick || !map.current) return;
        
        e.preventDefault();
        e.stopPropagation();

        // Use Leaflet's helper to convert the mouse event to map coordinates
        const latlng = map.current.mouseEventToLatLng(e as any);
        const lng = latlng.lng;
        const lat = latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          return; // Don't update if outside bounds
        }
        
        // Update marker position
        marker.setLatLng([lat, lng]);
        lastValidPosition = [lat, lng];
      };

      // Handle mouse up to end drag
      const handleMouseUp = (e: MouseEvent) => {
        if (!isDraggingWithLeftClick) return;
        
        e.preventDefault();
        e.stopPropagation();

        // On release, ALWAYS drop the point exactly where the mouse was released
        // (even if there were few/no mousemove events).
        if (map.current) {
          const dropLatLng = map.current.mouseEventToLatLng(e as any);
          const dropLng = dropLatLng.lng;
          const dropLat = dropLatLng.lat;

          if (isPointWithinBounds(dropLng, dropLat)) {
            marker.setLatLng([dropLat, dropLng]);
            lastValidPosition = [dropLat, dropLng];
            // Update React state ONCE at the end to avoid re-rendering/remounting markers mid-drag
            onUpdatePoint(index, { lng: dropLng, lat: dropLat, height: point.height });
          }
        }
        
        isDraggingWithLeftClick = false;
        el.style.cursor = 'pointer';
        el.classList.remove('is-dragging');
        marker.setZIndexOffset(0);
        
        // Re-enable all map interactions
        if (map.current) {
          map.current.dragging.enable();
          map.current.touchZoom.enable();
          map.current.doubleClickZoom.enable();
          map.current.scrollWheelZoom.enable();
          map.current.boxZoom.enable();
          map.current.keyboard.enable();
        }
        
        // Validate final position
        const finalLatLng = marker.getLatLng();
        if (!isPointWithinBounds(finalLatLng.lng, finalLatLng.lat)) {
          // Reset to last valid position if outside bounds
          marker.setLatLng(lastValidPosition);
          onUpdatePoint(index, { lng: lastValidPosition[1], lat: lastValidPosition[0] });
          alert('Cannot move point outside DTM bounding box. Point has been reset to the previous valid position.');
        }
      };

      // Add event listeners to document for mouse move and up
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      // Store cleanup function
      marker.on('remove', () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      });

      el.addEventListener('mouseenter', () => {
        hoveredPointRef.current = index;
        onPathPointHover(point);
      });

      el.addEventListener('mouseleave', () => {
        hoveredPointRef.current = null;
        onPathPointHover(null);
      });

      markersRef.current.push(marker);
    });

    // Don't auto-fit bounds while drawing - let user control the view
    // Map view will remain fixed during drawing
  }, [
    flightPath,
    onInsertPoints,
    onUpdatePoint,
    onDeletePoint,
    onPathPointHover,
    isPointWithinBounds,
    dtmLoaded,
    isDrawing,
    isParallelLineMode,
    nominalFlightHeight,
    editingPointIndex,
    externalEditPointIndex,
    activeRouteColor
  ]);

  // Render passive polylines for non-active routes
  useEffect(() => {
    if (!map.current) return;

    // Remove lines that should no longer exist
    Object.entries(passiveRouteLinesRef.current).forEach(([routeId, polyline]) => {
      const stillExists = routes.some(
        (route) => route.id === routeId && route.visible && route.id !== activeRouteId
      );
      if (!stillExists) {
        map.current?.removeLayer(polyline);
        delete passiveRouteLinesRef.current[routeId];
      }
    });

    routes.forEach((route) => {
      if (route.id === activeRouteId || !route.visible || route.points.length === 0) {
        return;
      }

      const latlngs = route.points.map((p) => [p.lat, p.lng] as [number, number]);
      const existing = passiveRouteLinesRef.current[route.id];
      if (existing) {
        existing.setLatLngs(latlngs);
        existing.setStyle({ color: route.color });
      } else {
        passiveRouteLinesRef.current[route.id] = L.polyline(latlngs, {
          color: route.color,
          weight: 3,
          opacity: 0.6,
          dashArray: '6 6'
        }).addTo(map.current!);
      }
    });

    return () => {
      Object.values(passiveRouteLinesRef.current).forEach((polyline) => {
        map.current?.removeLayer(polyline);
      });
      passiveRouteLinesRef.current = {};
    };
  }, [routes, activeRouteId]);

  // Update hovered elevation point marker
  useEffect(() => {
    if (!map.current) return;

    // Remove existing hovered elevation marker
    if (hoveredElevationMarkerRef.current) {
      map.current.removeLayer(hoveredElevationMarkerRef.current);
      hoveredElevationMarkerRef.current = null;
    }

    // Add new marker if there's a hovered elevation point
    if (hoveredElevationPoint) {
      const icon = L.divIcon({
        className: 'hovered-elevation-marker',
        html: '<div style="background-color: #9B59B6; width: 14px; height: 14px; border-radius: 50%; border: 2px solid black; box-shadow: 0 0 6px rgba(155,89,182,0.8);"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      hoveredElevationMarkerRef.current = L.marker(
        [hoveredElevationPoint.latitude, hoveredElevationPoint.longitude],
        { icon }
      ).addTo(map.current);
    }
  }, [hoveredElevationPoint]);

  // Exit drawing mode if DTM is unloaded
  useEffect(() => {
    if (!dtmLoaded && isDrawing) {
      setIsDrawing(false);
    }
    if (!dtmLoaded && isParallelLineMode) {
      setIsParallelLineMode(false);
    }
  }, [dtmLoaded, isDrawing, isParallelLineMode]);

  // Sync external edit point index with internal state
  useEffect(() => {
    if (externalEditPointIndex !== undefined && externalEditPointIndex !== editingPointIndex) {
      setEditingPointIndex(externalEditPointIndex);
    }
  }, [externalEditPointIndex]);

  // Update cursor when parallel line mode changes
  useEffect(() => {
    if (!map.current) return;
    const currentEditingIndex = externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex;
    if (isParallelLineMode) {
      map.current.getContainer().style.cursor = 'crosshair';
    } else if (!isDrawing && currentEditingIndex === null) {
      map.current.getContainer().style.cursor = '';
    }
  }, [isParallelLineMode, isDrawing, editingPointIndex, externalEditPointIndex]);

  // Prevent map dragging when interacting with DTM transparency slider
  useEffect(() => {
    if (!dtmTransparencyControlRef.current || !map.current) return;

    const element = dtmTransparencyControlRef.current;
    
    // Use Leaflet's built-in methods to prevent map interactions
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
    
    // Prevent drag events
    L.DomEvent.on(element, 'mousedown', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'mouseup', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'mousemove', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'touchstart', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'touchend', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'touchmove', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'dblclick', L.DomEvent.stopPropagation);
    L.DomEvent.on(element, 'contextmenu', L.DomEvent.stopPropagation);

    return () => {
      L.DomEvent.off(element, 'mousedown', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'mouseup', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'mousemove', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'touchstart', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'touchend', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'touchmove', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'dblclick', L.DomEvent.stopPropagation);
      L.DomEvent.off(element, 'contextmenu', L.DomEvent.stopPropagation);
    };
  }, [dtmLoaded]);

  // Handle DTM source changes - load and display DTM
  useEffect(() => {
    if (!map.current || !dtmSource) {
      // Remove DTM overlay if source is cleared
      if (dtmImageOverlayRef.current && map.current) {
        map.current.removeLayer(dtmImageOverlayRef.current);
        dtmImageOverlayRef.current = null;
      }
      // Remove DTM boundary if present
      if (dtmBoundaryRef.current && map.current) {
        map.current.removeLayer(dtmBoundaryRef.current);
        dtmBoundaryRef.current = null;
      }
      // Reset file input so it can be used again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setDtmLoaded(false);
      setDtmBounds(null);
      setIsDtmProcessing(false);
      // Keep opacity setting - don't reset it so user preference persists
      return;
    }

    const loadDTM = async () => {
      setDtmLoaded(false); // Reset loading state when starting to load
      setIsDtmProcessing(true);
      try {
        // Extract filename from path
        const filename = dtmSource.split('/').pop();
        if (!filename) {
          setIsDtmProcessing(false);
          return;
        }

        // Fetch raster data
        const response = await fetch(`/api/dtm/${filename}/raster`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || `Failed to load DTM data: ${response.status}`);
        }

        const rasterData = await response.json();
        console.log('DTM raster data received:', {
          width: rasterData.width,
          height: rasterData.height,
          dataLength: rasterData.data?.length,
          min: rasterData.min,
          max: rasterData.max,
          bounds: rasterData.bounds
        });

        const { width, height, data, min, max, bounds, isProjected, epsg, crs } = rasterData;
        
        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new Error('Invalid DTM data: empty or invalid data array');
        }
        
        if (!bounds || !Array.isArray(bounds) || bounds.length !== 4) {
          throw new Error('Invalid DTM bounds');
        }
        
        // Transform projected coordinates to WGS84 (lat/lon) if needed
        let transformedBounds = bounds;
        
        if (isProjected) {
          console.log('DTM uses projected coordinates. Attempting coordinate transformation...');
          console.log('EPSG Code:', epsg);
          console.log('CRS Info:', crs);
          
          // Try to determine source projection from EPSG code
          let sourceProj: string | null = null;
          
          if (epsg) {
            // Use the EPSG code directly
            sourceProj = `EPSG:${epsg}`;
            console.log('Using source projection from EPSG:', sourceProj);
          } else if (crs?.projectedCSType) {
            // Try to use projected CRS type
            sourceProj = `EPSG:${crs.projectedCSType}`;
            console.log('Using source projection from CRS:', sourceProj);
          }
          
          if (!sourceProj) {
            // Default to UTM Zone 36N (EPSG:32636) when no coordinate system is detected
            sourceProj = 'EPSG:32636';
            console.warn('Could not determine EPSG code from GeoTIFF metadata.');
            console.warn('Assuming UTM Zone 36N (EPSG:32636) as default coordinate system.');
          }
          
          if (sourceProj) {
            try {
              // Transform bounds from projected to WGS84
              const [minX, minY, maxX, maxY] = bounds;
              
              console.log(`Transforming from ${sourceProj} to EPSG:4326 (WGS84)...`);
              
              // Transform all four corners
              const topLeft = proj4(sourceProj, 'EPSG:4326', [minX, maxY]);
              const topRight = proj4(sourceProj, 'EPSG:4326', [maxX, maxY]);
              const bottomRight = proj4(sourceProj, 'EPSG:4326', [maxX, minY]);
              const bottomLeft = proj4(sourceProj, 'EPSG:4326', [minX, minY]);
              
              // Create new bounds from transformed coordinates
              const transformedMinX = Math.min(topLeft[0], topRight[0], bottomRight[0], bottomLeft[0]);
              const transformedMinY = Math.min(topLeft[1], topRight[1], bottomRight[1], bottomLeft[1]);
              const transformedMaxX = Math.max(topLeft[0], topRight[0], bottomRight[0], bottomLeft[0]);
              const transformedMaxY = Math.max(topLeft[1], topRight[1], bottomRight[1], bottomLeft[1]);
              
              transformedBounds = [transformedMinX, transformedMinY, transformedMaxX, transformedMaxY];
              
              console.log('Original bounds (projected):', bounds);
              console.log('Transformed bounds (WGS84):', transformedBounds);
              console.log('✅ Coordinate transformation successful!');
            } catch (transformError) {
              console.error('Error transforming coordinates:', transformError);
              console.error('Source projection:', sourceProj);
              alert(`Transform failed: ${transformError instanceof Error ? transformError.message : 'Unknown error'}\nSource projection: ${sourceProj}\nCheck the EPSG in your GeoTIFF.`);
              throw new Error(`Coordinate transformation failed: ${transformError instanceof Error ? transformError.message : 'Unknown error'}`);
            }
          }
        } else {
          console.log('DTM already uses geographic coordinates (WGS84) - no transformation needed');
        }

        // Create canvas to render elevation as image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Create image data
        const imageData = ctx.createImageData(width, height);
        const range = max - min || 1;

        // Convert elevation data to grayscale
        const noDataValue = rasterData.noDataValue;
        for (let i = 0; i < data.length; i++) {
          let elevation = data[i];
          
          // Skip no-data values
          if (noDataValue !== null && noDataValue !== undefined && elevation === noDataValue) {
            elevation = min; // Use min for no-data to render as lowest elevation
          }
          
          if (isNaN(elevation) || !isFinite(elevation)) {
            elevation = min;
          }
          
          const normalized = (elevation - min) / range;
          
          // Grayscale: black (low) -> white (high)
          // Convert normalized value (0-1) to grayscale (0-255)
          const gray = Math.floor(normalized * 255);
          const r = gray;
          const g = gray;
          const b = gray;

          const idx = i * 4;
          imageData.data[idx] = r;     // R
          imageData.data[idx + 1] = g; // G
          imageData.data[idx + 2] = b;  // B
          imageData.data[idx + 3] = 255; // A (fully opaque for better visibility)
        }

        ctx.putImageData(imageData, 0, 0);
        console.log('Canvas rendered, creating image...');

        // Helper function to add DTM layer
        // @ts-ignore
        const addDTMLayer = (img: HTMLImageElement, bounds: number[]) => {
          if (!map.current) {
            console.error('Map not initialized');
            return;
          }

          console.log('Adding DTM layer to map...');
          console.log('Bounds (WGS84):', bounds);

          // Remove existing DTM overlay if present
          if (dtmImageOverlayRef.current) {
            map.current.removeLayer(dtmImageOverlayRef.current);
            dtmImageOverlayRef.current = null;
          }
          // Remove existing DTM boundary if present
          if (dtmBoundaryRef.current) {
            map.current.removeLayer(dtmBoundaryRef.current);
            dtmBoundaryRef.current = null;
          }

          // Get bounds (now in WGS84 lat/lon)
          const [minX, minY, maxX, maxY] = bounds;

          try {
            const imageUrl = canvas.toDataURL();
            console.log('Image URL length:', imageUrl.length);
            console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);

            // Create image overlay bounds in Leaflet format (southwest, northeast)
            const imageBounds: L.LatLngBoundsExpression = [
              [minY, minX], // Southwest (south, west)
              [maxY, maxX]  // Northeast (north, east)
            ];

            // Add image overlay with user-defined opacity (default 90% transparency = 10% opacity)
            dtmImageOverlayRef.current = L.imageOverlay(imageUrl, imageBounds, {
              opacity: dtmOpacity
            }).addTo(map.current);

            // Add black solid stroke boundary rectangle
            dtmBoundaryRef.current = L.rectangle(imageBounds, {
              color: '#000000',
              weight: 2,
              fill: false,
              opacity: 1.0
            }).addTo(map.current);

            console.log('DTM layer added successfully');
            setDtmLoaded(true);
            setDtmBounds(bounds); // Store bounds for the "Fit to DTM" button
            setIsDtmProcessing(false);

            // Fit map to DTM bounds (now in WGS84)
            console.log('Fitting map to DTM bounds (WGS84):', bounds);
            try {
              map.current.fitBounds(imageBounds, {
                padding: [50, 50],
                maxZoom: 18
              });
              console.log('Map fitted to DTM bounds successfully');
            } catch (fitError) {
              console.error('Error fitting map to bounds:', fitError);
              // Fallback: try to center on the middle of the bounds
              const centerLng = (minX + maxX) / 2;
              const centerLat = (minY + maxY) / 2;
              console.log('Falling back to center:', centerLng, centerLat);
              map.current.setView([centerLat, centerLng], 13);
            }
          } catch (sourceError) {
            console.error('Error adding DTM source/layer:', sourceError);
            console.error('Error details:', sourceError);
            setDtmLoaded(false);
            setIsDtmProcessing(false);
            alert(`Can't add DTM: ${sourceError instanceof Error ? sourceError.message : 'Unknown error'}\nSee console for details.`);
          }
        };

        // Convert canvas to image
        const img = new Image();
        img.onload = () => {
          console.log('DTM image loaded successfully, dimensions:', img.width, 'x', img.height);
          console.log('Image src length:', img.src.length);
          
          // Wait for map to be fully loaded
          if (!map.current) {
            console.error('Map not initialized');
            return;
          }

          addDTMLayer(img, transformedBounds);
        };

        img.onerror = (error) => {
          console.error('Error loading DTM image:', error);
          setDtmLoaded(false);
          setIsDtmProcessing(false);
          alert('Could not create DTM image. See console.');
        };

        const dataUrl = canvas.toDataURL();
        console.log('Canvas data URL created, length:', dataUrl.length);
        if (dataUrl.length < 100) {
          console.error('Canvas data URL seems too short, might be empty!');
        }
        img.src = dataUrl;
      } catch (error) {
        console.error('Error loading DTM:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setDtmLoaded(false);
        setIsDtmProcessing(false);
        alert(`Failed to load DTM: ${errorMessage}\nEnsure the file is a valid GeoTIFF.`);
      }
    };

    loadDTM();
  }, [dtmSource]);
  const resetFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const uploadDtmFile = async (file: File) => {
    const allowedExtensions = ['.tif', '.tiff', '.geotiff'];
    const lowerName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some((ext) => lowerName.endsWith(ext));

    if (!hasValidExtension) {
      alert('Upload a GeoTIFF (.tif/.tiff/.geotiff).');
      resetFileInput();
      return;
    }

    if (isUploading) {
      alert('Upload in progress. Please wait.');
      resetFileInput();
      return;
    }

    // Check file size (199 MB = 199 * 1024 * 1024 bytes)
    const maxSizeBytes = 199 * 1024 * 1024; // 199 MB
    if (file.size > maxSizeBytes) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
      alert(`File is ${fileSizeMB} MB (max 199). Use a smaller DTM.`);
      resetFileInput();
      return;
    }

    // Prevent uploading if a DTM is already loaded
    if (dtmLoaded) {
      alert('Unload the current DTM before loading another.');
      resetFileInput();
      return;
    }

    const formData = new FormData();
    formData.append('dtm', file);

    // Reset progress and set uploading state
    setUploadProgress(0);
    setIsUploading(true);

    try {
      // Use XMLHttpRequest to track upload progress
      const xhr = new XMLHttpRequest();

      // Track upload progress
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(percentComplete);
        }
      });

      // Handle completion
      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
              onDtmLoad(data.path, data);
            } else {
              throw new Error(data.error || 'Upload failed');
            }
          } catch (parseError) {
            console.error('Error parsing response:', parseError);
            alert('Failed to parse server response');
          }
        } else {
          try {
            const errorData = JSON.parse(xhr.responseText);
            throw new Error(errorData.error || `Upload failed with status ${xhr.status}`);
          } catch {
            throw new Error(`Upload failed with status ${xhr.status}`);
          }
        }
      });

      const handleUploadComplete = () => {
        setIsUploading(false);
        setUploadProgress(0);
        resetFileInput();
        setIsDragOver(false);
      };

      // Handle errors
      xhr.addEventListener('error', () => {
        console.error('Error uploading DTM:', xhr.statusText);
        alert('Failed to upload DTM file');
      });

      // Handle abort
      xhr.addEventListener('abort', () => {
        setIsUploading(false);
        setUploadProgress(0);
      });

      xhr.addEventListener('loadend', handleUploadComplete);

      // Send request
      xhr.open('POST', '/api/upload-dtm');
      xhr.send(formData);
    } catch (error) {
      console.error('Error uploading DTM:', error);
      alert('Failed to upload DTM file');
      setIsUploading(false);
      setUploadProgress(0);
      resetFileInput();
      setIsDragOver(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadDtmFile(file);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (dtmLoaded || isUploading) {
      return;
    }
    setIsDragOver(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (dtmLoaded || isUploading) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (isUploading) {
      alert('Upload in progress. Please wait.');
      return;
    }
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    uploadDtmFile(file);
  };

  const handleFitToDTM = () => {
    if (!map.current || !dtmBounds) return;
    
    const [minX, minY, maxX, maxY] = dtmBounds;
    try {
      const imageBounds: L.LatLngBoundsExpression = [
        [minY, minX], // Southwest
        [maxY, maxX]  // Northeast
      ];
      map.current.fitBounds(imageBounds, {
        padding: [50, 50],
        maxZoom: 18
      });
    } catch (fitError) {
      console.error('Error fitting map to DTM bounds:', fitError);
      // Fallback: center on the middle of the bounds
      const centerLng = (minX + maxX) / 2;
      const centerLat = (minY + maxY) / 2;
      map.current.setView([centerLat, centerLng], 13);
    }
  };

  const handleDeleteAllPoints = () => {
    if (window.confirm('Delete all points?')) {
      onPathChange([]);
    }
  };

  const handleResetView = () => {
    if (!map.current) return;
    map.current.setView([31.0461, 34.8516], 6); // Israel default
  };

  const handleSetFlightHeight = (pointIndex: number) => {
    const currentPoint = flightPath[pointIndex];
    const currentHeight = currentPoint.height ?? nominalFlightHeight;
    setDialog({
      type: 'height',
      title: `Point ${pointIndex + 1} height`
    });
    setDialogValues({ height: currentHeight.toString(), pointIndex: pointIndex.toString() });
    setDialogError(null);
  };

  const handleCreatePointFromAzimuthDistance = () => {
    if (flightPath.length === 0) {
      alert('Add a point first.');
      return;
    }

    if (!dtmLoaded) {
      alert('Load a DTM first.');
      return;
    }

    setDialog({
      type: 'azimuthDistance',
      title: 'Azimuth + distance'
    });
    setDialogValues({ azimuth: '0', distance: '100' });
    setDialogError(null);
  };

  // Handle DTM opacity change
  const handleDtmOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newOpacity = parseFloat(e.target.value);
    setDtmOpacity(newOpacity);
    
    // Update the DTM overlay opacity if it exists
    if (dtmImageOverlayRef.current) {
      dtmImageOverlayRef.current.setOpacity(newOpacity);
    }
  };

  const handleCreatePointFromCoordinates = () => {
    if (!dtmLoaded) {
      alert('Load a DTM first.');
      return;
    }

    setDialog({
      type: 'coordinates',
      title: 'Add point by coords'
    });
    setDialogValues({
      mode: 'geo',
      lng: '',
      lat: '',
      easting: '',
      northing: '',
      zone: '36',
      hemisphere: 'N'
    });
    setDialogError(null);
  };

  const handleAddUTurn = () => {
    if (!dtmLoaded) {
      alert('Load a DTM first.');
      return;
    }

    if (flightPath.length < 2) {
      alert('Add at least two points first.');
      return;
    }

    setDialog({
      type: 'uTurn',
      title: 'Add U-turn'
    });
    setDialogValues({
      radius: '50',
      distance: '100'
    });
    setDialogError(null);
  };

  const currentBaseIndex = baseMaps.findIndex((entry) => entry.id === activeBaseMapId);
  const nextBaseMap = baseMaps.length > 1
    ? baseMaps[(Math.max(currentBaseIndex, 0) + 1) % baseMaps.length]
    : null;

  const handleDialogSubmit = () => {
    if (!dialog) return;
    setDialogError(null);

    if (dialog.type === 'height') {
      const target = dialogValues.height;
      const height = target ? parseFloat(target) : NaN;
      const index = parseInt(dialogValues.pointIndex || '0', 10);
      if (isNaN(height) || height < 0) {
        setDialogError('Height must be >= 0.');
        return;
      }
      const point = flightPath[index];
      if (!point) {
        setDialogError('Point not found.');
        return;
      }
      onUpdatePoint(index, { ...point, height });
      resetDialog();
        return;
      }

    if (dialog.type === 'azimuthDistance') {
      const azimuth = parseFloat(dialogValues.azimuth || '');
      const distance = parseFloat(dialogValues.distance || '');
      if (isNaN(azimuth) || azimuth < 0 || azimuth >= 360) {
        setDialogError('Azimuth 0-360.');
        return;
      }
      if (isNaN(distance) || distance <= 0) {
        setDialogError('Distance > 0.');
        return;
      }
      const lastPoint = flightPath[flightPath.length - 1];
      const bearing = (azimuth * Math.PI) / 180;
      const newPoint = calculateDestination(lastPoint, bearing, distance);
      if (!isPointWithinBounds(newPoint.lng, newPoint.lat)) {
        setDialogError('Point outside DTM.');
        return;
      }
      onAddPoint(newPoint);
      resetDialog();
        return;
      }

    if (dialog.type === 'parallelOffset') {
      const offset = parseFloat(dialogValues.offset || '');
      const segmentIndex = parseInt(dialogValues.segmentIndex || '-1', 10);
      if (isNaN(offset)) {
        setDialogError('Offset needed.');
        return;
      }
      if (segmentIndex < 0 || segmentIndex >= flightPath.length - 1) {
        setDialogError('Pick segment again.');
        return;
      }
      const segmentStart = flightPath[segmentIndex];
      const segmentEnd = flightPath[segmentIndex + 1];
      const [parallelStart, parallelEnd] = calculateParallelLine(
        segmentStart,
        segmentEnd,
        offset
      );
      if (
        isPointWithinBounds(parallelStart.lng, parallelStart.lat) &&
        isPointWithinBounds(parallelEnd.lng, parallelEnd.lat)
      ) {
        onAddPoints([parallelEnd, parallelStart]);
        setIsParallelLineMode(false);
        resetDialog();
      } else {
        setDialogError('Offset exits DTM.');
      }
      return;
    }

    if (dialog.type === 'coordinates') {
      const mode = dialogValues.mode || 'geo';
      let lng: number | null = null;
      let lat: number | null = null;

      if (mode === 'geo') {
        lng = parseFloat(dialogValues.lng || '');
        lat = parseFloat(dialogValues.lat || '');
        if (isNaN(lng) || isNaN(lat)) {
          setDialogError('Enter numbers.');
          return;
        }
        if (lng < -180 || lng > 180) {
          setDialogError('Lng -180..180.');
          return;
        }
        if (lat < -90 || lat > 90) {
          setDialogError('Lat -90..90.');
          return;
        }
      } else {
        const easting = parseFloat(dialogValues.easting || '');
        const northing = parseFloat(dialogValues.northing || '');
        const zone = parseInt(dialogValues.zone || '', 10);
        const hemisphere = (dialogValues.hemisphere || 'N').toUpperCase();
      if (isNaN(easting) || isNaN(northing) || isNaN(zone)) {
          setDialogError('UTM numbers only.');
        return;
      }
      if (zone < 1 || zone > 60) {
          setDialogError('Zone 1-60.');
        return;
      }
      if (hemisphere !== 'N' && hemisphere !== 'S') {
          setDialogError('Hemisphere N/S.');
        return;
      }
      try {
        const utmProjString = `+proj=utm +zone=${zone} +${hemisphere === 'N' ? 'north' : 'south'} +datum=WGS84 +units=m +no_defs`;
        const wgs84Proj = '+proj=longlat +datum=WGS84 +no_defs';
        const [transformedLng, transformedLat] = proj4(utmProjString, wgs84Proj, [easting, northing]);
        lng = transformedLng;
        lat = transformedLat;
      } catch (transformError) {
        console.error('Error transforming UTM coordinates:', transformError);
          setDialogError('UTM convert failed.');
        return;
      }
    }

      if (lng === null || lat === null) {
        setDialogError('Coordinates missing.');
      return;
    }

      if (!isPointWithinBounds(lng, lat)) {
        setDialogError('Point outside DTM.');
      return;
    }

      onAddPoint({ lng, lat });
      resetDialog();
      return;
    }

    if (dialog.type === 'uTurn') {
      const radius = parseFloat(dialogValues.radius || '');
      const distance = parseFloat(dialogValues.distance || '');
    if (isNaN(radius) || radius === 0) {
        setDialogError('Radius non-zero.');
      return;
    }
      if (isNaN(distance) || distance <= 0) {
        setDialogError('Distance > 0.');
        return;
      }
    const side: UTurnSide = radius > 0 ? 'R' : 'L';
    const radiusMeters = Math.abs(radius);
    const prev = flightPath[flightPath.length - 2];
    const start = flightPath[flightPath.length - 1];
    const numUTurnPoints = 10;
    const maxStartEndDistance = radiusMeters * 2;
      const clampedDistance = Math.min(distance, maxStartEndDistance);
      if (distance > maxStartEndDistance) {
        setDialogError(`Distance capped at ${maxStartEndDistance}m.`);
      }
    const pts = generateUTurnPoints(prev, start, radiusMeters, clampedDistance, numUTurnPoints, side);
    if (pts.length !== numUTurnPoints) {
        setDialogError('Could not build U-turn.');
      return;
    }
    const outOfBounds = pts.find(p => !isPointWithinBounds(p.lng, p.lat));
    if (outOfBounds) {
        setDialogError('U-turn outside DTM.');
      return;
    }
    const startHeight = start.height;
    const uTurnPoints: Coordinate[] =
      startHeight !== undefined
        ? pts.map(p => ({ ...p, height: startHeight }))
        : pts;
    onAddPoints(uTurnPoints);
      resetDialog();
    }
  };

  const renderDialogFields = () => {
    if (!dialog) return null;
    if (dialog.type === 'height') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="height-input">Height (m)</label>
          <input
            id="height-input"
            type="number"
            step="0.1"
            value={dialogValues.height ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, height: e.target.value }))}
            className="quick-modal__input"
          />
          <input type="hidden" value={dialogValues.pointIndex ?? ''} readOnly />
        </>
      );
    }
    if (dialog.type === 'azimuthDistance') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="azimuth-input">
            Azimuth (0-360)
          </label>
          <input
            id="azimuth-input"
            type="number"
            step="0.1"
            value={dialogValues.azimuth ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, azimuth: e.target.value }))}
            className="quick-modal__input"
          />
          <label className="quick-modal__label" htmlFor="distance-input">
            Distance (m)
          </label>
          <input
            id="distance-input"
            type="number"
            step="1"
            value={dialogValues.distance ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, distance: e.target.value }))}
            className="quick-modal__input"
          />
        </>
      );
    }
    if (dialog.type === 'parallelOffset') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="offset-input">
            Offset (m)
            <Tooltip tooltip="Positive = right, negative = left">
              <span className="quick-modal__info" aria-label="Offset direction info">i</span>
            </Tooltip>
          </label>
          <input
            id="offset-input"
            type="number"
            step="1"
            value={dialogValues.offset ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, offset: e.target.value }))}
            className="quick-modal__input"
          />
        </>
      );
    }
    if (dialog.type === 'coordinates') {
      const mode = dialogValues.mode || 'geo';
      return (
        <>
          <div className="quick-modal__segmented">
            <button
              type="button"
              className={`quick-modal__pill ${mode === 'geo' ? 'active' : ''}`}
              onClick={() => setDialogValues((prev) => ({ ...prev, mode: 'geo' }))}
            >
              Lat/Lng
            </button>
            <button
              type="button"
              className={`quick-modal__pill ${mode === 'utm' ? 'active' : ''}`}
              onClick={() => setDialogValues((prev) => ({ ...prev, mode: 'utm' }))}
            >
              UTM
            </button>
          </div>
          {mode === 'geo' ? (
            <>
              <label className="quick-modal__label" htmlFor="lng-input">Longitude</label>
              <input
                id="lng-input"
                type="number"
                step="0.000001"
                value={dialogValues.lng ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, lng: e.target.value }))}
                className="quick-modal__input"
              />
              <label className="quick-modal__label" htmlFor="lat-input">Latitude</label>
              <input
                id="lat-input"
                type="number"
                step="0.000001"
                value={dialogValues.lat ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, lat: e.target.value }))}
                className="quick-modal__input"
              />
            </>
          ) : (
            <>
              <label className="quick-modal__label" htmlFor="easting-input">Easting (m)</label>
              <input
                id="easting-input"
                type="number"
                step="1"
                value={dialogValues.easting ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, easting: e.target.value }))}
                className="quick-modal__input"
              />
              <label className="quick-modal__label" htmlFor="northing-input">Northing (m)</label>
              <input
                id="northing-input"
                type="number"
                step="1"
                value={dialogValues.northing ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, northing: e.target.value }))}
                className="quick-modal__input"
              />
              <div className="quick-modal__split">
                <div>
                  <label className="quick-modal__label" htmlFor="zone-input">Zone</label>
                  <input
                    id="zone-input"
                    type="number"
                    step="1"
                    value={dialogValues.zone ?? ''}
                    onChange={(e) => setDialogValues((prev) => ({ ...prev, zone: e.target.value }))}
                    className="quick-modal__input"
                  />
                </div>
                <div>
                  <label className="quick-modal__label" htmlFor="hemisphere-input">Hem</label>
                  <input
                    id="hemisphere-input"
                    type="text"
                    maxLength={1}
                    value={dialogValues.hemisphere ?? 'N'}
                    onChange={(e) => setDialogValues((prev) => ({ ...prev, hemisphere: e.target.value }))}
                    className="quick-modal__input"
                  />
                </div>
              </div>
            </>
          )}
        </>
      );
    }
    if (dialog.type === 'uTurn') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="radius-input">
            Radius (m)
            <Tooltip tooltip="Positive = right, negative = left">
              <span className="quick-modal__info" aria-label="Radius direction info">i</span>
            </Tooltip>
          </label>
          <input
            id="radius-input"
            type="number"
            step="1"
            value={dialogValues.radius ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, radius: e.target.value }))}
            className="quick-modal__input"
          />
          <label className="quick-modal__label" htmlFor="distance-ut-input">Span (m)</label>
          <input
            id="distance-ut-input"
            type="number"
            step="1"
            value={dialogValues.distance ?? ''}
            onChange={(e) => setDialogValues((prev) => ({ ...prev, distance: e.target.value }))}
            className="quick-modal__input"
          />
        </>
      );
    }
    return null;
  };

  return (
    <div className="map-panel">
      {dialog && (
        <div className="quick-modal__backdrop" role="dialog" aria-modal="true">
          <div className="quick-modal__card">
            <div className="quick-modal__header">
              <div className="quick-modal__title">{dialog.title}</div>
              <button
                type="button"
                className="quick-modal__close"
                onClick={resetDialog}
                aria-label="Close input dialog"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body">
              {renderDialogFields()}
              {dialogError && <div className="quick-modal__error">{dialogError}</div>}
            </div>
            <div className="quick-modal__actions">
              <button type="button" className="btn btn-tertiary" onClick={resetDialog}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleDialogSubmit}>Apply</button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            onDeletePoint(contextMenu.pointIndex);
            setContextMenu(null);
          }}
          onSetHeight={() => {
            handleSetFlightHeight(contextMenu.pointIndex);
            setContextMenu(null);
          }}
        />
      )}
      {(externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex) !== null && (
        <div className="edit-mode-indicator">
          Edit mode: Click on the map to move point {(externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex)! + 1}
        </div>
      )}
      {isParallelLineMode && (
        <div className="edit-mode-indicator">
          Click a line segment to create a parallel line
        </div>
      )}
      <div className="map-controls">
        <div className={`control-group routes-panel ${isRoutesPanelOpen ? 'open' : 'closed'}`}>
          <div className="routes-panel-header">
            <span className="group-title">Routes</span>
            <button
              type="button"
              className="btn btn-tertiary btn-compact"
              onClick={() => setIsRoutesPanelOpen((prev) => !prev)}
              aria-label={isRoutesPanelOpen ? 'Collapse routes panel' : 'Expand routes panel'}
            >
              {isRoutesPanelOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          {isRoutesPanelOpen && (
            <div className="group-columns">
              <div className="group-column route-list">
                {routes.map((route, idx) => (
                  <div
                    key={route.id}
                    className={`route-row ${route.id === activeRouteId ? 'active' : ''} ${editingRouteId === route.id ? 'editing' : ''}`}
                  >
                    <div className="route-main" title="Select active route">
                      <label className="route-radio">
                        <input
                          type="radio"
                          name="active-route"
                          checked={route.id === activeRouteId}
                          onChange={() => onActiveRouteChange(route.id)}
                        />
                        <span
                          className="route-color-dot"
                          style={{ backgroundColor: route.color }}
                          aria-hidden
                        />
                      </label>
                      <span className="route-name-block">
                        <span className="route-index">#{idx + 1}</span>
                        {editingRouteId === route.id ? (
                          <input
                            className="route-name-input"
                            value={editingRouteName}
                            autoFocus
                            onChange={(e) => setEditingRouteName(e.target.value)}
                            onBlur={() => {
                              if (editingRouteId) {
                                onRenameRoute(editingRouteId, editingRouteName);
                              }
                              setEditingRouteId(null);
                              setEditingRouteName('');
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (editingRouteId) {
                                  onRenameRoute(editingRouteId, editingRouteName);
                                }
                                setEditingRouteId(null);
                                setEditingRouteName('');
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingRouteId(null);
                                setEditingRouteName('');
                              }
                            }}
                            placeholder={`Route ${idx + 1}`}
                          />
                        ) : (
                          <button
                            type="button"
                            className="route-name-button"
                            onDoubleClick={() => {
                              setEditingRouteId(route.id);
                              setEditingRouteName(route.name);
                            }}
                            title={`${route.name} (Double-click to rename)`}
                          >
                            <span className="route-name-text">{route.name}</span>
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="route-actions">
                      <label
                        className="route-visibility switch"
                        title={
                          route.id === activeRouteId
                            ? 'Active route stays visible.'
                            : route.visible
                              ? 'Hide route'
                              : 'Show route'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={route.visible}
                          disabled={route.id === activeRouteId}
                          onChange={() => onToggleRouteVisibility(route.id)}
                        />
                        <span className="switch-slider" aria-hidden />
                      </label>
                      <Tooltip tooltip={routes.length <= 1 ? 'Keep at least one route.' : 'Delete route.'}>
                        <button
                          type="button"
                          className="btn btn-destructive btn-icon btn-compact"
                          onClick={() => {
                            if (routes.length <= 1) return;
                            if (window.confirm(`Delete "${route.name}"? Cannot undo.`)) {
                              onDeleteRoute(route.id);
                            }
                          }}
                          disabled={routes.length <= 1}
                          aria-label={`Delete ${route.name}`}
                        >
                          <Icon name="trash" />
                          <span className="sr-only">Delete route</span>
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onAddRoute}
                  aria-label="Add new route"
                >
                  + New Route
                </button>
                <div className="route-bulk-actions">
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    onClick={onShowAllRoutes}
                    disabled={routes.length === 0}
                    aria-label="Show all routes"
                  >
                    Show all
                  </button>
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    onClick={onHideNonActiveRoutes}
                    disabled={routes.length === 0}
                    aria-label="Hide non-active routes"
                  >
                    Show active only
                  </button>
                  <button
                    type="button"
                    className="btn btn-destructive"
                    onClick={() => {
                      if (window.confirm('Reset to one empty route? Removes all routes and points.')) {
                        onResetToSingleRoute();
                      }
                    }}
                    aria-label="Reset to single route"
                  >
                    Reset routes
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="control-group">
          <div className="group-title">Data Management</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <input
                ref={fileInputRef}
                type="file"
                accept=".tif,.tiff,.geotiff"
                onChange={handleFileUpload}
                id="dtm-upload"
                style={{ display: 'none' }}
                disabled={dtmLoaded}
              />
              <Tooltip tooltip={dtmLoaded ? 'Unload current DTM first.' : 'Load DTM (GeoTIFF).'}>
                <label
                  htmlFor="dtm-upload"
                  className={`btn btn-secondary btn-icon ${dtmLoaded ? 'disabled' : ''}`}
                  style={dtmLoaded ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
                  aria-label="Load DTM"
                >
                  <Icon name="upload" />
                  <span className="sr-only">Load DTM</span>
                </label>
              </Tooltip>
              <Tooltip
                tooltip={
                  !dtmSource || !dtmLoaded
                    ? 'No DTM loaded.'
                    : 'Unload DTM and clear routes.'
                }
              >
                <button
                  onClick={onDtmUnload}
                  className="btn btn-destructive btn-icon"
                  disabled={!dtmSource || !dtmLoaded}
                  aria-label="Unload DTM and clear routes"
                  type="button"
                >
                  <Icon name="eject" />
                  <span className="sr-only">Unload DTM and clear routes</span>
                </button>
              </Tooltip>
            </div>
            <div className="group-column group-column-icons">
              <Tooltip tooltip={flightPath.length === 0 ? 'No points to delete.' : 'Clear all points.'}>
                <button
                  onClick={handleDeleteAllPoints}
                  className="btn btn-destructive btn-icon"
                  disabled={flightPath.length === 0}
                  aria-label="Delete all points"
                  type="button"
                >
                  <Icon name="trash" />
                  <span className="sr-only">Delete All Points</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">Planning Options</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={!dtmLoaded ? 'Load a DTM first.' : isDrawing ? 'Stop drawing.' : 'Draw path (click map).'}>
                <button
                  onClick={() => {
                    setIsDrawing(!isDrawing);
                    setEditingPointIndex(null);
                    if (onEditPointIndexChange) {
                      onEditPointIndexChange(null);
                    }
                    setIsParallelLineMode(false);
                  }}
                  className={`btn btn-primary btn-icon ${isDrawing ? 'active' : ''}`}
                  disabled={!dtmLoaded}
                  aria-label={isDrawing ? 'Stop drawing' : 'Draw path'}
                  type="button"
                >
                  <Icon name="pencil" />
                  <span className="sr-only">{isDrawing ? 'Stop Drawing' : 'Draw Path'}</span>
                </button>
              </Tooltip>
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'Load a DTM first.'
                    : flightPath.length < 2
                      ? 'Add 2+ points first.'
                      : isParallelLineMode
                        ? 'Stop parallel line mode.'
                        : 'Parallel line: click a segment, set offset.'
                }
              >
                <button
                  onClick={() => {
                    setIsParallelLineMode(!isParallelLineMode);
                    setIsDrawing(false);
                    setEditingPointIndex(null);
                    if (onEditPointIndexChange) {
                      onEditPointIndexChange(null);
                    }
                  }}
                  className={`btn btn-secondary btn-icon ${isParallelLineMode ? 'active' : ''}`}
                  disabled={!dtmLoaded || flightPath.length < 2}
                  aria-label={isParallelLineMode ? 'Cancel parallel line' : 'Create parallel line'}
                  type="button"
                >
                  <Icon name="parallel" />
                  <span className="sr-only">{isParallelLineMode ? 'Cancel Parallel Line' : 'Create Parallel Line'}</span>
                </button>
              </Tooltip>
            </div>
            <div className="group-column group-column-icons">
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'Load a DTM first.'
                    : flightPath.length === 0
                      ? 'Add a point first.'
                      : 'Add point by azimuth + distance.'
                }
              >
                <button
                  onClick={handleCreatePointFromAzimuthDistance}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length === 0}
                  aria-label="Add point by azimuth and distance"
                  type="button"
                >
                  <Icon name="compass" />
                  <span className="sr-only">Azimuth + Distance</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={!dtmLoaded ? 'Load a DTM first.' : 'Add point by coordinates.'}>
                <button
                  onClick={handleCreatePointFromCoordinates}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded}
                  aria-label="Add point by coordinate"
                  type="button"
                >
                  <Icon name="crosshair" />
                  <span className="sr-only">Point by Coordinate</span>
                </button>
              </Tooltip>
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'Load a DTM first.'
                    : flightPath.length < 2
                      ? 'Add 2+ points first.'
                      : 'Add U-turn with radius + distance.'
                }
              >
                <button
                  onClick={handleAddUTurn}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length < 2}
                  aria-label="Add U-turn"
                  type="button"
                >
                  <Icon name="uturn" />
                  <span className="sr-only">U-turn</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">History</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={flightPath.length === 0 ? 'Draw points first.' : 'Undo (Ctrl+Z).'}>
                <button
                  onClick={onUndo}
                  disabled={!canUndo || flightPath.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="Undo"
                  type="button"
                >
                  <Icon name="undo" />
                  <span className="sr-only">Undo</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={flightPath.length === 0 ? 'Draw points first.' : 'Redo (Ctrl+Y or Ctrl+Shift+Z).'}>
                <button
                  onClick={onRedo}
                  disabled={!canRedo || flightPath.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="Redo"
                  type="button"
                >
                  <Icon name="redo" />
                  <span className="sr-only">Redo</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">View Controls</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={!dtmLoaded ? 'Load a DTM first.' : 'Fit view to DTM.'}>
                <button
                  onClick={handleFitToDTM}
                  className="btn btn-tertiary btn-icon"
                  disabled={!dtmLoaded}
                  aria-label="Fit to DTM"
                  type="button"
                >
                  <Icon name="fit" />
                  <span className="sr-only">Fit to DTM</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="Reset map view to the default extent.">
                <button
                  onClick={handleResetView}
                  className="btn btn-tertiary btn-icon"
                  aria-label="Reset view"
                  type="button"
                >
                  <Icon name="home" />
                  <span className="sr-only">Reset View</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
      <div
        ref={mapContainer}
        className="map-container"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && !isUploading && !isDtmProcessing && (
          <div className="dtm-drop-overlay">
            <div className="dtm-drop-content">
              <Icon name="upload" />
              <div className="dtm-drop-text">
                <div className="dtm-drop-title">Drop DTM GeoTIFF to upload</div>
                <div className="dtm-drop-subtitle">.tif, .tiff, .geotiff • Max 199 MB</div>
              </div>
            </div>
          </div>
        )}
        {isUploading && (
          <div className="upload-progress-overlay">
            <div className="upload-progress-container">
              <div className="upload-progress-label">Uploading DTM: {uploadProgress}%</div>
              <div className="upload-progress-bar">
                <div 
                  className="upload-progress-fill" 
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          </div>
        )}
        {isDtmProcessing && !isUploading && (
          <div className="upload-progress-overlay">
            <div className="loading-spinner" />
          </div>
        )}
        {dtmLoaded && (
          <div 
            ref={dtmTransparencyControlRef}
            className="dtm-transparency-control"
          >
            <label htmlFor="dtm-opacity-slider" className="dtm-opacity-label">
              DTM Transparency: {Math.round((1 - dtmOpacity) * 100)}%
            </label>
            <input
              id="dtm-opacity-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={dtmOpacity}
              onChange={handleDtmOpacityChange}
              className="dtm-opacity-slider"
            />
          </div>
        )}
        {baseMaps.length > 1 && nextBaseMap && (
          <button
            type="button"
            className="basemap-toggle"
            onClick={handleBaseMapButtonClick}
            title={`Switch to ${nextBaseMap.name}`}
          >
            <div 
              className="basemap-preview" 
              style={{
                backgroundImage: `url(${getPreviewTileUrl(nextBaseMap)})`
              }}
            ></div>
          </button>
        )}
      </div>
    </div>
  );
};

export default MapPanel;
