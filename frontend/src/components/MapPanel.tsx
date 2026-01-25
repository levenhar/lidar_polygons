import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { fromArrayBuffer } from 'geotiff';
import { Coordinate, ElevationPoint } from '../App';
import { FlightRoute } from '../hooks/useFlightPath';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import CoordinateTooltip from './CoordinateTooltip';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination, generateUTurnPoints, UTurnSide, calculateDistance, calculateBearing, calculateNextLineSpacing, samplePointsAlongLine } from '../utils/geometry';
import { latLngToUTM } from '../utils/coordinates';
import './MapPanel.css';
import { TileLayerOptions } from 'leaflet';


type TileLayerOptionsWithAgent = TileLayerOptions;

// DTM Options types
interface DTMOption {
  id: string;
  displayName: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface ClipResponse {
  clippedId: string;
  raster: {
    crs: string;
    bbox: number[];
    width: number;
    height: number;
  };
  tilesUrl: string;
  metadataUrl: string;
  dataUrl: string;
}

// AOI selection state
type AOISelectionMethod = 'bbox' | 'polygon' | 'kml';

interface AOIBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface AOIPolygon {
  coordinates: [number, number][]; // [lon, lat] pairs
}

// Unified DTM Loader types
type DtmLoaderStep = 
  | 'source-choice'    // Step 0: Choose between local or server
  | 'local-picker'     // Step 1A: Local file selection
  | 'server-area'      // Step 1B: Server area selection (method + draw)
  | 'server-results';  // Step 2B: List of overlapping DTMs

type DtmSourceType = 'local' | 'server' | null;

interface ViewshedRasterData {
  width: number;
  height: number;
  data: ArrayLike<number>;
  bounds: number[];
  min: number;
  max: number;
  noDataValue: number | null;
  isProjected: boolean;
  crs: string | null;
}

type ColormapStop = { pos: number; color: string };

const VIEWSHED_COLORMAPS: Record<string, { label: string; stops: ColormapStop[] }> = {
  jet: {
    label: 'Jet',
    stops: [
      { pos: 0, color: '#00007f' },
      { pos: 0.35, color: '#00ffff' },
      { pos: 0.5, color: '#ffff00' },
      { pos: 0.65, color: '#ff7f00' },
      { pos: 1, color: '#7f0000' }
    ]
  },
  viridis: {
    label: 'Viridis',
    stops: [
      { pos: 0, color: '#440154' },
      { pos: 0.35, color: '#31688e' },
      { pos: 0.6, color: '#35b779' },
      { pos: 1, color: '#fde725' }
    ]
  },
  plasma: {
    label: 'Plasma',
    stops: [
      { pos: 0, color: '#0d0887' },
      { pos: 0.4, color: '#7e03a8' },
      { pos: 0.7, color: '#f89441' },
      { pos: 1, color: '#f0f921' }
    ]
  },
  inferno: {
    label: 'Inferno',
    stops: [
      { pos: 0, color: '#000004' },
      { pos: 0.35, color: '#420a68' },
      { pos: 0.7, color: '#f1605d' },
      { pos: 1, color: '#fcffa4' }
    ]
  },
  gray: {
    label: 'Gray',
    stops: [
      { pos: 0, color: '#000000' },
      { pos: 1, color: '#ffffff' }
    ]
  }
};

// DTM color palettes
const DTM_COLORMAPS: Record<'gray' | 'jet', { label: string; stops: ColormapStop[] }> = {
  gray: {
    label: 'אפור',
    stops: [
      { pos: 0, color: '#000000' },
      { pos: 1, color: '#ffffff' }
    ]
  },
  jet: {
    label: 'צבעוני',
    stops: [
      { pos: 0, color: '#00007f' },
      { pos: 0.15, color: '#0000ff' },
      { pos: 0.35, color: '#00ffff' },
      { pos: 0.5, color: '#00ff00' },
      { pos: 0.65, color: '#ffff00' },
      { pos: 0.85, color: '#ff0000' },
      { pos: 1, color: '#7f0000' }
    ]
  }
};

const getDtmColorForValue = (
  normalized: number,
  palette: 'gray' | 'jet',
  inverted: boolean
): { r: number; g: number; b: number } => {
  const value = inverted ? 1 - normalized : normalized;
  const stops = DTM_COLORMAPS[palette].stops;
  
  let lower = stops[0];
  let upper = stops[stops.length - 1];
  
  for (let i = 0; i < stops.length - 1; i++) {
    if (value >= stops[i].pos && value <= stops[i + 1].pos) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }
  
  const t = (value - lower.pos) / (upper.pos - lower.pos || 1);
  const c1 = hexToRgb(lower.color);
  const c2 = hexToRgb(upper.color);
  
  return {
    r: Math.round(lerp(c1.r, c2.r, t)),
    g: Math.round(lerp(c1.g, c2.g, t)),
    b: Math.round(lerp(c1.b, c2.b, t))
  };
};

const stripDtmTimestamp = (name: string) => {
  return name.replace(/^\d{10,}-/, '');
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hexToRgb = (hex: string) => {
  const normalized = hex.replace('#', '');
  const bigint = parseInt(normalized, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
};

const getColorForValue = (value: number, min: number, max: number, colormap: string) => {
  const stops = VIEWSHED_COLORMAPS[colormap]?.stops ?? VIEWSHED_COLORMAPS.jet.stops;
  const range = max - min || 1;
  const normalized = Math.min(1, Math.max(0, (value - min) / range));
  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (normalized >= stops[i].pos && normalized <= stops[i + 1].pos) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }
  const t = (normalized - lower.pos) / (upper.pos - lower.pos || 1);
  const c1 = hexToRgb(lower.color);
  const c2 = hexToRgb(upper.color);
  return {
    r: Math.round(lerp(c1.r, c2.r, t)),
    g: Math.round(lerp(c1.g, c2.g, t)),
    b: Math.round(lerp(c1.b, c2.b, t))
  };
};

type IconName =
  | 'upload'
  | 'download'
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
  | 'home'
  | 'folder'
  | 'crop'
  | 'search'
  | 'close'
  | 'rectangle'
  | 'polygon'
  | 'file'
  | 'info'
  | 'tag'
  | 'plus'
  | 'bell'
  | 'vibrate'
  | 'silent'
  | 'checklist'
  | 'checklist-single'
  | 'pin'
  | 'sliders'
  | 'eye'
  | 'eye-off';

type RouteVisibilityMode = 'all' | 'active' | 'custom';

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
    case 'download':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 4v12" />
          <path {...stroke} d="M7 12l5 4 5-4" />
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
    case 'folder':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 7v12a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      );
    case 'crop':
      return (
        <svg {...common}>
          <path {...stroke} d="M6 2v14a2 2 0 002 2h14" />
          <path {...stroke} d="M18 22V8a2 2 0 00-2-2H2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle {...stroke} cx="11" cy="11" r="8" />
          <path {...stroke} d="M21 21l-4.35-4.35" />
        </svg>
      );
    case 'close':
      return (
        <svg {...common}>
          <path {...stroke} d="M18 6L6 18" />
          <path {...stroke} d="M6 6l12 12" />
        </svg>
      );
    case 'rectangle':
      return (
        <svg {...common}>
          <rect {...stroke} x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      );
    case 'polygon':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 3L3 9l3 12h12l3-12z" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path {...stroke} d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path {...stroke} d="M14 2v6h6" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path {...stroke} d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path {...stroke} d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case 'vibrate':
      return (
        <svg {...common}>
          <rect {...stroke} x="7" y="5" width="10" height="14" rx="2" />
          <path {...stroke} d="M5 8a5 5 0 0 1 0 8" />
          <path {...stroke} d="M19 8a5 5 0 0 0 0 8" />
        </svg>
      );
    case 'silent':
      return (
        <svg {...common}>
          <path {...stroke} d="M11 5L6 9H2v6h4l5 4V5z" />
          <line {...stroke} x1="23" y1="9" x2="17" y2="15" />
          <line {...stroke} x1="17" y1="9" x2="23" y2="15" />
        </svg>
      );
    case 'checklist':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 7l2 2 4-4" stroke="#0ea5e9" />
          <path {...stroke} d="M3 12l2 2 4-4" stroke="#0ea5e9" />
          <path {...stroke} d="M3 17l2 2 4-4" stroke="#0ea5e9" />
          <line {...stroke} x1="12" y1="7" x2="21" y2="7" />
          <line {...stroke} x1="12" y1="12" x2="21" y2="12" />
          <line {...stroke} x1="12" y1="17" x2="21" y2="17" />
        </svg>
      );
    case 'checklist-single':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 7l2 2 4-4" stroke="#0ea5e9" />
          <line {...stroke} x1="12" y1="7" x2="21" y2="7" />
          <line {...stroke} x1="12" y1="12" x2="21" y2="12" />
          <line {...stroke} x1="12" y1="17" x2="21" y2="17" />
        </svg>
      );
    case 'tag':
      return (
        <svg {...common}>
          <path {...stroke} d="M20 12l-8 8-10-10V2h8l10 10z" />
          <circle {...stroke} cx="6" cy="6" r="1.5" />
        </svg>
      );
    case 'pin':
      return (
        <svg {...common}>
          <path {...stroke} d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <path {...stroke} d="M10 7v6 M10 10a2 2 0 0 1 4 0v3" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="10" />
          <path {...stroke} d="M12 16v-4" />
          <path {...stroke} d="M12 8h.01" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 5v14" />
          <path {...stroke} d="M5 12h14" />
        </svg>
      );
    case 'sliders':
      return (
        <svg {...common}>
          <line {...stroke} x1="4" y1="21" x2="4" y2="14" />
          <line {...stroke} x1="4" y1="10" x2="4" y2="3" />
          <line {...stroke} x1="12" y1="21" x2="12" y2="12" />
          <line {...stroke} x1="12" y1="8" x2="12" y2="3" />
          <line {...stroke} x1="20" y1="21" x2="20" y2="16" />
          <line {...stroke} x1="20" y1="12" x2="20" y2="3" />
          <line {...stroke} x1="1" y1="14" x2="7" y2="14" />
          <line {...stroke} x1="9" y1="8" x2="15" y2="8" />
          <line {...stroke} x1="17" y1="16" x2="23" y2="16" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...common}>
          <path {...stroke} d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle {...stroke} cx="12" cy="12" r="3" />
        </svg>
      );
    case 'eye-off':
      return (
        <svg {...common}>
          <path {...stroke} d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line {...stroke} x1="1" y1="1" x2="23" y2="23" />
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
  clippedId?: string | null;
  routes: FlightRoute[];
  activeRouteId: string;
  flightPath: Coordinate[];
  climbMarkers: { lat: number; lng: number; label: string; type: 'start' | 'end' }[];
  showClimbLabels: boolean;
  onShowClimbLabelsChange: (show: boolean) => void;
  onPathPointHover: (point: Coordinate | null, distance?: number) => void;
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
  onDtmLoad: (source: string, info?: any, clippedId?: string, options?: {
    sourceType?: 'local' | 'server';
    originalFile?: File;
    serverId?: string;
    serverMetadata?: { displayName?: string; sizeBytes?: number; modifiedAt?: string };
    aoi?: { type: 'bbox' | 'polygon' | 'kml'; bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number }; polygon?: [number, number][] };
  }) => void;
  onDtmUnload: () => void;
  onDisplaySettingsChange?: (settings: { palette: 'gray' | 'jet'; inverted: boolean; opacity: number }) => void;
  initialDisplaySettings?: { palette: 'gray' | 'jet'; inverted: boolean; opacity: number };
  nominalFlightHeight: number;
  overlapPercentage: number;
  fovDegrees: number;
  onUndo: () => void;
  canUndo: boolean;
  editPointIndex?: number | null;
  onEditPointIndexChange?: (index: number | null) => void;
  hoveredElevationPoint?: ElevationPoint | null;
  hoverSource?: 'map' | 'profile' | null;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
  showNextLineSuggestions: boolean;
  onShowNextLineSuggestionsChange: (show: boolean) => void;
  climbRequests?: { endDistance: number; climbAmount: number }[];
  elevationProfile?: ElevationPoint[]; // Elevation profile with planned altitudes
  // Export/Import props
  onExportClick: () => void;
  onImportKML: (file: File) => Promise<void>;
  canExport: boolean;
}

const MapPanel: React.FC<MapPanelProps> = ({
  dtmSource,
  clippedId: propClippedId,
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
  onDisplaySettingsChange,
  initialDisplaySettings,
  nominalFlightHeight,
  overlapPercentage,
  fovDegrees,
  onUndo,
  canUndo,
  climbMarkers,
  onShowClimbLabelsChange,
  showClimbLabels,
  editPointIndex: externalEditPointIndex,
  onEditPointIndexChange,
  hoveredElevationPoint,
  hoverSource,
  showMetadata,
  onShowMetadataChange,
  showNextLineSuggestions,
  onShowNextLineSuggestionsChange,
  climbRequests: _climbRequests = [],
  elevationProfile = [],
  onExportClick,
  onImportKML,
  canExport
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const tileLayerOptionsRef = useRef<TileLayerOptionsWithAgent | null>(null);
  const mapTokenRef = useRef<string | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [showDrawModeNote, setShowDrawModeNote] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const drawModeNoteTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isParallelLineMode, setIsParallelLineMode] = useState(false);
  const [dtmLoaded, setDtmLoaded] = useState(false);
  const [dtmBounds, setDtmBounds] = useState<number[] | null>(null);
  const [dtmOpacity, setDtmOpacity] = useState<number>(initialDisplaySettings?.opacity ?? 0.1); // Default 90% transparency (10% opacity)
  const [dtmColorPalette, setDtmColorPalette] = useState<'gray' | 'jet'>(initialDisplaySettings?.palette ?? 'gray');
  const [dtmColorInverted, setDtmColorInverted] = useState<boolean>(initialDisplaySettings?.inverted ?? false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState<boolean>(false);
  
  // Apply initial display settings when they change (e.g., from project load)
  useEffect(() => {
    if (initialDisplaySettings) {
      setDtmOpacity(initialDisplaySettings.opacity);
      setDtmColorPalette(initialDisplaySettings.palette);
      setDtmColorInverted(initialDisplaySettings.inverted);
    }
  }, [initialDisplaySettings]);
  const displaySettingsButtonRef = useRef<HTMLButtonElement>(null);
  const displaySettingsPopoverRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const climbMarkersRef = useRef<L.Marker[]>([]);
  const flightPathLineRef = useRef<L.Polyline | null>(null);
  const flightPathClickableLineRef = useRef<L.Polyline | null>(null);
  const flightPathBufferRef = useRef<L.Polyline | null>(null);
  const segmentLengthLabelsRef = useRef<L.Marker[]>([]);
  const hoveredPointRef = useRef<number | null>(null);
  const justFinishedDraggingRef = useRef<boolean>(false);
  const lastRightClickTimeRef = useRef<number>(0);
  const dtmImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const dtmBoundaryRef = useRef<L.Rectangle | null>(null);
  const viewshedImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const basemapToggleRef = useRef<HTMLButtonElement | null>(null);
  const routesPanelRef = useRef<HTMLDivElement | null>(null);
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
  const [isInfoMode, setIsInfoMode] = useState<boolean>(false);
  const [cursorElevation, setCursorElevation] = useState<{ elevation: number | null; lat: number; lng: number } | null>(null);
  const elevationQueryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const elevationCacheRef = useRef<Map<string, number | null>>(new Map());
  const dtmRasterDataRef = useRef<{
    width: number;
    height: number;
    data: number[];
    bounds: number[];
    isProjected: boolean;
    crs: string | null;
    noDataValue: number | null;
  } | null>(null);
  // Cache for avgAGL per line segment: key is `${startIndex}-${endIndex}`, value is avgAGL or null if unavailable
  const avgAGLCacheRef = useRef<Map<string, number | null>>(new Map());
  // Track cache invalidation: when flightPath signature changes, clear cache
  const flightPathSignatureRef = useRef<string>('');
  const [viewshedRaster, setViewshedRaster] = useState<ViewshedRasterData | null>(null);
  const [viewshedVisible, setViewshedVisible] = useState(true);
  const [viewshedColormap, setViewshedColormap] = useState('jet');
  const [viewshedOpacity, setViewshedOpacity] = useState(0.75);
  const [isViewshedProcessing, setIsViewshedProcessing] = useState(false);
  const [viewshedJobId, setViewshedJobId] = useState<string | null>(null);
  const [viewshedProgress, setViewshedProgress] = useState(0);
  const [viewshedStatus, setViewshedStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'cancelled'>('idle');
  const [isViewshedRouteModalOpen, setIsViewshedRouteModalOpen] = useState(false);
  const viewshedPollRef = useRef<number | null>(null);
  const viewshedSignatureRef = useRef<string | null>(null);
  const viewshedRouteSnapshotRef = useRef<Coordinate[] | null>(null);
  const pendingViewshedRouteSnapshotRef = useRef<Coordinate[] | null>(null);
  const skipViewshedRoutePromptRef = useRef(false);
  const skipViewshedReplaceConfirmRef = useRef(false);
  const passiveRouteLinesRef = useRef<Record<string, L.Polyline>>({});
  const suggestedLinesRef = useRef<L.Polyline[]>([]);
  const [isRoutesPanelOpen, setIsRoutesPanelOpen] = useState<boolean>(false);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editingRouteName, setEditingRouteName] = useState<string>('');
  const routeVisibilityMode = useMemo<RouteVisibilityMode>(() => {
    if (routes.length === 0) return 'all';
    const allVisible = routes.every((route) => route.visible);
    const activeOnly = routes.every((route) =>
      route.id === activeRouteId ? route.visible : !route.visible
    );
    if (allVisible) return 'all';
    if (activeOnly) return 'active';
    return 'custom';
  }, [routes, activeRouteId]);
  const routeVisibilityLabel = routeVisibilityMode === 'all'
    ? 'הצג הכול'
    : routeVisibilityMode === 'active'
      ? 'פעיל בלבד'
      : 'תצוגה מותאמת';
  const handleCycleRoutesVisibility = useCallback(() => {
    if (routes.length === 0) return;
    if (routeVisibilityMode === 'all') {
      onHideNonActiveRoutes();
      return;
    }
    onShowAllRoutes();
  }, [routeVisibilityMode, onHideNonActiveRoutes, onShowAllRoutes, routes.length]);
  const [dialog, setDialog] = useState<{
    type: 'height' | 'azimuthDistance' | 'coordinates' | 'uTurn' | 'parallelOffset';
    title: string;
  } | null>(null);
  const [dialogValues, setDialogValues] = useState<Record<string, string>>({});
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [isViewshedModalOpen, setIsViewshedModalOpen] = useState(false);
  const [viewshedModalMode, setViewshedModalMode] = useState<'progress' | 'settings' | null>(null);

  // ============================================================================
  // UNIFIED DTM LOADER STATE
  // ============================================================================
  const [dtmLoaderOpen, setDtmLoaderOpen] = useState(false);
  const [dtmLoaderStep, setDtmLoaderStep] = useState<DtmLoaderStep>('source-choice');
  // @ts-ignore - dtmSourceType is used for tracking selected source
  const [dtmSourceType, setDtmSourceType] = useState<DtmSourceType>(null);
  
  // Local file picker state
  const [localFileError, setLocalFileError] = useState<string | null>(null);
  const [isLocalUploading, setIsLocalUploading] = useState(false);
  const [localUploadProgress, setLocalUploadProgress] = useState(0);
  const localFileInputRef = useRef<HTMLInputElement>(null);
  
  // Server DTM options state
  const [dtmOptions, setDtmOptions] = useState<DTMOption[]>([]);
  const [dtmOptionsLoading, setDtmOptionsLoading] = useState(false);
  const [dtmOptionsError, setDtmOptionsError] = useState<string | null>(null);
  const [dtmSearchQuery, setDtmSearchQuery] = useState('');
  const [selectedDtmId, setSelectedDtmId] = useState<string | null>(null);
  const [activeDtmName, setActiveDtmName] = useState<string | null>(null);
  
  // AOI selection state (for server flow)
  const [isAoiSelectionMode, setIsAoiSelectionMode] = useState(false);
  const [aoiSelectionMethod, setAoiSelectionMethod] = useState<AOISelectionMethod | null>(null);
  const [aoiBounds, setAoiBounds] = useState<AOIBounds | null>(null);
  const [aoiPolygon, setAoiPolygon] = useState<AOIPolygon | null>(null);
  const aoiRectRef = useRef<L.Rectangle | null>(null);
  const aoiPolygonRef = useRef<L.Polygon | null>(null);
  const aoiPolygonPointsRef = useRef<[number, number][]>([]); // [lon, lat] pairs during drawing
  const aoiMarkersRef = useRef<L.CircleMarker[]>([]);
  const aoiFirstClickRef = useRef<L.LatLng | null>(null); // For two-click bbox
  const kmlInputRef = useRef<HTMLInputElement | null>(null);
  const [isClipping, setIsClipping] = useState(false);
  const [_activeClippedId, setActiveClippedId] = useState<string | null>(propClippedId || null);
  
  // Legacy modal state (to be removed after migration)
  const [showDtmOptionsModal, setShowDtmOptionsModal] = useState(false);

  const resetDialog = () => {
    setDialog(null);
    setDialogValues({});
    setDialogError(null);
  };

  // Real-time validation function for dialog inputs
  const validateDialogInput = useCallback((type: string, value: string) => {
    if (!value || value.trim() === '') {
      setDialogError(null);
      return;
    }

    const numValue = parseFloat(value);
    const isNaN = Number.isNaN(numValue);

    switch (type) {
      case 'height':
        if (isNaN || numValue < 0 || numValue > 10000) {
          setDialogError('גובה חייב להיות בין 0 ל-10000 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      case 'azimuth':
        if (isNaN || numValue < 0 || numValue > 360) {
          setDialogError('אזימוט חייב להיות בין 0 ל-360 מעלות');
        } else {
          setDialogError(null);
        }
        break;
      case 'distance':
        if (isNaN || numValue < 0.1 || numValue > 100000) {
          setDialogError('מרחק חייב להיות בין 0.1 ל-100000 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      case 'offset':
        if (isNaN || numValue < -10000 || numValue > 10000) {
          setDialogError('היסט חייב להיות בין -10000 ל-10000 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      case 'lng':
        if (isNaN || numValue < -180 || numValue > 180) {
          setDialogError('קו אורך חייב להיות בין -180 ל-180');
        } else {
          setDialogError(null);
        }
        break;
      case 'lat':
        if (isNaN || numValue < -90 || numValue > 90) {
          setDialogError('קו רוחב חייב להיות בין -90 ל-90');
        } else {
          setDialogError(null);
        }
        break;
      case 'easting':
        if (isNaN || numValue < 0 || numValue > 999999) {
          setDialogError('Easting חייב להיות בין 0 ל-999999 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      case 'northing':
        if (isNaN || numValue < 0 || numValue > 10000000) {
          setDialogError('Narthing חייב להיות בין 0 ל-10000000 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      case 'zone':
        const zoneValue = parseInt(value, 10);
        if (Number.isNaN(zoneValue) || zoneValue < 1 || zoneValue > 60) {
          setDialogError('אזור חייב להיות בין 1 ל-60');
        } else {
          setDialogError(null);
        }
        break;
      case 'radius':
        if (isNaN || numValue === 0 || numValue < -1000 || numValue > 1000) {
          setDialogError('רדיוס חייב להיות בין -1000 ל-1000 מטרים (לא אפס)');
        } else {
          setDialogError(null);
        }
        break;
      case 'distance-ut':
        if (isNaN || numValue < 0.1 || numValue > 10000) {
          setDialogError('מרווח חייב להיות בין 0.1 ל-10000 מטרים');
        } else {
          setDialogError(null);
        }
        break;
      default:
        setDialogError(null);
    }
  }, []);

  // ============================================================================
  // UNIFIED DTM LOADER FUNCTIONS
  // ============================================================================

  // Open the unified DTM loader dialog
  const handleOpenDtmLoader = useCallback(() => {
    setDtmLoaderOpen(true);
    setDtmLoaderStep('source-choice');
    setDtmSourceType(null);
    setLocalFileError(null);
    setDtmSearchQuery('');
    setSelectedDtmId(null);
    setDtmOptionsError(null);
  }, []);

  // Close the unified DTM loader and reset state
  const handleCloseDtmLoader = useCallback(() => {
    setDtmLoaderOpen(false);
    setDtmLoaderStep('source-choice');
    setDtmSourceType(null);
    setLocalFileError(null);
    setLocalUploadProgress(0);
    setIsLocalUploading(false);
    setDtmSearchQuery('');
    setSelectedDtmId(null);
    setAoiSelectionMethod(null);
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
    // Clear any AOI shapes on map
    if (aoiRectRef.current && map.current) {
      map.current.removeLayer(aoiRectRef.current);
      aoiRectRef.current = null;
    }
    if (aoiPolygonRef.current && map.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }
    aoiMarkersRef.current.forEach(marker => {
      if (map.current) map.current.removeLayer(marker);
    });
    aoiMarkersRef.current = [];
    
    // Exit AOI selection mode if active
    if (isAoiSelectionMode) {
      setIsAoiSelectionMode(false);
    }
  }, [isAoiSelectionMode]);

  // Handle source choice
  const handleSelectSource = useCallback((source: DtmSourceType) => {
    setDtmSourceType(source);
    if (source === 'local') {
      // Directly trigger file picker dialog
      if (localFileInputRef.current) {
        localFileInputRef.current.click();
      }
    } else if (source === 'server') {
      setDtmLoaderStep('server-area');
    }
  }, []);

  // Go back to source choice
  const handleBackToSourceChoice = useCallback(() => {
    setDtmLoaderStep('source-choice');
    setDtmSourceType(null);
    setLocalFileError(null);
    setDtmSearchQuery('');
    setSelectedDtmId(null);
    setAoiSelectionMethod(null);
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
    // Clear any AOI shapes on map
    if (aoiRectRef.current && map.current) {
      map.current.removeLayer(aoiRectRef.current);
      aoiRectRef.current = null;
    }
    if (aoiPolygonRef.current && map.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }
    aoiMarkersRef.current.forEach(marker => {
      if (map.current) map.current.removeLayer(marker);
    });
    aoiMarkersRef.current = [];
    
    // Exit AOI selection mode if active
    if (isAoiSelectionMode) {
      setIsAoiSelectionMode(false);
    }
  }, [isAoiSelectionMode]);

  // Validate local file (TIF only, <2GB)
  const validateLocalFile = useCallback((file: File): { valid: boolean; error?: string } => {
    const allowedExtensions = ['.tif', '.tiff'];
    const lowerName = file.name.toLowerCase();
    const hasValidExtension = allowedExtensions.some((ext) => lowerName.endsWith(ext));
    
    if (!hasValidExtension) {
      return { valid: false, error: 'You can select TIF files only (.tif, .tiff)' };
    }
    
    const maxSizeBytes = 2 * 1024 * 1024 * 1024; // 2GB
    if (file.size > maxSizeBytes) {
      const fileSizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
      return { valid: false, error: `File is ${fileSizeGB}GB. Maximum allowed size is 2GB.` };
    }
    
    return { valid: true };
  }, []);

  // Handle local file selection
  const handleLocalFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Switch to local-picker step to show progress/errors
    setDtmLoaderStep('local-picker');
    setLocalFileError(null);
    
    const validation = validateLocalFile(file);
    if (!validation.valid) {
      setLocalFileError(validation.error || 'Invalid file');
      if (localFileInputRef.current) {
        localFileInputRef.current.value = '';
      }
      return;
    }
    
    // Upload the file
    handleUploadLocalFile(file);
  }, [validateLocalFile]);

  // Upload local DTM file
  const handleUploadLocalFile = useCallback(async (file: File) => {
    setIsLocalUploading(true);
    setLocalUploadProgress(0);
    setLocalFileError(null);
    
    const formData = new FormData();
    formData.append('dtm', file);
    
    try {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          setLocalUploadProgress(percentComplete);
        }
      });
      
      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
              const uploadedFileName = data.path?.split('/').pop()?.split('\\').pop() || 'Uploaded DTM';
              setActiveDtmName(stripDtmTimestamp(uploadedFileName));
              onDtmLoad(data.path, data, undefined, {
                sourceType: 'local',
                originalFile: file
              });
              handleCloseDtmLoader();
            } else {
              throw new Error(data.error || 'Upload failed');
            }
          } catch (parseError) {
            console.error('Error parsing response:', parseError);
            setLocalFileError('Failed to parse server response');
          }
        } else {
          try {
            const errorData = JSON.parse(xhr.responseText);
            setLocalFileError(errorData.error || `Upload failed with status ${xhr.status}`);
          } catch {
            setLocalFileError(`Upload failed with status ${xhr.status}`);
          }
        }
        setIsLocalUploading(false);
        setLocalUploadProgress(0);
        if (localFileInputRef.current) {
          localFileInputRef.current.value = '';
        }
      });
      
      xhr.addEventListener('error', () => {
        console.error('Error uploading DTM:', xhr.statusText);
        setLocalFileError('Failed to upload DTM file. Please try again.');
        setIsLocalUploading(false);
        setLocalUploadProgress(0);
      });
      
      xhr.addEventListener('abort', () => {
        setIsLocalUploading(false);
        setLocalUploadProgress(0);
      });
      
      xhr.open('POST', '/api/upload-dtm');
      xhr.send(formData);
    } catch (error) {
      console.error('Error uploading DTM:', error);
      setLocalFileError('Failed to upload DTM file. Please try again.');
      setIsLocalUploading(false);
      setLocalUploadProgress(0);
    }
  }, [onDtmLoad, handleCloseDtmLoader]);

  // Fetch available DTM options from the server
  const fetchDtmOptions = useCallback(async () => {
    setDtmOptionsLoading(true);
    setDtmOptionsError(null);
    try {
      const response = await fetch('/api/dtm/options');
      if (!response.ok) {
        throw new Error(`Failed to fetch DTM options: ${response.status}`);
      }
      const data = await response.json();
      setDtmOptions(data.options || []);
    } catch (error) {
      console.error('Error fetching DTM options:', error);
      setDtmOptionsError(error instanceof Error ? error.message : 'Error loading DTM list');
    } finally {
      setDtmOptionsLoading(false);
    }
  }, []);

  // Close DTM options modal (legacy - used by legacy modal rendering)
  const handleCloseDtmOptionsModal = useCallback(() => {
    setShowDtmOptionsModal(false);
    setSelectedDtmId(null);
    setDtmSearchQuery('');
  }, []);

  // Select a DTM and enter AOI selection mode (used in server flow)
  const handleSelectDtm = useCallback((dtmId: string, displayName?: string) => {
    setSelectedDtmId(dtmId);
    // Store the display name for later use when DTM is loaded
    if (displayName) {
      setActiveDtmName(displayName);
    }
    
    // Close the unified loader dialog and enter AOI selection mode
    setDtmLoaderOpen(false);
    setShowDtmOptionsModal(false);
    setIsAoiSelectionMode(true);
    setAoiSelectionMethod(null); // Show method chooser first
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
    // Clear any existing AOI shapes
    if (aoiRectRef.current && map.current) {
      map.current.removeLayer(aoiRectRef.current);
      aoiRectRef.current = null;
    }
    if (aoiPolygonRef.current && map.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }
    // Clear markers
    aoiMarkersRef.current.forEach(marker => {
      if (map.current) map.current.removeLayer(marker);
    });
    aoiMarkersRef.current = [];
  }, []);

  // Cancel AOI selection - returns to unified loader source choice
  const handleCancelAoiSelection = useCallback(() => {
    setIsAoiSelectionMode(false);
    setSelectedDtmId(null);
    setAoiSelectionMethod(null);
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
    // Remove AOI shapes
    if (aoiRectRef.current && map.current) {
      map.current.removeLayer(aoiRectRef.current);
      aoiRectRef.current = null;
    }
    if (aoiPolygonRef.current && map.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }
    // Clear markers
    aoiMarkersRef.current.forEach(marker => {
      if (map.current) map.current.removeLayer(marker);
    });
    aoiMarkersRef.current = [];
    
    // Re-open the unified loader at source choice
    setDtmLoaderOpen(true);
    setDtmLoaderStep('source-choice');
    setDtmSourceType(null);
  }, []);

  // Clip the DTM to the selected AOI
  const handleClipDtm = useCallback(async () => {
    if (!selectedDtmId || (!aoiBounds && !aoiPolygon)) {
      alert('בחר DTM ושרטט אזור עבודה.');
      return;
    }

    setIsClipping(true);
    try {
      // Build AOI object based on selection method
      let aoiPayload: { type: string; crs: string; bbox?: number[]; coordinates?: [number, number][] };
      
      if (aoiPolygon && aoiPolygon.coordinates.length >= 3) {
        // Polygon AOI - close the ring if not already closed
        const coords = [...aoiPolygon.coordinates];
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          coords.push(first);
        }
        aoiPayload = {
          type: 'polygon',
          crs: 'EPSG:4326',
          coordinates: coords
        };
      } else if (aoiBounds) {
        // Bbox AOI
        aoiPayload = {
          type: 'bbox',
          crs: 'EPSG:4326',
          bbox: [aoiBounds.minLon, aoiBounds.minLat, aoiBounds.maxLon, aoiBounds.maxLat]
        };
      } else {
        alert('בחר אזור עבודה תקין.');
        setIsClipping(false);
        return;
      }
      
      const response = await fetch('/api/dtm/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dtmId: selectedDtmId,
          aoi: aoiPayload
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || errorData.error || `Clip failed: ${response.status}`);
      }

      const clipResult: ClipResponse = await response.json();
      
      // Store the clipped ID
      setActiveClippedId(clipResult.clippedId);
      
      // Exit AOI selection mode
      setIsAoiSelectionMode(false);
      setSelectedDtmId(null);
      setAoiSelectionMethod(null);
      setAoiPolygon(null);
      aoiPolygonPointsRef.current = [];
      
      // Remove AOI shapes
      if (aoiRectRef.current && map.current) {
        map.current.removeLayer(aoiRectRef.current);
        aoiRectRef.current = null;
      }
      if (aoiPolygonRef.current && map.current) {
        map.current.removeLayer(aoiPolygonRef.current);
        aoiPolygonRef.current = null;
      }
      // Clear markers
      aoiMarkersRef.current.forEach(marker => {
        if (map.current) map.current.removeLayer(marker);
      });
      aoiMarkersRef.current = [];

      // Notify parent with the clipped DTM info
      // Use the dataUrl as the dtmSource (for raster loading)
      const selectedDtm = dtmOptions.find(d => d.id === selectedDtmId);
      onDtmLoad(clipResult.dataUrl, {
        bounds: {
          minX: clipResult.raster.bbox[0],
          minY: clipResult.raster.bbox[1],
          maxX: clipResult.raster.bbox[2],
          maxY: clipResult.raster.bbox[3]
        },
        resolution: {
          width: clipResult.raster.width,
          height: clipResult.raster.height
        },
        clippedId: clipResult.clippedId,
        crs: clipResult.raster.crs
      }, clipResult.clippedId, {
        sourceType: 'server',
        serverId: selectedDtmId || '',
        serverMetadata: selectedDtm ? {
          displayName: selectedDtm.displayName,
          sizeBytes: selectedDtm.sizeBytes,
          modifiedAt: selectedDtm.modifiedAt
        } : undefined,
        aoi: aoiPolygon ? {
          type: 'polygon',
          polygon: aoiPolygon.coordinates
        } : aoiBounds ? {
          type: 'bbox',
          bbox: {
            minLon: aoiBounds.minLon,
            minLat: aoiBounds.minLat,
            maxLon: aoiBounds.maxLon,
            maxLat: aoiBounds.maxLat
          }
        } : undefined
      });

    } catch (error) {
      console.error('Error clipping DTM:', error);
      alert(`שגיאה בחיתוך DTM: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
    } finally {
      setIsClipping(false);
    }
  }, [selectedDtmId, aoiBounds, aoiPolygon, onDtmLoad]);

  /*
  // Delete clipped DTM from cache
  const deleteClippedDtm = useCallback(async (clippedIdToDelete?: string) => {
    const targetId = clippedIdToDelete || activeClippedId;
    if (!targetId) return;

    try {
      await fetch(`/api/dtm/clipped/${targetId}`, {
        method: 'DELETE'
      });
      console.log(`Deleted clipped DTM: ${targetId}`);
    } catch (error) {
      console.error('Error deleting clipped DTM:', error);
    }
  }, [activeClippedId]);
  */

  // Format file size for display
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }, []);

  // Format date for display
  const formatDate = useCallback((isoDate: string): string => {
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString('he-IL', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoDate;
    }
  }, []);

  // Filter DTM options based on search query
  const filteredDtmOptions = useMemo(() => {
    if (!dtmSearchQuery.trim()) return dtmOptions;
    const query = dtmSearchQuery.toLowerCase();
    return dtmOptions.filter(opt => 
      opt.displayName.toLowerCase().includes(query) ||
      opt.id.toLowerCase().includes(query)
    );
  }, [dtmOptions, dtmSearchQuery]);

  // Fetch DTM options when entering server-area step
  useEffect(() => {
    if (dtmLoaderStep === 'server-area' && dtmOptions.length === 0 && !dtmOptionsLoading) {
      fetchDtmOptions();
    }
  }, [dtmLoaderStep, dtmOptions.length, dtmOptionsLoading, fetchDtmOptions]);

  const activeRoute = routes.find((route) => route.id === activeRouteId) || routes[0];
  const activeRouteColor = activeRoute?.color || '#ff0000';
  const flightPathSignature = useMemo(() => {
    return flightPath
      .map((point) => {
        const height = point.height ?? nominalFlightHeight;
        return `${point.lng.toFixed(7)},${point.lat.toFixed(7)},${height}`;
      })
      .join('|');
  }, [flightPath, nominalFlightHeight]);
  const viewshedGradient = useMemo(() => {
    const stops = VIEWSHED_COLORMAPS[viewshedColormap]?.stops ?? VIEWSHED_COLORMAPS.jet.stops;
    const gradientStops = stops.map((stop) => `${stop.color} ${stop.pos * 100}%`).join(', ');
    return `linear-gradient(to bottom, ${gradientStops})`;
  }, [viewshedColormap]);
  const hasViewshedResult = Boolean(viewshedRaster) || viewshedStatus === 'done';
  const viewshedStatusLabel = useMemo(() => {
    switch (viewshedStatus) {
      case 'running':
        return 'מחשב';
      case 'done':
        return 'מוכן';
      case 'error':
        return 'שגיאה';
      case 'cancelled':
        return 'בוטל';
      default:
        return 'ממתין';
    }
  }, [viewshedStatus]);
  const hoveredUtm = useMemo(() => {
    if (!hoveredElevationPoint) return null;
    return latLngToUTM(hoveredElevationPoint.latitude, hoveredElevationPoint.longitude);
  }, [hoveredElevationPoint]);

  const formatSegmentLength = (meters: number): string => {
    if (!Number.isFinite(meters)) return '—';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    if (meters >= 100) {
      return `${meters.toFixed(0)} m`;
    }
    return `${meters.toFixed(1)} m`;
  };

  const formatSegmentLength = (meters: number): string => {
    if (!Number.isFinite(meters)) return '—';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(2)} km`;
    }
    if (meters >= 100) {
      return `${meters.toFixed(0)} m`;
    }
    return `${meters.toFixed(1)} m`;
  };

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
    if (!mapContainer.current || map.current) return;

    const initializeMap = async () => {
      const response_crs = await fetch('/api/crs')

      if (!response_crs.ok) {
        throw new Error(`Failed to get CRS for maps ${response_crs.status}`);
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
          zoom: 7,
          crs: leafletCrs,
          zoomControl: false // disable default zoom control
          // crs: L.CRS.EPSG4326
        });
        // Add zoom control at bottom-left (use 'bottomright' because RTL flips it)
        L.control.zoom({ position: 'bottomright' }).addTo(map.current);
      }

      // Create options
      const options: TileLayerOptionsWithAgent = {
        maxZoom: 19,
        noWrap: true // prevent repeated world copies when zoomed out
      };
      tileLayerOptionsRef.current = options;

      const response_token = await fetch('/api/token')

      if (!response_token.ok) {
        const errorData = await response_token.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || 'Failed to get token for maps ${response.status}');
      }
      const MAPS_TOKEN = await response_token.json();
      mapTokenRef.current = MAPS_TOKEN.token || '';


      const response_url = await fetch('/api/url')

      if (!response_url.ok) {
        const errorData = await response_url.json().catch(() => ({ error: 'Unknown error' }));
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
    };

    initializeMap();

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

  // Clear hover state when mouse leaves the map container
  useEffect(() => {
    if (!map.current) return;

    const mapContainer = map.current.getContainer();
    const handleMouseLeave = () => {
      setMousePos(null);
      if (hoverSource === 'map') {
        onPathPointHover(null);
      }
      if (isInfoMode) {
        setCursorElevation(null);
      }
    };

    mapContainer.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      mapContainer.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [hoverSource, onPathPointHover, isInfoMode]);

  // Calculate tooltip position to keep it on screen
  useLayoutEffect(() => {
    if (!mousePos || !tooltipRef.current || !showMetadata || !hoveredElevationPoint || hoverSource !== 'map') {
      setTooltipPosition(null);
      return;
    }

    // Use requestAnimationFrame to ensure the tooltip is rendered and measured
    requestAnimationFrame(() => {
      if (!tooltipRef.current) return;
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const padding = 8;
      const offset = 15;

      let left = mousePos.x + offset;
      
      // Check if tooltip would go off the right edge of the screen
      if (left + tooltipRect.width > windowWidth - padding) {
        // Position at the start of the window with padding
        left = padding;
      }

      // Also check if it would go off the left edge (shouldn't happen, but just in case)
      if (left < padding) {
        left = padding;
      }

      setTooltipPosition({ left, top: mousePos.y + offset });
    });
  }, [mousePos, showMetadata, hoveredElevationPoint, hoverSource]);

  // Calculate tooltip position to keep it on screen
  useLayoutEffect(() => {
    if (!mousePos || !tooltipRef.current || !showMetadata || !hoveredElevationPoint || hoverSource !== 'map') {
      setTooltipPosition(null);
      return;
    }

    // Use requestAnimationFrame to ensure the tooltip is rendered and measured
    requestAnimationFrame(() => {
      if (!tooltipRef.current) return;
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const padding = 8;
      const offset = 15;

      let left = mousePos.x + offset;
      
      // Check if tooltip would go off the right edge of the screen
      if (left + tooltipRect.width > windowWidth - padding) {
        // Position at the start of the window with padding
        left = padding;
      }

      // Also check if it would go off the left edge (shouldn't happen, but just in case)
      if (left < padding) {
        left = padding;
      }

      setTooltipPosition({ left, top: mousePos.y + offset });
    });
  }, [mousePos, showMetadata, hoveredElevationPoint, hoverSource]);

  // AOI selection mode handlers
  useEffect(() => {
    if (!map.current || !isAoiSelectionMode || !aoiSelectionMethod) return;

    // Helper to add a marker for polygon points
    const addPolygonMarker = (latlng: L.LatLng, isFirst: boolean = false) => {
      const marker = L.circleMarker(latlng, {
        radius: isFirst ? 8 : 6,
        color: isFirst ? '#ef4444' : '#3b82f6',
        fillColor: isFirst ? '#ef4444' : '#3b82f6',
        fillOpacity: 0.8,
        weight: 2
      }).addTo(map.current!);
      
      if (isFirst) {
        // Make first marker clickable to close polygon
        marker.on('click', () => {
          if (aoiPolygonPointsRef.current.length >= 3) {
            // Close the polygon
            setAoiPolygon({ coordinates: [...aoiPolygonPointsRef.current] });
            // Update polygon style to show completion
            if (aoiPolygonRef.current) {
              aoiPolygonRef.current.setStyle({
                color: '#22c55e',
                dashArray: ''
              });
            }
          }
        });
      }
      
      aoiMarkersRef.current.push(marker);
    };

    // Update the polygon preview
    const updatePolygonPreview = () => {
      if (aoiPolygonPointsRef.current.length < 2) return;
      
      const latlngs = aoiPolygonPointsRef.current.map(([lon, lat]) => [lat, lon] as [number, number]);
      
      if (aoiPolygonRef.current) {
        aoiPolygonRef.current.setLatLngs(latlngs);
      } else {
        aoiPolygonRef.current = L.polygon(latlngs, {
          color: '#3b82f6',
          weight: 2,
          fillColor: '#3b82f6',
          fillOpacity: 0.2,
          dashArray: '5, 5'
        }).addTo(map.current!);
      }
    };

    if (aoiSelectionMethod === 'bbox') {
      // Two-click bounding box mode
      const handleBboxClick = (e: L.LeafletMouseEvent) => {
        if (!aoiFirstClickRef.current) {
          // First click - store the start point
          aoiFirstClickRef.current = e.latlng;
          setAoiBounds(null);
          
          // Create initial rectangle at click point
          if (aoiRectRef.current) {
            map.current!.removeLayer(aoiRectRef.current);
          }
          
          aoiRectRef.current = L.rectangle(
            L.latLngBounds(e.latlng, e.latlng),
            {
              color: '#3b82f6',
              weight: 2,
              fillColor: '#3b82f6',
              fillOpacity: 0.2,
              dashArray: '5, 5'
            }
          ).addTo(map.current!);
        } else {
          // Second click - finalize the bbox
          const start = aoiFirstClickRef.current;
          const end = e.latlng;
          
          const minLat = Math.min(start.lat, end.lat);
          const maxLat = Math.max(start.lat, end.lat);
          const minLon = Math.min(start.lng, end.lng);
          const maxLon = Math.max(start.lng, end.lng);
          
          // Check if area is large enough
          if (Math.abs(maxLat - minLat) < 0.0001 || Math.abs(maxLon - minLon) < 0.0001) {
            // Too small, reset
            if (aoiRectRef.current) {
              map.current!.removeLayer(aoiRectRef.current);
              aoiRectRef.current = null;
            }
            aoiFirstClickRef.current = null;
            setAoiBounds(null);
            return;
          }
          
          setAoiBounds({ minLon, minLat, maxLon, maxLat });
          
          // Update rectangle to final bounds with success style
          if (aoiRectRef.current) {
            aoiRectRef.current.setBounds([[minLat, minLon], [maxLat, maxLon]]);
            aoiRectRef.current.setStyle({
              color: '#22c55e',
              dashArray: ''
            });
          }
          
          aoiFirstClickRef.current = null;
        }
      };

      const handleBboxMouseMove = (e: L.LeafletMouseEvent) => {
        if (!aoiFirstClickRef.current || !aoiRectRef.current) return;
        const bounds = L.latLngBounds(aoiFirstClickRef.current, e.latlng);
        aoiRectRef.current.setBounds(bounds);
      };

      map.current.on('click', handleBboxClick);
      map.current.on('mousemove', handleBboxMouseMove);
      map.current.getContainer().style.cursor = 'crosshair';

      return () => {
        if (map.current) {
          map.current.off('click', handleBboxClick);
          map.current.off('mousemove', handleBboxMouseMove);
          map.current.getContainer().style.cursor = '';
        }
      };
    } else if (aoiSelectionMethod === 'polygon') {
      // Multi-click polygon mode
      const handlePolygonClick = (e: L.LeafletMouseEvent) => {
        const newPoint: [number, number] = [e.latlng.lng, e.latlng.lat];
        
        // Check if clicking near the first point to close the polygon
        if (aoiPolygonPointsRef.current.length >= 3) {
          const firstPoint = aoiPolygonPointsRef.current[0];
          const dist = Math.sqrt(
            Math.pow(e.latlng.lng - firstPoint[0], 2) + 
            Math.pow(e.latlng.lat - firstPoint[1], 2)
          );
          // If within ~500m at equator (0.005 degrees), close the polygon
          if (dist < 0.005) {
            setAoiPolygon({ coordinates: [...aoiPolygonPointsRef.current] });
            if (aoiPolygonRef.current) {
              aoiPolygonRef.current.setStyle({
                color: '#22c55e',
                dashArray: ''
              });
            }
            return;
          }
        }
        
        // Add the new point
        aoiPolygonPointsRef.current.push(newPoint);
        addPolygonMarker(e.latlng, aoiPolygonPointsRef.current.length === 1);
        updatePolygonPreview();
      };

      const handlePolygonDblClick = (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        
        // Close polygon on double-click if we have at least 3 points
        if (aoiPolygonPointsRef.current.length >= 3) {
          setAoiPolygon({ coordinates: [...aoiPolygonPointsRef.current] });
          if (aoiPolygonRef.current) {
            aoiPolygonRef.current.setStyle({
              color: '#22c55e',
              dashArray: ''
            });
          }
        }
      };

      // Disable double-click zoom while drawing
      map.current.doubleClickZoom.disable();
      map.current.on('click', handlePolygonClick);
      map.current.on('dblclick', handlePolygonDblClick);
      map.current.getContainer().style.cursor = 'crosshair';

      return () => {
        if (map.current) {
          map.current.doubleClickZoom.enable();
          map.current.off('click', handlePolygonClick);
          map.current.off('dblclick', handlePolygonDblClick);
          map.current.getContainer().style.cursor = '';
        }
      };
    }
    // KML mode doesn't need map click handlers - it uses file upload
  }, [isAoiSelectionMode, aoiSelectionMethod]);

  // KML file handler
  const handleKmlFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        // Parse KML to extract polygon coordinates
        const parser = new DOMParser();
        const kmlDoc = parser.parseFromString(content, 'text/xml');
        
        // Look for coordinates in Polygon elements
        const coordinatesElements = kmlDoc.getElementsByTagName('coordinates');
        
        if (coordinatesElements.length === 0) {
          alert('לא נמצאו קואורדינטות בקובץ KML');
          return;
        }

        // Get the first coordinates element
        const coordsText = coordinatesElements[0].textContent?.trim() || '';
        const coordPairs = coordsText.split(/\s+/).filter(s => s.length > 0);
        
        const coordinates: [number, number][] = [];
        for (const pair of coordPairs) {
          const [lon, lat] = pair.split(',').map(Number);
          if (!isNaN(lon) && !isNaN(lat)) {
            coordinates.push([lon, lat]);
          }
        }

        if (coordinates.length < 3) {
          alert('הפוליגון בקובץ KML חייב להכיל לפחות 3 נקודות');
          return;
        }

        // Store the polygon
        setAoiPolygon({ coordinates });
        aoiPolygonPointsRef.current = coordinates;

        // Draw the polygon on map
        if (map.current) {
          // Clear existing shapes
          if (aoiPolygonRef.current) {
            map.current.removeLayer(aoiPolygonRef.current);
          }
          aoiMarkersRef.current.forEach(marker => map.current!.removeLayer(marker));
          aoiMarkersRef.current = [];

          const latlngs = coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
          aoiPolygonRef.current = L.polygon(latlngs, {
            color: '#22c55e',
            weight: 2,
            fillColor: '#22c55e',
            fillOpacity: 0.2
          }).addTo(map.current);

          // Zoom to the polygon
          map.current.fitBounds(aoiPolygonRef.current.getBounds(), { padding: [50, 50] });
        }
      } catch (error) {
        console.error('Error parsing KML:', error);
        alert('שגיאה בקריאת קובץ KML');
      }
    };
    reader.readAsText(file);
    
    // Reset input so same file can be selected again
    event.target.value = '';
  }, []);

  // Reset AOI selection (for re-drawing)
  const handleResetAoiSelection = useCallback(() => {
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
    // Clear shapes
    if (aoiRectRef.current && map.current) {
      map.current.removeLayer(aoiRectRef.current);
      aoiRectRef.current = null;
    }
    if (aoiPolygonRef.current && map.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }
    aoiMarkersRef.current.forEach(marker => {
      if (map.current) map.current.removeLayer(marker);
    });
    aoiMarkersRef.current = [];
  }, []);

  // NOTE: Cleanup handlers removed - too aggressive
  // The lease protection system now handles cleanup:
  // - If client stops using DTM, lease expires after 2-5 minutes
  // - DTM can then be cleaned up by scheduled jobs
  // - But it won't be deleted while actively in use
  //
  // If explicit cleanup is needed, it should be done via UI button
  // or when user explicitly unloads the DTM, not on page events.
  // REMOVED: Aggressive cleanup handlers that were deleting DTMs when:
  // - User switches tabs (visibilitychange) 
  // - User navigates away temporarily (pagehide)
  // - Page unloads (beforeunload)
  //
  // These events fire too frequently and can delete DTMs that are still in use.
  // The backend lease protection system will prevent deletion if DTM is in use.

  // Set up click handler for adding points, editing points, and parallel line creation
  useEffect(() => {
    if (!map.current) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      // Skip if in AOI selection mode
      if (isAoiSelectionMode) return;
      
      // If editing a point, move it to the new location
      const currentEditingIndex = externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex;
      if (currentEditingIndex !== null && dtmLoaded) {
        const lng = e.latlng.lng;
        const lat = e.latlng.lat;

        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('נקודה חייבת להישאר בתוך גבולות ה-DTM.');
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
          // Calculate default spacing using shared function for the selected segment with line-specific avgAGL
          const segmentStart = flightPath[closestSegmentIndex];
          const segmentEnd = flightPath[closestSegmentIndex + 1];
          
          // Compute line-specific avgAGL for the selected segment
          const avgAGL = computeAvgAGLForSegment(segmentStart, segmentEnd, closestSegmentIndex, closestSegmentIndex + 1, nominalFlightHeight);
          
          // Use avgAGL if available, otherwise fall back to average height
          const effectiveAGL = avgAGL !== null ? avgAGL : (() => {
            const startHeight = segmentStart.height ?? nominalFlightHeight;
            const endHeight = segmentEnd.height ?? nominalFlightHeight;
            return (startHeight + endHeight) / 2;
          })();
          
          const calculatedSpacing = calculateNextLineSpacing(overlapPercentage, fovDegrees, effectiveAGL);
          const defaultOffset = calculatedSpacing !== null && calculatedSpacing > 0 
            ? calculatedSpacing.toFixed(1) 
            : '50'; // Fallback to 50 if calculation fails
          
          setDialog({
            type: 'parallelOffset',
            title: 'היסט מקביל'
          });
          setDialogValues({
            segmentIndex: closestSegmentIndex.toString(),
            offset: defaultOffset
          });
          setDialogError(null);
        } else {
          alert('לחץ קרוב יותר למקטע קו.');
        }
        return;
      }

      // Otherwise, add new point if drawing
      if (isDrawing && dtmLoaded) {
        // Skip creating a new point if we just finished dragging a point
        if (justFinishedDraggingRef.current) {
          return;
        }

        const lng = e.latlng.lng;
        const lat = e.latlng.lat;

        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('נקודה חייבת להיות בתוך גבולות ה-DTM.');
          return;
        }

        const newPoint: Coordinate = {
          lng,
          lat
        };
        onAddPoint(newPoint);
      }
    };

    const handleContextMenu = (e: L.LeafletMouseEvent) => {
      const now = Date.now();
      const timeSinceLastClick = now - lastRightClickTimeRef.current;
      
      // Check for double right-click (within 500ms)
      if (timeSinceLastClick < 500 && timeSinceLastClick > 0) {
        // Double right-click detected - enable draw mode
        e.originalEvent.preventDefault();
        if (!isDrawing && dtmLoaded) {
          setIsDrawing(true);
        }
        lastRightClickTimeRef.current = 0; // Reset to prevent triple-click from triggering again
        return;
      }
      
      // Update last click time
      lastRightClickTimeRef.current = now;
      
      // Reset timer after 1 second to prevent very old clicks from interfering
      setTimeout(() => {
        if (Date.now() - lastRightClickTimeRef.current > 1000) {
          lastRightClickTimeRef.current = 0;
        }
      }, 1000);
      
      // Exit draw mode on single right-click
      if (isDrawing) {
        e.originalEvent.preventDefault();
        setIsDrawing(false);
      }
    };

    map.current.on('click', handleClick);
    map.current.on('contextmenu', handleContextMenu);

    return () => {
      if (map.current) {
        map.current.off('click', handleClick);
        map.current.off('contextmenu', handleContextMenu);
      }
    };
  }, [isDrawing, isParallelLineMode, dtmLoaded, onAddPoint, onUpdatePoint, isPointWithinBounds, editingPointIndex, flightPath, onAddPoints, isAoiSelectionMode]);

  // Reset info mode when DTM is unloaded or not available
  useEffect(() => {
    if (!dtmSource || !dtmLoaded) {
      setIsInfoMode(false);
      setCursorElevation(null);
      setMousePos(null);
      elevationCacheRef.current.clear();
      dtmRasterDataRef.current = null;
    }
  }, [dtmSource, dtmLoaded]);

  // Client-side elevation calculation function
  const calculateElevationAtPoint = useCallback((lat: number, lng: number): number | null => {
    const rasterData = dtmRasterDataRef.current;
    if (!rasterData) return null;

    const { width, height, data, bounds, noDataValue } = rasterData;
    const [minLon, minLat, maxLon, maxLat] = bounds;

    // Check if point is within bounds
    if (lng < minLon || lng > maxLon || lat < minLat || lat > maxLat) {
      return null;
    }

    // Calculate pixel coordinates
    // Normalize coordinates to 0-1 range
    const xNorm = (lng - minLon) / (maxLon - minLon);
    const yNorm = 1 - (lat - minLat) / (maxLat - minLat); // Invert Y because image coordinates start at top

    // Convert to pixel coordinates
    const col = Math.floor(xNorm * width);
    const row = Math.floor(yNorm * height);

    // Clamp to valid range
    const clampedCol = Math.max(0, Math.min(width - 1, col));
    const clampedRow = Math.max(0, Math.min(height - 1, row));

    // Get elevation value from data array (row-major order)
    const index = clampedRow * width + clampedCol;
    if (index < 0 || index >= data.length) {
      return null;
    }

    const elevation = data[index];

    // Check for no-data values
    if (noDataValue !== null && elevation === noDataValue) {
      return null;
    }

    if (isNaN(elevation) || !isFinite(elevation)) {
      return null;
    }

    return elevation;
  }, []);

  /**
   * Compute average AGL (Altitude Above Ground Level) for a line segment
   * Samples points along the line, queries DTM elevation, and computes AGL = plannedAltitude - DTM elevation
   * @param start Start coordinate of the line segment
   * @param end End coordinate of the line segment
   * @param startIndex Index of start point in flightPath (for caching)
   * @param endIndex Index of end point in flightPath (for caching)
   * @param nominalFlightHeight Default flight height if point doesn't have height property
   * @returns Average AGL in meters, or null if DTM is unavailable or calculation fails
   */
  const computeAvgAGLForSegment = useCallback((
    start: Coordinate,
    end: Coordinate,
    startIndex: number,
    endIndex: number,
    nominalFlightHeight: number
  ): number | null => {
    // Check cache first - include elevation profile signature, entry height, and climb requests in cache key
    // This ensures cache is invalidated when any of these change
    const profileSignature = elevationProfile && elevationProfile.length > 0
      ? elevationProfile
          .filter((_, idx) => idx % Math.max(1, Math.floor(elevationProfile.length / 10)) === 0) // Sample ~10 points
          .map(p => `${p.distance.toFixed(1)}:${(p.plannedAltitude ?? p.baseAltitude ?? 0).toFixed(1)}`)
          .join('|')
      : 'no-profile';
    const climbSignature = _climbRequests.length > 0
      ? _climbRequests.map(c => `${c.endDistance.toFixed(1)}:${c.climbAmount.toFixed(1)}`).join('|')
      : 'no-climbs';
    const cacheKey = `${startIndex}-${endIndex}-${nominalFlightHeight.toFixed(1)}-${climbSignature}-${profileSignature}`;
    
    // Only use cache if elevation profile has planned altitudes (not just base altitudes)
    const hasPlannedAltitudes = elevationProfile && elevationProfile.some(p => p.plannedAltitude !== undefined);
    if (avgAGLCacheRef.current.has(cacheKey) && hasPlannedAltitudes) {
      const cached = avgAGLCacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        console.log(`[avgAGL] Cache hit for segment ${startIndex}-${endIndex}: ${cached !== null ? cached.toFixed(1) + 'm' : 'null'} (profile has planned altitudes)`);
        return cached;
      }
    } else if (avgAGLCacheRef.current.has(cacheKey) && !hasPlannedAltitudes) {
      // Clear cache if we don't have planned altitudes yet (profile might be updating)
      console.log(`[avgAGL] Cache exists but elevation profile lacks planned altitudes - recalculating`);
      avgAGLCacheRef.current.delete(cacheKey);
    }

    // Get point heights
    const startHeight = start.height ?? nominalFlightHeight;
    const endHeight = end.height ?? nominalFlightHeight;
    console.log(`[avgAGL] Computing for segment ${startIndex}-${endIndex}: startHeight=${startHeight}m, endHeight=${endHeight}m, nominalFlightHeight=${nominalFlightHeight}m`);

    // Check if DTM is available
    if (!dtmRasterDataRef.current) {
      console.warn(`[avgAGL] DTM unavailable for segment ${startIndex}-${endIndex} - will use fallback (avg height: ${((startHeight + endHeight) / 2).toFixed(1)}m)`);
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

    console.log(`[avgAGL] DTM available, sampling points for segment ${startIndex}-${endIndex}`);
    console.log(`[avgAGL] Elevation profile status: length=${elevationProfile?.length || 0}, hasPlannedAltitudes=${elevationProfile?.some(p => p.plannedAltitude !== undefined) || false}`);

    // Calculate cumulative distances for the entire flight path to get accurate distance along path
    const cumulativeDistances: number[] = [];
    let totalDist = 0;
    cumulativeDistances.push(0);
    for (let i = 1; i < flightPath.length; i++) {
      const segDist = calculateDistance(flightPath[i - 1], flightPath[i]);
      totalDist += segDist;
      cumulativeDistances.push(totalDist);
    }
    
    // Calculate distance from start of path to start and end of this segment
    const segmentStartDistance = cumulativeDistances[startIndex] || 0;
    const segmentEndDistance = cumulativeDistances[endIndex] || totalDist;
    const segmentLength = segmentEndDistance - segmentStartDistance;

    // Sample points along the line (increase to 50 samples for better accuracy)
    const numSamples = 50;
    const samplePoints = samplePointsAlongLine(start, end, numSamples);
    console.log(`[avgAGL] Sampled ${samplePoints.length} points along segment ${startIndex}-${endIndex} (segment length: ${segmentLength.toFixed(1)}m)`);
    
    const aglValues: number[] = [];
    let validSamples = 0;
    let dtmNullCount = 0;
    let negativeAGLCount = 0;
    let sampleDetails: Array<{ t: number; distance: number; plannedAlt: number; groundElev: number | null; agl: number | null }> = [];

    for (let i = 0; i < samplePoints.length; i++) {
      const point = samplePoints[i];
      const t = samplePoints.length > 1 ? i / (samplePoints.length - 1) : 0; // 0 to 1
      
      // Calculate actual distance along path from start of flight path
      const distanceAlongPath = segmentStartDistance + (segmentLength * t);
      
      // Get planned altitude from elevation profile if available, otherwise interpolate between start and end heights
      let plannedAltitude: number;
      let altitudeSource = 'fallback';
      if (elevationProfile && elevationProfile.length > 0) {
        // Find the two adjacent points in elevation profile for interpolation
        let pointBefore: ElevationPoint | null = null;
        let pointAfter: ElevationPoint | null = null;
        
        for (let j = 0; j < elevationProfile.length - 1; j++) {
          const p1 = elevationProfile[j];
          const p2 = elevationProfile[j + 1];
          if (p1.distance <= distanceAlongPath && p2.distance >= distanceAlongPath) {
            pointBefore = p1;
            pointAfter = p2;
            break;
          }
        }
        
        if (pointBefore && pointAfter) {
          // Interpolate between the two points
          const distRange = pointAfter.distance - pointBefore.distance;
          const distFromBefore = distanceAlongPath - pointBefore.distance;
          const interpolationFactor = distRange > 0 ? distFromBefore / distRange : 0;
          
          // Prefer plannedAltitude, then baseAltitude, then fallback to nominalFlightHeight
          const altBefore = pointBefore.plannedAltitude ?? pointBefore.baseAltitude ?? nominalFlightHeight;
          const altAfter = pointAfter.plannedAltitude ?? pointAfter.baseAltitude ?? nominalFlightHeight;
          plannedAltitude = altBefore + (altAfter - altBefore) * interpolationFactor;
          altitudeSource = pointBefore.plannedAltitude !== undefined || pointAfter.plannedAltitude !== undefined 
            ? 'elevationProfile-planned' 
            : 'elevationProfile-base';
          
          // Debug logging for first and middle samples
          if (i === 0 || i === Math.floor(samplePoints.length / 2)) {
            console.debug(`[avgAGL] Sample ${i}: dist=${distanceAlongPath.toFixed(1)}m, before=${pointBefore.distance.toFixed(1)}m (plannedAlt=${pointBefore.plannedAltitude?.toFixed(1) ?? 'N/A'}, baseAlt=${pointBefore.baseAltitude?.toFixed(1) ?? 'N/A'}), after=${pointAfter.distance.toFixed(1)}m (plannedAlt=${pointAfter.plannedAltitude?.toFixed(1) ?? 'N/A'}, baseAlt=${pointAfter.baseAltitude?.toFixed(1) ?? 'N/A'}), interpolated=${plannedAltitude.toFixed(1)}m (${altitudeSource})`);
          }
        } else {
          // Distance is outside profile range, use closest point
          let closestPoint = elevationProfile[0];
          let minDelta = Math.abs(closestPoint.distance - distanceAlongPath);
          
          for (const profilePoint of elevationProfile) {
            const delta = Math.abs(profilePoint.distance - distanceAlongPath);
            if (delta < minDelta) {
              minDelta = delta;
              closestPoint = profilePoint;
            }
          }
          
          plannedAltitude = closestPoint.plannedAltitude ?? closestPoint.baseAltitude ?? nominalFlightHeight;
          altitudeSource = closestPoint.plannedAltitude !== undefined ? 'elevationProfile-closest-planned' : 'elevationProfile-closest-base';
        }
      } else {
        // No elevation profile: interpolate between start and end heights (both are ASL)
        // Entry height (nominalFlightHeight) is ASL, so startHeight and endHeight are ASL
        plannedAltitude = startHeight + (endHeight - startHeight) * t;
        altitudeSource = 'interpolated-heights';
      }
      
      // Query DTM elevation at this point
      const groundElevation = calculateElevationAtPoint(point.lat, point.lng);
      
      if (groundElevation === null) {
        dtmNullCount++;
        sampleDetails.push({ t, distance: distanceAlongPath, plannedAlt: plannedAltitude, groundElev: null, agl: null });
        continue;
      }
      
      if (!isFinite(groundElevation)) {
        dtmNullCount++;
        sampleDetails.push({ t, distance: distanceAlongPath, plannedAlt: plannedAltitude, groundElev: groundElevation, agl: null });
        continue;
      }
      
      // AGL = plannedAltitude (ASL) - groundElevation (ASL)
      // Both are ASL, so the difference gives AGL
      const agl = plannedAltitude - groundElevation;
      sampleDetails.push({ t, distance: distanceAlongPath, plannedAlt: plannedAltitude, groundElev: groundElevation, agl });
      
      // Log first and last samples for debugging
      if (i === 0 || i === samplePoints.length - 1) {
        console.debug(`[avgAGL] Sample ${i} (t=${t.toFixed(3)}, dist=${distanceAlongPath.toFixed(1)}m): plannedAlt=${plannedAltitude.toFixed(1)}m (${altitudeSource}), groundElev=${groundElevation.toFixed(1)}m, agl=${agl.toFixed(1)}m`);
      }
      
      // Accept any finite AGL value (even negative) - the user's flight path might be below ground
      // which is a valid scenario to detect, but we'll still calculate spacing based on the absolute difference
      if (isFinite(agl)) {
        // Use absolute value of AGL for spacing calculation if negative
        // This handles cases where ground is higher than flight altitude
        const aglForSpacing = agl > 0 ? agl : Math.abs(agl);
        aglValues.push(aglForSpacing);
        validSamples++;
        if (agl <= 0) {
          negativeAGLCount++;
          console.warn(`[avgAGL] Sample ${i} (t=${t.toFixed(2)}, dist=${distanceAlongPath.toFixed(1)}m): Flight below ground - plannedAlt=${plannedAltitude.toFixed(1)}m, groundElev=${groundElevation.toFixed(1)}m, agl=${agl.toFixed(1)}m (using abs value: ${aglForSpacing.toFixed(1)}m)`);
        }
      } else {
        dtmNullCount++;
        console.debug(`[avgAGL] Sample ${i} (t=${t.toFixed(2)}, dist=${distanceAlongPath.toFixed(1)}m): invalid AGL - plannedAlt=${plannedAltitude.toFixed(1)}m, groundElev=${groundElevation.toFixed(1)}m, agl=${agl}`);
      }
    }

    console.log(`[avgAGL] Segment ${startIndex}-${endIndex} analysis:
  - Total samples: ${samplePoints.length}
  - Valid AGL samples: ${validSamples}
  - DTM null/invalid: ${dtmNullCount}
  - Negative AGL: ${negativeAGLCount}
  - Required valid samples: ${Math.ceil(samplePoints.length * 0.5)}`);

    // If we don't have enough valid samples, return null
    const requiredSamples = Math.ceil(samplePoints.length * 0.5);
    if (validSamples < requiredSamples) {
      console.warn(`[avgAGL] Insufficient valid samples for segment ${startIndex}-${endIndex}: ${validSamples}/${samplePoints.length} (need ${requiredSamples}) - will use fallback (avg height: ${((startHeight + endHeight) / 2).toFixed(1)}m)`);
      if (sampleDetails.length > 0 && sampleDetails.length <= 5) {
        console.log(`[avgAGL] Sample details:`, sampleDetails);
      }
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

    // Calculate average AGL
    const avgAGL = aglValues.reduce((sum, agl) => sum + agl, 0) / aglValues.length;
    
    // Calculate min/max AGL for debugging
    const minAGL = Math.min(...aglValues);
    const maxAGL = Math.max(...aglValues);
    
    if (!isFinite(avgAGL) || avgAGL <= 0) {
      console.error(`[avgAGL] Invalid avgAGL for segment ${startIndex}-${endIndex}: ${avgAGL} - will use fallback (avg height: ${((startHeight + endHeight) / 2).toFixed(1)}m)`);
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

    // Only cache if we have planned altitudes - don't cache values calculated without planned altitudes
    const hasPlannedAltitudesForCache = elevationProfile && elevationProfile.some(p => p.plannedAltitude !== undefined);
    if (hasPlannedAltitudesForCache) {
      avgAGLCacheRef.current.set(cacheKey, avgAGL);
      console.log(`[avgAGL] ✓ Segment ${startIndex}-${endIndex}: avgAGL=${avgAGL.toFixed(1)}m (min=${minAGL.toFixed(1)}m, max=${maxAGL.toFixed(1)}m, ${validSamples}/${samplePoints.length} valid samples, elevationProfile.length=${elevationProfile?.length || 0}, CACHED)`);
    } else {
      console.log(`[avgAGL] ✓ Segment ${startIndex}-${endIndex}: avgAGL=${avgAGL.toFixed(1)}m (min=${minAGL.toFixed(1)}m, max=${maxAGL.toFixed(1)}m, ${validSamples}/${samplePoints.length} valid samples, elevationProfile.length=${elevationProfile?.length || 0}, NOT CACHED - no planned altitudes)`);
    }
    
    return avgAGL;
  }, [calculateElevationAtPoint, elevationProfile, flightPath, nominalFlightHeight, _climbRequests]);

  // Invalidate avgAGL cache when flightPath or DTM changes
  useEffect(() => {
    const currentSignature = JSON.stringify(flightPath.map(p => ({ lng: p.lng, lat: p.lat, height: p.height })));
    if (currentSignature !== flightPathSignatureRef.current) {
      avgAGLCacheRef.current.clear();
      flightPathSignatureRef.current = currentSignature;
      console.debug('[avgAGL] Cache invalidated: flightPath changed');
    }
  }, [flightPath]);

  // Invalidate cache when DTM changes
  useEffect(() => {
    avgAGLCacheRef.current.clear();
    console.debug('[avgAGL] Cache invalidated: DTM changed');
  }, [dtmSource, dtmLoaded]);

  // Invalidate cache when elevation profile changes (especially when planned altitudes are added)
  useEffect(() => {
    if (elevationProfile && elevationProfile.length > 0) {
      // Create a signature based on planned altitudes to detect changes
      const profileSignature = elevationProfile
        .filter((_, idx) => idx % Math.max(1, Math.floor(elevationProfile.length / 10)) === 0) // Sample ~10 points
        .map(p => `${p.distance.toFixed(1)}:${(p.plannedAltitude ?? p.baseAltitude ?? 0).toFixed(1)}`)
        .join('|');
      
      const lastSignature = (avgAGLCacheRef.current as any).__lastProfileSignature;
      const hasPlanned = elevationProfile.some(p => p.plannedAltitude !== undefined);
      const lastHadPlanned = (avgAGLCacheRef.current as any).__lastHadPlannedAltitudes;
      
      // Clear cache if:
      // 1. Signature changed (profile data changed)
      // 2. Planned altitudes just became available (was false, now true) - this is critical!
      if (profileSignature !== lastSignature || (hasPlanned && !lastHadPlanned)) {
        avgAGLCacheRef.current.clear();
        (avgAGLCacheRef.current as any).__lastProfileSignature = profileSignature;
        (avgAGLCacheRef.current as any).__lastHadPlannedAltitudes = hasPlanned;
        console.debug(`[avgAGL] Cache invalidated: elevation profile changed (hasPlannedAltitudes=${hasPlanned}, signature changed=${profileSignature !== lastSignature}, plannedAltitudes just added=${hasPlanned && !lastHadPlanned})`);
      }
    } else if (elevationProfile && elevationProfile.length === 0) {
      // Profile cleared
      avgAGLCacheRef.current.clear();
      (avgAGLCacheRef.current as any).__lastProfileSignature = undefined;
      (avgAGLCacheRef.current as any).__lastHadPlannedAltitudes = false;
      console.debug('[avgAGL] Cache invalidated: elevation profile cleared');
    }
  }, [elevationProfile]);

  // Invalidate cache when entry height (nominalFlightHeight) changes
  useEffect(() => {
    avgAGLCacheRef.current.clear();
    console.debug(`[avgAGL] Cache invalidated: entry height (nominalFlightHeight) changed to ${nominalFlightHeight}m`);
  }, [nominalFlightHeight]);

  // Invalidate cache when climb requests change (climb points added/removed/modified)
  useEffect(() => {
    const climbSignature = JSON.stringify(_climbRequests.map(c => ({ endDistance: c.endDistance, climbAmount: c.climbAmount })));
    const lastClimbSignature = (avgAGLCacheRef.current as any).__lastClimbSignature;
    if (climbSignature !== lastClimbSignature) {
      avgAGLCacheRef.current.clear();
      (avgAGLCacheRef.current as any).__lastClimbSignature = climbSignature;
      console.debug(`[avgAGL] Cache invalidated: climb requests changed (count: ${_climbRequests.length})`);
    }
  }, [_climbRequests]);

  // Handle information mode - query elevation on mouse move
  useEffect(() => {
    if (!map.current || !isInfoMode || !dtmSource) {
      setCursorElevation(null);
      return;
    }

    const handleMouseMove = async (e: L.LeafletMouseEvent) => {
      const latlng = e.latlng;
      const lat = latlng.lat;
      const lng = latlng.lng;

      // Check if point is within DTM bounds first
      const withinBounds = isPointWithinBounds(lng, lat);
      if (!withinBounds) {
        setCursorElevation(null);
        setMousePos(null); // Clear mouse position to hide tooltip
        return;
      }

      // Update mouse position for tooltip (use screen coordinates)
      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent) {
        setMousePos({ x: originalEvent.clientX, y: originalEvent.clientY });
      }

      // Round coordinates to reduce cache misses (about 10m precision)
      const roundedLat = Math.round(lat * 10000) / 10000;
      const roundedLng = Math.round(lng * 10000) / 10000;
      const cacheKey = `${roundedLat},${roundedLng}`;
      
      // Check cache first
      if (elevationCacheRef.current.has(cacheKey)) {
        const cachedElevation = elevationCacheRef.current.get(cacheKey);
        setCursorElevation({
          elevation: cachedElevation ?? null,
          lat: lat,
          lng: lng
        });
        return;
      }

      // Debounce elevation queries (increased to 200ms for better performance)
      if (elevationQueryTimeoutRef.current) {
        clearTimeout(elevationQueryTimeoutRef.current);
      }

      elevationQueryTimeoutRef.current = setTimeout(() => {
        // Calculate elevation client-side for instant response
        const elevation = calculateElevationAtPoint(lat, lng);
        
        // Cache the result
        elevationCacheRef.current.set(cacheKey, elevation);
        
        // Limit cache size to prevent memory issues
        if (elevationCacheRef.current.size > 1000) {
          const firstKey = elevationCacheRef.current.keys().next().value;
          if (firstKey !== undefined) {
            elevationCacheRef.current.delete(firstKey);
          }
        }
        
        setCursorElevation({
          elevation: elevation,
          lat: lat,
          lng: lng
        });
      }, 50); // Reduced debounce since calculation is instant
    };

    map.current.on('mousemove', handleMouseMove);

    return () => {
      if (map.current) {
        map.current.off('mousemove', handleMouseMove);
      }
      if (elevationQueryTimeoutRef.current) {
        clearTimeout(elevationQueryTimeoutRef.current);
      }
      setCursorElevation(null);
      // Clear cache when info mode is disabled
      elevationCacheRef.current.clear();
    };
  }, [isInfoMode, dtmSource, propClippedId, isPointWithinBounds, calculateElevationAtPoint]);

  // Update flight path on map
  useEffect(() => {
    if (!map.current) return;

    // Remove existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    climbMarkersRef.current.forEach(marker => marker.remove());
    climbMarkersRef.current = [];

    // Remove existing flight path lines
    if (flightPathLineRef.current) {
      map.current.removeLayer(flightPathLineRef.current);
      flightPathLineRef.current = null;
    }
    if (flightPathClickableLineRef.current) {
      map.current.removeLayer(flightPathClickableLineRef.current);
      flightPathClickableLineRef.current = null;
    }
    if (flightPathBufferRef.current) {
      map.current.removeLayer(flightPathBufferRef.current);
      flightPathBufferRef.current = null;
    }

    // Remove existing segment length labels
    segmentLengthLabelsRef.current.forEach((label) => label.remove());
    segmentLengthLabelsRef.current = [];

    // Remove existing segment length labels
    segmentLengthLabelsRef.current.forEach((label) => label.remove());
    segmentLengthLabelsRef.current = [];

    if (flightPath.length === 0) return;

    // Convert coordinates to Leaflet format (lat, lng)
    const latlngs = flightPath.map(p => [p.lat, p.lng] as [number, number]);

    // Add visual buffer line (footprint) - invisible but keeps size for clickable area calculation
    flightPathBufferRef.current = L.polyline(latlngs, {
      color: activeRouteColor,
      weight: 20,
      opacity: 0, // Hide the buffer as per user request
      interactive: false,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map.current);

    // Add invisible clickable line for line segment selection (wide stroke)
    // We make this interactive and it will also cover the buffer area
    flightPathClickableLineRef.current = L.polyline(latlngs, {
      color: 'transparent',
      weight: 80,
      opacity: 0,
      interactive: true
    }).addTo(map.current);

    // Allow inserting a new vertex by clicking on a line segment.
    // Only works when draw mode is on.
    const handleClickableLineClick = (e: L.LeafletMouseEvent) => {
      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent && originalEvent.button !== 0) return; // left-click only
      if (!dtmLoaded) return;
      if (isParallelLineMode) return;
      
      // Only insert points when draw mode is on
      if (!isDrawing) return;

      // If editing a point via "click to move", don't insert
      const currentEditingIndex =
        externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex;
      if (currentEditingIndex !== null) return;

      // Only allow inserting points in the middle of a line if Shift key is pressed
      if (!originalEvent || !originalEvent.shiftKey) return;

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
        alert('נקודה חייבת להיות בתוך גבולות ה-DTM.');
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

    // Add mousemove handler to flight path to sync with elevation profile
    const handlePathMouseMove = (e: L.LeafletMouseEvent) => {
      if (flightPath.length < 2) return;

      const mousePt = { lng: e.latlng.lng, lat: e.latlng.lat };
      let minSegDist = Infinity;
      let hoveredDistance = 0;
      let bestPoint = mousePt;

      let currentCumulative = 0;
      for (let i = 0; i < flightPath.length - 1; i++) {
        const start = flightPath[i];
        const end = flightPath[i + 1];
        const segmentLen = calculateDistance(start, end);
        const result = findClosestPointOnLine(mousePt, start, end);

        if (result.distance < minSegDist) {
          minSegDist = result.distance;
          hoveredDistance = currentCumulative + result.t * segmentLen;
          bestPoint = {
            lng: start.lng + result.t * (end.lng - start.lng),
            lat: start.lat + result.t * (end.lat - start.lat)
          };
        }
        currentCumulative += segmentLen;
      }

      setMousePos({ x: (e as any).originalEvent.clientX, y: (e as any).originalEvent.clientY });
      onPathPointHover(bestPoint, hoveredDistance);
    };

    flightPathClickableLineRef.current.on('mousemove', handlePathMouseMove);
    flightPathClickableLineRef.current.on('mouseout', (e) => {
      setMousePos(null);
      const originalEvent = (e as any).originalEvent as MouseEvent;
      const relatedTarget = originalEvent?.relatedTarget as HTMLElement;
      if (relatedTarget && (relatedTarget.classList?.contains('flight-point-marker') || relatedTarget.closest?.('.flight-point-marker'))) {
        return;
      }
      onPathPointHover(null);
    });

    // Add flight path line (will be on top visually)
    flightPathLineRef.current = L.polyline(latlngs, {
      color: activeRouteColor,
      weight: 3,
      opacity: 0.8,
      interactive: false // Disable interaction to prevent flickering with the wide clickable layer
    }).addTo(map.current);

    // Add segment length labels at midpoints
    for (let i = 0; i < flightPath.length - 1; i++) {
      const start = flightPath[i];
      const end = flightPath[i + 1];
      const distanceMeters = calculateDistance(start, end);
      const midpointLat = (start.lat + end.lat) / 2;
      const midpointLng = (start.lng + end.lng) / 2;

      const bearingDeg = (calculateBearing(start, end) * 180) / Math.PI;
      const normalizedBearing = ((bearingDeg % 360) + 360) % 360;
      let displayAngle = normalizedBearing <= 270 ? bearingDeg - 90 : bearingDeg + 90;
      // Add extra 180 degree rotation for azimuth between 180-270
      if (normalizedBearing >= 180 && normalizedBearing <= 270) {
        displayAngle += 180;
      }

      const labelIcon = L.divIcon({
        className: 'segment-length-label',
        html: `<span style="transform: translate(-50%, -50%) rotate(${displayAngle}deg);">${formatSegmentLength(distanceMeters)}</span>`
      });

      const labelMarker = L.marker([midpointLat, midpointLng], {
        icon: labelIcon,
        interactive: false,
        zIndexOffset: 500
      }).addTo(map.current!);

      segmentLengthLabelsRef.current.push(labelMarker);
    }

    // Add climb markers (both start and end) with optional labels
    climbMarkers.forEach((climb) => {
      const isStart = climb.type === 'start';
      const iconClass = isStart ? 'climb-marker-dot climb-marker-dot--start' : 'climb-marker-dot';
      const iconHtml = isStart 
        ? '<span class="climb-marker-dot__square"></span>'
        : '<span class="climb-marker-dot__circle"></span>';

      const dotIcon = L.divIcon({
        className: iconClass,
        html: iconHtml,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      const dotMarker = L.marker([climb.lat, climb.lng], {
        icon: dotIcon,
        interactive: false,
        zIndexOffset: 620
      }).addTo(map.current!);

      climbMarkersRef.current.push(dotMarker);

      // Only show labels for end markers
      if (showClimbLabels && !isStart && climb.label) {
        const labelIcon = L.divIcon({
          className: 'climb-marker-label',
          html: `<span class="climb-marker-label__text">${climb.label}</span>`,
          iconSize: [1, 1],
          iconAnchor: [0, -4]
        });

        const labelMarker = L.marker([climb.lat, climb.lng], {
          icon: labelIcon,
          interactive: false,
          zIndexOffset: 610
        }).addTo(map.current!);

        climbMarkersRef.current.push(labelMarker);
      }
    });

    // Force initial update of buffer weight
    setTimeout(() => {
      if (map.current) {
        map.current.fire('zoomend');
      }
    }, 100);

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
        // Only allow dragging when draw mode is on
        if (!isDrawing) return;

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
            // Position change check and warning is now handled in App.tsx via handleUpdatePoint
            // which checks for anchor points and shows the warning modal
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
          alert('לא ניתן להזיז נקודה מחוץ לתיבת התוחם של ה-DTM. הנקודה אופסה למיקום החוקי הקודם.');
        }

        // Set flag to prevent map click handler from creating a new point
        justFinishedDraggingRef.current = true;
        // Reset the flag after a short delay to allow the click event to be ignored
        setTimeout(() => {
          justFinishedDraggingRef.current = false;
        }, 100);
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

      el.addEventListener('mouseleave', (e) => {
        const relatedTarget = (e as any).relatedTarget as HTMLElement;
        if (relatedTarget && (relatedTarget.classList?.contains('leaflet-interactive') || relatedTarget.tagName === 'path')) {
          // Standard check for Leaflet: if we move to the line, don't clear
          // This helps avoid flickering when transitioning between marker and line
          // return; // But we need to clear the marker-specific hover state? 
          // Actually let's just clear, the mousemove on line will pick it up.
        }
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
    activeRouteColor,
    climbMarkers,
    showClimbLabels
  ]);

  // Handle zoom-dependent buffer width
  useEffect(() => {
    if (!map.current) return;

    const updateWeights = () => {
      if (!map.current || !flightPathBufferRef.current || !flightPathClickableLineRef.current) return;

      const center = map.current.getCenter();

      // Calculate pixels per meter at current zoom and latitude
      // We use a small offset to get local scale
      const latlng1 = center;
      const latlng2 = L.latLng(center.lat, center.lng + 0.01);
      const distanceMeters = latlng1.distanceTo(latlng2);
      if (distanceMeters === 0) return;

      const p1 = map.current.latLngToLayerPoint(latlng1);
      const p2 = map.current.latLngToLayerPoint(latlng2);
      const pixels = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
      const pixelsPerMeter = pixels / distanceMeters;

      // LiDAR footprint width = 2 * H * tan(FOV/2)
      const bufferWidthMeters = 2 * nominalFlightHeight * Math.tan((fovDegrees / 2) * Math.PI / 180);
      const weightPixels = bufferWidthMeters * pixelsPerMeter;

      flightPathBufferRef.current.setStyle({ weight: weightPixels });
      // Clickable area should be at least as wide as the buffer, with a generous minimum for usability
      // Increased to 80px for a very smooth "catch" area
      flightPathClickableLineRef.current.setStyle({ weight: Math.max(weightPixels, 80) });
    };

    map.current.on('zoomend', updateWeights);
    map.current.on('moveend', updateWeights);

    // Initial update
    const timer = setTimeout(updateWeights, 150);

    return () => {
      clearTimeout(timer);
      if (map.current) {
        map.current.off('zoomend', updateWeights);
        map.current.off('moveend', updateWeights);
      }
    };
  }, [nominalFlightHeight, fovDegrees, flightPath]);

  // Render suggested parallel lines based on mission parameters
  useEffect(() => {
    if (!map.current) return;

    // Clear previous suggestion overlays
    suggestedLinesRef.current.forEach((line) => {
      map.current?.removeLayer(line);
    });
    suggestedLinesRef.current = [];

    // Don't render if toggle is off
    if (!showNextLineSuggestions) return;

    if (flightPath.length < 2) return;

    for (let i = 0; i < flightPath.length - 1; i++) {
      const start = flightPath[i];
      const end = flightPath[i + 1];
      
      // Compute line-specific avgAGL
      const avgAGL = computeAvgAGLForSegment(start, end, i, i + 1, nominalFlightHeight);
      
      // If avgAGL is unavailable, fall back to average height (old behavior)
      // This ensures suggestions still show even without DTM
      const effectiveAGL = avgAGL !== null ? avgAGL : (() => {
        const startHeight = start.height ?? nominalFlightHeight;
        const endHeight = end.height ?? nominalFlightHeight;
        const fallbackAGL = (startHeight + endHeight) / 2;
        console.log(`[suggestions] Segment ${i}-${i + 1}: avgAGL is null, using fallback AGL=${fallbackAGL.toFixed(1)}m (startHeight=${startHeight}m, endHeight=${endHeight}m)`);
        return fallbackAGL;
      })();

      console.log(`[suggestions] Segment ${i}-${i + 1}: effectiveAGL=${effectiveAGL.toFixed(1)}m (from ${avgAGL !== null ? 'avgAGL' : 'fallback'})`);

      // Use shared spacing calculation function with line-specific avgAGL (or fallback)
      const spacing = calculateNextLineSpacing(overlapPercentage, fovDegrees, effectiveAGL);
      
      if (spacing === null || spacing <= 0) {
        console.warn(`[suggestions] Segment ${i}-${i + 1}: Invalid spacing=${spacing} (overlap=${overlapPercentage}%, fov=${fovDegrees}°, effectiveAGL=${effectiveAGL.toFixed(1)}m), skipping`);
        continue;
      }
      
      console.log(`[suggestions] Segment ${i}-${i + 1}: spacing=${spacing.toFixed(1)}m`);

      [spacing, -spacing].forEach((offset) => {
        const [parallelStart, parallelEnd] = calculateParallelLine(start, end, offset);
        const suggestion = L.polyline(
          [
            [parallelStart.lat, parallelStart.lng],
            [parallelEnd.lat, parallelEnd.lng]
          ],
          {
            color: activeRouteColor,
            weight: 3, // Increased from 2 for better visibility
            opacity: 0.5, // Increased from 0.25 for better visibility
            dashArray: '8 4', // More prominent dash pattern
            interactive: false
          }
        ).addTo(map.current!);

        suggestedLinesRef.current.push(suggestion);
      });
    }
    return () => {
      suggestedLinesRef.current.forEach((line) => {
        map.current?.removeLayer(line);
      });
      suggestedLinesRef.current = [];
    };
  }, [flightPath, overlapPercentage, fovDegrees, nominalFlightHeight, activeRouteColor, showNextLineSuggestions, computeAvgAGLForSegment]);

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
          dashArray: '6 6',
          interactive: false
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

  // Auto-fit map bounds to show all routes when routes are imported/added
  const previousRoutesCountRef = useRef<number>(0);
  useEffect(() => {
    if (!map.current) return;
    
    const currentRoutesCount = routes.filter(route => route.visible && route.points.length >= 2).length;
    
    // Only fit bounds when new routes are added (count increases)
    // Skip if routes count decreased or stayed the same (user might be editing)
    if (currentRoutesCount <= previousRoutesCountRef.current) {
      previousRoutesCountRef.current = currentRoutesCount;
      return;
    }
    
    previousRoutesCountRef.current = currentRoutesCount;
    
    // Collect all visible routes (active + passive)
    const visibleRoutes = routes.filter(route => route.visible && route.points.length >= 2);
    if (visibleRoutes.length === 0) return;

    // Collect all coordinates from all visible routes
    const allCoordinates: L.LatLng[] = [];
    visibleRoutes.forEach(route => {
      route.points.forEach(point => {
        allCoordinates.push(L.latLng(point.lat, point.lng));
      });
    });

    if (allCoordinates.length === 0) return;

    // Create a bounds group and fit map to show all routes
    // Use a small delay to ensure routes are rendered first
    setTimeout(() => {
      if (!map.current) return;
      try {
        const bounds = L.latLngBounds(allCoordinates);
        // Add padding to the bounds
        map.current.fitBounds(bounds, { 
          padding: [50, 50],
          maxZoom: 18 // Don't zoom in too much
        });
        console.log('MapPanel: Fitted bounds to show', visibleRoutes.length, 'route(s)');
      } catch (error) {
        console.warn('Failed to fit bounds to routes:', error);
      }
    }, 100);
  }, [routes, activeRouteId]);

  // Update hovered elevation point marker
  useEffect(() => {
    if (!map.current) return;

    // Remove existing hovered elevation marker
    if (hoveredElevationMarkerRef.current) {
      map.current.removeLayer(hoveredElevationMarkerRef.current);
      hoveredElevationMarkerRef.current = null;
    }

    // Add new marker if there's a hovered elevation point (from either map or profile)
    if (hoveredElevationPoint && (hoverSource === 'map' || hoverSource === 'profile')) {
      const icon = L.divIcon({
        className: 'hovered-elevation-marker',
        html: '<div style="background-color: #9B59B6; width: 14px; height: 14px; border-radius: 50%; border: 2px solid black; box-shadow: 0 0 6px rgba(155,89,182,0.8);"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      hoveredElevationMarkerRef.current = L.marker(
        [hoveredElevationPoint.latitude, hoveredElevationPoint.longitude],
        {
          icon,
          interactive: false // Disable interaction on the hover dot to prevent interaction dead-zones
        }
      ).addTo(map.current);
    }
  }, [hoveredElevationPoint, hoverSource]);

  // Exit drawing mode if DTM is unloaded
  useEffect(() => {
    if (!dtmLoaded && isDrawing) {
      setIsDrawing(false);
    }
    if (!dtmLoaded && isParallelLineMode) {
      setIsParallelLineMode(false);
    }
  }, [dtmLoaded, isDrawing, isParallelLineMode]);

  // Show note when draw mode is turned on
  useEffect(() => {
    // Clear any existing timers
    if (drawModeNoteTimerRef.current) {
      clearTimeout(drawModeNoteTimerRef.current);
      drawModeNoteTimerRef.current = null;
    }

    if (isDrawing) {
      setIsFadingOut(false);
      setShowDrawModeNote(true);
      drawModeNoteTimerRef.current = setTimeout(() => {
        setIsFadingOut(true);
        drawModeNoteTimerRef.current = setTimeout(() => {
          setShowDrawModeNote(false);
          setIsFadingOut(false);
          drawModeNoteTimerRef.current = null;
        }, 300); // Fade out duration
      }, 3000); // Show for 3 seconds before fading
    } else {
      setIsFadingOut(false);
      setShowDrawModeNote(false);
    }

    return () => {
      if (drawModeNoteTimerRef.current) {
        clearTimeout(drawModeNoteTimerRef.current);
        drawModeNoteTimerRef.current = null;
      }
    };
  }, [isDrawing]);

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

  // Prevent display settings popover clicks from creating points in draw mode
  useEffect(() => {
    if (!displaySettingsPopoverRef.current || !map.current) return;

    const element = displaySettingsPopoverRef.current;

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
  }, [displaySettingsOpen]);

  // Prevent display settings button clicks from creating points in draw mode
  useEffect(() => {
    if (!displaySettingsButtonRef.current) return;

    const element = displaySettingsButtonRef.current;

    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
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
  }, []);

  // Prevent basemap toggle clicks from creating points in draw mode
  useEffect(() => {
    if (!basemapToggleRef.current) return;

    const element = basemapToggleRef.current;

    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
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
  }, [baseMaps.length]);

  // Prevent routes panel clicks from creating points in draw mode
  useEffect(() => {
    if (!routesPanelRef.current) return;

    const element = routesPanelRef.current;

    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
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
  }, []);

  // Handle outside click and ESC to close display settings popover
  useEffect(() => {
    if (!displaySettingsOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        displaySettingsPopoverRef.current &&
        !displaySettingsPopoverRef.current.contains(target) &&
        displaySettingsButtonRef.current &&
        !displaySettingsButtonRef.current.contains(target)
      ) {
        setDisplaySettingsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDisplaySettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [displaySettingsOpen]);

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
      setActiveDtmName(null);
      // Keep opacity setting - don't reset it so user preference persists
      return;
    }

    if (!activeDtmName) {
      const sourceName = dtmSource.split('/').pop()?.split('\\').pop();
      if (sourceName) {
        setActiveDtmName(stripDtmTimestamp(sourceName));
      }
    }

    const loadDTM = async () => {
      setDtmLoaded(false); // Reset loading state when starting to load
      setIsDtmProcessing(true);
      try {
        // Check if dtmSource is a clipped DTM API path or a filename
        let rasterUrl: string;
        if (dtmSource.startsWith('/api/dtm/clipped/')) {
          // For clipped DTMs, dtmSource is already the API endpoint path (e.g., /api/dtm/clipped/{clippedId}/raster)
          rasterUrl = dtmSource;
          console.log('Loading clipped DTM from API path:', rasterUrl);
        } else {
          // For uploaded DTMs, extract filename and construct API path
          const filename = dtmSource.split('/').pop();
          if (!filename) {
            setIsDtmProcessing(false);
            return;
          }
          rasterUrl = `/api/dtm/${filename}/raster`;
          console.log('Loading uploaded DTM from filename:', filename, 'API path:', rasterUrl);
        }

        // Fetch raster data
        const response = await fetch(rasterUrl);
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
        // Note: Clipped DTMs already have bounds in WGS84 (transformed by backend), so skip transformation
        const isClippedDtm = dtmSource.startsWith('/api/dtm/clipped/');
        let transformedBounds = bounds;

        if (isClippedDtm) {
          console.log('Clipped DTM - bounds already in WGS84 (transformed by backend), skipping transformation');
        }

        if (isProjected && !isClippedDtm) {
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

        // Store raster data for client-side elevation calculation
        dtmRasterDataRef.current = {
          width,
          height,
          data,
          bounds: transformedBounds,
          isProjected: isProjected || false,
          crs: crs || (epsg ? `EPSG:${epsg}` : null),
          noDataValue: rasterData.noDataValue ?? null
        };

        // Create canvas to render elevation as image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Create image data
        const imageData = ctx.createImageData(width, height);
        const range = max - min || 1;

        // Convert elevation data to colored image using current palette settings
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

          const normalized = Math.min(1, Math.max(0, (elevation - min) / range));

          // Use palette color function
          const { r, g, b } = getDtmColorForValue(normalized, dtmColorPalette, dtmColorInverted);

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
          alert('לא ניתן ליצור תמונת DTM. ראה קונסולה.');
        };

        const dataUrl = canvas.toDataURL();
        console.log('Canvas data URL created, length:', dataUrl.length);
        if (dataUrl.length < 100) {
          console.error('Canvas data URL seems too short, might be empty!');
        }
        img.src = dataUrl;
      } catch (error) {
        console.error('Error loading DTM:', error);
        const errorMessage = error instanceof Error ? error.message : 'שגיאה לא ידועה';
        setDtmLoaded(false);
        setIsDtmProcessing(false);
        alert(`טעינת DTM נכשלה: ${errorMessage}\nוודא שהקובץ הוא GeoTIFF תקין.`);
      }
    };

    loadDTM();
  }, [dtmSource]);

  // Re-render DTM overlay when palette or invert settings change
  useEffect(() => {
    if (!map.current || !dtmLoaded || !dtmRasterDataRef.current || !dtmBounds) return;

    const { width, height, data, bounds, noDataValue } = dtmRasterDataRef.current;
    
    // Recalculate min/max from cached data
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (noDataValue !== null && noDataValue !== undefined && val === noDataValue) continue;
      if (isNaN(val) || !isFinite(val)) continue;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    if (!isFinite(min) || !isFinite(max)) return;
    
    const range = max - min || 1;

    // Create canvas to render elevation as image
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create image data
    const imageData = ctx.createImageData(width, height);

    // Convert elevation data to colored image using current palette settings
    for (let i = 0; i < data.length; i++) {
      let elevation = data[i];

      if (noDataValue !== null && noDataValue !== undefined && elevation === noDataValue) {
        elevation = min;
      }

      if (isNaN(elevation) || !isFinite(elevation)) {
        elevation = min;
      }

      const normalized = Math.min(1, Math.max(0, (elevation - min) / range));
      const { r, g, b } = getDtmColorForValue(normalized, dtmColorPalette, dtmColorInverted);

      const idx = i * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);

    // Update the image overlay
    const [minX, minY, maxX, maxY] = bounds;
    const imageBounds: L.LatLngBoundsExpression = [
      [minY, minX],
      [maxY, maxX]
    ];

    // Remove existing overlay
    if (dtmImageOverlayRef.current) {
      map.current.removeLayer(dtmImageOverlayRef.current);
    }

    // Add new overlay with updated colors
    const imageUrl = canvas.toDataURL();
    dtmImageOverlayRef.current = L.imageOverlay(imageUrl, imageBounds, {
      opacity: dtmOpacity
    }).addTo(map.current);

    // Ensure the DTM layer is below route lines
    if (dtmImageOverlayRef.current) {
      dtmImageOverlayRef.current.bringToBack();
    }
    if (dtmBoundaryRef.current) {
      dtmBoundaryRef.current.bringToBack();
    }
  }, [dtmColorPalette, dtmColorInverted, dtmLoaded, dtmBounds, dtmOpacity]);

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
      alert('העלה קובץ GeoTIFF (.tif/.tiff/.geotiff).');
      resetFileInput();
      return;
    }

    if (isUploading) {
      alert('העלאה מתבצעת. אנא המתן.');
      resetFileInput();
      return;
    }

    // Check file size (2 GB = 2048 * 1024 * 1024 bytes)
    const maxSizeBytes = 2048 * 1024 * 1024; // 2 GB
    if (file.size > maxSizeBytes) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(0);
      alert(`הקובץ הוא ${fileSizeMB} MB (מקסימום 2048). השתמש ב-DTM קטן יותר.`);
      resetFileInput();
      return;
    }

    // Prevent uploading if a DTM is already loaded
    if (dtmLoaded) {
      alert('הסר את ה-DTM הנוכחי לפני טעינת אחר.');
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
              // Extract filename from path for display
              const uploadedFileName = data.path?.split('/').pop()?.split('\\').pop() || 'Uploaded DTM';
              setActiveDtmName(stripDtmTimestamp(uploadedFileName));
              onDtmLoad(data.path, data);
            } else {
              throw new Error(data.error || 'Upload failed');
            }
          } catch (parseError) {
            console.error('Error parsing response:', parseError);
            alert('ניתוח תגובת השרת נכשל');
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
        alert('העלאת קובץ DTM נכשלה');
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
      alert('העלאת קובץ DTM נכשלה');
      setIsUploading(false);
      setUploadProgress(0);
      resetFileInput();
      setIsDragOver(false);
    }
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
      alert('העלאה מתבצעת. אנא המתן.');
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
    if (window.confirm('למחוק את כל הנקודות?')) {
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
      title: `גובה נקודה ${pointIndex + 1}`
    });
    setDialogValues({ height: currentHeight.toString(), pointIndex: pointIndex.toString() });
    setDialogError(null);
  };

  const handleCreatePointFromAzimuthDistance = () => {
    if (flightPath.length === 0) {
      alert('הוסף נקודה תחילה.');
      return;
    }

    if (!dtmLoaded) {
      alert('טען DTM תחילה.');
      return;
    }

    setDialog({
      type: 'azimuthDistance',
      title: 'אזימוט + מרחק'
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
    
    // Notify parent of display settings change
    onDisplaySettingsChange?.({
      palette: dtmColorPalette,
      inverted: dtmColorInverted,
      opacity: newOpacity
    });
  };

  const handleViewshedOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newOpacity = parseFloat(e.target.value);
    setViewshedOpacity(newOpacity);

    if (viewshedImageOverlayRef.current) {
      viewshedImageOverlayRef.current.setOpacity(newOpacity);
    }
  };

  const clearViewshedOverlay = useCallback(() => {
    if (viewshedImageOverlayRef.current && map.current) {
      map.current.removeLayer(viewshedImageOverlayRef.current);
      viewshedImageOverlayRef.current = null;
    }
  }, []);

  const stopViewshedPolling = useCallback(() => {
    if (viewshedPollRef.current !== null) {
      window.clearInterval(viewshedPollRef.current);
      viewshedPollRef.current = null;
    }
  }, []);

  const renderViewshedOverlay = useCallback(() => {
    if (!map.current || !viewshedRaster || !viewshedVisible) {
      clearViewshedOverlay();
      return;
    }

    const { width, height, data, bounds, min, max, noDataValue } = viewshedRaster;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.createImageData(width, height);
    const alpha = 220;
    for (let i = 0; i < data.length; i++) {
      let value = Number(data[i]);
      if (noDataValue !== null && noDataValue !== undefined && value === noDataValue) {
        const idx = i * 4;
        imageData.data[idx] = 0;
        imageData.data[idx + 1] = 0;
        imageData.data[idx + 2] = 0;
        imageData.data[idx + 3] = 0;
        continue;
      }
      if (!Number.isFinite(value)) {
        value = min;
      }
      const { r, g, b } = getColorForValue(value, min, max, viewshedColormap);
      const idx = i * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = alpha;
    }

    ctx.putImageData(imageData, 0, 0);
    const imageUrl = canvas.toDataURL();

    const [minX, minY, maxX, maxY] = bounds;
    const imageBounds: L.LatLngBoundsExpression = [
      [minY, minX],
      [maxY, maxX]
    ];

    clearViewshedOverlay();
    viewshedImageOverlayRef.current = L.imageOverlay(imageUrl, imageBounds, {
      opacity: viewshedOpacity
    }).addTo(map.current);
  }, [clearViewshedOverlay, viewshedRaster, viewshedVisible, viewshedColormap, viewshedOpacity]);

  const loadViewshedFromArrayBuffer = useCallback(async (arrayBuffer: ArrayBuffer, signature?: string) => {
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();

    const width = image.getWidth();
    const height = image.getHeight();
    const raster = await image.readRasters({ interleave: true });
    const rasterData = Array.isArray(raster) ? raster[0] : raster;
    const noDataValue = image.getGDALNoData();

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < rasterData.length; i++) {
      const value = Number(rasterData[i]);
      if (noDataValue !== null && noDataValue !== undefined && value === noDataValue) {
        continue;
      }
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }

    const geoKeys = image.getGeoKeys?.() ?? {};
    const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;
    const sourceProj = epsg ? `EPSG:${epsg}` : null;
    const isProjected = Boolean(geoKeys.ProjectedCSTypeGeoKey);
    const bbox = image.getBoundingBox();

    let bounds = bbox;
    if (!sourceProj) {
      const fallbackBounds = dtmRasterDataRef.current?.bounds ?? dtmBounds ?? null;
      if (fallbackBounds && fallbackBounds.length === 4) {
        bounds = fallbackBounds;
      }
    } else if (sourceProj !== 'EPSG:4326') {
      try {
        const [minX, minY, maxX, maxY] = bbox;
        const topLeft = proj4(sourceProj, 'EPSG:4326', [minX, maxY]);
        const topRight = proj4(sourceProj, 'EPSG:4326', [maxX, maxY]);
        const bottomRight = proj4(sourceProj, 'EPSG:4326', [maxX, minY]);
        const bottomLeft = proj4(sourceProj, 'EPSG:4326', [minX, minY]);
        const transformedMinX = Math.min(topLeft[0], topRight[0], bottomRight[0], bottomLeft[0]);
        const transformedMinY = Math.min(topLeft[1], topRight[1], bottomRight[1], bottomLeft[1]);
        const transformedMaxX = Math.max(topLeft[0], topRight[0], bottomRight[0], bottomLeft[0]);
        const transformedMaxY = Math.max(topLeft[1], topRight[1], bottomRight[1], bottomLeft[1]);
        bounds = [transformedMinX, transformedMinY, transformedMaxX, transformedMaxY];
      } catch (transformError) {
        console.error('Error transforming viewshed bounds:', transformError);
        const fallbackBounds = dtmRasterDataRef.current?.bounds ?? dtmBounds ?? null;
        if (fallbackBounds && fallbackBounds.length === 4) {
          bounds = fallbackBounds;
        } else {
          alert('כשל בהמרת תחומי שדה ראייה. מוצג עם תחום לא מומר.');
        }
      }
    }

    setViewshedRaster({
      width,
      height,
      data: rasterData as ArrayLike<number>,
      bounds,
      min,
      max,
      noDataValue: noDataValue ?? null,
      isProjected,
      crs: sourceProj
    });
    setViewshedVisible(true);
    if (signature) {
      viewshedSignatureRef.current = signature;
    }
    if (pendingViewshedRouteSnapshotRef.current) {
      viewshedRouteSnapshotRef.current = pendingViewshedRouteSnapshotRef.current.map((point) => ({ ...point }));
      pendingViewshedRouteSnapshotRef.current = null;
    }
  }, [dtmBounds]);

  const handleGenerateViewshed = useCallback(async () => {
    if (!dtmSource || !dtmLoaded) {
      alert('טען DTM תחילה.');
      return;
    }
    if (flightPath.length < 2) {
      alert('הוסף לפחות שתי נקודות תחילה.');
      return;
    }
    if (isViewshedProcessing) return;

    if ((viewshedRaster || viewshedStatus === 'done') && !skipViewshedReplaceConfirmRef.current) {
      const shouldReplace = window.confirm('שדה ראייה קיים כבר. למחוק אותו ולחשב חדש?');
      if (!shouldReplace) return;
      if (viewshedJobId && isViewshedProcessing) {
        await handleCancelViewshed();
      }
      clearViewshedOverlay();
      setViewshedRaster(null);
      setViewshedVisible(false);
      setViewshedStatus('idle');
      setViewshedProgress(0);
    }
    skipViewshedReplaceConfirmRef.current = false;

    stopViewshedPolling();
    setIsViewshedProcessing(true);
    setViewshedStatus('running');
    setViewshedProgress(0);
    pendingViewshedRouteSnapshotRef.current = flightPath.map((point) => ({ ...point }));
    try {
      const trajectory = flightPath.map((point) => ({
        lng: point.lng,
        lat: point.lat,
        height: point.height ?? nominalFlightHeight
      }));

      const response = await fetch('/api/viewshed/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dtmPath: dtmSource,
          clippedId: propClippedId ?? undefined,
          coordinates: trajectory,
          samplingIntervalMeters: 50
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Viewshed generation failed');
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('image/tiff')) {
        const arrayBuffer = await response.arrayBuffer();
        await loadViewshedFromArrayBuffer(arrayBuffer, flightPathSignature);
        setViewshedStatus('done');
        setViewshedProgress(100);
        setViewshedJobId(null);
        return;
      }

      const startPayload = await response.json();
      const jobId = startPayload.jobId as string;
      setViewshedJobId(jobId);

      viewshedPollRef.current = window.setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/viewshed/status/${jobId}`);
          if (!statusRes.ok) {
            throw new Error('Failed to read status');
          }
          const statusJson = await statusRes.json();
          const status = statusJson.status as typeof viewshedStatus;
          setViewshedProgress(statusJson.progress ?? 0);
          setViewshedStatus(status);
          if (status === 'done') {
            stopViewshedPolling();
            const resultRes = await fetch(`/api/viewshed/result/${jobId}`);
            if (!resultRes.ok) {
              const errorText = await resultRes.text();
              throw new Error(errorText || 'Failed to fetch viewshed result');
            }
            const arrayBuffer = await resultRes.arrayBuffer();
            await loadViewshedFromArrayBuffer(arrayBuffer, flightPathSignature);
            setIsViewshedProcessing(false);
          } else if (status === 'error' || status === 'cancelled') {
            stopViewshedPolling();
            setIsViewshedProcessing(false);
            if (status === 'error') {
              alert(`שגיאה ביצירת שדה ראייה: ${statusJson.error || 'שגיאה לא ידועה'}`);
            }
          }
        } catch (pollError) {
          console.error('Viewshed status polling failed:', pollError);
          stopViewshedPolling();
          setIsViewshedProcessing(false);
          setViewshedStatus('error');
        }
      }, 1500);
    } catch (error) {
      console.error('Error generating viewshed:', error);
      alert(`שגיאה ביצירת שדה ראייה: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
      setViewshedStatus('error');
    } finally {
      if (!viewshedPollRef.current) {
        setIsViewshedProcessing(false);
      }
    }
  }, [dtmSource, dtmLoaded, flightPath, isViewshedProcessing, nominalFlightHeight, propClippedId, stopViewshedPolling, viewshedStatus, loadViewshedFromArrayBuffer, flightPathSignature]);

  const handleViewshedButtonClick = useCallback(() => {
    if (hasViewshedResult) {
      setViewshedModalMode('settings');
      setIsViewshedModalOpen(true);
      return;
    }
    setViewshedModalMode('progress');
    setIsViewshedModalOpen(true);
    handleGenerateViewshed();
  }, [handleGenerateViewshed, hasViewshedResult]);

  const handleCancelViewshed = useCallback(async () => {
    if (!viewshedJobId) return;
    try {
      await fetch(`/api/viewshed/cancel/${viewshedJobId}`, { method: 'POST' });
      setViewshedStatus('cancelled');
    } catch (error) {
      console.error('Cancel viewshed failed:', error);
    } finally {
      stopViewshedPolling();
      setIsViewshedProcessing(false);
    }
  }, [viewshedJobId, stopViewshedPolling]);

  const handleViewshedRouteRecalculate = useCallback(() => {
    setIsViewshedRouteModalOpen(false);
    skipViewshedReplaceConfirmRef.current = true;
    setViewshedModalMode('progress');
    setIsViewshedModalOpen(true);
    handleGenerateViewshed();
  }, [handleGenerateViewshed]);

  const handleViewshedRouteDelete = useCallback(() => {
    setIsViewshedRouteModalOpen(false);
    clearViewshedOverlay();
    setViewshedRaster(null);
    setViewshedVisible(false);
    setViewshedStatus('idle');
    setViewshedProgress(0);
    viewshedSignatureRef.current = null;
    viewshedRouteSnapshotRef.current = null;
  }, [clearViewshedOverlay]);

  const handleViewshedRouteCancelEditing = useCallback(() => {
    setIsViewshedRouteModalOpen(false);
    const snapshot = viewshedRouteSnapshotRef.current;
    if (snapshot && snapshot.length > 0) {
      skipViewshedRoutePromptRef.current = true;
      onPathChange(snapshot.map((point) => ({ ...point })));
      return;
    }
    if (canUndo) {
      skipViewshedRoutePromptRef.current = true;
      onUndo();
    }
  }, [onPathChange, onUndo, canUndo]);

  useEffect(() => {
    if (!viewshedRaster || viewshedStatus !== 'done') return;
    if (!viewshedSignatureRef.current) {
      viewshedSignatureRef.current = flightPathSignature;
      viewshedRouteSnapshotRef.current = flightPath.map((point) => ({ ...point }));
      return;
    }
    if (viewshedSignatureRef.current === flightPathSignature) return;
    if (skipViewshedRoutePromptRef.current) {
      skipViewshedRoutePromptRef.current = false;
      return;
    }
    if (isViewshedRouteModalOpen) return;
    if (isViewshedModalOpen) {
      setIsViewshedModalOpen(false);
      setViewshedModalMode(null);
    }
    setIsViewshedRouteModalOpen(true);
  }, [flightPathSignature, viewshedRaster, viewshedStatus, flightPath, isViewshedRouteModalOpen, isViewshedModalOpen]);

  useEffect(() => {
    return () => {
      stopViewshedPolling();
    };
  }, [stopViewshedPolling]);

  useEffect(() => {
    renderViewshedOverlay();
  }, [renderViewshedOverlay]);

  useEffect(() => {
    if (viewshedStatus === 'done' && isViewshedModalOpen && viewshedModalMode === 'progress') {
      setIsViewshedModalOpen(false);
      setViewshedModalMode(null);
    }
  }, [viewshedStatus, isViewshedModalOpen, viewshedModalMode]);

  useEffect(() => {
    if (!dtmSource || !dtmLoaded) {
      setViewshedRaster(null);
      setViewshedVisible(false);
      clearViewshedOverlay();
    }
  }, [dtmSource, dtmLoaded, clearViewshedOverlay]);

  const handleCreatePointFromCoordinates = () => {
    if (!dtmLoaded) {
      alert('טען DTM תחילה.');
      return;
    }

    setDialog({
      type: 'coordinates',
      title: 'הוסף נקודה לפי קואורדינטות'
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
      alert('טען DTM תחילה.');
      return;
    }

    if (flightPath.length < 2) {
      alert('הוסף לפחות שתי נקודות תחילה.');
      return;
    }

    setDialog({
      type: 'uTurn',
      title: 'הוסף פרסה'
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
        setDialogError('גובה חייב להיות >= 0.');
        return;
      }
      const point = flightPath[index];
      if (!point) {
        setDialogError('נקודה לא נמצאה.');
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
        setDialogError('אזימוט חייב להיות 0-360.');
        return;
      }
      if (isNaN(distance) || distance <= 0) {
        setDialogError('מרחק חייב להיות > 0.');
        return;
      }
      const lastPoint = flightPath[flightPath.length - 1];
      const bearing = (azimuth * Math.PI) / 180;
      const newPoint = calculateDestination(lastPoint, bearing, distance);
      if (!isPointWithinBounds(newPoint.lng, newPoint.lat)) {
        setDialogError('נקודה מחוץ ל-DTM.');
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
        setDialogError('נדרש היסט.');
        return;
      }
      if (segmentIndex < 0 || segmentIndex >= flightPath.length - 1) {
        setDialogError('בחר מקטע שוב.');
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
        setDialogError('היסט יוצא מ-DTM.');
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
          setDialogError('הזן מספרים.');
          return;
        }
        if (lng < -180 || lng > 180) {
          setDialogError('קו אורך: -180..180.');
          return;
        }
        if (lat < -90 || lat > 90) {
          setDialogError('קו רוחב: -90..90.');
          return;
        }
      } else {
        const easting = parseFloat(dialogValues.easting || '');
        const northing = parseFloat(dialogValues.northing || '');
        const zone = parseInt(dialogValues.zone || '', 10);
        const hemisphere = (dialogValues.hemisphere || 'N').toUpperCase();
        if (isNaN(easting) || isNaN(northing) || isNaN(zone)) {
          setDialogError('UTM: מספרים בלבד.');
          return;
        }
        if (zone < 1 || zone > 60) {
          setDialogError('אזור: 1-60.');
          return;
        }
        if (hemisphere !== 'N' && hemisphere !== 'S') {
          setDialogError('חצי כדור: N/S.');
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
          setDialogError('המרת UTM נכשלה.');
          return;
        }
      }

      if (lng === null || lat === null) {
        setDialogError('קואורדינטות חסרות.');
        return;
      }

      if (!isPointWithinBounds(lng, lat)) {
        setDialogError('נקודה מחוץ ל-DTM.');
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
        setDialogError('רדיוס חייב להיות שונה מאפס.');
        return;
      }
      if (isNaN(distance) || distance <= 0) {
        setDialogError('מרחק חייב להיות > 0.');
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
        setDialogError(`מרחק מוגבל ל-${maxStartEndDistance}מ'.`);
      }
      const pts = generateUTurnPoints(prev, start, radiusMeters, clampedDistance, numUTurnPoints, side);
      if (pts.length !== numUTurnPoints) {
        setDialogError('לא ניתן לבנות פרסה.');
        return;
      }
      const outOfBounds = pts.find(p => !isPointWithinBounds(p.lng, p.lat));
      if (outOfBounds) {
        setDialogError('פרסה מחוץ ל-DTM.');
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
          <label className="quick-modal__label" htmlFor="height-input">גובה (מ')</label>
          <input
            id="height-input"
            type="number"
            min="0"
            max="10000"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.height ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, height: e.target.value }));
              validateDialogInput('height', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
          />
          <input type="hidden" value={dialogValues.pointIndex ?? ''} readOnly />
        </>
      );
    }
    if (dialog.type === 'azimuthDistance') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="azimuth-input">
            אזימוט (0-360)
          </label>
          <input
            id="azimuth-input"
            type="number"
            min="0"
            max="360"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.azimuth ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, azimuth: e.target.value }));
              validateDialogInput('azimuth', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
          />
          <label className="quick-modal__label" htmlFor="distance-input">
            מרחק (מ')
          </label>
          <input
            id="distance-input"
            type="number"
            min="0.1"
            max="100000"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.distance ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, distance: e.target.value }));
              validateDialogInput('distance', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
          />
        </>
      );
    }
    if (dialog.type === 'parallelOffset') {
      return (
        <>
          <label className="quick-modal__label" htmlFor="offset-input">
            היסט (מ')
            <Tooltip tooltip="חיובי = ימינה, שלילי = שמאלה">
              <span className="quick-modal__info" aria-label="מידע כיוון היסט">i</span>
            </Tooltip>
          </label>
          <input
            id="offset-input"
            type="number"
            min="-10000"
            max="10000"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.offset ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, offset: e.target.value }));
              validateDialogInput('offset', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
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
              קו רוחב/אורך
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
              <label className="quick-modal__label" htmlFor="lng-input">קו אורך</label>
              <input
                id="lng-input"
                type="number"
                min="-180"
                max="180"
                step="0.000001"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.lng ?? ''}
                onChange={(e) => {
                  setDialogValues((prev) => ({ ...prev, lng: e.target.value }));
                  validateDialogInput('lng', e.target.value);
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
              <label className="quick-modal__label" htmlFor="lat-input">קו רוחב</label>
              <input
                id="lat-input"
                type="number"
                min="-90"
                max="90"
                step="0.000001"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.lat ?? ''}
                onChange={(e) => {
                  setDialogValues((prev) => ({ ...prev, lat: e.target.value }));
                  validateDialogInput('lat', e.target.value);
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
            </>
          ) : (
            <>
              <label className="quick-modal__label" htmlFor="easting-input">Easting (מ')</label>
              <input
                id="easting-input"
                type="number"
                min="0"
                max="999999"
                step="0.01"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.easting ?? ''}
                onChange={(e) => {
                  setDialogValues((prev) => ({ ...prev, easting: e.target.value }));
                  validateDialogInput('easting', e.target.value);
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
              <label className="quick-modal__label" htmlFor="northing-input">Northing (מ')</label>
              <input
                id="northing-input"
                type="number"
                min="0"
                max="10000000"
                step="0.01"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.northing ?? ''}
                onChange={(e) => {
                  setDialogValues((prev) => ({ ...prev, northing: e.target.value }));
                  validateDialogInput('northing', e.target.value);
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
              <div className="quick-modal__split">
                <div>
                  <label className="quick-modal__label" htmlFor="zone-input">אזור</label>
                  <input
                    id="zone-input"
                    type="number"
                    min="1"
                    max="60"
                    step="1"
                    required
                    inputMode="numeric"
                    aria-required="true"
                    value={dialogValues.zone ?? ''}
                    onChange={(e) => {
                      setDialogValues((prev) => ({ ...prev, zone: e.target.value }));
                      validateDialogInput('zone', e.target.value);
                    }}
                    className={`quick-modal__input ${dialogError ? 'error' : ''}`}
                  />
                </div>
                <div>
                  <label className="quick-modal__label" htmlFor="hemisphere-input">חצי כדור</label>
                  <input
                    id="hemisphere-input"
                    type="text"
                    pattern="[NnSs]"
                    maxLength={1}
                    required
                    aria-required="true"
                    value={dialogValues.hemisphere ?? 'N'}
                    onChange={(e) => {
                      const value = e.target.value.toUpperCase();
                      if (value === '' || value === 'N' || value === 'S') {
                        setDialogValues((prev) => ({ ...prev, hemisphere: value }));
                        if (value && value !== 'N' && value !== 'S') {
                          setDialogError('חצי כדור חייב להיות N או S');
                        } else {
                          setDialogError(null);
                        }
                      } else {
                        setDialogError('חצי כדור חייב להיות N או S');
                      }
                    }}
                    className={`quick-modal__input ${dialogError ? 'error' : ''}`}
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
            רדיוס (מ')
            <Tooltip tooltip="חיובי = ימינה, שלילי = שמאלה">
              <span className="quick-modal__info" aria-label="מידע כיוון רדיוס">i</span>
            </Tooltip>
          </label>
          <input
            id="radius-input"
            type="number"
            min="-1000"
            max="1000"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.radius ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, radius: e.target.value }));
              validateDialogInput('radius', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
          />
          <label className="quick-modal__label" htmlFor="distance-ut-input">מרווח (מ')</label>
          <input
            id="distance-ut-input"
            type="number"
            min="0.1"
            max="10000"
            step="0.1"
            required
            inputMode="decimal"
            aria-required="true"
            value={dialogValues.distance ?? ''}
            onChange={(e) => {
              setDialogValues((prev) => ({ ...prev, distance: e.target.value }));
              validateDialogInput('distance-ut', e.target.value);
            }}
            className={`quick-modal__input ${dialogError ? 'error' : ''}`}
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
                aria-label="סגירת חלון קלט"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body">
              {renderDialogFields()}
              {dialogError && <div className="quick-modal__error">{dialogError}</div>}
            </div>
            <div className="quick-modal__actions">
              <button type="button" className="btn btn-tertiary" onClick={resetDialog}>ביטול</button>
              <button type="button" className="btn btn-primary" onClick={handleDialogSubmit}>החל</button>
            </div>
          </div>
        </div>
      )}
      {isViewshedModalOpen && (
        <div
          className="quick-modal__backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setIsViewshedModalOpen(false);
            setViewshedModalMode(null);
          }}
        >
          <div className="quick-modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="quick-modal__header">
              <div className="quick-modal__title">{hasViewshedResult ? 'הגדרות שדה ראייה' : 'חישוב שדה ראייה'}</div>
              <button
                type="button"
                className="quick-modal__close"
                onClick={() => {
                  setIsViewshedModalOpen(false);
                  setViewshedModalMode(null);
                }}
                aria-label="סגירת חלון שדה ראייה"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body viewshed-modal__body">
              {hasViewshedResult ? (
                <>
                  <label className="quick-modal__label" htmlFor="viewshed-visible-toggle">
                    תצוגה
                  </label>
                  <label className="switch viewshed-modal__toggle">
                    <input
                      id="viewshed-visible-toggle"
                      type="checkbox"
                      checked={viewshedVisible}
                      onChange={(e) => setViewshedVisible(e.target.checked)}
                      disabled={!viewshedRaster}
                    />
                    <span className="switch-slider" />
                    <span className="viewshed-modal__toggle-text">{viewshedVisible ? 'מוצג' : 'מוסתר'}</span>
                  </label>

                  <label className="quick-modal__label" htmlFor="viewshed-colormap">
                    צבע
                  </label>
                  <select
                    id="viewshed-colormap"
                    className="viewshed-select"
                    value={viewshedColormap}
                    onChange={(e) => setViewshedColormap(e.target.value)}
                    disabled={!viewshedRaster}
                  >
                    {Object.entries(VIEWSHED_COLORMAPS).map(([key, item]) => (
                      <option key={key} value={key}>
                        {item.label}
                      </option>
                    ))}
                  </select>

                  <label className="quick-modal__label" htmlFor="viewshed-opacity-slider">
                    אטימות {Math.round(viewshedOpacity * 100)}%
                  </label>
                  <input
                    id="viewshed-opacity-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={viewshedOpacity}
                    onChange={handleViewshedOpacityChange}
                    className="viewshed-opacity-slider"
                    disabled={!viewshedRaster}
                  />

                  <div className="viewshed-modal__status">
                    סטטוס: {viewshedStatusLabel}
                  </div>

                  {isViewshedProcessing && (
                    <div className="viewshed-progress">
                      <div className="viewshed-progress-bar">
                        <div
                          className="viewshed-progress-fill"
                          style={{ width: `${viewshedProgress}%` }}
                        />
                      </div>
                      <span className="viewshed-progress-text">{viewshedProgress}%</span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="viewshed-modal__status">
                    סטטוס: {viewshedStatusLabel}
                  </div>
                  <div className="viewshed-progress">
                    <div className="viewshed-progress-bar">
                      <div
                        className="viewshed-progress-fill"
                        style={{ width: `${viewshedProgress}%` }}
                      />
                    </div>
                    <span className="viewshed-progress-text">{viewshedProgress}%</span>
                  </div>
                </>
              )}
            </div>
            <div className="quick-modal__actions">
              <button
                type="button"
                className="btn btn-tertiary"
                onClick={() => {
                  setIsViewshedModalOpen(false);
                  setViewshedModalMode(null);
                }}
              >
                סגור
              </button>
              {hasViewshedResult ? (
                <>
                  <button
                    type="button"
                    className="btn btn-destructive"
                    onClick={handleCancelViewshed}
                    disabled={!viewshedJobId || !isViewshedProcessing}
                  >
                    בטל חישוב
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleGenerateViewshed}
                    disabled={!dtmLoaded || flightPath.length < 2 || isViewshedProcessing}
                  >
                    חשב שדה ראייה
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-destructive"
                  onClick={handleCancelViewshed}
                  disabled={!viewshedJobId || !isViewshedProcessing}
                >
                  בטל חישוב
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {isViewshedRouteModalOpen && (
        <div
          className="quick-modal__backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setIsViewshedRouteModalOpen(false)}
        >
          <div className="quick-modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="quick-modal__header">
              <div className="quick-modal__title">מסלול עודכן</div>
              <button
                type="button"
                className="quick-modal__close"
                onClick={() => setIsViewshedRouteModalOpen(false)}
                aria-label="סגירת חלון שינוי מסלול"
              >
                ×
              </button>
            </div>
            <div className="quick-modal__body">
              <div className="quick-modal__text">
                מסלול הטיסה השתנה ויש שדה ראייה קיים.
              </div>
            </div>
            <div className="quick-modal__actions quick-modal__actions--stack">
              <button type="button" className="btn btn-primary" onClick={handleViewshedRouteRecalculate}>
                עריכת מסלול וחישוב שדה ראייה חדש
              </button>
              <button type="button" className="btn btn-primary" onClick={handleViewshedRouteDelete}>
                עריכת מסלול ומחיקת שדה ראייה
              </button>
              <button type="button" className="btn btn-primary" onClick={handleViewshedRouteCancelEditing}>
                ביטול עריכת מסלול
              </button>
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
          מצב עריכה: לחץ על המפה כדי להזיז את נקודה {(externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex)! + 1}
        </div>
      )}
      {isParallelLineMode && (
        <div className="edit-mode-indicator">
          לחץ על מקטע קו כדי ליצור קו מקביל
        </div>
      )}
      <div className="map-controls">
        <div className="control-group">
          <div className="group-title">ניהול נתונים</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              {/* Unified DTM Loader Button */}
              <Tooltip tooltip="טען DTM (מקומי או מהשרת)">
                <button
                  onClick={handleOpenDtmLoader}
                  className={`btn btn-tertiary btn-icon ${dtmLoaded ? 'disabled' : ''}`}
                  disabled={dtmLoaded || isAoiSelectionMode}
                  aria-label="טעינת DTM"
                  type="button"
                >
                  <Icon name="folder" />
                  <span className="sr-only">טעינת DTM</span>
                </button>
              </Tooltip>
              <input
                type="file"
                accept=".kml"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    await onImportKML(file);
                    e.target.value = '';
                  }
                }}
                style={{ display: 'none' }}
                id="import-kml-map"
              />
              <Tooltip tooltip="העלאת מסלול טיסה (KML)">
                <label
                  htmlFor="import-kml-map"
                  className={`btn btn-secondary btn-icon ${!dtmSource ? 'disabled' : ''}`}
                  style={!dtmSource ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : undefined}
                  aria-label="העלאת מסלול טיסה"
                >
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M10 12.5L6 8.5H9V2H11V8.5H14L10 12.5ZM5 15H15V13H17V15C17 16.1 16.1 17 15 17H5C3.9 17 3 16.1 3 15V13H5V15Z" fill="currentColor"/>
                  </svg>
                  <span className="sr-only">העלאת מסלול טיסה</span>
                </label>
              </Tooltip>
              <Tooltip tooltip="ייצוא מסלול טיסה (KML)">
                <button
                  onClick={onExportClick}
                  className={`btn btn-secondary btn-icon ${!canExport ? 'disabled' : ''}`}
                  disabled={!canExport}
                  aria-label="ייצוא מסלול טיסה"
                  type="button"
                >
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M10 7.5L14 11.5H11V18H9V11.5H6L10 7.5ZM5 5H15V7H17V5C17 3.9 16.1 3 15 3H5C3.9 3 3 3.9 3 5V7H5V5Z" fill="currentColor"/>
                  </svg>
                  <span className="sr-only">ייצוא מסלול טיסה</span>
                </button>
              </Tooltip>
            </div>
            <div className="group-column group-column-icons">
              <Tooltip tooltip="הסר DTM ונקה מסלולים">
                <button
                  onClick={onDtmUnload}
                  className="btn btn-destructive btn-icon"
                  disabled={!dtmSource || !dtmLoaded}
                  aria-label="פריקת DTM וניקוי מסלולים"
                  type="button"
                >
                  <Icon name="eject" />
                  <span className="sr-only">פריקת DTM וניקוי מסלולים</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="נקה את כל הנקודות מהמסלול">
                <button
                  onClick={handleDeleteAllPoints}
                  className="btn btn-destructive btn-icon"
                  disabled={flightPath.length === 0}
                  aria-label="מחיקת כל הנקודות"
                  type="button"
                >
                  <Icon name="trash" />
                  <span className="sr-only">מחיקת כל הנקודות</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">אפשרויות תכנון</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={isDrawing ? 'עצור שרטוט' : 'צייר מסלול (קליק על המפה)'}>
                <button
                  onClick={() => {
                    setIsDrawing(!isDrawing);
                    setEditingPointIndex(null);
                    if (onEditPointIndexChange) {
                      onEditPointIndexChange(null);
                    }
                    setIsParallelLineMode(false);
                  }}
                  className={isDrawing ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  disabled={!dtmLoaded}
                  aria-label={isDrawing ? 'עצירת שרטוט' : 'שרטט מסלול'}
                  type="button"
                >
                  <Icon name="pencil" />
                  <span className="sr-only">{isDrawing ? 'עצירת שרטוט' : 'שרטט מסלול'}</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={isParallelLineMode ? 'עצור מצב קו מקביל' : 'קו מקביל: לחץ על מקטע, קבע היסט'}>
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
                  aria-label={isParallelLineMode ? 'בטל קו מקביל' : 'צור קו מקביל'}
                  type="button"
                >
                  <Icon name="parallel" />
                  <span className="sr-only">{isParallelLineMode ? 'בטל קו מקביל' : 'צור קו מקביל'}</span>
                </button>
              </Tooltip>
            </div>
            <div className="group-column group-column-icons">
              <Tooltip tooltip="הוסף נקודה לפי אזימוט ומרחק">
                <button
                  onClick={handleCreatePointFromAzimuthDistance}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length === 0}
                  aria-label="הוסף נקודה לפי אזימוט ומרחק"
                  type="button"
                >
                  <Icon name="compass" />
                  <span className="sr-only">אזימוט + מרחק</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="הוסף נקודה לפי קואורדינטות">
                <button
                  onClick={handleCreatePointFromCoordinates}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded}
                  aria-label="הוסף נקודה לפי קואורדינטות"
                  type="button"
                >
                  <Icon name="crosshair" />
                  <span className="sr-only">נקודה לפי קואורדינטות</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="הוסף פרסה עם רדיוס ומרחק">
                <button
                  onClick={handleAddUTurn}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length < 2}
                  aria-label="הוסף פרסה"
                  type="button"
                >
                  <Icon name="uturn" />
                  <span className="sr-only">פרסה</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">מתקדם</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={hasViewshedResult ? 'פתח הגדרות שדה ראייה' : 'חשב שדה ראייה (visibility analysis)'}>
                <button
                  onClick={handleViewshedButtonClick}
                  className="btn btn-tertiary btn-icon"
                  aria-label={hasViewshedResult ? 'פתח הגדרות שדה ראייה' : 'חשב שדה ראייה'}
                  type="button"
                  disabled={!dtmLoaded || flightPath.length < 2}
                >
                  <Icon name="search" />
                  <span className="sr-only">{hasViewshedResult ? 'הגדרות שדה ראייה' : 'חשב שדה ראייה'}</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={isInfoMode ? 'כבה מצב מידע' : 'הצג גובה קרקע במיקום העכבר'}>
                <button
                  onClick={() => {
                    const newInfoMode = !isInfoMode;
                    setIsInfoMode(newInfoMode);
                    if (newInfoMode) {
                      // Turn off route info when turning on info mode
                      onShowMetadataChange(false);
                      setCursorElevation(null);
                    } else {
                      setCursorElevation(null);
                      setMousePos(null);
                      elevationCacheRef.current.clear();
                    }
                  }}
                  className={isInfoMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  disabled={!dtmLoaded}
                  aria-label={isInfoMode ? 'כבה מצב מידע' : 'הצג גובה קרקע'}
                  type="button"
                >
                  <Icon name="pin" />
                  <span className="sr-only">{isInfoMode ? 'כבה מצב מידע' : 'הצג גובה קרקע'}</span>
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
        {showDrawModeNote && (
          <div className={`map-instruction-banner ${isFadingOut ? 'fade-out' : 'fade-in'}`}>
            <div className="map-instruction-content">
              <div className="map-instruction-text">
                לחץ Shift על מנת להוסיף נקודה בין נקודות קיימות
              </div>
              <div className="map-instruction-icon">
                <Icon name="info" />
              </div>
            </div>
          </div>
        )}
        {/* Routes Panel - positioned inside map */}
        <div className={`control-group routes-panel ${isRoutesPanelOpen ? 'open' : 'closed'}`} ref={routesPanelRef}>
          <div className="routes-panel-header header-group">
            <button
              type="button"
              className="routes-panel-toggle"
              onClick={() => setIsRoutesPanelOpen((prev) => !prev)}
              aria-label={isRoutesPanelOpen ? 'סגירת לוח המסלולים' : 'פתיחת לוח המסלולים'}
            >
              <span className="group-title">מסלולים</span>
              <span className={`header-chevron ${isRoutesPanelOpen ? 'open' : ''}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </span>
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
                    <div 
                      className="route-main" 
                      title="בחר מסלול פעיל"
                      onClick={() => onActiveRouteChange(route.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <span
                        className="route-color-dot"
                        style={{ backgroundColor: route.color }}
                        aria-hidden
                      />
                      <span 
                        className="route-name-block"
                        onClick={(e) => {
                          // Detect double-click using detail property (detail === 2 means double-click)
                          if (e.detail === 2) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (editingRouteId !== route.id) {
                              setEditingRouteId(route.id);
                              setEditingRouteName(route.name);
                            }
                          } else {
                            // Single click - prevent route selection
                            e.stopPropagation();
                          }
                        }}
                      >
                        <span className="route-index">#{idx + 1}</span>
                        {editingRouteId === route.id ? (
                          <input
                            className="route-name-input"
                            value={editingRouteName}
                            autoFocus
                            onChange={(e) => setEditingRouteName(e.target.value)}
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                            onBlur={() => {
                              // Only save if we're still in editing mode (not cancelled)
                              if (editingRouteId) {
                                onRenameRoute(editingRouteId, editingRouteName);
                                setEditingRouteId(null);
                                setEditingRouteName('');
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (editingRouteId) {
                                  onRenameRoute(editingRouteId, editingRouteName);
                                }
                                setEditingRouteId(null);
                                setEditingRouteName('');
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                // Clear editing state first to prevent onBlur from saving
                                setEditingRouteId(null);
                                setEditingRouteName('');
                                e.currentTarget.blur();
                              }
                            }}
                            placeholder={`מסלול ${idx + 1}`}
                          />
                        ) : (
                          <button
                            type="button"
                            className="route-name-button"
                            title={`${route.name} (לחיצה כפולה לשינוי שם)`}
                            onClick={(e) => {
                              // Detect double-click using detail property (detail === 2 means double-click)
                              if (e.detail === 2) {
                                e.preventDefault();
                                e.stopPropagation();
                                if (editingRouteId !== route.id) {
                                  setEditingRouteId(route.id);
                                  setEditingRouteName(route.name);
                                }
                              } else {
                                // Single click - prevent route selection
                                e.stopPropagation();
                              }
                            }}
                          >
                            <span className="route-name-text">{route.name}</span>
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="route-actions">
                      <Tooltip tooltip={
                        route.id === activeRouteId
                          ? 'המסלול הפעיל נשאר גלוי.'
                          : route.visible
                            ? 'הסתר מסלול'
                            : 'הצג מסלול'
                      }>
                        <button
                          type="button"
                          className="btn btn-icon btn-compact route-visibility-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (route.id !== activeRouteId) {
                              onToggleRouteVisibility(route.id);
                            }
                          }}
                          disabled={route.id === activeRouteId}
                          aria-label={route.visible ? 'הסתר מסלול' : 'הצג מסלול'}
                        >
                          <Icon name={route.visible ? 'eye' : 'eye-off'} />
                        </button>
                      </Tooltip>
                      <Tooltip tooltip={routes.length <= 1 ? 'השאר לפחות מסלול אחד' : 'מחק מסלול'}>
                        <button
                          type="button"
                          className="btn btn-destructive btn-icon btn-compact"
                          onClick={(e) => {
                            e.stopPropagation(); // Prevent selecting the route when clicking delete
                            if (routes.length <= 1) return;
                            if (window.confirm(`למחוק את "${route.name}"? לא ניתן לבטל.`)) {
                              onDeleteRoute(route.id);
                            }
                          }}
                          disabled={routes.length <= 1}
                          aria-label={`מחיקת ${route.name}`}
                        >
                          <Icon name="trash" />
                          <span className="sr-only">מחיקת מסלול</span>
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))}
                <div className="route-bulk-actions">
                  <Tooltip tooltip="הוסף מסלול חדש">
                    <button
                      type="button"
                      className="btn btn-primary btn-icon btn-compact"
                      onClick={onAddRoute}
                      aria-label="הוסף מסלול חדש"
                    >
                      <Icon name="plus" />
                    </button>
                  </Tooltip>
                  <Tooltip tooltip="איפוס למסלול אחד">
                    <button
                      type="button"
                      className="btn btn-destructive btn-icon btn-compact"
                      onClick={() => {
                        if (window.confirm('לאפס למסלול ריק אחד? ימחק את כל המסלולים והנקודות.')) {
                          onResetToSingleRoute();
                        }
                      }}
                      aria-label="איפוס מסלולים"
                    >
                      <Icon name="eject" />
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className={`btn btn-visibility-cycle ${routeVisibilityMode === 'custom' ? 'is-custom' : ''}`}
                    onClick={handleCycleRoutesVisibility}
                    disabled={routes.length === 0}
                    title={`שינוי מצב תצוגה (כרגע: ${routeVisibilityLabel})`}
                  >
                    <Icon name={
                      routeVisibilityMode === 'all' 
                        ? 'checklist' 
                        : routeVisibilityMode === 'active' 
                          ? 'checklist-single' 
                          : 'silent'
                    } />
                    <span style={{ marginRight: '0.4rem' }}>{routeVisibilityLabel}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        {isDragOver && !isUploading && !isDtmProcessing && (
          <div className="dtm-drop-overlay">
            <div className="dtm-drop-content">
              <Icon name="upload" />
              <div className="dtm-drop-text">
                <div className="dtm-drop-title">גרור ושחרר קובץ DTM GeoTIFF להעלאה</div>
                <div className="dtm-drop-subtitle">.tif, .tiff, .geotiff • עד 199MB</div>
              </div>
            </div>
          </div>
        )}
        {isUploading && (
          <div className="upload-progress-overlay">
            <div className="upload-progress-container">
              <div className="upload-progress-label">מעלה DTM: {uploadProgress}%</div>
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
        {viewshedRaster && viewshedVisible && (
          <div className="viewshed-legend">
            <div className="viewshed-legend-title">שדה ראייה</div>
            <div className="viewshed-legend-label viewshed-legend-label-top">0</div>
            <div className="viewshed-legend-bar" style={{ background: viewshedGradient }} />
            <div className="viewshed-legend-label viewshed-legend-label-bottom">
              {Number.isFinite(viewshedRaster.max) ? Math.round(viewshedRaster.max) : '—'}
            </div>
          </div>
        )}
        {baseMaps.length > 1 && nextBaseMap && (
          <button
            type="button"
            className="basemap-toggle"
            onClick={handleBaseMapButtonClick}
            title={`החלף ל‑${nextBaseMap.name}`}
            ref={basemapToggleRef}
          >
            <div
              className="basemap-preview"
              style={{
                backgroundImage: `url(${getPreviewTileUrl(nextBaseMap)})`
              }}
            ></div>
          </button>
        )}
        
        {/* Display Settings Button & Popover - positioned near zoom controls */}
        <div className="display-settings-container">
          <button
            type="button"
            ref={displaySettingsButtonRef}
            className={`display-settings-trigger ${displaySettingsOpen ? 'active' : ''}`}
            onClick={() => setDisplaySettingsOpen(!displaySettingsOpen)}
            aria-label="Display settings"
            aria-expanded={displaySettingsOpen}
            aria-haspopup="true"
          >
            <Icon name="sliders" />
          </button>
          
          {displaySettingsOpen && (
            <div
              ref={displaySettingsPopoverRef}
              className="display-settings-popover"
              role="dialog"
              aria-label="Display Settings"
            >
              <div className="display-settings-header">
                <span className="display-settings-title">הגדרות תצוגה</span>
                <button
                  type="button"
                  className="display-settings-close"
                  onClick={() => setDisplaySettingsOpen(false)}
                  aria-label="Close display settings"
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="display-settings-content">
                {/* View Controls Section */}
                <div className="display-settings-section">
                  <div className="display-settings-section-title">זום</div>
                  <div className="display-settings-row display-settings-row-buttons">
                    <Tooltip tooltip="התאם תצוגה ל‑DTM">
                      <button
                        onClick={() => {
                          handleFitToDTM();
                          setDisplaySettingsOpen(false);
                        }}
                        className="btn btn-tertiary btn-icon btn-sm"
                        disabled={!dtmLoaded}
                        aria-label="התאם ל‑DTM"
                        type="button"
                      >
                        <Icon name="fit" />
                      </button>
                    </Tooltip>
                    <Tooltip tooltip="זום ברירת מחדל">
                      <button
                        onClick={() => {
                          handleResetView();
                          setDisplaySettingsOpen(false);
                        }}
                        className="btn btn-tertiary btn-icon btn-sm"
                        aria-label="איפוס תצוגה"
                        type="button"
                      >
                        <Icon name="home" />
                      </button>
                    </Tooltip>
                  </div>

                  <div className="display-settings-divider" />

                  <div className="display-settings-subsection-title">נתוני עזר</div>

                  <div className="display-settings-row">
                    <div className="display-settings-icon-row">
                      <Tooltip tooltip="הצג נתונים בריחוף">
                        <button
                          type="button"
                          onClick={() => {
                            const newShowMetadata = !showMetadata;
                            onShowMetadataChange(newShowMetadata);
                            if (newShowMetadata) {
                              setIsInfoMode(false);
                              setCursorElevation(null);
                              setMousePos(null);
                              elevationCacheRef.current.clear();
                            }
                          }}
                          className={`display-settings-icon-toggle ${showMetadata ? 'active' : ''}`}
                          aria-pressed={showMetadata}
                          aria-label={showMetadata ? 'הסתר נתונים' : 'הצג נתונים'}
                        >
                          <Icon name="info" />
                        </button>
                      </Tooltip>
                      <Tooltip tooltip="תוויות נקודות הגבהה">
                        <button
                          type="button"
                          onClick={() => onShowClimbLabelsChange(!showClimbLabels)}
                          className={`display-settings-icon-toggle ${showClimbLabels ? 'active' : ''}`}
                          aria-pressed={showClimbLabels}
                          aria-label={showClimbLabels ? 'הסתר תוויות' : 'הצג תוויות'}
                        >
                          <Icon name="tag" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  <div className="display-settings-row">
                    <div className="display-settings-toggle-row">
                      <span className="display-settings-label">הצג הצעות קווים הבאים</span>
                      <button
                        type="button"
                        onClick={() => onShowNextLineSuggestionsChange(!showNextLineSuggestions)}
                        className={`toggle-btn ${showNextLineSuggestions ? 'active' : ''}`}
                        aria-pressed={showNextLineSuggestions}
                        aria-label={showNextLineSuggestions ? 'הסתר הצעות קווים' : 'הצג הצעות קווים'}
                      >
                        <span className="toggle-btn-thumb" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* DTM Section */}
                <div className="display-settings-section">
                  <div className="display-settings-section-title">DTM</div>

                  {/* Active DTM Name */}
                  <div className="display-settings-row">
                    <div className="display-settings-info-row">
                      <span className="display-settings-label-secondary">DTM פעיל</span>
                      <span
                        className="display-settings-value"
                        title={activeDtmName || ''}
                      >
                        {dtmLoaded && activeDtmName ? activeDtmName : ''}
                      </span>
                    </div>
                  </div>

                  {/* DTM Opacity */}
                  <div className="display-settings-row">
                    <label htmlFor="ds-dtm-opacity" className="display-settings-label">
                      שקיפות {Math.round((1 - dtmOpacity) * 100)}%
                    </label>
                    <input
                      id="ds-dtm-opacity"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={dtmOpacity}
                      onChange={handleDtmOpacityChange}
                      className="display-settings-slider"
                      disabled={!dtmLoaded}
                    />
                  </div>

                  {/* DTM Color Palette */}
                  <div className="display-settings-row display-settings-row-palette">
                    <span className="display-settings-label">ערכת צבעים</span>
                    <div className="display-settings-segmented">
                      <button
                        type="button"
                        className={`display-settings-segment ${dtmColorPalette === 'gray' ? 'active' : ''}`}
                        onClick={() => {
                          setDtmColorPalette('gray');
                          onDisplaySettingsChange?.({
                            palette: 'gray',
                            inverted: dtmColorInverted,
                            opacity: dtmOpacity
                          });
                        }}
                        disabled={!dtmLoaded}
                        aria-pressed={dtmColorPalette === 'gray'}
                      >
                      אפור
                      </button>
                      <button
                        type="button"
                        className={`display-settings-segment ${dtmColorPalette === 'jet' ? 'active' : ''}`}
                        onClick={() => {
                          setDtmColorPalette('jet');
                          onDisplaySettingsChange?.({
                            palette: 'jet',
                            inverted: dtmColorInverted,
                            opacity: dtmOpacity
                          });
                        }}
                        disabled={!dtmLoaded}
                        aria-pressed={dtmColorPalette === 'jet'}
                      >
                      צבעוני
                      </button>
                    </div>
                  </div>

                  {/* Invert Colors Toggle */}
                  <div className="display-settings-row">
                    <div className="display-settings-toggle-row">
                      <span className="display-settings-label">היפוך צבעים</span>
                      <button
                        type="button"
                        onClick={() => {
                          const newInverted = !dtmColorInverted;
                          setDtmColorInverted(newInverted);
                          onDisplaySettingsChange?.({
                            palette: dtmColorPalette,
                            inverted: newInverted,
                            opacity: dtmOpacity
                          });
                        }}
                        className={`toggle-btn ${dtmColorInverted ? 'active' : ''}`}
                        disabled={!dtmLoaded}
                        aria-pressed={dtmColorInverted}
                        aria-label={dtmColorInverted ? 'בטל היפוך צבעים' : 'הפעל היפוך צבעים'}
                      >
                        <span className="toggle-btn-thumb" />
                      </button>
                    </div>
                  </div>

                  <div className="display-settings-helper">
                    משפיע על הצגת ה-DTM בלבד
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {showMetadata && hoveredElevationPoint && mousePos && hoverSource === 'map' && !contextMenu && (
        <div
          ref={tooltipRef}
          className="hover-metadata-tooltip"
          style={{
            left: tooltipPosition?.left ?? mousePos.x + 15,
            top: tooltipPosition?.top ?? mousePos.y + 15,
            visibility: tooltipPosition ? 'visible' : 'hidden'
          }}
        >
          <CoordinateTooltip point={hoveredElevationPoint} utm={hoveredUtm} />
        </div>
      )}
      {isInfoMode && mousePos && cursorElevation && (
        <div
          ref={tooltipRef}
          className="hover-metadata-tooltip"
          style={{
            left: tooltipPosition?.left ?? mousePos.x + 15,
            top: tooltipPosition?.top ?? mousePos.y + 15,
            visibility: tooltipPosition ? 'visible' : 'hidden'
          }}
        >
          <div className="tooltip-section">
            <span className="tooltip-label">גובה קרקע:</span> {cursorElevation.elevation !== null ? `${cursorElevation.elevation.toFixed(1)} מ'` : '—'}
          </div>
        </div>
      )}

      {/* Unified DTM Loader Dialog */}
      {dtmLoaderOpen && (
        <div 
          className="dtm-loader-overlay" 
          onClick={handleCloseDtmLoader}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dtm-loader-title"
        >
          <div 
            className="dtm-loader-dialog" 
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                handleCloseDtmLoader();
              }
            }}
          >
            {/* Header */}
            <div className="dtm-loader-header">
              <h2 id="dtm-loader-title">
                {dtmLoaderStep === 'source-choice' && 'טען DTM'}
                {dtmLoaderStep === 'local-picker' && 'טען קובץ מקומי'}
                {dtmLoaderStep === 'server-area' && 'בחר DTM מהשרת'}
                {dtmLoaderStep === 'server-results' && 'בחר תשתית'}
              </h2>
              <button
                type="button"
                className="btn btn-icon btn-tertiary dtm-loader-close"
                onClick={handleCloseDtmLoader}
                aria-label="סגור"
              >
                <Icon name="close" />
              </button>
            </div>

            {/* Hidden file input - always available for direct file picker */}
            <input
              ref={localFileInputRef}
              type="file"
              accept=".tif,.tiff"
              onChange={handleLocalFileSelect}
              id="dtm-local-upload"
              style={{ display: 'none' }}
              disabled={isLocalUploading}
            />

            {/* Step: Source Choice */}
            {dtmLoaderStep === 'source-choice' && (
              <div className="dtm-loader-content">
                <p className="dtm-loader-subtitle">בחר מקור DTM לטעינה:</p>
                <div className="dtm-source-options">
                  <button
                    type="button"
                    className="dtm-source-card"
                    onClick={() => handleSelectSource('server')}
                  >
                    <div className="dtm-source-icon dtm-source-icon-server">
                      <Icon name="folder" />
                    </div>
                    <div className="dtm-source-info">
                      <span className="dtm-source-title">טען מהשרת</span>
                      <span className="dtm-source-desc">בחר תשתית קיימת מהשרת</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="dtm-source-card"
                    onClick={() => handleSelectSource('local')}
                  >
                    <div className="dtm-source-icon dtm-source-icon-local">
                      <Icon name="download" />
                    </div>
                    <div className="dtm-source-info">
                      <span className="dtm-source-title">טען מקומי</span>
                      <span className="dtm-source-desc" style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.25rem' }}>טעינה מקומית מוגבלת ל-2 GB</span>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Step: Local File Picker */}
            {dtmLoaderStep === 'local-picker' && (
              <div className="dtm-loader-content">
                <button
                  type="button"
                  className="dtm-loader-back"
                  onClick={handleBackToSourceChoice}
                  disabled={isLocalUploading}
                >
                  <Icon name="undo" />
                  חזרה
                </button>
                
                <div className="dtm-local-picker">
                  {!isLocalUploading ? (
                    <>
                      <label
                        htmlFor="dtm-local-upload"
                        className="dtm-local-dropzone"
                      >
                        <Icon name="upload" />
                        <span className="dtm-local-title">לחץ לבחירת קובץ</span>
                        <span className="dtm-local-hint">ניתן לבחור קבצי TIF בלבד</span>
                        <span className="dtm-local-hint" style={{ marginTop: '0.5rem', fontWeight: '500' }}>הערה: טעינה מקומית מוגבלת ל-2 GB</span>
                      </label>
                      
                      {localFileError && (
                        <div className="dtm-local-error">
                          <span>⚠️ {localFileError}</span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setLocalFileError(null)}
                          >
                            נסה שוב
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="dtm-local-progress">
                      <div className="loading-spinner" />
                      <span>מעלה קובץ... {localUploadProgress}%</span>
                      <div className="dtm-progress-bar">
                        <div 
                          className="dtm-progress-fill"
                          style={{ width: `${localUploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step: Server Area Selection */}
            {dtmLoaderStep === 'server-area' && (
              <div className="dtm-loader-content">
                <button
                  type="button"
                  className="dtm-loader-back"
                  onClick={handleBackToSourceChoice}
                >
                  <Icon name="undo" />
                  חזרה
                </button>

                <div className="dtm-modal-search">
                  <Icon name="search" />
                  <input
                    type="text"
                    placeholder="חיפוש קובץ DTM..."
                    maxLength={200}
                    value={dtmSearchQuery}
                    onChange={(e) => setDtmSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="dtm-server-content">
                  {dtmOptionsLoading && (
                    <div className="dtm-modal-loading">
                      <div className="loading-spinner" />
                      <span>טוען רשימת DTM...</span>
                    </div>
                  )}
                  
                  {dtmOptionsError && (
                    <div className="dtm-modal-error">
                      <span>⚠️ {dtmOptionsError}</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={fetchDtmOptions}
                      >
                        נסה שוב
                      </button>
                    </div>
                  )}
                  
                  {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length === 0 && (
                    <div className="dtm-modal-empty">
                      {dtmSearchQuery ? (
                        <span>לא נמצאו קבצים התואמים לחיפוש "{dtmSearchQuery}"</span>
                      ) : (
                        <span>לא נמצאו קבצי DTM בתיקייה.</span>
                      )}
                    </div>
                  )}
                  
                  {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length > 0 && (
                    <div className="dtm-options-list">
                      {filteredDtmOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="dtm-option-item"
                          onClick={() => handleSelectDtm(option.id, option.displayName)}
                        >
                          <div className="dtm-option-icon">
                            <Icon name="folder" />
                          </div>
                          <div className="dtm-option-info">
                            <div className="dtm-option-name">{option.displayName}</div>
                            <div className="dtm-option-meta">
                              <span>{formatFileSize(option.sizeBytes)}</span>
                              <span>•</span>
                              <span>{formatDate(option.modifiedAt)}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="dtm-modal-footer">
                  <span className="dtm-modal-count">
                    {dtmOptions.length} קבצים זמינים
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Legacy DTM Options Modal - keeping for backward compatibility during migration */}
      {showDtmOptionsModal && !dtmLoaderOpen && (
        <div className="dtm-modal-overlay" onClick={handleCloseDtmOptionsModal}>
          <div className="dtm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dtm-modal-header">
              <h2>בחר קובץ DTM</h2>
              <button
                type="button"
                className="btn btn-icon btn-tertiary"
                onClick={handleCloseDtmOptionsModal}
                aria-label="סגור"
              >
                <Icon name="close" />
              </button>
            </div>
            
            <div className="dtm-modal-search">
              <Icon name="search" />
              <input
                type="text"
                placeholder="חיפוש קובץ DTM..."
                maxLength={200}
                value={dtmSearchQuery}
                onChange={(e) => setDtmSearchQuery(e.target.value)}
                autoFocus
              />
            </div>

            <div className="dtm-modal-content">
              {dtmOptionsLoading && (
                <div className="dtm-modal-loading">
                  <div className="loading-spinner" />
                  <span>טוען רשימת DTM...</span>
                </div>
              )}
              
              {dtmOptionsError && (
                <div className="dtm-modal-error">
                  <span>⚠️ {dtmOptionsError}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={fetchDtmOptions}
                  >
                    נסה שוב
                  </button>
                </div>
              )}
              
              {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length === 0 && (
                <div className="dtm-modal-empty">
                  {dtmSearchQuery ? (
                    <span>לא נמצאו קבצים התואמים לחיפוש "{dtmSearchQuery}"</span>
                  ) : (
                    <span>לא נמצאו קבצי DTM בתיקייה. ודא ש-DTM_DATA_DIR מוגדר נכון.</span>
                  )}
                </div>
              )}
              
              {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length > 0 && (
                <div className="dtm-options-list">
                  {filteredDtmOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="dtm-option-item"
                      onClick={() => handleSelectDtm(option.id, option.displayName)}
                    >
                      <div className="dtm-option-icon">
                        <Icon name="folder" />
                      </div>
                      <div className="dtm-option-info">
                        <div className="dtm-option-name">{option.displayName}</div>
                        <div className="dtm-option-meta">
                          <span>{formatFileSize(option.sizeBytes)}</span>
                          <span>•</span>
                          <span>{formatDate(option.modifiedAt)}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <div className="dtm-modal-footer">
              <span className="dtm-modal-count">
                {dtmOptions.length} קבצים זמינים
              </span>
            </div>
          </div>
        </div>
      )}

      {/* AOI Selection Overlay */}
      {isAoiSelectionMode && (
        <div className="aoi-selection-overlay">
          <div className="aoi-selection-panel">
            <div className="aoi-selection-header">
              <Icon name="crop" />
              <div className="aoi-selection-title">
                <h3>בחר אזור עבודה (AOI)</h3>
                <span className="aoi-selection-dtm">{selectedDtmId}</span>
              </div>
            </div>
            
            {/* Method Selection */}
            {!aoiSelectionMethod && (
              <div className="aoi-method-selection">
                <span className="aoi-method-label">בחר שיטת בחירה:</span>
                <div className="aoi-method-options">
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('bbox')}
                  >
                    <Icon name="rectangle" />
                    <span>מלבן (שתי לחיצות)</span>
                  </button>
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('polygon')}
                  >
                    <Icon name="polygon" />
                    <span>פוליגון (נקודות מרובות)</span>
                  </button>
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('kml')}
                  >
                    <Icon name="file" />
                    <span>טעינה מקובץ KML</span>
                  </button>
                </div>
              </div>
            )}

            {/* Active Method Instructions */}
            {aoiSelectionMethod && (
              <div className="aoi-selection-instructions">
                {aoiSelectionMethod === 'bbox' && !aoiBounds && (
                  <span>לחץ על המפה לקביעת הפינה הראשונה, ואז לחץ שוב לקביעת הפינה השנייה</span>
                )}
                {aoiSelectionMethod === 'polygon' && !aoiPolygon && (
                  <span>לחץ על המפה להוספת נקודות. לחץ פעמיים או לחץ על הנקודה הראשונה לסגירת הפוליגון</span>
                )}
                {aoiSelectionMethod === 'kml' && !aoiPolygon && (
                  <div className="aoi-kml-upload">
                    <input
                      ref={kmlInputRef}
                      type="file"
                      accept=".kml,.kmz"
                      onChange={handleKmlFileSelect}
                      style={{ display: 'none' }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => kmlInputRef.current?.click()}
                    >
                      <Icon name="upload" />
                      בחר קובץ KML
                    </button>
                  </div>
                )}
                
                {/* Show bounds info when bbox is selected */}
                {aoiBounds && (
                  <div className="aoi-bounds-info">
                    <div>מינ' רוחב: {aoiBounds.minLat.toFixed(6)}</div>
                    <div>מקס' רוחב: {aoiBounds.maxLat.toFixed(6)}</div>
                    <div>מינ' אורך: {aoiBounds.minLon.toFixed(6)}</div>
                    <div>מקס' אורך: {aoiBounds.maxLon.toFixed(6)}</div>
                  </div>
                )}
                
                {/* Show polygon info when polygon is selected */}
                {aoiPolygon && (
                  <div className="aoi-polygon-info">
                    <div>מספר נקודות: {aoiPolygon.coordinates.length}</div>
                    <div className="aoi-polygon-ready">✓ פוליגון מוכן</div>
                  </div>
                )}
              </div>
            )}
            
            <div className="aoi-selection-actions">
              {aoiSelectionMethod && (aoiBounds || aoiPolygon) && (
                <button
                  type="button"
                  className="btn btn-tertiary"
                  onClick={handleResetAoiSelection}
                  disabled={isClipping}
                >
                  שרטט מחדש
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCancelAoiSelection}
                disabled={isClipping}
              >
                ביטול
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleClipDtm}
                disabled={(!aoiBounds && !aoiPolygon) || isClipping}
              >
                {isClipping ? (
                  <>
                    <div className="loading-spinner-small" />
                    חותך...
                  </>
                ) : (
                  'טען אזור נבחר'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clipping Progress Overlay */}
      {isClipping && (
        <div className="upload-progress-overlay">
          <div className="upload-progress-container">
            <div className="loading-spinner" />
            <div className="upload-progress-label">חותך DTM לאזור הנבחר...</div>
          </div>
        </div>
      )}

      {/* DTM Options Modal */}
      {showDtmOptionsModal && (
        <div className="dtm-modal-overlay" onClick={handleCloseDtmOptionsModal}>
          <div className="dtm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dtm-modal-header">
              <h2>בחר קובץ DTM</h2>
              <button
                type="button"
                className="btn btn-icon btn-tertiary"
                onClick={handleCloseDtmOptionsModal}
                aria-label="סגור"
              >
                <Icon name="close" />
              </button>
            </div>
            
            <div className="dtm-modal-search">
              <Icon name="search" />
              <input
                type="text"
                placeholder="חיפוש קובץ DTM..."
                value={dtmSearchQuery}
                onChange={(e) => setDtmSearchQuery(e.target.value)}
                autoFocus
              />
            </div>

            <div className="dtm-modal-content">
              {dtmOptionsLoading && (
                <div className="dtm-modal-loading">
                  <div className="loading-spinner" />
                  <span>טוען רשימת DTM...</span>
                </div>
              )}
              
              {dtmOptionsError && (
                <div className="dtm-modal-error">
                  <span>⚠️ {dtmOptionsError}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={fetchDtmOptions}
                  >
                    נסה שוב
                  </button>
                </div>
              )}
              
              {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length === 0 && (
                <div className="dtm-modal-empty">
                  {dtmSearchQuery ? (
                    <span>לא נמצאו קבצים התואמים לחיפוש "{dtmSearchQuery}"</span>
                  ) : (
                    <span>לא נמצאו קבצי DTM בתיקייה. ודא ש-DTM_DATA_DIR מוגדר נכון.</span>
                  )}
                </div>
              )}
              
              {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length > 0 && (
                <div className="dtm-options-list">
                  {filteredDtmOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="dtm-option-item"
                      onClick={() => handleSelectDtm(option.id)}
                    >
                      <div className="dtm-option-icon">
                        <Icon name="folder" />
                      </div>
                      <div className="dtm-option-info">
                        <div className="dtm-option-name">{option.displayName}</div>
                        <div className="dtm-option-meta">
                          <span>{formatFileSize(option.sizeBytes)}</span>
                          <span>•</span>
                          <span>{formatDate(option.modifiedAt)}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <div className="dtm-modal-footer">
              <span className="dtm-modal-count">
                {dtmOptions.length} קבצים זמינים
              </span>
            </div>
          </div>
        </div>
      )}

      {/* AOI Selection Overlay */}
      {isAoiSelectionMode && (
        <div className="aoi-selection-overlay">
          <div className="aoi-selection-panel">
            <div className="aoi-selection-header">
              <Icon name="crop" />
              <div className="aoi-selection-title">
                <h3>בחר אזור עבודה (AOI)</h3>
                <span className="aoi-selection-dtm">{selectedDtmId}</span>
              </div>
            </div>
            
            {/* Method Selection */}
            {!aoiSelectionMethod && (
              <div className="aoi-method-selection">
                <span className="aoi-method-label">בחר שיטת בחירה:</span>
                <div className="aoi-method-options">
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('bbox')}
                  >
                    <Icon name="rectangle" />
                    <span>מלבן (שתי לחיצות)</span>
                  </button>
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('polygon')}
                  >
                    <Icon name="polygon" />
                    <span>פוליגון (נקודות מרובות)</span>
                  </button>
                  <button
                    type="button"
                    className="aoi-method-btn"
                    onClick={() => setAoiSelectionMethod('kml')}
                  >
                    <Icon name="file" />
                    <span>טעינה מקובץ KML</span>
                  </button>
                </div>
              </div>
            )}

            {/* Active Method Instructions */}
            {aoiSelectionMethod && (
              <div className="aoi-selection-instructions">
                {aoiSelectionMethod === 'bbox' && !aoiBounds && (
                  <span>לחץ על המפה לקביעת הפינה הראשונה, ואז לחץ שוב לקביעת הפינה השנייה</span>
                )}
                {aoiSelectionMethod === 'polygon' && !aoiPolygon && (
                  <span>לחץ על המפה להוספת נקודות. לחץ פעמיים או לחץ על הנקודה הראשונה לסגירת הפוליגון</span>
                )}
                {aoiSelectionMethod === 'kml' && !aoiPolygon && (
                  <div className="aoi-kml-upload">
                    <input
                      ref={kmlInputRef}
                      type="file"
                      accept=".kml,.kmz"
                      onChange={handleKmlFileSelect}
                      style={{ display: 'none' }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => kmlInputRef.current?.click()}
                    >
                      <Icon name="upload" />
                      בחר קובץ KML
                    </button>
                  </div>
                )}
                
                {/* Show bounds info when bbox is selected */}
                {aoiBounds && (
                  <div className="aoi-bounds-info">
                    <div>מינ' רוחב: {aoiBounds.minLat.toFixed(6)}</div>
                    <div>מקס' רוחב: {aoiBounds.maxLat.toFixed(6)}</div>
                    <div>מינ' אורך: {aoiBounds.minLon.toFixed(6)}</div>
                    <div>מקס' אורך: {aoiBounds.maxLon.toFixed(6)}</div>
                  </div>
                )}
                
                {/* Show polygon info when polygon is selected */}
                {aoiPolygon && (
                  <div className="aoi-polygon-info">
                    <div>מספר נקודות: {aoiPolygon.coordinates.length}</div>
                    <div className="aoi-polygon-ready">✓ פוליגון מוכן</div>
                  </div>
                )}
              </div>
            )}
            
            <div className="aoi-selection-actions">
              {aoiSelectionMethod && (aoiBounds || aoiPolygon) && (
                <button
                  type="button"
                  className="btn btn-tertiary"
                  onClick={handleResetAoiSelection}
                  disabled={isClipping}
                >
                  שרטט מחדש
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCancelAoiSelection}
                disabled={isClipping}
              >
                ביטול
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleClipDtm}
                disabled={(!aoiBounds && !aoiPolygon) || isClipping}
              >
                {isClipping ? (
                  <>
                    <div className="loading-spinner-small" />
                    חותך...
                  </>
                ) : (
                  'טען אזור נבחר'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clipping Progress Overlay */}
      {isClipping && (
        <div className="upload-progress-overlay">
          <div className="upload-progress-container">
            <div className="loading-spinner" />
            <div className="upload-progress-label">חותך DTM לאזור הנבחר...</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapPanel;
