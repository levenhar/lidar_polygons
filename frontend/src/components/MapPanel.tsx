import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
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
import SuccessNotification from './SuccessNotification';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination, generateUTurnPoints, generateUTurnPointsBetweenAhead, UTurnSide, calculateDistance, calculateBearing, calculateNextLineSpacing, calculateAverageNextLineSpacing, samplePointsAlongLine, calculateLineIntersection } from '../utils/geometry';
import { latLngToUTM } from '../utils/coordinates';
import { debug } from '../utils/debug';
import { ClimbConfig } from '../utils/climb';
import { saveFileWithLocation } from '../utils/fileSave';
import { buildViewshedTrajectory, interpolatePlannedAltitude } from '../utils/viewshedTrajectory';
import html2canvas from 'html2canvas';
import './MapPanel.css';
import { TileLayerOptions } from 'leaflet';
import { aoiContains, AOIGeometry } from '../utils/aoiContainment';
import ThreeDView from './ThreeDView';


type TileLayerOptionsWithAgent = TileLayerOptions;

// DTM Options types
interface DTMOption {
  id: string;
  displayName: string;
  sizeBytes: number;
  sizeMB?: number;
  modifiedAt: string;
  footprintBBox?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  resolution?: {
    width: number;
    height: number;
  };
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

// DTM loading state machine
type DtmLoadState = 'IDLE' | 'LOADING' | 'READY' | 'FAILED';

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

const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');

/** Default class colors when colormap is not used (fallback) */
const VIEWSHED_CLASS_COLORS_DEFAULT: Record<1 | 2 | 3 | 4, string> = {
  1: '#440154',
  2: '#31688e',
  3: '#35b779',
  4: '#fde725'
};

/** Sample colormap at normalized position (0–1), return RGB */
const getColorAtNormalized = (colormap: string, normalized: number) => {
  const stops = VIEWSHED_COLORMAPS[colormap]?.stops ?? VIEWSHED_COLORMAPS.jet.stops;
  const n = Math.min(1, Math.max(0, normalized));
  let lower = stops[0];
  let upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (n >= stops[i].pos && n <= stops[i + 1].pos) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }
  const t = (n - lower.pos) / (upper.pos - lower.pos || 1);
  const c1 = hexToRgb(lower.color);
  const c2 = hexToRgb(upper.color);
  return {
    r: lerp(c1.r, c2.r, t),
    g: lerp(c1.g, c2.g, t),
    b: lerp(c1.b, c2.b, t)
  };
};

/** Four hex colors for viewshed classes 1, 2, 3, 4+ sampled from the given colormap */
const getViewshedClassColorsFromColormap = (colormap: string): [string, string, string, string] => {
  const positions = [0.15, 0.4, 0.65, 0.9];
  return positions.map((pos) => {
    const { r, g, b } = getColorAtNormalized(colormap, pos);
    return rgbToHex(r, g, b);
  }) as [string, string, string, string];
};

const getViewshedClassColor = (
  value: number,
  noDataValue: number | null,
  classColors: [string, string, string, string]
): { r: number; g: number; b: number } | null => {
  if (noDataValue !== null && noDataValue !== undefined && value === noDataValue) return null;
  if (!Number.isFinite(value) || value < 1) return null;
  const classIndex = value >= 4 ? 3 : Math.floor(value) - 1; // 1->0, 2->1, 3->2, 4+->3
  const hex = classColors[classIndex] ?? VIEWSHED_CLASS_COLORS_DEFAULT[(classIndex + 1) as 1 | 2 | 3 | 4];
  const { r, g, b } = hexToRgb(hex);
  return { r, g, b };
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
  | 'uturn-between'
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
  | 'eye-off'
  | 'circle'
  | 'rotate'
  | 'chart'
  | 'refresh'
  | 'altitude'
  | 'cube';

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
    case 'uturn-between':
      return (
        <svg {...common}>
          <path {...stroke} d="M6 4v4" />
          <path {...stroke} d="M18 20v-4" />
          <path {...stroke} d="M6 8c0 4 3 7 6 8 3-1 6-4 6-8" />
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
    case 'circle':
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="10" />
        </svg>
      );
    case 'rotate':
      return (
        <svg {...common}>
          <path {...stroke} d="M4 10V4h6" />
          <path {...stroke} d="M20 14v6h-6" />
          <path {...stroke} d="M5 10a7 7 0 0 1 11.5-4.95L19 4" />
          <path {...stroke} d="M19 14a7 7 0 0 1-11.5 4.95L5 20" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <path {...stroke} d="M3 18v-6" />
          <path {...stroke} d="M9 18V12" />
          <path {...stroke} d="M15 18V6" />
          <path {...stroke} d="M21 18v-4" />
          <path {...stroke} d="M3 18h18" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path {...stroke} d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path {...stroke} d="M3 3v5h5" />
          <path {...stroke} d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path {...stroke} d="M21 21v-5h-5" />
        </svg>
      );
    case 'altitude':
      return (
        <svg {...common}>
          <path {...stroke} d="M12 3v18" />
          <path {...stroke} d="M6 9l6-6 6 6" />
          <path {...stroke} d="M6 15l6 6 6-6" />
        </svg>
      );
    case 'cube':
      return (
        <svg {...common}>
          <path {...stroke} d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path {...stroke} d="M3.27 6.96L12 12.01l8.73-5.05" />
          <path {...stroke} d="M12 22.08V12" />
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
  kmlImports?: Array<{
    id: string;
    name: string;
    points: Array<{ lng: number; lat: number; label: string }>;
    polygons: Array<{ coordinates: [number, number][]; name?: string }>;
    color: string;
    symbol: 'square' | 'circle' | 'triangle' | 'star' | 'diamond' | 'cross';
    visible: boolean;
  }>;
  onPathPointHover: (point: Coordinate | null, distance?: number) => void;
  onPathChange: (path: Coordinate[]) => void;
  onGroupMoveCommitted?: (path: Coordinate[]) => void;
  onDeleteAllPoints: () => void;
  onReverseFlightPath: () => void;
  onAddPoint: (point: Coordinate) => void;
  onAddPoints: (points: Coordinate[]) => void;
  onInsertPoints: (index: number, points: Coordinate[]) => void;
  onDeleteClimbsOnSegment?: (pointIdA: string, pointIdB: string) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onDeletePoint: (index: number) => void;
  onAddRoute: () => void;
  onActiveRouteChange: (routeId: string) => void;
  onRenameRoute: (routeId: string, name: string) => void;
  onRouteNominalFlightHeightChange: (routeId: string, height: number) => void;
  onRouteColorChange: (routeId: string, color: string) => void;
  onRouteLineWidthChange: (routeId: string, width: number) => void;
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
  // Props for DTM replacement feature
  currentAoi?: AOIGeometry | null;
  dtmSourceType?: 'local' | 'server' | null;
  onDisplaySettingsChange?: (settings: { palette: 'gray' | 'jet'; inverted: boolean; opacity: number }) => void;
  initialDisplaySettings?: { palette: 'gray' | 'jet'; inverted: boolean; opacity: number };
  nominalFlightHeight: number;
  safetyRadius: number;
  safetyHeight: number;
  overlapPercentage: number;
  fovDegrees: number;
  resolutionHeight: number;
  onUndo: () => void;
  canUndo: boolean;
  editPointIndex?: number | null;
  onEditPointIndexChange?: (index: number | null) => void;
  hoveredElevationPoint?: ElevationPoint | null;
  hoverSource?: 'map' | 'profile' | 'overlap' | null;
  onOverlapGraphPointHover?: (point: ElevationPoint | null) => void;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
  showNextLineSuggestions: boolean;
  onShowNextLineSuggestionsChange: (show: boolean) => void;
  climbRequests?: { endDistance: number; climbAmount: number }[];
  elevationProfile?: ElevationPoint[]; // Elevation profile with planned altitudes
  climbConfig?: ClimbConfig; // Climb configuration for vertex proximity circles
  // Export/Import props
  onExportClick: () => void;
  onImportKML: (file: File) => Promise<void>;
  canExport: boolean;
  zoomToBounds?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
  onRequestClimbAtDistance?: (distance: number) => void;
}

const MapPanel: React.FC<MapPanelProps> = ({
  dtmSource,
  clippedId: propClippedId,
  routes,
  activeRouteId,
  flightPath,
  onPathPointHover,
  onPathChange,
  onGroupMoveCommitted,
  onDeleteAllPoints,
  onReverseFlightPath,
  onAddPoint,
  onAddPoints,
  onInsertPoints,
  onDeleteClimbsOnSegment,
  onUpdatePoint,
  onDeletePoint,
  onAddRoute,
  onActiveRouteChange,
  onRenameRoute,
  onRouteNominalFlightHeightChange,
  onRouteColorChange,
  onRouteLineWidthChange,
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
  safetyRadius,
  safetyHeight,
  overlapPercentage,
  fovDegrees,
  resolutionHeight,
  onUndo,
  canUndo,
  climbMarkers,
  onShowClimbLabelsChange,
  showClimbLabels,
  editPointIndex: externalEditPointIndex,
  onEditPointIndexChange,
  hoveredElevationPoint,
  hoverSource,
  onOverlapGraphPointHover,
  showMetadata,
  onShowMetadataChange,
  showNextLineSuggestions,
  onShowNextLineSuggestionsChange,
  climbRequests: _climbRequests = [],
  elevationProfile = [],
  climbConfig,
  onExportClick,
  onImportKML,
  canExport,
  currentAoi,
  dtmSourceType: propDtmSourceType,
  zoomToBounds,
  kmlImports = [],
  onRequestClimbAtDistance
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
  // Ordered selection to preserve click order
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [parallelBatchOffset, setParallelBatchOffset] = useState<string>('');
  const [parallelBatchDirection, setParallelBatchDirection] = useState<'right' | 'left'>('right');
  const [isParallelBatchOffsetOverridden, setIsParallelBatchOffsetOverridden] = useState(false);
  const [parallelBatchError, setParallelBatchError] = useState<string | null>(null);
  
  // Draggable window state
  const [parallelWindowPosition, setParallelWindowPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingParallelWindow, setIsDraggingParallelWindow] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const parallelWindowRef = useRef<HTMLDivElement | null>(null);

  // 3D float window state
  const [threeDFloatPosition, setThreeDFloatPosition] = useState<{ x: number; y: number } | null>(null);
  const [threeDFloatSize, setThreeDFloatSize] = useState<{ w: number; h: number }>({ w: 640, h: 420 });
  const [isDraggingThreeDFloat, setIsDraggingThreeDFloat] = useState(false);
  const [isResizingThreeDFloat, setIsResizingThreeDFloat] = useState(false);
  const threeDFloatRef = useRef<HTMLDivElement | null>(null);
  const threeDFloatDragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const threeDFloatResizeStartRef = useRef<{ x: number; y: number; startW: number; startH: number } | null>(null);
  const lastParallelOffsetRef = useRef<number | null>(null);
  const lastParallelOffsetByLineIdRef = useRef<Map<string, number>>(new Map());
  const averageNextLineSpacingRef = useRef<number>(50); // Default fallback
  const prevParallelModeRef = useRef(false);
  const [successNotification, setSuccessNotification] = useState<{ isOpen: boolean; message: string }>({
    isOpen: false,
    message: ''
  });
  // DTM loading state machine (replaces dtmLoaded boolean)
  const [dtmLoadState, setDtmLoadState] = useState<DtmLoadState>('IDLE');
  const [dtmLoadError, setDtmLoadError] = useState<string | null>(null);
  const [dtmBounds, setDtmBounds] = useState<number[] | null>(null);
  
  // Backward compatibility: dtmLoaded is true only when state is READY
  const dtmLoaded = dtmLoadState === 'READY';
  
  // Polling refs to track and cancel polling
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingAbortRef = useRef<AbortController | null>(null);
  
  // Helper function to poll DTM readiness for clipped DTMs
  const pollDtmReadiness = useCallback(async (clippedId: string, maxAttempts: number = 120, initialDelay: number = 500): Promise<boolean> => {
    // Clear any existing polling
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingAbortRef.current) {
      pollingAbortRef.current.abort();
    }
    
    const abortController = new AbortController();
    pollingAbortRef.current = abortController;
    
    let attempt = 0;
    let delay = initialDelay;
    const maxDelay = 2000; // Maximum delay between polls
    
    const checkReadiness = async (): Promise<boolean> => {
      if (abortController.signal.aborted) {
        return false;
      }
      
      try {
        const response = await fetch(`/api/dtm/clipped/${clippedId}/ready`, {
          signal: abortController.signal
        });
        
        if (!response.ok) {
          if (attempt < maxAttempts) {
            return false; // Continue polling
          }
          throw new Error(`Readiness check failed: ${response.status}`);
        }
        
        const data = await response.json();
        if (data.ready === true) {
          debug.log(`DTM ${clippedId} is ready after ${attempt + 1} attempts`);
          return true;
        }
        
        return false; // Not ready yet, continue polling
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return false; // Polling was cancelled
        }
        
        if (attempt >= maxAttempts - 1) {
          throw error;
        }
        return false; // Continue polling on error
      }
    };
    
    // Poll with exponential backoff
    return new Promise((resolve, reject) => {
      const poll = async () => {
        if (abortController.signal.aborted) {
          resolve(false);
          return;
        }
        
        const isReady = await checkReadiness();
        
        if (isReady) {
          resolve(true);
          return;
        }
        
        attempt++;
        if (attempt >= maxAttempts) {
          reject(new Error(`DTM readiness timeout after ${maxAttempts} attempts (${(maxAttempts * delay) / 1000}s)`));
          return;
        }
        
        // Exponential backoff: increase delay gradually, but cap at maxDelay
        delay = Math.min(delay * 1.1, maxDelay);
        
        pollingIntervalRef.current = setTimeout(poll, delay);
      };
      
      // Start polling
      poll();
    });
  }, []);
  
  // Cleanup polling on unmount or when DTM source changes
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
        pollingAbortRef.current = null;
      }
    };
  }, []);
  const [dtmOpacity, setDtmOpacity] = useState<number>(initialDisplaySettings?.opacity ?? 0.1); // Default 90% transparency (10% opacity)
  const [dtmColorPalette, setDtmColorPalette] = useState<'gray' | 'jet'>(initialDisplaySettings?.palette ?? 'gray');
  const [dtmColorInverted, setDtmColorInverted] = useState<boolean>(initialDisplaySettings?.inverted ?? false);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState<boolean>(false);
  const [showVertexRadius, setShowVertexRadius] = useState<boolean>(true);
  const [showAzimuthDistanceLabels, setShowAzimuthDistanceLabels] = useState<boolean>(true);
  
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
  const vertexProximityCirclesRef = useRef<L.Circle[]>([]);
  const climbMarkersRef = useRef<L.Marker[]>([]);
  const importedPointsMarkersRef = useRef<L.Marker[]>([]);
  const importedPolygonsRef = useRef<L.Polygon[]>([]);

  // Helper function to generate icon HTML based on symbol type
  const getPointIconHtml = (symbol: 'square' | 'circle' | 'triangle' | 'star' | 'diamond' | 'cross', color: string): string => {
    const size = 18;
    const borderWidth = 2.5;
    const borderColor = '#ffffff';
    const shadow = '0 2px 6px rgba(0, 0, 0, 0.35)';

    switch (symbol) {
      case 'square':
        return `<span class="imported-point-marker__square" style="background-color: ${color}; border: ${borderWidth}px solid ${borderColor}; box-shadow: ${shadow}; transform: rotate(45deg);"></span>`;
      case 'circle':
        return `<span class="imported-point-marker__circle" style="background-color: ${color}; border: ${borderWidth}px solid ${borderColor}; box-shadow: ${shadow}; border-radius: 50%;"></span>`;
      case 'triangle':
        // Triangle using SVG for better control
        return `<svg class="imported-point-marker__triangle" width="${size}" height="${size}" viewBox="0 0 24 24" style="filter: drop-shadow(${shadow});">
          <path fill="${color}" stroke="${borderColor}" stroke-width="1.5" d="M12 2 L22 20 L2 20 Z"/>
        </svg>`;
      case 'star':
        // Star using SVG
        return `<svg class="imported-point-marker__star" width="${size}" height="${size}" viewBox="0 0 24 24" style="filter: drop-shadow(${shadow});">
          <path fill="${color}" stroke="${borderColor}" stroke-width="1.5" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>`;
      case 'diamond':
        return `<span class="imported-point-marker__diamond" style="background-color: ${color}; border: ${borderWidth}px solid ${borderColor}; box-shadow: ${shadow}; transform: rotate(45deg);"></span>`;
      case 'cross':
        // Cross using SVG with rounded ends
        return `<svg class="imported-point-marker__cross" width="${size}" height="${size}" viewBox="0 0 24 24" style="filter: drop-shadow(${shadow});">
          <line x1="12" y1="2" x2="12" y2="22" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
          <line x1="2" y1="12" x2="22" y2="12" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
          <line x1="12" y1="2" x2="12" y2="22" stroke="${borderColor}" stroke-width="2" stroke-linecap="round"/>
          <line x1="2" y1="12" x2="22" y2="12" stroke="${borderColor}" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
      default:
        return `<span class="imported-point-marker__square" style="background-color: ${color}; border: ${borderWidth}px solid ${borderColor}; box-shadow: ${shadow}; transform: rotate(45deg);"></span>`;
    }
  };
  const flightPathLineRef = useRef<L.Polyline | null>(null);
  const flightPathClickableLineRef = useRef<L.Polyline | null>(null);
  const flightPathBufferRef = useRef<L.Polyline | null>(null);
  const selectedLineHalosRef = useRef<L.Polyline[]>([]);
  const segmentLengthLabelsRef = useRef<L.Marker[]>([]);
  const hoveredPointRef = useRef<number | null>(null);
  const justFinishedDraggingRef = useRef<boolean>(false);
  const lastRightClickTimeRef = useRef<number>(0);
  // Multi-select state
  const [selectedPointIndices, setSelectedPointIndices] = useState<Set<number>>(new Set());
  const dragStartPositionsRef = useRef<Map<number, Coordinate>>(new Map());
  const isGroupDraggingRef = useRef<boolean>(false);
  const isMarkerDragActiveRef = useRef<boolean>(false);
  // Rotate mode state
  const [isRotateMode, setIsRotateMode] = useState<boolean>(false);
  const isRotatingRef = useRef<boolean>(false);
  const rotateCenterRef = useRef<{ lat: number; lng: number } | null>(null);
  const rotateCenterUtmRef = useRef<{
    easting: number;
    northing: number;
    zone: number;
    hemisphere: 'N' | 'S';
  } | null>(null);
  const rotateStartAngleRef = useRef<number | null>(null);
  const rotateInitialPointsRef = useRef<Coordinate[] | null>(null);
  const dtmImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const dtmBoundaryRef = useRef<L.Rectangle | null>(null);
  const viewshedImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const basemapToggleRef = useRef<HTMLButtonElement | null>(null);
  const routesPanelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hoveredElevationMarkerRef = useRef<L.Marker | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [routeContextMenu, setRouteContextMenu] = useState<{ x: number; y: number; distance: number } | null>(null);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isDtmProcessing, setIsDtmProcessing] = useState<boolean>(false);
  const [baseMaps, setBaseMaps] = useState<BaseMapConfig[]>([]);
  const [activeBaseMapId, setActiveBaseMapId] = useState<string | null>(null);
  const [threeDActiveBaseMapId, setThreeDActiveBaseMapId] = useState<string | null>(null);
  const [mapToken, setMapToken] = useState<string>('');
  const [previewConfig, setPreviewConfig] = useState<BaseMapPreviewResponse | null>(null);
  const [isInfoMode, setIsInfoMode] = useState<boolean>(false);
  const [threeDMode, setThreeDMode] = useState<'off' | 'full' | 'float'>('off');
  const is3DFull = threeDMode === 'full';
  const is3DFloat = threeDMode === 'float';
  const [cursorElevation, setCursorElevation] = useState<{ elevation: number | null; lat: number; lng: number } | null>(null);
  const elevationQueryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const elevationCacheRef = useRef<Map<string, number | null>>(new Map());
  // Measurement tools state
  const [isCoordMode, setIsCoordMode] = useState<boolean>(false);
  const [isMeasureLengthMode, setIsMeasureLengthMode] = useState<boolean>(false);
  const [isAzimuthMode, setIsAzimuthMode] = useState<boolean>(false);
  const [coordModePos, setCoordModePos] = useState<{ lat: number; lng: number; x: number; y: number } | null>(null);
  const [measurePoint1, setMeasurePoint1] = useState<{ lat: number; lng: number } | null>(null);
  const [, setMeasureResult] = useState<{ distance: number; azimuth?: number } | null>(null);
  const measureLineRef = useRef<L.Polyline | null>(null);
  const measureMarker1Ref = useRef<L.CircleMarker | null>(null);
  const measureMarker2Ref = useRef<L.CircleMarker | null>(null);
  const measureLabelRef = useRef<L.Marker | null>(null);
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
  const infoModeTooltipRef = useRef<HTMLDivElement>(null);
  const [infoModeTooltipPosition, setInfoModeTooltipPosition] = useState<{ left: number; top: number } | null>(null);
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

  // Overlap graph float window (after viewshed done) — data comes from viewshed job status when done
  const [overlapGraphWindowOpen, setOverlapGraphWindowOpen] = useState(false);
  const [viewshedOverlapByPoint, setViewshedOverlapByPoint] = useState<Record<string, [number, number][]> | null>(null);
  /** Per-pair distances: same keys as overlap (e.g. "1-3", "2-4"), value = list of distances for that pair */
  const [viewshedPointDistances, setViewshedPointDistances] = useState<Record<string, number[]> | null>(null);
  const [overlapGraphLoading, setOverlapGraphLoading] = useState(false);
  const [overlapGraphError, setOverlapGraphError] = useState<string | null>(null);
  const overlapChartRef = useRef<HTMLDivElement | null>(null);
  const [overlapGraphWindowPosition, setOverlapGraphWindowPosition] = useState<{ x: number; y: number } | null>(null);
  const [overlapGraphWindowSize, setOverlapGraphWindowSize] = useState<{ width: number; height: number } | null>(null);
  const [isDraggingOverlapGraphWindow, setIsDraggingOverlapGraphWindow] = useState(false);
  const [isResizingOverlapGraphWindow, setIsResizingOverlapGraphWindow] = useState(false);
  const overlapGraphDragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const overlapGraphResizeStartRef = useRef<{ x: number; y: number; startWidth: number; startHeight: number } | null>(null);
  const overlapGraphWindowRef = useRef<HTMLDivElement | null>(null);

  const OVERLAP_GRAPH_MIN_WIDTH = 280;
  const OVERLAP_GRAPH_MAX_WIDTH = 600;
  const OVERLAP_GRAPH_MIN_HEIGHT = 260;
  const OVERLAP_GRAPH_MAX_HEIGHT = 400;
  const OVERLAP_GRAPH_DEFAULT_WIDTH = 340;
  const OVERLAP_GRAPH_DEFAULT_HEIGHT = 320;

  // Height limitation visualization (output/safety altitude compliance)
  const HEIGHT_LIMITATION_COLORS = { green: '#2ecc71', yellow: '#f39c12', red: '#e74c3c' } as const;
  const HEIGHT_LIMITATION_THRESHOLD_M = 10;
  const [heightLimitationWindowOpen, setHeightLimitationWindowOpen] = useState(false);
  const [heightLimitationMode, setHeightLimitationMode] = useState<'output' | 'safety'>('output');
  const [heightLimitationWindowPosition, setHeightLimitationWindowPosition] = useState<{ x: number; y: number } | null>(null);
  const [heightLimitationWindowSize, setHeightLimitationWindowSize] = useState<{ width: number; height: number } | null>(null);
  const [isDraggingHeightLimitationWindow, setIsDraggingHeightLimitationWindow] = useState(false);
  const [isResizingHeightLimitationWindow, setIsResizingHeightLimitationWindow] = useState(false);
  const heightLimitationDragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const heightLimitationResizeStartRef = useRef<{ x: number; y: number; startWidth: number; startHeight: number } | null>(null);
  const heightLimitationWindowRef = useRef<HTMLDivElement | null>(null);
  const heightLimitationMarkersRef = useRef<L.CircleMarker[]>([]);
  const HEIGHT_LIMITATION_DEFAULT_WIDTH = 300;
  const HEIGHT_LIMITATION_DEFAULT_HEIGHT = 360;
  const HEIGHT_LIMITATION_MIN_WIDTH = 260;
  const HEIGHT_LIMITATION_MIN_HEIGHT = 300;

  // ============================================================================
  // UNIFIED DTM LOADER STATE
  // ============================================================================
  const [dtmLoaderOpen, setDtmLoaderOpen] = useState(false);
  const [dtmLoaderStep, setDtmLoaderStep] = useState<DtmLoaderStep>('source-choice');
  // @ts-ignore - dtmSourceType is used for tracking selected source
  const [dtmSourceType, setDtmSourceType] = useState<DtmSourceType>(null);
  
  // DTM replacement state
  const [isReplacingDtm, setIsReplacingDtm] = useState(false);
  const [replacementAbortController, setReplacementAbortController] = useState<AbortController | null>(null);
  const [containmentWarning, setContainmentWarning] = useState<{ isOpen: boolean }>({ isOpen: false });
  
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

  const segmentIdByIndex = useMemo(() => {
    const ids: string[] = [];
    for (let i = 0; i < flightPath.length - 1; i++) {
      const a = flightPath[i];
      const b = flightPath[i + 1];
      const aId = a?.id ?? `idx-${i}`;
      const bId = b?.id ?? `idx-${i + 1}`;
      ids.push(`${aId}->${bId}`);
    }
    return ids;
  }, [flightPath]);

  const segmentIndexById = useMemo(() => {
    const m = new Map<string, number>();
    segmentIdByIndex.forEach((id, idx) => m.set(id, idx));
    return m;
  }, [segmentIdByIndex]);

  /** When exactly two consecutive points are selected, yields { startIndex }; otherwise null. */
  const consecutiveUTurnSelection = useMemo(() => {
    if (selectedPointIndices.size !== 2 || flightPath.length < 2) return null;
    const [a, b] = Array.from(selectedPointIndices).sort((x, y) => x - y);
    if (b - a !== 1) return null;
    return { startIndex: a };
  }, [selectedPointIndices, flightPath.length]);

  // Average spacing is calculated in the useEffect that renders suggestions
  // and stored in averageNextLineSpacingRef to use the same AGL calculations

  const computeDefaultOffsetForSegmentIndex = useCallback(
    (segmentIndex: number): number => {
      // Check if DTM is available - required for accurate AGL calculation
      if (!dtmRasterDataRef.current) {
        throw new Error('DTM is required for parallel line distance calculation. Please load DTM first.');
      }

      const segmentStart = flightPath[segmentIndex];
      const segmentEnd = flightPath[segmentIndex + 1];
      if (!segmentStart || !segmentEnd) return averageNextLineSpacingRef.current;

      const avgAGL = computeAvgAGLForSegment(
        segmentStart,
        segmentEnd,
        segmentIndex,
        segmentIndex + 1,
        nominalFlightHeight
      );

      // If AGL calculation failed (returns null), DTM is required
      if (avgAGL === null) {
        throw new Error('DTM is required for parallel line distance calculation. Please load DTM first.');
      }

      const effectiveAGL = avgAGL;

      const calculatedSpacing = calculateNextLineSpacing(overlapPercentage, fovDegrees, effectiveAGL);
      return calculatedSpacing !== null && calculatedSpacing > 0
        ? Math.round(calculatedSpacing * 10) / 10
        : averageNextLineSpacingRef.current;
    },
    // NOTE: computeAvgAGLForSegment is declared later in this file.
    // We intentionally don't include it in deps to avoid TDZ issues and because it's a stable callback.
    // However, we MUST include _climbRequests and elevationProfile to ensure the callback is recreated
    // when these change, so it uses the updated computeAvgAGLForSegment function.
    [flightPath, fovDegrees, nominalFlightHeight, overlapPercentage, _climbRequests, elevationProfile]
  );

  const getSuggestedDistanceForLine = useCallback(
    (lineId: string): number => {
      // Check if DTM is available
      if (!dtmRasterDataRef.current) {
        // Return a default value but this should be caught by validation before use
        throw new Error('DTM is required for parallel line distance calculation. Please load DTM first.');
      }

      // First check if there's a per-line cached value (from previous parallel line operations)
      const perLine = lastParallelOffsetByLineIdRef.current.get(lineId);
      if (typeof perLine === 'number' && isFinite(perLine)) return perLine;
      
      // Get the segment index for this line
      const idx = segmentIndexById.get(lineId);
      if (idx === undefined) {
        // Fallback if we can't identify the line
        return lastParallelOffsetRef.current !== null && isFinite(lastParallelOffsetRef.current)
          ? lastParallelOffsetRef.current
          : averageNextLineSpacingRef.current;
      }
      
      // For each line, calculate its own relevant distance based on that specific line segment
      // This ensures each line gets the spacing appropriate for its own AGL and characteristics
      // We always calculate for the specific line, not using cached values
      try {
        return computeDefaultOffsetForSegmentIndex(idx);
      } catch (error) {
        // If DTM is not available, throw the error
        throw error;
      }
    },
    [computeDefaultOffsetForSegmentIndex, segmentIndexById]
  );

  // Load parallel window position from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('parallelLinesWindowPosition');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          // Clamp to viewport on load
          const clampedX = Math.max(0, Math.min(parsed.x, window.innerWidth - 300));
          const clampedY = Math.max(0, Math.min(parsed.y, window.innerHeight - 200));
          setParallelWindowPosition({ x: clampedX, y: clampedY });
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  // Load 3D float window position from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('threeDFloatWindowPosition');
      if (saved) {
        const p = JSON.parse(saved);
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          setThreeDFloatPosition({ x: Math.max(0, Math.min(p.x, window.innerWidth - 200)), y: Math.max(0, Math.min(p.y, window.innerHeight - 100)) });
        }
      }
    } catch (e) { /* ignore */ }
  }, []);

  // Save 3D float window position to localStorage when it changes
  useEffect(() => {
    if (threeDFloatPosition) {
      try { localStorage.setItem('threeDFloatWindowPosition', JSON.stringify(threeDFloatPosition)); } catch (e) { /* ignore */ }
    }
  }, [threeDFloatPosition]);

  // Save parallel window position to localStorage when it changes
  useEffect(() => {
    if (parallelWindowPosition) {
      try {
        localStorage.setItem('parallelLinesWindowPosition', JSON.stringify(parallelWindowPosition));
      } catch (e) {
        // Ignore storage errors
      }
    }
  }, [parallelWindowPosition]);

  // Load overlap graph window position and size from localStorage on mount
  useEffect(() => {
    try {
      const savedPos = localStorage.getItem('overlapGraphWindowPosition');
      if (savedPos) {
        const parsed = JSON.parse(savedPos);
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const w = 380;
          const h = 440;
          const clampedX = Math.max(0, Math.min(parsed.x, window.innerWidth - w));
          const clampedY = Math.max(0, Math.min(parsed.y, window.innerHeight - h));
          setOverlapGraphWindowPosition({ x: clampedX, y: clampedY });
        }
      }
      const savedSize = localStorage.getItem('overlapGraphWindowSize');
      if (savedSize) {
        const parsed = JSON.parse(savedSize);
        if (parsed && typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          const w = Math.max(OVERLAP_GRAPH_MIN_WIDTH, Math.min(OVERLAP_GRAPH_MAX_WIDTH, parsed.width));
          const h = Math.max(OVERLAP_GRAPH_MIN_HEIGHT, Math.min(OVERLAP_GRAPH_MAX_HEIGHT, parsed.height));
          setOverlapGraphWindowSize({ width: w, height: h });
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  // Save overlap graph window position to localStorage when it changes
  useEffect(() => {
    if (overlapGraphWindowPosition) {
      try {
        localStorage.setItem('overlapGraphWindowPosition', JSON.stringify(overlapGraphWindowPosition));
      } catch (e) {
        // Ignore storage errors
      }
    }
  }, [overlapGraphWindowPosition]);

  // Save overlap graph window size to localStorage when it changes
  useEffect(() => {
    if (overlapGraphWindowSize) {
      try {
        localStorage.setItem('overlapGraphWindowSize', JSON.stringify(overlapGraphWindowSize));
      } catch (e) {
        // Ignore storage errors
      }
    }
  }, [overlapGraphWindowSize]);

  // Set overlap graph error when window opens but no data
  useEffect(() => {
    if (!overlapGraphWindowOpen) return;
    setOverlapGraphLoading(false);
    if (viewshedOverlapByPoint && Object.keys(viewshedOverlapByPoint).length > 0) {
      setOverlapGraphError(null);
    } else {
      setOverlapGraphError('הרץ שדה ראייה כדי לראות את גרף החפיפה');
    }
  }, [overlapGraphWindowOpen, viewshedOverlapByPoint]);

  // Lookup: 1-based point index -> distance (m), built from per-pair data
  const pointIndexToDistanceMap = useMemo(() => {
    const byPair = viewshedPointDistances;
    const overlap = viewshedOverlapByPoint;
    if (!byPair || typeof byPair !== 'object' || !overlap || typeof overlap !== 'object') return null;
    const map = new Map<number, number>();
    Object.keys(overlap).forEach((label) => {
      const pts = overlap[label] ?? [];
      const dists = byPair[label];
      if (!Array.isArray(dists) || dists.length !== pts.length) return;
      pts.forEach(([idx1Based], i) => {
        if (typeof dists[i] === 'number') map.set(idx1Based, dists[i]);
      });
    });
    return map;
  }, [viewshedPointDistances, viewshedOverlapByPoint]);

  // Convert overlap point index to ElevationPoint for hover sync
  const pointIndexToElevationPoint = useCallback((pointIndex: number): ElevationPoint | null => {
    const map = pointIndexToDistanceMap;
    const profile = elevationProfile;
    if (!map || pointIndex < 0 || !profile.length) return null;
    const distance = map.get(pointIndex + 1);
    if (distance === undefined) return null;
    const minD = profile[0]?.distance ?? 0;
    const maxD = profile[profile.length - 1]?.distance ?? 0;
    const clampedDist = Math.max(minD, Math.min(maxD, distance));
    for (let i = 0; i < profile.length - 1; i++) {
      const p1 = profile[i];
      const p2 = profile[i + 1];
      if (clampedDist >= p1.distance && clampedDist <= p2.distance) {
        const t = p1.distance === p2.distance ? 0 : (clampedDist - p1.distance) / (p2.distance - p1.distance);
        return {
          distance: clampedDist,
          latitude: p1.latitude + (p2.latitude - p1.latitude) * t,
          longitude: p1.longitude + (p2.longitude - p1.longitude) * t,
          elevation: p1.elevation + (p2.elevation - p1.elevation) * t,
          ...(p1.plannedAltitude != null && p2.plannedAltitude != null && { plannedAltitude: p1.plannedAltitude + (p2.plannedAltitude - p1.plannedAltitude) * t }),
          ...(p1.flightHeight != null && p2.flightHeight != null && { flightHeight: p1.flightHeight + (p2.flightHeight - p1.flightHeight) * t }),
        };
      }
    }
    return profile[0] ?? null;
  }, [pointIndexToDistanceMap, elevationProfile]);

  // Height limitation: per-point status and colors (output = max allowed, safety = min required)
  type HeightLimitStatus = 'green' | 'yellow' | 'red';
  const heightLimitationData = useMemo(() => {
    const profile = elevationProfile;
    const outMode = heightLimitationMode === 'output';
    const safeMode = heightLimitationMode === 'safety';
    if (!profile.length) {
      return {
        points: [] as Array<{
          index: number;
          lat: number;
          lng: number;
          flightAltitude: number;
          outputAltitude: number;
          safetyAltitude: number;
          outputStatus?: HeightLimitStatus;
          safetyStatus?: HeightLimitStatus;
          outputColor?: string;
          safetyColor?: string;
          excess: number;
          isWorst: boolean;
        }>,
        stats: { total: 0, green: 0, yellow: 0, red: 0 },
        outputLegend: null as { green: string; yellow: string; red: string } | null,
        safetyLegend: null as { green: string; yellow: string; red: string } | null
      };
    }
    const points: Array<{
      index: number;
      lat: number;
      lng: number;
      flightAltitude: number;
      outputAltitude: number;
      safetyAltitude: number;
      outputStatus?: HeightLimitStatus;
      safetyStatus?: HeightLimitStatus;
      outputColor?: string;
      safetyColor?: string;
      excess: number;
      isWorst: boolean;
    }> = [];
    let green = 0, yellow = 0, red = 0;
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      const flightAltitude = p.plannedAltitude;
      if (flightAltitude === undefined || !Number.isFinite(flightAltitude)) continue;
      const minElev = p.minElevation !== undefined ? p.minElevation : p.elevation;
      const maxElev = p.maxElevation !== undefined ? p.maxElevation : p.elevation;
      const outputAltitude = minElev + resolutionHeight;
      const safetyAltitude = maxElev + safetyHeight;
      let outputStatus: HeightLimitStatus | undefined;
      let safetyStatus: HeightLimitStatus | undefined;
      if (outMode) {
        if (flightAltitude < outputAltitude - HEIGHT_LIMITATION_THRESHOLD_M) outputStatus = 'green';
        else if (flightAltitude < outputAltitude) outputStatus = 'yellow';
        else outputStatus = 'red';
      }
      if (safeMode) {
        if (flightAltitude > safetyAltitude + HEIGHT_LIMITATION_THRESHOLD_M) safetyStatus = 'green';
        else if (flightAltitude > safetyAltitude) safetyStatus = 'yellow';
        else safetyStatus = 'red';
      }
      const outputColor = outputStatus ? HEIGHT_LIMITATION_COLORS[outputStatus] : undefined;
      const safetyColor = safetyStatus ? HEIGHT_LIMITATION_COLORS[safetyStatus] : undefined;
      // excess: how much the flight altitude exceeds the limit (positive = violation)
      const excess = outMode
        ? flightAltitude - outputAltitude   // output mode: too high above resolution limit
        : safetyAltitude - flightAltitude;  // safety mode: too close/below safety height
      points.push({
        index: i,
        lat: p.latitude,
        lng: p.longitude,
        flightAltitude,
        outputAltitude,
        safetyAltitude,
        outputStatus,
        safetyStatus,
        outputColor,
        safetyColor,
        excess,
        isWorst: false
      });
      // For stats: count worst status per point when both modes (spec: aggregate by color)
      const outC = outputStatus ? HEIGHT_LIMITATION_COLORS[outputStatus] : null;
      const safeC = safetyStatus ? HEIGHT_LIMITATION_COLORS[safetyStatus] : null;
      const isRed = outC === HEIGHT_LIMITATION_COLORS.red || safeC === HEIGHT_LIMITATION_COLORS.red;
      const isYellow = outC === HEIGHT_LIMITATION_COLORS.yellow || safeC === HEIGHT_LIMITATION_COLORS.yellow;
      if (isRed) red++;
      else if (isYellow) yellow++;
      else green++;
    }
    // Mark the single worst-offending point (highest positive excess)
    const worstCandidate = [...points].filter(p => p.excess > 0).sort((a, b) => b.excess - a.excess)[0];
    if (worstCandidate) worstCandidate.isWorst = true;

    // Legend: absolute heights above ground (AGL) in meters
    const out10 = resolutionHeight - HEIGHT_LIMITATION_THRESHOLD_M;
    const safe10 = safetyHeight + HEIGHT_LIMITATION_THRESHOLD_M;
    const outputLegend: { green: string; yellow: string; red: string } | null = heightLimitationMode === 'output' ? {
      green: `< ${Math.round(out10)} מ' מהקרקע`,
      yellow: `${Math.round(out10)} – ${Math.round(resolutionHeight)} מ' מהקרקע`,
      red: `≥ ${Math.round(resolutionHeight)} מ' מהקרקע`
    } : null;
    const safetyLegend: { green: string; yellow: string; red: string } | null = heightLimitationMode === 'safety' ? {
      green: `> ${Math.round(safe10)} מ' מהקרקע`,
      yellow: `${Math.round(safetyHeight)} – ${Math.round(safe10)} מ' מהקרקע`,
      red: `≤ ${Math.round(safetyHeight)} מ' מהקרקע`
    } : null;
    return { points, stats: { total: points.length, green, yellow, red }, outputLegend, safetyLegend };
  }, [elevationProfile, heightLimitationMode, safetyHeight, resolutionHeight]);

  // Sync height limitation circle markers to the map
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    heightLimitationMarkersRef.current.forEach(marker => m.removeLayer(marker));
    heightLimitationMarkersRef.current = [];
    if (!heightLimitationWindowOpen || heightLimitationData.points.length === 0) return;
    const { points } = heightLimitationData;
    const outMode = heightLimitationMode === 'output';
    const safeMode = heightLimitationMode === 'safety';
    let worstCircle: L.CircleMarker | null = null;
    points.forEach((pt) => {
      if (safeMode) {
        const isWorst = pt.isWorst;
        const fillColor = isWorst ? '#7f0000' : (pt.safetyColor ?? '#94a3b8');
        const circle = L.circleMarker([pt.lat, pt.lng], {
          radius: 10,
          color: fillColor,
          fillColor,
          fillOpacity: 0.9,
          weight: 2,
          opacity: 1
        });
        (circle as any).__heightLimitPoint = pt;
        circle.bindTooltip(() => {
          const x = (circle as any).__heightLimitPoint as typeof pt;
          const status = x.safetyStatus === 'green' ? 'תקין' : x.safetyStatus === 'yellow' ? 'אזהרה' : 'קריטי';
          const excessStr = x.excess > 0 ? ` | חריגה: ${x.excess.toFixed(1)}מ'` : '';
          return `נקודה ${x.index + 1} | גובה טיסה: ${x.flightAltitude.toFixed(1)}מ' | בטיחות: ${x.safetyAltitude.toFixed(1)}מ' | ${status}${excessStr}`;
        }, { direction: 'top', offset: [0, -8] });
        circle.addTo(m);
        heightLimitationMarkersRef.current.push(circle);
        if (isWorst) {
          worstCircle = circle;
          const label = L.marker([pt.lat, pt.lng], {
            icon: L.divIcon({
              className: '',
              html: `<div style="display:inline-block;background:rgba(127,0,0,0.85);color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;white-space:nowrap;transform:translate(-50%,-26px);pointer-events:none;border:1px solid #000;box-shadow:0 0 0 1px #000">+${pt.excess.toFixed(0)}מ'</div>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0]
            }),
            interactive: false,
            zIndexOffset: 1000
          });
          label.addTo(m);
          heightLimitationMarkersRef.current.push(label as unknown as L.CircleMarker);
        }
      }
      if (outMode) {
        const isWorst = pt.isWorst;
        const fillColor = isWorst ? '#7f0000' : (pt.outputColor ?? '#94a3b8');
        const circle = L.circleMarker([pt.lat, pt.lng], {
          radius: 10,
          color: fillColor,
          fillColor,
          fillOpacity: 0.95,
          weight: 2,
          opacity: 1
        });
        (circle as any).__heightLimitPoint = pt;
        circle.bindTooltip(() => {
          const x = (circle as any).__heightLimitPoint as typeof pt;
          const status = x.outputStatus === 'green' ? 'תקין' : x.outputStatus === 'yellow' ? 'אזהרה' : 'קריטי';
          const excessStr = x.excess > 0 ? ` | חריגה: ${x.excess.toFixed(1)}מ'` : '';
          return `נקודה ${x.index + 1} | גובה טיסה: ${x.flightAltitude.toFixed(1)}מ' | תוצר: ${x.outputAltitude.toFixed(1)}מ' | ${status}${excessStr}`;
        }, { direction: 'top', offset: [0, -8] });
        circle.addTo(m);
        heightLimitationMarkersRef.current.push(circle);
        if (isWorst) {
          worstCircle = circle;
          const label = L.marker([pt.lat, pt.lng], {
            icon: L.divIcon({
              className: '',
              html: `<div style="display:inline-block;background:rgba(127,0,0,0.85);color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;white-space:nowrap;transform:translate(-50%,-26px);pointer-events:none;border:1px solid #000;box-shadow:0 0 0 1px #000">+${pt.excess.toFixed(0)}מ'</div>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0]
            }),
            interactive: false,
            zIndexOffset: 1000
          });
          label.addTo(m);
          heightLimitationMarkersRef.current.push(label as unknown as L.CircleMarker);
        }
      }
    });
    // Bring worst circle to front after all markers are added
    if (worstCircle) (worstCircle as L.CircleMarker).bringToFront();
    return () => {
      heightLimitationMarkersRef.current.forEach(marker => {
        if (m && m.hasLayer(marker)) m.removeLayer(marker);
      });
      heightLimitationMarkersRef.current = [];
    };
  }, [heightLimitationWindowOpen, heightLimitationData.points, heightLimitationMode]);

  // Render overlap chart with D3 - overlap vs distance, lines only (uses per-pair distances)
  useEffect(() => {
    const container = overlapChartRef.current;
    if (!container || !overlapGraphWindowOpen || !viewshedOverlapByPoint || Object.keys(viewshedOverlapByPoint).length === 0 || !viewshedPointDistances || typeof viewshedPointDistances !== 'object') return;
    const labels = Object.keys(viewshedOverlapByPoint);
    const colors = ['#0ea5e9', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];
    const margin = { top: 12, right: 65, bottom: 32, left: 42 };
    const w = Math.max(180, (container.offsetWidth || 300) - margin.left - margin.right);
    const h = Math.max(120, (container.offsetHeight || 200) - margin.top - margin.bottom);
    d3.select(container).selectAll('*').remove();
    const svg = d3.select(container).append('svg').attr('width', w + margin.left + margin.right).attr('height', h + margin.top + margin.bottom);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const allPoints: { dist: number; overlap: number; label: string; idx: number }[] = [];
    labels.forEach((label) => {
      const pts = viewshedOverlapByPoint[label] ?? [];
      const dists = viewshedPointDistances[label];
      if (!Array.isArray(dists) || dists.length !== pts.length) return;
      pts.forEach(([idx1Based, val], i) => {
        const dist = dists[i];
        if (typeof dist !== 'number') return;
        allPoints.push({ dist, overlap: val, label, idx: idx1Based });
      });
    });
    if (allPoints.length === 0) return;
    const xExtent = d3.extent(allPoints, d => d.dist) as [number, number];
    const yExtent: [number, number] = [0, 100];
    const xScale = d3.scaleLinear().domain([xExtent[0], xExtent[1]]).range([0, w]);
    const yScale = d3.scaleLinear().domain(yExtent).range([h, 0]);
    const xAxis = d3.axisBottom(xScale).ticks(6);
    const yAxis = d3.axisLeft(yScale).ticks(5);
    g.append('g').attr('transform', `translate(0,${h})`).call(xAxis)
      .append('text').attr('x', w / 2).attr('y', 28).attr('fill', '#475569').attr('font-size', 10).attr('text-anchor', 'middle').text('Distance (m)');
    g.append('g').call(yAxis)
      .append('text').attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -32).attr('fill', '#475569').attr('font-size', 10).attr('text-anchor', 'middle').text('Overlap (%)');
    const line = d3.line<{ dist: number; overlap: number }>().x(d => xScale(d.dist)).y(d => yScale(d.overlap));
    labels.forEach((label, i) => {
      const pts = viewshedOverlapByPoint[label] ?? [];
      const dists = viewshedPointDistances[label];
      if (!Array.isArray(dists) || dists.length !== pts.length) return;
      const pathPts = pts
        .map(([, val], j) => ({ dist: dists[j], overlap: val }))
        .filter((d): d is { dist: number; overlap: number } => typeof d.dist === 'number')
        .sort((a, b) => a.dist - b.dist);
      if (pathPts.length === 0) return;
      const color = colors[i % colors.length];
      g.append('path').datum(pathPts).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('d', line);
    });
    // Legend — small colored square with label centered inside; scrollable when many legs
    const swatchSize = 24;
    const rowH = swatchSize + 4;
    const maxVisibleRows = 5;
    const legendW = 56;
    const fullLegendH = labels.length * rowH;
    const legendH = Math.min(fullLegendH, maxVisibleRows * rowH);
    const needsScroll = labels.length > maxVisibleRows;
    const legend = g.append('g').attr('class', 'legend').attr('transform', `translate(${w + 10}, 0)`);
    legend.append('rect').attr('x', -4).attr('y', -2).attr('width', legendW + (needsScroll ? 10 : 0)).attr('height', legendH + 4).attr('fill', '#fff').attr('stroke', '#e2e8f0').attr('stroke-width', 1).attr('rx', 2);
    const fo = legend.append('foreignObject').attr('x', 0).attr('y', 0).attr('width', legendW + (needsScroll ? 10 : 0)).attr('height', legendH);
    const body = typeof document !== 'undefined' ? document.createElementNS('http://www.w3.org/1999/xhtml', 'div') : null;
    if (body) {
      body.style.cssText = 'display:flex;flex-direction:column;gap:4px;overflow-y:' + (needsScroll ? 'scroll' : 'visible') + ';overflow-x:hidden;max-height:' + legendH + 'px;padding:4px;box-sizing:border-box;scrollbar-width:thin;';
      labels.forEach((label, i) => {
        const color = colors[i % colors.length];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;flex-shrink:0;';
        const swatch = document.createElement('div');
        swatch.style.cssText = `width:${swatchSize}px;height:${swatchSize}px;background:${color};border:1px solid #94a3b8;border-radius:2px;color:#fff;font-size:9px;font-weight:600;display:flex;align-items:center;justify-content:center;`;
        swatch.textContent = label;
        row.appendChild(swatch);
        body.appendChild(row);
      });
      fo.node()?.appendChild(body);
    } else {
      labels.slice(0, maxVisibleRows).forEach((label, i) => {
        const color = colors[i % colors.length];
        const row = legend.append('g').attr('transform', `translate(4, ${4 + i * rowH})`);
        row.append('rect').attr('x', 0).attr('y', 0).attr('width', swatchSize).attr('height', swatchSize).attr('fill', color).attr('stroke', '#94a3b8').attr('stroke-width', 1).attr('rx', 2);
        row.append('text').attr('x', swatchSize / 2).attr('y', swatchSize / 2).attr('font-size', 9).attr('fill', '#fff').attr('text-anchor', 'middle').attr('dominant-baseline', 'central').style('font-weight', '600').text(label);
      });
    }
    const overlay = g.append('rect').attr('width', w).attr('height', h).attr('fill', 'none').attr('pointer-events', 'all');
    overlay.on('mousemove', function (evt: MouseEvent) {
      const [mx] = d3.pointer(evt, g.node() as SVGGElement);
      const xVal = xScale.invert(mx);
      let bestIdx: number | null = null;
      let bestDist = Infinity;
      for (const { dist, idx } of allPoints) {
        const d = Math.abs(dist - xVal);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }
      if (bestIdx !== null && onOverlapGraphPointHover) {
        const pt = pointIndexToElevationPoint(bestIdx - 1);
        onOverlapGraphPointHover(pt);
      }
    });
    overlay.on('mouseleave', () => {
      if (onOverlapGraphPointHover) onOverlapGraphPointHover(null);
    });
    return () => { d3.select(container).selectAll('*').remove(); };
  }, [overlapGraphWindowOpen, viewshedOverlapByPoint, viewshedPointDistances, overlapGraphWindowSize, pointIndexToElevationPoint, onOverlapGraphPointHover]);

  // Clear overlap hover when window closes
  useEffect(() => {
    if (!overlapGraphWindowOpen && onOverlapGraphPointHover) {
      onOverlapGraphPointHover(null);
    }
  }, [overlapGraphWindowOpen, onOverlapGraphPointHover]);

  // Zoom to bounds when zoomToBounds prop changes
  useEffect(() => {
    if (!zoomToBounds || !map.current) return;
    
    const bounds = L.latLngBounds(
      [zoomToBounds.minLat, zoomToBounds.minLon],
      [zoomToBounds.maxLat, zoomToBounds.maxLon]
    );
    
    map.current.fitBounds(bounds, { padding: [50, 50] });
  }, [zoomToBounds]);

  // Render AOI polygon from currentAoi prop
  useEffect(() => {
    if (!map.current) return;

    // Clear existing AOI polygon
    if (aoiPolygonRef.current) {
      map.current.removeLayer(aoiPolygonRef.current);
      aoiPolygonRef.current = null;
    }

    // Don't display AOI polygon if DTM is clipped (only show DTM itself)
    if (propClippedId) {
      return;
    }

    // Render polygon from currentAoi prop
    if (currentAoi && currentAoi.type === 'polygon' && currentAoi.polygon && currentAoi.polygon.length >= 3) {
      const latlngs = currentAoi.polygon.map(([lon, lat]) => [lat, lon] as [number, number]);
      aoiPolygonRef.current = L.polygon(latlngs, {
        color: '#3b82f6',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.2
      }).addTo(map.current);
    } else if (currentAoi && currentAoi.type === 'bbox' && currentAoi.bbox) {
      // Render bbox as rectangle
      const bounds = L.latLngBounds(
        [currentAoi.bbox.minLat, currentAoi.bbox.minLon],
        [currentAoi.bbox.maxLat, currentAoi.bbox.maxLon]
      );
      aoiPolygonRef.current = L.rectangle(bounds, {
        color: '#3b82f6',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.2
      }).addTo(map.current);
    }
  }, [currentAoi, propClippedId]);

  // Render polygons from all KML imports
  useEffect(() => {
    if (!map.current) return;

    // Clear existing imported polygons
    importedPolygonsRef.current.forEach(polygon => {
      map.current?.removeLayer(polygon);
    });
    importedPolygonsRef.current = [];

    // Render polygons from all KML imports
    kmlImports.filter(kml => kml.visible).forEach((kmlImport) => {
      kmlImport.polygons.forEach((polygon) => {
        if (polygon.coordinates.length >= 3) {
          const latlngs = polygon.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
          const leafletPolygon = L.polygon(latlngs, {
            color: kmlImport.color,
            weight: 2,
            fillColor: kmlImport.color,
            fillOpacity: 0.2
          }).addTo(map.current!);
          importedPolygonsRef.current.push(leafletPolygon);
        }
      });
    });
  }, [kmlImports]);

  // Keep batch distance default in sync with selection (unless user overrides)
  useEffect(() => {
    if (!isParallelLineMode) return;
    if (selectedLineIds.length === 0) {
      setParallelBatchError(null);
      setParallelBatchOffset('');
      setIsParallelBatchOffsetOverridden(false);
      return;
    }
    if (isParallelBatchOffsetOverridden) return;
    
    // Check if DTM is available
    if (!dtmRasterDataRef.current) {
      setParallelBatchError('טען DTM תחילה.');
      setParallelBatchOffset('');
      return;
    }
    
    // Use absolute values for averaging
    try {
      const offsets = selectedLineIds.map(getSuggestedDistanceForLine).map(Math.abs).filter((n) => isFinite(n));
      if (offsets.length === 0) {
        // Fallback to global default (absolute)
        const defaultOffset = Math.abs(lastParallelOffsetRef.current ?? 50);
        setParallelBatchOffset(defaultOffset.toFixed(1));
        setParallelBatchError(null);
        return;
      }
      const avg = offsets.reduce((sum, n) => sum + n, 0) / offsets.length;
      setParallelBatchOffset((Math.round(avg * 10) / 10).toFixed(1));
      setParallelBatchError(null);
    } catch (error) {
      setParallelBatchError('DTM נדרש לחישוב מרחק קוים מקבילים. אנא טען DTM תחילה.');
      setParallelBatchOffset('');
    }
  }, [
    getSuggestedDistanceForLine,
    isParallelBatchOffsetOverridden,
    isParallelLineMode,
    selectedLineIds,
    nominalFlightHeight,
    _climbRequests
  ]);

  // Clear cached parallel offset values when entrance height changes
  // This ensures fresh calculations with the new height
  useEffect(() => {
    lastParallelOffsetRef.current = null;
    lastParallelOffsetByLineIdRef.current.clear();
    // Trigger recalculation if in parallel mode
    if (isParallelLineMode && selectedLineIds.length > 0) {
      setIsParallelBatchOffsetOverridden(false);
    }
  }, [nominalFlightHeight, isParallelLineMode, selectedLineIds]);

  // Clear cached parallel offset values when parallel mode is reactivated
  // This ensures fresh calculations when re-entering parallel mode
  useEffect(() => {
    const wasInParallelMode = prevParallelModeRef.current;
    prevParallelModeRef.current = isParallelLineMode;
    
    // If we just entered parallel mode (was false, now true)
    if (!wasInParallelMode && isParallelLineMode) {
      lastParallelOffsetRef.current = null;
      lastParallelOffsetByLineIdRef.current.clear();
      setIsParallelBatchOffsetOverridden(false);
    }
  }, [isParallelLineMode]);

  // Clear cached parallel offset values when climb points change
  // This ensures fresh calculations with updated climb constraints
  useEffect(() => {
    if (isParallelLineMode) {
      lastParallelOffsetRef.current = null;
      lastParallelOffsetByLineIdRef.current.clear();
      // Trigger recalculation if lines are selected
      if (selectedLineIds.length > 0) {
        setIsParallelBatchOffsetOverridden(false);
      }
    }
  }, [_climbRequests, isParallelLineMode, selectedLineIds]);

  // Clear cached parallel offset values when flight path is edited
  // This ensures fresh calculations with updated line geometry
  useEffect(() => {
    if (isParallelLineMode) {
      lastParallelOffsetRef.current = null;
      lastParallelOffsetByLineIdRef.current.clear();
      // Trigger recalculation if lines are selected
      if (selectedLineIds.length > 0) {
        setIsParallelBatchOffsetOverridden(false);
      }
    }
  }, [flightPath, isParallelLineMode, selectedLineIds]);

  // Reset selection state when leaving parallel tool
  useEffect(() => {
    if (!isParallelLineMode) {
      setSelectedLineIds([]);
      setParallelBatchError(null);
      setParallelBatchOffset('');
      setParallelBatchDirection('right');
      setIsParallelBatchOffsetOverridden(false);
    }
  }, [isParallelLineMode]);

  const createParallelLineForSegmentIndex = useCallback(
    (segmentIndex: number, offset: number): { ok: true; points: Coordinate[] } | { ok: false; error: string } => {
      if (segmentIndex < 0 || segmentIndex >= flightPath.length - 1) {
        return { ok: false, error: 'בחר מקטע שוב.' };
      }
      if (!isFinite(offset)) {
        return { ok: false, error: 'נדרש היסט.' };
      }
      const segmentStart = flightPath[segmentIndex];
      const segmentEnd = flightPath[segmentIndex + 1];
      if (!segmentStart || !segmentEnd) {
        return { ok: false, error: 'בחר מקטע שוב.' };
      }
      const [parallelStart, parallelEnd] = calculateParallelLine(segmentStart, segmentEnd, offset);
      if (
        isPointWithinBounds(parallelStart.lng, parallelStart.lat) &&
        isPointWithinBounds(parallelEnd.lng, parallelEnd.lat)
      ) {
        // Keep existing behavior: add two points forming the parallel segment
        return { ok: true, points: [parallelEnd, parallelStart] };
      }
      return { ok: false, error: 'היסט יוצא מ-DTM.' };
    },
    // NOTE: isPointWithinBounds is declared later in this file; omit from deps to avoid TDZ issues.
    [flightPath]
  );

  const clearSelectedLines = useCallback(() => {
    setSelectedLineIds([]);
    setParallelBatchError(null);
    setParallelBatchOffset('');
    setIsParallelBatchOffsetOverridden(false);
  }, []);

  // Reset parallel window position to default
  const resetParallelWindowPosition = useCallback(() => {
    const defaultX = window.innerWidth - 320; // Right side with some margin
    const defaultY = 100; // Top with some margin
    setParallelWindowPosition({ x: defaultX, y: defaultY });
  }, []);

  // Handle drag start for parallel lines window
  const handleParallelWindowDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const currentX = parallelWindowPosition?.x ?? (window.innerWidth - 320);
    const currentY = parallelWindowPosition?.y ?? 100;
    
    setIsDraggingParallelWindow(true);
    dragStartRef.current = {
      x: clientX,
      y: clientY,
      startX: currentX,
      startY: currentY
    };
  }, [parallelWindowPosition]);

  // Handle drag move for parallel lines window
  const handleParallelWindowDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDraggingParallelWindow || !dragStartRef.current) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const deltaX = clientX - dragStartRef.current.x;
    const deltaY = clientY - dragStartRef.current.y;
    
    let newX = dragStartRef.current.startX + deltaX;
    let newY = dragStartRef.current.startY + deltaY;
    
    // Clamp to viewport bounds
    const windowWidth = parallelWindowRef.current?.offsetWidth || 300;
    const windowHeight = parallelWindowRef.current?.offsetHeight || 200;
    
    newX = Math.max(0, Math.min(newX, window.innerWidth - windowWidth));
    newY = Math.max(0, Math.min(newY, window.innerHeight - windowHeight));
    
    setParallelWindowPosition({ x: newX, y: newY });
  }, [isDraggingParallelWindow]);

  // Handle drag end for parallel lines window
  const handleParallelWindowDragEnd = useCallback(() => {
    setIsDraggingParallelWindow(false);
    dragStartRef.current = null;
  }, []);

  // 3D float window drag handlers
  const handleThreeDFloatDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const currentX = threeDFloatPosition?.x ?? (window.innerWidth - 660);
    const currentY = threeDFloatPosition?.y ?? 60;
    setIsDraggingThreeDFloat(true);
    threeDFloatDragStartRef.current = { x: clientX, y: clientY, startX: currentX, startY: currentY };
  }, [threeDFloatPosition]);

  const handleThreeDFloatDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDraggingThreeDFloat || !threeDFloatDragStartRef.current) return;
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - threeDFloatDragStartRef.current.x;
    const deltaY = clientY - threeDFloatDragStartRef.current.y;
    let newX = threeDFloatDragStartRef.current.startX + deltaX;
    let newY = threeDFloatDragStartRef.current.startY + deltaY;
    const winW = threeDFloatRef.current?.offsetWidth || 640;
    const winH = threeDFloatRef.current?.offsetHeight || 420;
    newX = Math.max(0, Math.min(newX, window.innerWidth - winW));
    newY = Math.max(0, Math.min(newY, window.innerHeight - winH));
    setThreeDFloatPosition({ x: newX, y: newY });
  }, [isDraggingThreeDFloat]);

  const handleThreeDFloatDragEnd = useCallback(() => {
    setIsDraggingThreeDFloat(false);
    threeDFloatDragStartRef.current = null;
  }, []);

  const handleThreeDFloatResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingThreeDFloat(true);
    threeDFloatResizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startW: threeDFloatRef.current?.offsetWidth ?? threeDFloatSize.w,
      startH: threeDFloatRef.current?.offsetHeight ?? threeDFloatSize.h,
    };
  }, [threeDFloatSize]);

  const handleThreeDFloatResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizingThreeDFloat || !threeDFloatResizeStartRef.current) return;
    e.preventDefault();
    const deltaX = e.clientX - threeDFloatResizeStartRef.current.x;
    const deltaY = e.clientY - threeDFloatResizeStartRef.current.y;
    const newW = Math.max(320, threeDFloatResizeStartRef.current.startW + deltaX);
    const newH = Math.max(220, threeDFloatResizeStartRef.current.startH + deltaY);
    setThreeDFloatSize({ w: newW, h: newH });
  }, [isResizingThreeDFloat]);

  const handleThreeDFloatResizeEnd = useCallback(() => {
    setIsResizingThreeDFloat(false);
    threeDFloatResizeStartRef.current = null;
  }, []);

  // Set up global drag handlers for 3D float window
  useEffect(() => {
    if (isDraggingThreeDFloat) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleThreeDFloatDragMove(e);
      const handleEnd = () => handleThreeDFloatDragEnd();
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isDraggingThreeDFloat, handleThreeDFloatDragMove, handleThreeDFloatDragEnd]);

  // Set up global resize handlers for 3D float window
  useEffect(() => {
    if (isResizingThreeDFloat) {
      window.addEventListener('mousemove', handleThreeDFloatResizeMove);
      window.addEventListener('mouseup', handleThreeDFloatResizeEnd);
      return () => {
        window.removeEventListener('mousemove', handleThreeDFloatResizeMove);
        window.removeEventListener('mouseup', handleThreeDFloatResizeEnd);
      };
    }
  }, [isResizingThreeDFloat, handleThreeDFloatResizeMove, handleThreeDFloatResizeEnd]);

  // Set up global drag handlers
  useEffect(() => {
    if (isDraggingParallelWindow) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleParallelWindowDragMove(e);
      const handleEnd = () => handleParallelWindowDragEnd();
      
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isDraggingParallelWindow, handleParallelWindowDragMove, handleParallelWindowDragEnd]);

  // Overlap graph float: reset position
  const resetOverlapGraphWindowPosition = useCallback(() => {
    const defaultX = window.innerWidth - (overlapGraphWindowSize?.width ?? OVERLAP_GRAPH_DEFAULT_WIDTH);
    const defaultY = 100;
    setOverlapGraphWindowPosition({ x: defaultX, y: defaultY });
  }, [overlapGraphWindowSize]);

  const handleOverlapGraphWindowDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const defaultW = overlapGraphWindowSize?.width ?? OVERLAP_GRAPH_DEFAULT_WIDTH;
    const currentX = overlapGraphWindowPosition?.x ?? (window.innerWidth - defaultW);
    const currentY = overlapGraphWindowPosition?.y ?? 100;
    setIsDraggingOverlapGraphWindow(true);
    overlapGraphDragStartRef.current = { x: clientX, y: clientY, startX: currentX, startY: currentY };
  }, [overlapGraphWindowPosition]);

  const handleOverlapGraphWindowDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDraggingOverlapGraphWindow || !overlapGraphDragStartRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - overlapGraphDragStartRef.current.x;
    const deltaY = clientY - overlapGraphDragStartRef.current.y;
    let newX = overlapGraphDragStartRef.current.startX + deltaX;
    let newY = overlapGraphDragStartRef.current.startY + deltaY;
    const w = overlapGraphWindowRef.current?.offsetWidth || 360;
    const h = overlapGraphWindowRef.current?.offsetHeight || 400;
    newX = Math.max(0, Math.min(newX, window.innerWidth - w));
    newY = Math.max(0, Math.min(newY, window.innerHeight - h));
    setOverlapGraphWindowPosition({ x: newX, y: newY });
  }, [isDraggingOverlapGraphWindow]);

  const handleOverlapGraphWindowDragEnd = useCallback(() => {
    setIsDraggingOverlapGraphWindow(false);
    overlapGraphDragStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isDraggingOverlapGraphWindow) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleOverlapGraphWindowDragMove(e);
      const handleEnd = () => handleOverlapGraphWindowDragEnd();
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isDraggingOverlapGraphWindow, handleOverlapGraphWindowDragMove, handleOverlapGraphWindowDragEnd]);

  const handleOverlapGraphWindowResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const el = overlapGraphWindowRef.current;
    const startWidth = overlapGraphWindowSize?.width ?? OVERLAP_GRAPH_DEFAULT_WIDTH;
    const startHeight = overlapGraphWindowSize?.height ?? OVERLAP_GRAPH_DEFAULT_HEIGHT;
    setIsResizingOverlapGraphWindow(true);
    overlapGraphResizeStartRef.current = { x: clientX, y: clientY, startWidth: el?.offsetWidth ?? startWidth, startHeight: el?.offsetHeight ?? startHeight };
  }, [overlapGraphWindowSize]);

  const handleOverlapGraphWindowResizeMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isResizingOverlapGraphWindow || !overlapGraphResizeStartRef.current) return;
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - overlapGraphResizeStartRef.current.x;
    const deltaY = clientY - overlapGraphResizeStartRef.current.y;
    let w = overlapGraphResizeStartRef.current.startWidth + deltaX;
    let h = overlapGraphResizeStartRef.current.startHeight + deltaY;
    w = Math.max(OVERLAP_GRAPH_MIN_WIDTH, Math.min(OVERLAP_GRAPH_MAX_WIDTH, w));
    h = Math.max(OVERLAP_GRAPH_MIN_HEIGHT, Math.min(OVERLAP_GRAPH_MAX_HEIGHT, h));
    setOverlapGraphWindowSize({ width: w, height: h });
  }, [isResizingOverlapGraphWindow]);

  const handleOverlapGraphWindowResizeEnd = useCallback(() => {
    setIsResizingOverlapGraphWindow(false);
    overlapGraphResizeStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isResizingOverlapGraphWindow) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleOverlapGraphWindowResizeMove(e);
      const handleEnd = () => handleOverlapGraphWindowResizeEnd();
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isResizingOverlapGraphWindow, handleOverlapGraphWindowResizeMove, handleOverlapGraphWindowResizeEnd]);

  // Height limitation window: drag and resize
  const resetHeightLimitationWindowPosition = useCallback(() => {
    const defaultX = 20;
    const defaultY = 100;
    setHeightLimitationWindowPosition({ x: defaultX, y: defaultY });
  }, []);

  const handleHeightLimitationWindowDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const currentX = heightLimitationWindowPosition?.x ?? 20;
    const currentY = heightLimitationWindowPosition?.y ?? 100;
    setIsDraggingHeightLimitationWindow(true);
    heightLimitationDragStartRef.current = { x: clientX, y: clientY, startX: currentX, startY: currentY };
  }, [heightLimitationWindowPosition]);

  const handleHeightLimitationWindowDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDraggingHeightLimitationWindow || !heightLimitationDragStartRef.current) return;
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - heightLimitationDragStartRef.current.x;
    const deltaY = clientY - heightLimitationDragStartRef.current.y;
    let newX = heightLimitationDragStartRef.current.startX + deltaX;
    let newY = heightLimitationDragStartRef.current.startY + deltaY;
    const w = heightLimitationWindowRef.current?.offsetWidth ?? HEIGHT_LIMITATION_DEFAULT_WIDTH;
    const h = heightLimitationWindowRef.current?.offsetHeight ?? HEIGHT_LIMITATION_DEFAULT_HEIGHT;
    newX = Math.max(0, Math.min(newX, window.innerWidth - w));
    newY = Math.max(0, Math.min(newY, window.innerHeight - h));
    setHeightLimitationWindowPosition({ x: newX, y: newY });
  }, [isDraggingHeightLimitationWindow]);

  const handleHeightLimitationWindowDragEnd = useCallback(() => {
    setIsDraggingHeightLimitationWindow(false);
    heightLimitationDragStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isDraggingHeightLimitationWindow) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleHeightLimitationWindowDragMove(e);
      const handleEnd = () => handleHeightLimitationWindowDragEnd();
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isDraggingHeightLimitationWindow, handleHeightLimitationWindowDragMove, handleHeightLimitationWindowDragEnd]);

  const handleHeightLimitationWindowResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = heightLimitationWindowRef.current;
    const startWidth = heightLimitationWindowSize?.width ?? HEIGHT_LIMITATION_DEFAULT_WIDTH;
    const startHeight = heightLimitationWindowSize?.height ?? HEIGHT_LIMITATION_DEFAULT_HEIGHT;
    setIsResizingHeightLimitationWindow(true);
    heightLimitationResizeStartRef.current = { x: 'touches' in e ? e.touches[0].clientX : e.clientX, y: 'touches' in e ? e.touches[0].clientY : e.clientY, startWidth: el?.offsetWidth ?? startWidth, startHeight: el?.offsetHeight ?? startHeight };
  }, [heightLimitationWindowSize]);

  const handleHeightLimitationWindowResizeMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isResizingHeightLimitationWindow || !heightLimitationResizeStartRef.current) return;
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - heightLimitationResizeStartRef.current.x;
    const deltaY = clientY - heightLimitationResizeStartRef.current.y;
    let w = heightLimitationResizeStartRef.current.startWidth + deltaX;
    let h = heightLimitationResizeStartRef.current.startHeight + deltaY;
    w = Math.max(HEIGHT_LIMITATION_MIN_WIDTH, Math.min(420, w));
    h = Math.max(HEIGHT_LIMITATION_MIN_HEIGHT, Math.min(500, h));
    setHeightLimitationWindowSize({ width: w, height: h });
  }, [isResizingHeightLimitationWindow]);

  const handleHeightLimitationWindowResizeEnd = useCallback(() => {
    setIsResizingHeightLimitationWindow(false);
    heightLimitationResizeStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isResizingHeightLimitationWindow) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleHeightLimitationWindowResizeMove(e);
      const handleEnd = () => handleHeightLimitationWindowResizeEnd();
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleEnd);
      return () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
    }
  }, [isResizingHeightLimitationWindow, handleHeightLimitationWindowResizeMove, handleHeightLimitationWindowResizeEnd]);

  const handleHeightLimitationExport = useCallback(async () => {
    const { points, outputLegend, safetyLegend } = heightLimitationData;
    if (points.length === 0 || !mapContainer.current || !map.current) {
      alert('אין נתוני גובה לייצוא. טען מסלול ופרופיל גובה.');
      return;
    }
    const activeRoute = routes.find((r) => r.id === activeRouteId) || routes[0];
    const routeName = activeRoute?.name ?? '';
    const escapedRouteName = routeName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const mainTitle = routeName ? ` חריגות גבהים - ${escapedRouteName}` : 'תצוגת חריגות גבהים';
    const legend = heightLimitationMode === 'output' ? outputLegend : safetyLegend;
    const subtitle = heightLimitationMode === 'output' ? 'גובה תוצר' : 'גובה בטיחות';

    const titleEl = document.createElement('div');
    titleEl.className = 'height-limitation-export-title';
    titleEl.setAttribute('data-export-legend', 'true');
    titleEl.textContent = mainTitle;
    const legendEl = document.createElement('div');
    legendEl.className = 'height-limitation-export-legend';
    legendEl.setAttribute('data-export-legend', 'true');
    legendEl.innerHTML = `
      <div class="height-limitation-export-legend__title">${subtitle}</div>
      ${legend ? `
        <div class="height-limitation-export-legend__row"><span class="height-limitation-export-legend__dot" style="background:${HEIGHT_LIMITATION_COLORS.green}"></span>${legend.green}</div>
        <div class="height-limitation-export-legend__row"><span class="height-limitation-export-legend__dot" style="background:${HEIGHT_LIMITATION_COLORS.yellow}"></span>${legend.yellow}</div>
        <div class="height-limitation-export-legend__row"><span class="height-limitation-export-legend__dot" style="background:${HEIGHT_LIMITATION_COLORS.red}"></span>${legend.red}</div>
      ` : ''}
    `;

    const prevCenter = map.current.getCenter();
    const prevZoom = map.current.getZoom();
    const routeBounds =
      flightPath.length > 1
        ? L.latLngBounds(flightPath.map((p) => [p.lat, p.lng] as L.LatLngExpression))
        : flightPath.length === 1
          ? L.latLngBounds(
              [flightPath[0].lat - 0.002, flightPath[0].lng - 0.002],
              [flightPath[0].lat + 0.002, flightPath[0].lng + 0.002]
            )
          : null;
    if (routeBounds) {
      map.current.fitBounds(routeBounds, { padding: [40, 40], animate: false });
      await new Promise((r) => setTimeout(r, 450));
    }
    mapContainer.current.appendChild(titleEl);
    mapContainer.current.appendChild(legendEl);

    try {
      const scale = window.devicePixelRatio || 1;
      const canvas = await html2canvas(mapContainer.current, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
        scale,
        ignoreElements: (el: Element) => {
          if (el.classList?.contains('map-instruction-banner') || el.classList?.contains('routes-panel')) return true;
          if (el.closest?.('.map-instruction-banner') || el.closest?.('.routes-panel')) return true;
          if (el.classList?.contains('basemap-toggle') || el.classList?.contains('display-settings-container')) return true;
          if (el.closest?.('.basemap-toggle') || el.closest?.('.display-settings-container')) return true;
          if (el.classList?.contains('segment-length-label') || el.closest?.('.segment-length-label')) return true;
          if (el.classList?.contains('leaflet-control-zoom') || el.classList?.contains('leaflet-control-attribution') || el.classList?.contains('leaflet-control-scale')) return true;
          if (el.closest?.('.leaflet-control-zoom') || el.closest?.('.leaflet-control-attribution') || el.closest?.('.leaflet-control-scale')) return true;
          if (/\bleaflet-control\b/.test(el.className?.toString() || '')) return true;
          if (el.closest?.('[class*="leaflet-control"]')) return true;
          return false;
        }
      });

      // Use the map container's size so latLngToContainerPoint coordinates match the canvas exactly
      const container = map.current?.getContainer?.() ?? mapContainer.current;
      const cw = container ? Math.round(container.offsetWidth * scale) : canvas.width;
      const ch = container ? Math.round(container.offsetHeight * scale) : canvas.height;
      const outCanvas = document.createElement('canvas');
      outCanvas.width = cw;
      outCanvas.height = ch;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png', 1));
        if (blob) {
          const defaultFilename = `height_limitation_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
          await saveFileWithLocation(blob, defaultFilename, 'image/png');
        }
        return;
      }
      outCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, cw, ch);

      const ctx = outCtx;
      if (ctx && map.current) {
        const toCanvas = (lat: number, lng: number) => {
          const p = map.current!.latLngToContainerPoint(L.latLng(lat, lng));
          return { x: p.x * scale, y: p.y * scale };
        };

        // 1. Thick colored path (green / yellow / red segments) along profile points
        const lineWidth = 14 * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = lineWidth;
        for (let i = 0; i < points.length - 1; i++) {
          const pt = points[i];
          const next = points[i + 1];
          const color = heightLimitationMode === 'output' ? (pt.outputColor ?? '#94a3b8') : (pt.safetyColor ?? '#94a3b8');
          const a = toCanvas(pt.lat, pt.lng);
          const b = toCanvas(next.lat, next.lng);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = color;
          ctx.stroke();
        }

        // 2. Small colored dots on each profile point (on top of the path) — fill only, no outline
        const dotRadius = 5 * scale;
        points.forEach((pt) => {
          const color = heightLimitationMode === 'output' ? (pt.outputColor ?? '#94a3b8') : (pt.safetyColor ?? '#94a3b8');
          const { x, y } = toCanvas(pt.lat, pt.lng);
          ctx.beginPath();
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });

        // 3. Numbered waypoint markers (red fill, white border + text) at flight path points
        const waypointRadius = 14 * scale;
        flightPath.forEach((wp, idx) => {
          const { x, y } = toCanvas(wp.lat, wp.lng);
          // Red filled circle
          ctx.beginPath();
          ctx.arc(x, y, waypointRadius, 0, Math.PI * 2);
          ctx.fillStyle = '#ff0000';
          ctx.fill();
          // White border
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2 * scale;
          ctx.stroke();
          // White number
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${12 * scale}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), x, y);
        });

        // 4. Worst-point marker: dark red dot + label with excess value
        const worst = points.find(p => p.isWorst);
        if (worst) {
          const { x, y } = toCanvas(worst.lat, worst.lng);
          const worstDotRadius = 7 * scale;

          ctx.beginPath();
          ctx.arc(x, y, worstDotRadius, 0, Math.PI * 2);
          ctx.fillStyle = '#7f0000';
          ctx.fill();
        }
      }

      const blob = await new Promise<Blob | null>((resolve) => {
        outCanvas.toBlob((b) => resolve(b), 'image/png', 1);
      });
      if (!blob) {
        alert('שגיאה ביצירת התמונה');
        return;
      }
      const defaultFilename = `height_limitation_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      await saveFileWithLocation(blob, defaultFilename, 'image/png');
    } catch (e) {
      if ((e as Error)?.message !== 'User cancelled file save') {
        console.error('Height limitation export failed:', e);
        alert('שגיאה בייצוא התמונה');
      }
    } finally {
      titleEl.remove();
      legendEl.remove();
      map.current?.setView(prevCenter, prevZoom, { animate: false });
    }
  }, [heightLimitationData, heightLimitationMode, flightPath, routes, activeRouteId]);

  const createParallelLinesBatch = useCallback(
    (lineIds: string[], distanceOverride?: number) => {
      const offset = distanceOverride ?? parseFloat(parallelBatchOffset || '');
      const failed: string[] = [];
      const createdLineIds: string[] = [];
      const newPoints: Coordinate[] = [];

      // If only one line is selected, use existing behavior (no intersection merging)
      if (lineIds.length === 1) {
        const lineId = lineIds[0];
        const segmentIndex = segmentIndexById.get(lineId);
        if (segmentIndex === undefined) {
          failed.push(lineId);
        } else {
          const result = createParallelLineForSegmentIndex(segmentIndex, offset);
          if (!result.ok) {
            failed.push(`seg-${segmentIndex + 1}`);
          } else {
            newPoints.push(...result.points);
            createdLineIds.push(lineId);
          }
        }
        return {
          offset,
          createdLineIds,
          failed,
          newPoints
        };
      }

      // For multiple lines: merge intermediate points at intersections
      // Step 1: Collect segment indices and sort them
      const segmentData: Array<{ lineId: string; segmentIndex: number; parallelLine: [Coordinate, Coordinate] | null }> = [];
      
      for (const lineId of lineIds) {
        const segmentIndex = segmentIndexById.get(lineId);
        if (segmentIndex === undefined) {
          failed.push(lineId);
          continue;
        }
        const result = createParallelLineForSegmentIndex(segmentIndex, offset);
        if (!result.ok) {
          failed.push(`seg-${segmentIndex + 1}`);
          continue;
        }
        // result.points is [parallelEnd, parallelStart] (reversed order)
        // Convert to [parallelStart, parallelEnd] for easier processing
        const parallelLine: [Coordinate, Coordinate] = [result.points[1], result.points[0]];
        segmentData.push({ lineId, segmentIndex, parallelLine });
        createdLineIds.push(lineId);
      }

      // Sort by segment index to process in order
      segmentData.sort((a, b) => a.segmentIndex - b.segmentIndex);

      if (segmentData.length === 0) {
        return {
          offset,
          createdLineIds,
          failed,
          newPoints
        };
      }

      // Step 2: Build points array with intersection merging for consecutive segments
      // The original code returns points as [parallelEnd, parallelStart] (reversed),
      // but we build the path in forward order to maintain logical sequence
      for (let i = 0; i < segmentData.length; i++) {
        const current = segmentData[i];
        const [parallelStart, parallelEnd] = current.parallelLine!;

        if (i === 0) {
          // First segment: add its start point (offset of first original point)
          newPoints.push(parallelStart);
        }

        // Check if next segment is consecutive (shares a vertex)
        const isLast = i === segmentData.length - 1;
        const next = !isLast ? segmentData[i + 1] : null;
        const isConsecutive = next && next.segmentIndex === current.segmentIndex + 1;

        if (isConsecutive && next) {
          // Consecutive segments: calculate intersection of the two parallel lines
          // This replaces the two separate points (one from each segment) with one intersection point
          const [nextParallelStart, nextParallelEnd] = next.parallelLine!;
          const intersection = calculateLineIntersection(
            parallelStart,
            parallelEnd,
            nextParallelStart,
            nextParallelEnd
          );

          if (intersection) {
            // Use intersection point for the shared vertex
            // This is the key change: one point instead of two
            newPoints.push(intersection);
          } else {
            // Fallback: if intersection calculation fails (parallel lines), use the end point of current segment
            newPoints.push(parallelEnd);
          }
        } else {
          // Not consecutive or last segment: add the end point (offset of last original point)
          newPoints.push(parallelEnd);
        }
      }

      // Reverse the points array to match the original ordering pattern
      newPoints.reverse();

      return {
        offset,
        createdLineIds,
        failed,
        newPoints
      };
    },
    [createParallelLineForSegmentIndex, parallelBatchOffset, segmentIndexById]
  );

  const handleCreateParallelLinesBatch = useCallback(() => {
    if (!dtmLoaded) {
      setParallelBatchError('טען DTM תחילה.');
      return;
    }
    if (selectedLineIds.length === 0) {
      setParallelBatchError('בחר לפחות קטע אחד.');
      return;
    }
    const distance = parseFloat(parallelBatchOffset || '');
    if (!isFinite(distance) || distance <= 0) {
      setParallelBatchError('נדרש מרחק חיובי.');
      return;
    }
    
    // Convert to signed distance based on direction
    const signedOffset = parallelBatchDirection === 'right' ? distance : -distance;

    const { createdLineIds, failed, newPoints } = createParallelLinesBatch(selectedLineIds, signedOffset);

    if (newPoints.length > 0) {
      // Single history entry: one onAddPoints call
      onAddPoints(newPoints);
      // Remember last-used offsets (global + per-line) - store signed value
      lastParallelOffsetRef.current = signedOffset;
      createdLineIds.forEach((id) => lastParallelOffsetByLineIdRef.current.set(id, signedOffset));
    }

    const total = selectedLineIds.length;
    const created = createdLineIds.length;
    const message =
      failed.length === 0
        ? `נוצרו ${created}/${total} קטעים מקבילים.`
        : `נוצרו ${created}/${total} קטעים מקבילים. נכשלו: ${failed.join(', ')}`;

    setSuccessNotification({ isOpen: true, message });
    setIsParallelLineMode(false);
    clearSelectedLines();
  }, [
    clearSelectedLines,
    createParallelLinesBatch,
    dtmLoaded,
    flightPath.length,
    onAddPoints,
    parallelBatchOffset,
    parallelBatchDirection,
    selectedLineIds
  ]);

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
        if (isNaN || numValue < 0.1 || numValue > 10000) {
          setDialogError('רדיוס חייב להיות בין 0.1 ל-10000 מטרים');
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
    // Check if a server DTM is already loaded - if so, enter AOI selection mode directly for replacement
    if (dtmSource && propDtmSourceType === 'server' && currentAoi) {
      // Cancel any ongoing replacement
      if (replacementAbortController) {
        replacementAbortController.abort();
        setReplacementAbortController(null);
      }
      setIsReplacingDtm(true);
      setDtmLoaderOpen(false);
      setIsAoiSelectionMode(true);
      setAoiSelectionMethod(null); // Show method chooser first
      setAoiBounds(null);
      setAoiPolygon(null);
      setSelectedDtmId(null);
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
      aoiMarkersRef.current.forEach(marker => {
        if (map.current) map.current.removeLayer(marker);
      });
      aoiMarkersRef.current = [];
    } else {
      // Normal flow - open dialog
      setDtmLoaderOpen(true);
      setDtmLoaderStep('source-choice');
      setDtmSourceType(null);
      setLocalFileError(null);
      setDtmSearchQuery('');
      setSelectedDtmId(null);
      setDtmOptionsError(null);
      setIsReplacingDtm(false);
    }
  }, [dtmSource, propDtmSourceType, currentAoi, replacementAbortController]);

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
      // NEW FLOW: Go directly to AOI selection mode (skip TIF list)
      setDtmLoaderOpen(false);
      setIsAoiSelectionMode(true);
      setAoiSelectionMethod(null); // Show method chooser first
      setAoiBounds(null);
      setAoiPolygon(null);
      setSelectedDtmId(null); // Will be set after TIF selection
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
            debug.error('Error parsing response:', parseError);
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
        debug.error('Error uploading DTM:', xhr.statusText);
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
      debug.error('Error uploading DTM:', error);
      setLocalFileError('Failed to upload DTM file. Please try again.');
      setIsLocalUploading(false);
      setLocalUploadProgress(0);
    }
  }, [onDtmLoad, handleCloseDtmLoader]);

  // Fetch available DTM options from the server (legacy - for backward compatibility)
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
      debug.error('Error fetching DTM options:', error);
      setDtmOptionsError(error instanceof Error ? error.message : 'Error loading DTM list');
    } finally {
      setDtmOptionsLoading(false);
    }
  }, []);

  // Fetch available TIF files for clipping: only those that fully contain the AOI (wanted polygon/bbox)
  const fetchAvailableTifs = useCallback(async (aoi: { type: string; crs: string; bbox?: number[]; coordinates?: [number, number][] }) => {
    setDtmOptionsLoading(true);
    setDtmOptionsError(null);
    try {
      const response = await fetch('/api/dtm/available', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          aoi: aoi,
          bufferMeters: 0.0,
          containment: true
        })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || errorData.error || `Failed to fetch available TIFs: ${response.status}`);
      }
      const data = await response.json();
      setDtmOptions(data.files || []);
    } catch (error) {
      debug.error('Error fetching available TIFs:', error);
      setDtmOptionsError(error instanceof Error ? error.message : 'Error loading available TIF files');
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

  // Legacy: Select a DTM and enter AOI selection mode (for backward compatibility)
  const handleSelectDtm = useCallback((dtmId: string, displayName?: string) => {
    // If we're in the new server flow (AOI already selected, just need TIF), automatically start clipping
    // Check if we're in server-results step OR if dtmSourceType is server AND we have AOI selected
    const isServerFlowWithAoi = (dtmLoaderStep === 'server-results' || dtmSourceType === 'server') && (aoiBounds || aoiPolygon);
    
    if (isServerFlowWithAoi && !selectedDtmId) {
      // Set the DTM ID first
      setSelectedDtmId(dtmId);
      if (displayName) {
        setActiveDtmName(displayName);
      }
      
      // Close the dialog immediately
      setDtmLoaderOpen(false);
      setShowDtmOptionsModal(false);
      
      // Trigger clipping directly with the DTM ID and current AOI
      // Capture AOI values to avoid closure issues
      const capturedAoiBounds = aoiBounds;
      const capturedAoiPolygon = aoiPolygon;
      
      const clipWithDtmId = async () => {
        if (!dtmId || (!capturedAoiBounds && !capturedAoiPolygon)) {
          alert('בחר DTM ושרטט אזור עבודה.');
          return;
        }

        setIsClipping(true);
        try {
          // Build AOI object based on selection method
          let aoiPayload: { type: string; crs: string; bbox?: number[]; coordinates?: [number, number][] };
          
          if (capturedAoiPolygon && capturedAoiPolygon.coordinates.length >= 3) {
            // Polygon AOI - close the ring if not already closed
            const coords = [...capturedAoiPolygon.coordinates];
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
          } else if (capturedAoiBounds) {
            // Bbox AOI
            aoiPayload = {
              type: 'bbox',
              crs: 'EPSG:4326',
              bbox: [capturedAoiBounds.minLon, capturedAoiBounds.minLat, capturedAoiBounds.maxLon, capturedAoiBounds.maxLat]
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
              dtmId: dtmId,
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
          const selectedDtm = dtmOptions.find(d => d.id === dtmId);
          const newAOI: AOIGeometry | undefined = capturedAoiPolygon ? {
            type: 'polygon',
            polygon: capturedAoiPolygon.coordinates
          } : capturedAoiBounds ? {
            type: 'bbox',
            bbox: {
              minLon: capturedAoiBounds.minLon,
              minLat: capturedAoiBounds.minLat,
              maxLon: capturedAoiBounds.maxLon,
              maxLat: capturedAoiBounds.maxLat
            }
          } : undefined;
          
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
            serverId: dtmId,
            serverMetadata: selectedDtm ? {
              displayName: selectedDtm.displayName,
              sizeBytes: selectedDtm.sizeBytes,
              modifiedAt: selectedDtm.modifiedAt
            } : undefined,
            aoi: newAOI
          });

        } catch (error) {
          debug.error('Error clipping DTM:', error);
          alert(`שגיאה בחיתוך DTM: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
        } finally {
          setIsClipping(false);
        }
      };
      
      // Trigger clipping after a short delay to ensure state is updated
      setTimeout(() => {
        clipWithDtmId();
      }, 100);
      return;
    }
    
    // Legacy flow: select DTM then enter AOI selection
    setSelectedDtmId(dtmId);
    if (displayName) {
      setActiveDtmName(displayName);
    }
    
    setDtmLoaderOpen(false);
    setShowDtmOptionsModal(false);
    setIsAoiSelectionMode(true);
    setAoiSelectionMethod(null);
    setAoiBounds(null);
    setAoiPolygon(null);
    aoiPolygonPointsRef.current = [];
    aoiFirstClickRef.current = null;
    
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
  }, [dtmSourceType, dtmLoaderStep, aoiBounds, aoiPolygon, selectedDtmId, dtmOptions, onDtmLoad]);

  // Cancel AOI selection - returns to unified loader source choice
  const handleCancelAoiSelection = useCallback(() => {
    // Cancel any ongoing replacement
    if (replacementAbortController) {
      replacementAbortController.abort();
      setReplacementAbortController(null);
    }
    setIsReplacingDtm(false);
    
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
    
    // Re-open the unified loader at source choice (only if not replacing)
    if (!isReplacingDtm) {
      setDtmLoaderOpen(true);
      setDtmLoaderStep('source-choice');
      setDtmSourceType(null);
      setDtmOptions([]);
      setDtmOptionsError(null);
    }
  }, [isReplacingDtm, replacementAbortController]);

  // Confirm AOI and fetch available TIF files (new flow)
  const handleConfirmAoiForServer = useCallback(async () => {
    if (!aoiBounds && !aoiPolygon) {
      alert('בחר אזור עבודה תחילה.');
      return;
    }

    // Ensure dtmSourceType is set to 'server'
    if (dtmSourceType !== 'server') {
      setDtmSourceType('server');
    }

    // Build AOI object
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
      return;
    }

    // Fetch available TIFs
    await fetchAvailableTifs(aoiPayload);
    
    // Show TIF selection dialog (but keep AOI selection mode active in background)
    setDtmLoaderStep('server-results');
    setDtmLoaderOpen(true);
    // Don't clear AOI selection mode - keep it active so AOI is preserved
  }, [aoiBounds, aoiPolygon, fetchAvailableTifs, dtmSourceType]);

  // Clip the DTM to the selected AOI
  const handleClipDtm = useCallback(async () => {
    if (!selectedDtmId || (!aoiBounds && !aoiPolygon)) {
      alert('בחר DTM ושרטט אזור עבודה.');
      return;
    }

    // If replacing DTM, check containment first
    if (isReplacingDtm && currentAoi) {
      const newAOI: AOIGeometry | null = aoiPolygon ? {
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
      } : null;
      
      if (!newAOI) {
        alert('בחר אזור עבודה תקין.');
        return;
      }
      
      // Check containment
      if (!aoiContains(newAOI, currentAoi)) {
        // Containment failed - show warning and cancel
        setContainmentWarning({ isOpen: true });
        setIsReplacingDtm(false);
        // Cancel AOI selection
        setIsAoiSelectionMode(false);
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
        aoiMarkersRef.current.forEach(marker => {
          if (map.current) map.current.removeLayer(marker);
        });
        aoiMarkersRef.current = [];
        return;
      }
      
      // Containment passed - proceed with replacement
      // Cancel any previous replacement operation
      if (replacementAbortController) {
        replacementAbortController.abort();
      }
      const abortController = new AbortController();
      setReplacementAbortController(abortController);
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
      
      // If replacing, delete old cache before clipping new one
      const oldClippedId = isReplacingDtm ? propClippedId : null;
      
      // Delete old cache if replacing (but don't wait for it to complete)
      if (oldClippedId && isReplacingDtm) {
        fetch(`/api/dtm/clipped/${oldClippedId}`, {
          method: 'DELETE',
          signal: replacementAbortController?.signal
        }).catch(error => {
          if (error.name !== 'AbortError') {
            debug.error('Failed to delete old DTM cache:', error);
          }
        });
      }
      
      const response = await fetch('/api/dtm/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dtmId: selectedDtmId,
          aoi: aoiPayload
        }),
        signal: isReplacingDtm ? replacementAbortController?.signal : undefined
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || errorData.error || `Clip failed: ${response.status}`);
      }

      const clipResult: ClipResponse = await response.json();
      
      // Check if operation was aborted
      if (isReplacingDtm && replacementAbortController?.signal.aborted) {
        setIsClipping(false);
        setIsReplacingDtm(false);
        setReplacementAbortController(null);
        return;
      }
      
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
      const newAOI: AOIGeometry | undefined = aoiPolygon ? {
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
      } : undefined;
      
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
        aoi: newAOI
      });
      
      // Clear replacement state
      if (isReplacingDtm) {
        setIsReplacingDtm(false);
        setReplacementAbortController(null);
      }

    } catch (error) {
      // Check if operation was aborted
      if (error instanceof Error && error.name === 'AbortError') {
        debug.log('DTM replacement was cancelled');
        setIsReplacingDtm(false);
        setReplacementAbortController(null);
        setIsClipping(false);
        return;
      }
      
      debug.error('Error clipping DTM:', error);
      alert(`שגיאה בחיתוך DTM: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
      
      // On error, restore replacement state
      if (isReplacingDtm) {
        setIsReplacingDtm(false);
        setReplacementAbortController(null);
      }
    } finally {
      setIsClipping(false);
    }
  }, [selectedDtmId, aoiBounds, aoiPolygon, dtmSourceType, onDtmLoad, dtmOptions, isReplacingDtm, currentAoi, propClippedId, replacementAbortController]);

  /*
  // Delete clipped DTM from cache
  const deleteClippedDtm = useCallback(async (clippedIdToDelete?: string) => {
    const targetId = clippedIdToDelete || activeClippedId;
    if (!targetId) return;

    try {
      await fetch(`/api/dtm/clipped/${targetId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      debug.error('Error deleting clipped DTM:', error);
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
  const activeRouteLineWidth = Number.isFinite(activeRoute?.lineWidth) ? activeRoute.lineWidth : 3;
  const flightPathSignature = useMemo(() => {
    return flightPath
      .map((point) => {
        const height = point.height ?? nominalFlightHeight;
        return `${point.lng.toFixed(7)},${point.lat.toFixed(7)},${height}`;
      })
      .join('|');
  }, [flightPath, nominalFlightHeight]);
  const hasViewshedResult = Boolean(viewshedRaster) || viewshedStatus === 'done';
  /** Class-wise colors 1, 2, 3, 4+ derived from the selected viewshed colormap */
  const viewshedClassColors = useMemo(
    () => getViewshedClassColorsFromColormap(viewshedColormap),
    [viewshedColormap]
  );
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
    const safetyRadiusMeters = Math.max(0, Number.isFinite(safetyRadius) ? safetyRadius : 0);

    if (safetyRadiusMeters <= 0) {
      return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
    }

    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;

    // Convert safety radius in meters into inner-bound offsets on each axis.
    const innerSouth = calculateDestination({ lng: centerLng, lat: minLat }, 0, safetyRadiusMeters).lat;
    const innerNorth = calculateDestination({ lng: centerLng, lat: maxLat }, Math.PI, safetyRadiusMeters).lat;
    const innerWest = calculateDestination({ lng: minLng, lat: centerLat }, Math.PI / 2, safetyRadiusMeters).lng;
    const innerEast = calculateDestination({ lng: maxLng, lat: centerLat }, -Math.PI / 2, safetyRadiusMeters).lng;

    // Safety buffer covers the whole area (too small DTM for configured radius).
    if (innerWest > innerEast || innerSouth > innerNorth) {
      return false;
    }

    return lng >= innerWest && lng <= innerEast && lat >= innerSouth && lat <= innerNorth;
  }, [dtmBounds, safetyRadius]);

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
      return;
    }
    const nextBaseMap = baseMaps.find((entry) => entry.id === nextBaseMapId);
    if (!nextBaseMap) {
      return;
    }
    if (nextBaseMap.id === activeBaseMapId) {
      return;
    }

    if (baseLayerRef.current) {
      baseLayerRef.current.remove();
    }

    // Use same-origin proxy (token added server-side); Leaflet substitutes {z},{x},{y}
    const proxyUrl = `/api/map-tile/${nextBaseMap.id}/{z}/{x}/{y}`;
    baseLayerRef.current = L.tileLayer(proxyUrl, tileLayerOptionsRef.current).addTo(map.current);
    setActiveBaseMapId(nextBaseMap.id);
  }, [activeBaseMapId, baseMaps]);

  const handleCycleBaseMap = useCallback(() => {
    if (baseMaps.length < 2) return;
    const currentIndex = baseMaps.findIndex((entry) => entry.id === activeBaseMapId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % baseMaps.length : 0;
    switchBaseMap(baseMaps[nextIndex].id);
  }, [activeBaseMapId, baseMaps, switchBaseMap]);

  const handleCycle3DBaseMap = useCallback(() => {
    if (baseMaps.length < 2 || !threeDActiveBaseMapId) return;
    const currentIndex = baseMaps.findIndex(b => b.id === threeDActiveBaseMapId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % baseMaps.length : 0;
    setThreeDActiveBaseMapId(baseMaps[nextIndex].id);
  }, [threeDActiveBaseMapId, baseMaps]);

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
          debug.warn(`Unknown CRS: ${crsString}. Defaulting to EPSG3857.`);
          leafletCrs = L.CRS.EPSG3857;
        }
      }

      if (mapContainer.current) {
        map.current = L.map(mapContainer.current, {
          center: [31.50, 35.02], // israel defulat
          zoom: 7,
          crs: leafletCrs,
          zoomControl: false, // disable default zoom control
          dragging: true // allow panning by dragging with cursor
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
      const tokenValue = MAPS_TOKEN.token || '';
      mapTokenRef.current = tokenValue;
      setMapToken(tokenValue);

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

      if (map.current && availableBaseMaps.length > 0 && tileLayerOptionsRef.current) {
        const initialBaseMap = availableBaseMaps[0];
        // Use same-origin proxy (token added server-side); Leaflet substitutes {z},{x},{y}
        const proxyUrl = `/api/map-tile/${initialBaseMap.id}/{z}/{x}/{y}`;
        baseLayerRef.current = L.tileLayer(proxyUrl, tileLayerOptionsRef.current).addTo(map.current);
        setActiveBaseMapId(initialBaseMap.id);
        setThreeDActiveBaseMapId(initialBaseMap.id); // 3D starts on same basemap as 2D
      } else {
        debug.error('Cannot add basemap - missing dependencies');
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
      setMapToken('');
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

    // Use double requestAnimationFrame to ensure the tooltip is fully rendered and measured
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!tooltipRef.current) return;
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const padding = 8;
        const offset = 15;

        let left = mousePos.x + offset;
        
        // Check if tooltip would go off the right edge of the screen
        if (left + tooltipRect.width > windowWidth - padding) {
          // Position on the left side of the cursor instead of the left side of the window
          left = mousePos.x - tooltipRect.width - offset;
        }

        // Also check if it would go off the left edge after repositioning
        if (left < padding) {
          left = padding;
        }

        setTooltipPosition({ left, top: mousePos.y + offset });
      });
    });
  }, [mousePos, showMetadata, hoveredElevationPoint, hoverSource]);

  // Calculate info mode tooltip position to keep it on screen
  useLayoutEffect(() => {
    if (!mousePos || !infoModeTooltipRef.current || !isInfoMode || !cursorElevation) {
      setInfoModeTooltipPosition(null);
      return;
    }

    // Use double requestAnimationFrame to ensure the tooltip is fully rendered and measured
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!infoModeTooltipRef.current) return;
        const tooltipRect = infoModeTooltipRef.current.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const padding = 8;
        const offset = 15;

        let left = mousePos.x + offset;
        
        // Check if tooltip would go off the right edge of the screen
        if (left + tooltipRect.width > windowWidth - padding) {
          // Position on the left side of the cursor instead of the left side of the window
          left = mousePos.x - tooltipRect.width - offset;
        }

        // Also check if it would go off the left edge after repositioning
        if (left < padding) {
          left = padding;
        }

        setInfoModeTooltipPosition({ left, top: mousePos.y + offset });
      });
    });
  }, [mousePos, isInfoMode, cursorElevation]);

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
        debug.error('Error parsing KML:', error);
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
      // Skip normal click handling while in rotate mode (let rotate handler take over)
      if (isRotateMode) {
        e.originalEvent?.stopPropagation();
        return;
      }

      // Measurement tools: intercept clicks for length/azimuth measurement
      if (isMeasureLengthMode || isAzimuthMode) {
        const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
        if (!measurePoint1) {
          // First click: place start marker
          if (measureMarker1Ref.current) { measureMarker1Ref.current.remove(); }
          if (measureMarker2Ref.current) { measureMarker2Ref.current.remove(); measureMarker2Ref.current = null; }
          if (measureLineRef.current) { measureLineRef.current.remove(); measureLineRef.current = null; }
          setMeasureResult(null);
          measureMarker1Ref.current = L.circleMarker([pt.lat, pt.lng], {
            radius: 6, color: '#f97316', fillColor: '#f97316', fillOpacity: 1, weight: 2
          }).addTo(map.current!);
          setMeasurePoint1(pt);
        } else {
          // Second click: place end marker, draw line, show result
          if (measureMarker2Ref.current) { measureMarker2Ref.current.remove(); }
          if (measureLineRef.current) { measureLineRef.current.remove(); }
          measureMarker2Ref.current = L.circleMarker([pt.lat, pt.lng], {
            radius: 6, color: '#f97316', fillColor: '#f97316', fillOpacity: 1, weight: 2
          }).addTo(map.current!);
          measureLineRef.current = L.polyline(
            [[measurePoint1.lat, measurePoint1.lng], [pt.lat, pt.lng]],
            { color: '#f97316', weight: 2, dashArray: '6,4' }
          ).addTo(map.current!);
          const dist = calculateDistance(measurePoint1, pt);
          const azRad = isAzimuthMode ? calculateBearing(measurePoint1, pt) : undefined;
          const azDeg = azRad !== undefined
            ? Math.round(((azRad * 180 / Math.PI) % 360 + 360) % 360)
            : undefined;
          // Place label at midpoint using same style as route segment labels
          const midLat = (measurePoint1.lat + pt.lat) / 2;
          const midLng = (measurePoint1.lng + pt.lng) / 2;
          const distLabel = dist >= 1000
            ? `${(dist / 1000).toFixed(3)} km`
            : `${Math.round(dist)} m`;
          const labelText = azDeg !== undefined
            ? `${distLabel} | ${azDeg}°`
            : distLabel;
          if (measureLabelRef.current) { measureLabelRef.current.remove(); }
          measureLabelRef.current = L.marker([midLat, midLng], {
            icon: L.divIcon({
              className: 'segment-length-label',
              html: `<span style="direction: ltr; text-align: left;">${labelText}</span>`
            }),
            interactive: false,
            zIndexOffset: 500
          }).addTo(map.current!);
          setMeasureResult({ distance: dist, azimuth: azDeg });
          // Reset to allow next measurement
          setMeasurePoint1(null);
        }
        return;
      }

      // If in coord mode, ignore regular clicks
      if (isCoordMode) return;

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
        const originalEvent = e.originalEvent as MouseEvent | undefined;
        const clickTarget = originalEvent?.target as HTMLElement | null;
        const isClickOnPopup = clickTarget?.closest('.edit-mode-indicator') !== null;
        
        // If click is on the pop-up, ignore it
        if (isClickOnPopup) {
          return;
        }
        
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
          const lineId = segmentIdByIndex[closestSegmentIndex] ?? `seg-${closestSegmentIndex}`;

          // Allow selection with normal click - toggle selection on/off
          // Selection is PERSISTENT - halos remain visible until toggled off or parallel lines are created
          setSelectedLineIds((prev) => {
            const idx = prev.indexOf(lineId);
            if (idx >= 0) {
              // Remove if already selected (halo will disappear)
              const next = [...prev];
              next.splice(idx, 1);
              return next;
            }
            // Add to selection (halo will appear and persist)
            return [...prev, lineId];
          });
          setParallelBatchError(null);
          return;
        } else {
          alert('לחץ קרוב יותר למקטע קו.');
        }
        return;
      }

      // If there are selected points, a click on the map should ONLY clear the selection
      // and NOT create a new point.
      // BUT: In parallel line mode, don't clear point selection (different selection system)
      if (selectedPointIndices.size > 0 && !justFinishedDraggingRef.current && !isParallelLineMode) {
        setSelectedPointIndices(new Set());
        return;
      }

      // Add new point if drawing and there is no active selection
      if (isDrawing && dtmLoaded) {
        // Skip creating a new point if we just finished dragging a point
        if (justFinishedDraggingRef.current) {
          return;
        }

        // Don't add a point if clicking on a marker (let marker handle the click for dragging)
        const originalEvent = e.originalEvent as MouseEvent | undefined;
        const clickTarget = originalEvent?.target as HTMLElement | null;
        const isMarkerClick = clickTarget?.closest('.flight-point-marker');
        if (isMarkerClick) {
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
          setIsRotateMode(false);
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
      
      // Exit rotate mode on right-click
      if (isRotateMode) {
        e.originalEvent.preventDefault();
        setIsRotateMode(false);
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
  }, [
    computeDefaultOffsetForSegmentIndex,
    dtmLoaded,
    editingPointIndex,
    externalEditPointIndex,
    flightPath,
    isAoiSelectionMode,
    isDrawing,
    isParallelLineMode,
    isRotateMode,
    onAddPoint,
    onAddPoints,
    onEditPointIndexChange,
    onUpdatePoint,
    segmentIdByIndex,
    selectedPointIndices.size,
    setSelectedPointIndices,
    isPointWithinBounds,
    isMeasureLengthMode,
    isAzimuthMode,
    isCoordMode,
    measurePoint1,
    formatSegmentLength
  ]);

  // Multi-select helper functions
  const togglePointSelection = useCallback((index: number) => {
    setSelectedPointIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const selectAllPoints = useCallback(() => {
    setSelectedPointIndices(new Set(flightPath.map((_, i) => i)));
  }, [flightPath]);

  // Rotate helpers - preserves segment lengths and cumulative distances
  const rotatePointsAroundCenter = useCallback(
    (
      initialPoints: Coordinate[],
      centerUtm: { easting: number; northing: number; zone: number; hemisphere: 'N' | 'S' },
      angleRad: number
    ): Coordinate[] => {
      if (initialPoints.length < 2) return initialPoints;

      const utmProjString = `+proj=utm +zone=${centerUtm.zone} +${
        centerUtm.hemisphere === 'N' ? 'north' : 'south'
      } +datum=WGS84 +units=m +no_defs`;

      // Calculate initial segment lengths and bearings in UTM
      const segmentLengths: number[] = [];
      const segmentBearings: number[] = [];
      
      for (let i = 0; i < initialPoints.length - 1; i++) {
        const pt1Utm = latLngToUTM(initialPoints[i].lat, initialPoints[i].lng);
        const pt2Utm = latLngToUTM(initialPoints[i + 1].lat, initialPoints[i + 1].lng);
        
        if (!pt1Utm || !pt2Utm) {
          // Fallback to simple rotation if UTM conversion fails
          return initialPoints.map((pt) => {
            const ptUtm = latLngToUTM(pt.lat, pt.lng);
            if (!ptUtm) return pt;
            const dx = ptUtm.easting - centerUtm.easting;
            const dy = ptUtm.northing - centerUtm.northing;
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            const rx = dx * cos - dy * sin;
            const ry = dx * sin + dy * cos;
            const newEasting = centerUtm.easting + rx;
            const newNorthing = centerUtm.northing + ry;
            try {
              const [lng, lat] = proj4(utmProjString, 'EPSG:4326', [newEasting, newNorthing]);
              return { ...pt, lng, lat };
            } catch (error) {
              debug.error('Failed to convert rotated UTM back to lat/lng:', error);
              return pt;
            }
          });
        }
        
        const dx = pt2Utm.easting - pt1Utm.easting;
        const dy = pt2Utm.northing - pt1Utm.northing;
        const length = Math.sqrt(dx * dx + dy * dy);
        const bearing = Math.atan2(dy, dx);
        
        segmentLengths.push(length);
        segmentBearings.push(bearing);
      }

      // Rotate first point around center
      const firstPtUtm = latLngToUTM(initialPoints[0].lat, initialPoints[0].lng);
      if (!firstPtUtm) return initialPoints;
      
      const dx0 = firstPtUtm.easting - centerUtm.easting;
      const dy0 = firstPtUtm.northing - centerUtm.northing;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const rx0 = dx0 * cos - dy0 * sin;
      const ry0 = dx0 * sin + dy0 * cos;
      const newFirstEasting = centerUtm.easting + rx0;
      const newFirstNorthing = centerUtm.northing + ry0;

      let firstLng: number, firstLat: number;
      try {
        [firstLng, firstLat] = proj4(utmProjString, 'EPSG:4326', [newFirstEasting, newFirstNorthing]);
      } catch (error) {
        debug.error('Failed to convert rotated first point:', error);
        return initialPoints;
      }

      const rotated: Coordinate[] = [{ ...initialPoints[0], lng: firstLng, lat: firstLat }];

      // Build remaining points by placing each segment at the end of the previous one,
      // maintaining the original segment length but with rotated bearing
      let currentEasting = newFirstEasting;
      let currentNorthing = newFirstNorthing;

      for (let i = 0; i < segmentLengths.length; i++) {
        // Rotate the bearing by the rotation angle
        const rotatedBearing = segmentBearings[i] + angleRad;
        const length = segmentLengths[i];
        
        // Calculate next point position
        const nextEasting = currentEasting + length * Math.cos(rotatedBearing);
        const nextNorthing = currentNorthing + length * Math.sin(rotatedBearing);
        
        // Convert back to lat/lng
        let nextLng: number, nextLat: number;
        try {
          [nextLng, nextLat] = proj4(utmProjString, 'EPSG:4326', [nextEasting, nextNorthing]);
        } catch (error) {
          debug.error('Failed to convert rotated point:', error);
          return initialPoints;
        }
        
        rotated.push({ ...initialPoints[i + 1], lng: nextLng, lat: nextLat });
        currentEasting = nextEasting;
        currentNorthing = nextNorthing;
      }

      return rotated;
    },
    []
  );

  // Clear selection when flight path changes (points added/removed)
  useEffect(() => {
    // Only clear if indices are out of bounds
    setSelectedPointIndices((prev) => {
      const valid = new Set<number>();
      prev.forEach((idx) => {
        if (idx >= 0 && idx < flightPath.length) {
          valid.add(idx);
        }
      });
      return valid;
    });
  }, [flightPath.length]);

  // Rotate mode: attach map drag handlers to rotate entire path with cursor
  useEffect(() => {
    if (!map.current) return;

    const mapInstance = map.current;

    const handleRotateMouseDown = (e: L.LeafletMouseEvent) => {
      if (!isRotateMode) return;
      if (flightPath.length < 2) return;

      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent && originalEvent.button !== 0) return; // left button only
      
      // Stop event propagation to prevent other handlers from interfering
      if (originalEvent) {
        originalEvent.stopPropagation();
        originalEvent.preventDefault();
      }
      L.DomEvent.stop(e);

      // Compute rotation center as geometric center of current path
      const avgLat =
        flightPath.reduce((sum, p) => sum + p.lat, 0) / flightPath.length;
      const avgLng =
        flightPath.reduce((sum, p) => sum + p.lng, 0) / flightPath.length;

      const centerLat = avgLat;
      const centerLng = avgLng;

      const centerUtm = latLngToUTM(centerLat, centerLng);
      const mouseUtm = latLngToUTM(e.latlng.lat, e.latlng.lng);
      if (!centerUtm || !mouseUtm) {
        return;
      }

      rotateCenterRef.current = { lat: centerLat, lng: centerLng };
      rotateCenterUtmRef.current = centerUtm as any;
      rotateInitialPointsRef.current = flightPath.map((p) => ({ ...p }));

      const startAngle = Math.atan2(
        mouseUtm.northing - centerUtm.northing,
        mouseUtm.easting - centerUtm.easting
      );
      rotateStartAngleRef.current = startAngle;
      isRotatingRef.current = true;

      // Disable map interactions while rotating
      mapInstance.dragging.disable();
      mapInstance.touchZoom.disable();
      mapInstance.doubleClickZoom.disable();
      mapInstance.scrollWheelZoom.disable();
      mapInstance.boxZoom.disable();
      mapInstance.keyboard.disable();
    };

    const applyRotationPreview = (angleDelta: number) => {
      if (
        !rotateCenterUtmRef.current ||
        !rotateInitialPointsRef.current ||
        !map.current
      ) {
        return;
      }

      const rotated = rotatePointsAroundCenter(
        rotateInitialPointsRef.current,
        rotateCenterUtmRef.current as any,
        angleDelta
      );

      // If any point goes outside DTM bounds, do not preview that step
      const outOfBounds = rotated.some((p) => !isPointWithinBounds(p.lng, p.lat));
      if (outOfBounds) return;

      // Update markers and polyline previews without touching React state
      rotated.forEach((pt, idx) => {
        const marker = markersRef.current[idx];
        if (marker) {
          marker.setLatLng([pt.lat, pt.lng]);
        }
      });

      const latlngs = rotated.map((p) => [p.lat, p.lng] as [number, number]);
      if (flightPathLineRef.current) {
        flightPathLineRef.current.setLatLngs(latlngs);
      }
      if (flightPathClickableLineRef.current) {
        flightPathClickableLineRef.current.setLatLngs(latlngs);
      }
      if (flightPathBufferRef.current) {
        flightPathBufferRef.current.setLatLngs(latlngs);
      }
    };

    const handleRotateMouseMove = (e: L.LeafletMouseEvent) => {
      if (!isRotatingRef.current) return;
      if (!rotateCenterUtmRef.current || rotateStartAngleRef.current === null) {
        return;
      }

      const mouseUtm = latLngToUTM(e.latlng.lat, e.latlng.lng);
      if (!mouseUtm) return;

      const centerUtm = rotateCenterUtmRef.current as any;
      const currentAngle = Math.atan2(
        mouseUtm.northing - centerUtm.northing,
        mouseUtm.easting - centerUtm.easting
      );
      const angleDelta = currentAngle - rotateStartAngleRef.current;
      applyRotationPreview(angleDelta);
    };

    const handleRotateMouseUp = (e: L.LeafletMouseEvent) => {
      if (!isRotatingRef.current) return;

      isRotatingRef.current = false;

      // Re-enable map interactions
      mapInstance.dragging.enable();
      mapInstance.touchZoom.enable();
      mapInstance.doubleClickZoom.enable();
      mapInstance.scrollWheelZoom.enable();
      mapInstance.boxZoom.enable();
      mapInstance.keyboard.enable();

      if (
        !rotateCenterUtmRef.current ||
        !rotateInitialPointsRef.current ||
        rotateStartAngleRef.current === null
      ) {
        rotateCenterRef.current = null;
        rotateCenterUtmRef.current = null;
        rotateInitialPointsRef.current = null;
        rotateStartAngleRef.current = null;
        return;
      }

      const mouseUtm = latLngToUTM(e.latlng.lat, e.latlng.lng);
      if (!mouseUtm) {
        // Revert to initial positions
        const original = rotateInitialPointsRef.current;
        if (original) {
          onPathChange(original);
        }
        rotateCenterRef.current = null;
        rotateCenterUtmRef.current = null;
        rotateInitialPointsRef.current = null;
        rotateStartAngleRef.current = null;
        return;
      }

      const centerUtm = rotateCenterUtmRef.current as any;
      const currentAngle = Math.atan2(
        mouseUtm.northing - centerUtm.northing,
        mouseUtm.easting - centerUtm.easting
      );
      const angleDelta = currentAngle - rotateStartAngleRef.current;

      const rotated = rotatePointsAroundCenter(
        rotateInitialPointsRef.current!,
        centerUtm,
        angleDelta
      );

      const outOfBounds = rotated.some((p) => !isPointWithinBounds(p.lng, p.lat));
      if (outOfBounds) {
        alert('לא ניתן לסובב: חלק מהנקודות יוצאות מגבולות ה‑DTM.');
        // Revert visuals and state to original
        const original = rotateInitialPointsRef.current!;
        onPathChange(original);
      } else {
        // Clear profile first by temporarily setting path to empty, then set rotated path
        // This forces profile recalculation with new coordinates after rotation
        onPathChange([]);
        // Use requestAnimationFrame to ensure the empty path is processed before setting the rotated path
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            onPathChange(rotated);
          });
        });
      }

      rotateCenterRef.current = null;
      rotateCenterUtmRef.current = null;
      rotateInitialPointsRef.current = null;
      rotateStartAngleRef.current = null;
    };

    mapInstance.on('mousedown', handleRotateMouseDown);
    mapInstance.on('mousemove', handleRotateMouseMove);
    mapInstance.on('mouseup', handleRotateMouseUp);

    return () => {
      mapInstance.off('mousedown', handleRotateMouseDown);
      mapInstance.off('mousemove', handleRotateMouseMove);
      mapInstance.off('mouseup', handleRotateMouseUp);
      isRotatingRef.current = false;
    };
  }, [flightPath, isRotateMode, isPointWithinBounds, onPathChange, rotatePointsAroundCenter]);

  // Prevent clickable line from interfering with rotate mode
  useEffect(() => {
    if (!flightPathClickableLineRef.current) return;
    
    const line = flightPathClickableLineRef.current;
    
    // Temporarily remove clickable line from map during rotate mode to allow rotation
    if (isRotateMode) {
      if (map.current && map.current.hasLayer(line)) {
        map.current.removeLayer(line);
      }
    } else {
      if (map.current && !map.current.hasLayer(line)) {
        line.addTo(map.current);
      }
    }
  }, [isRotateMode]);

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
        return cached;
      }
    } else if (avgAGLCacheRef.current.has(cacheKey) && !hasPlannedAltitudes) {
      // Clear cache if we don't have planned altitudes yet (profile might be updating)
      avgAGLCacheRef.current.delete(cacheKey);
    }

    // Get point heights
    const startHeight = start.height ?? nominalFlightHeight;
    const endHeight = end.height ?? nominalFlightHeight;

    // Check if DTM is available
    if (!dtmRasterDataRef.current) {
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

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
      const plannedAltitude = elevationProfile && elevationProfile.length > 0
        ? interpolatePlannedAltitude(elevationProfile, distanceAlongPath, nominalFlightHeight)
        : startHeight + (endHeight - startHeight) * t;
      
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
        }
      } else {
        dtmNullCount++;
      }
    }

    // If we don't have enough valid samples, return null
    const requiredSamples = Math.ceil(samplePoints.length * 0.5);
    if (validSamples < requiredSamples) {
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

    // Calculate average AGL
    const avgAGL = aglValues.reduce((sum, agl) => sum + agl, 0) / aglValues.length;
    
    if (!isFinite(avgAGL) || avgAGL <= 0) {
      debug.error(`[avgAGL] Invalid avgAGL for segment ${startIndex}-${endIndex}: ${avgAGL}`);
      avgAGLCacheRef.current.set(cacheKey, null);
      return null;
    }

    // Only cache if we have planned altitudes - don't cache values calculated without planned altitudes
    const hasPlannedAltitudesForCache = elevationProfile && elevationProfile.some(p => p.plannedAltitude !== undefined);
    if (hasPlannedAltitudesForCache) {
      avgAGLCacheRef.current.set(cacheKey, avgAGL);
    }
    
    return avgAGL;
  }, [calculateElevationAtPoint, elevationProfile, flightPath, nominalFlightHeight, _climbRequests]);

  // Invalidate avgAGL cache when flightPath or DTM changes
  useEffect(() => {
    const currentSignature = JSON.stringify(flightPath.map(p => ({ lng: p.lng, lat: p.lat, height: p.height })));
    if (currentSignature !== flightPathSignatureRef.current) {
      avgAGLCacheRef.current.clear();
      flightPathSignatureRef.current = currentSignature;
    }
  }, [flightPath]);

  // Invalidate cache when DTM changes
  useEffect(() => {
    avgAGLCacheRef.current.clear();
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
      }
    } else if (elevationProfile && elevationProfile.length === 0) {
      // Profile cleared
      avgAGLCacheRef.current.clear();
      (avgAGLCacheRef.current as any).__lastProfileSignature = undefined;
      (avgAGLCacheRef.current as any).__lastHadPlannedAltitudes = false;
    }
  }, [elevationProfile]);

  // Invalidate cache when entry height (nominalFlightHeight) changes
  useEffect(() => {
    avgAGLCacheRef.current.clear();
  }, [nominalFlightHeight]);

  // Invalidate cache when climb requests change (climb points added/removed/modified)
  useEffect(() => {
    const climbSignature = JSON.stringify(_climbRequests.map(c => ({ endDistance: c.endDistance, climbAmount: c.climbAmount })));
    const lastClimbSignature = (avgAGLCacheRef.current as any).__lastClimbSignature;
    if (climbSignature !== lastClimbSignature) {
      avgAGLCacheRef.current.clear();
      (avgAGLCacheRef.current as any).__lastClimbSignature = climbSignature;
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

  // Handle coordinate mode - show UTM on mouse move, copy on right-click
  useEffect(() => {
    if (!map.current || !isCoordMode) {
      setCoordModePos(null);
      return;
    }

    const handleMouseMove = (e: L.LeafletMouseEvent) => {
      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent) {
        setCoordModePos({ lat: e.latlng.lat, lng: e.latlng.lng, x: originalEvent.clientX, y: originalEvent.clientY });
      }
    };

    const handleContextMenu = (e: L.LeafletMouseEvent) => {
      e.originalEvent?.preventDefault();
      const utm = latLngToUTM(e.latlng.lat, e.latlng.lng);
      if (utm) {
        const text = `N: ${utm.northing.toFixed(2)} E: ${utm.easting.toFixed(2)} (${utm.zone}${utm.hemisphere})`;
        navigator.clipboard.writeText(text).catch(() => {/* ignore */});
      }
    };

    map.current.on('mousemove', handleMouseMove);
    map.current.on('contextmenu', handleContextMenu);

    return () => {
      if (map.current) {
        map.current.off('mousemove', handleMouseMove);
        map.current.off('contextmenu', handleContextMenu);
      }
      setCoordModePos(null);
    };
  }, [isCoordMode]);

  // Update flight path on map
  useEffect(() => {
    if (!map.current) return;

    // Remove existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Remove existing vertex proximity circles
    vertexProximityCirclesRef.current.forEach(circle => circle.remove());
    vertexProximityCirclesRef.current = [];

    climbMarkersRef.current.forEach(marker => marker.remove());
    climbMarkersRef.current = [];
    importedPointsMarkersRef.current.forEach(marker => marker.remove());
    importedPointsMarkersRef.current = [];

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

    // NOTE: Do NOT remove halos here - they are managed by the dedicated halo rendering useEffect
    // Halos will be updated automatically when flightPath changes via the halo rendering effect

    // Render imported points from all KML imports even if flightPath is empty
    kmlImports.filter(kml => kml.visible).forEach((kmlImport) => {
      kmlImport.points.forEach((point) => {
        // Create marker icon with custom symbol and color
        const iconHtml = getPointIconHtml(kmlImport.symbol, kmlImport.color);
        const pointIcon = L.divIcon({
          className: 'imported-point-marker',
          html: iconHtml,
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        });

        const pointMarker = L.marker([point.lat, point.lng], {
          icon: pointIcon,
          interactive: false,
          zIndexOffset: 620
        }).addTo(map.current!);

        importedPointsMarkersRef.current.push(pointMarker);

        // Add label
        if (point.label) {
          const labelIcon = L.divIcon({
            className: 'imported-point-label',
            html: `<span class="imported-point-label__text">${point.label}</span>`,
            iconSize: [1, 1],
            iconAnchor: [0, -4]
          });

          const labelMarker = L.marker([point.lat, point.lng], {
            icon: labelIcon,
            interactive: false,
            zIndexOffset: 610
          }).addTo(map.current!);

          importedPointsMarkersRef.current.push(labelMarker);
        }
      });
    });

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
      if (isRotateMode) return; // Don't interfere with rotate mode
      
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
      if (isRotateMode) return; // Don't interfere with rotate mode

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

    // Right-click on route line → show "Add climb point" context menu
    const handleRouteContextMenu = (e: L.LeafletMouseEvent) => {
      if (!onRequestClimbAtDistance) return;
      e.originalEvent.preventDefault();
      L.DomEvent.stop(e);

      const mousePt = { lng: e.latlng.lng, lat: e.latlng.lat };
      let minSegDist = Infinity;
      let hoveredDistance = 0;
      let currentCumulative = 0;
      for (let i = 0; i < flightPath.length - 1; i++) {
        const start = flightPath[i];
        const end = flightPath[i + 1];
        const segmentLen = calculateDistance(start, end);
        const result = findClosestPointOnLine(mousePt, start, end);
        if (result.distance < minSegDist) {
          minSegDist = result.distance;
          hoveredDistance = currentCumulative + result.t * segmentLen;
        }
        currentCumulative += segmentLen;
      }
      setRouteContextMenu({ x: e.originalEvent.clientX, y: e.originalEvent.clientY, distance: hoveredDistance });
    };

    flightPathClickableLineRef.current.on('contextmenu', handleRouteContextMenu);

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
      weight: activeRouteLineWidth,
      opacity: 0.8,
      interactive: false // Disable interaction to prevent flickering with the wide clickable layer
    }).addTo(map.current);

    // Add segment length labels at midpoints
    if (showAzimuthDistanceLabels) {
      for (let i = 0; i < flightPath.length - 1; i++) {
        const start = flightPath[i];
        const end = flightPath[i + 1];
        const distanceMeters = calculateDistance(start, end);
        const midpointLat = (start.lat + end.lat) / 2;
        const midpointLng = (start.lng + end.lng) / 2;

        const bearingRad = calculateBearing(start, end);
        const bearingDeg = (bearingRad * 180) / Math.PI;
        const normalizedBearing = ((bearingDeg % 360) + 360) % 360;
        const azimuthDeg = Math.round(normalizedBearing);
        let displayAngle = normalizedBearing <= 270 ? bearingDeg - 90 : bearingDeg + 90;
        // Add extra 180 degree rotation for azimuth between 180-270
        if (normalizedBearing >= 180 && normalizedBearing <= 270) {
          displayAngle += 180;
        }

        // Offset label by constant pixel amount perpendicular to the line
        // Transform order (applied right-to-left): center, rotate, then offset perpendicular
        const offsetPixels = 12; // pixels
        const labelIcon = L.divIcon({
          className: 'segment-length-label',
          html: `<span style="transform: translateY(-${offsetPixels}px) rotate(${displayAngle}deg) translate(-50%, -50%); direction: ltr; text-align: left;">${formatSegmentLength(distanceMeters)} | ${azimuthDeg}°</span>`
        });

        const labelMarker = L.marker([midpointLat, midpointLng], {
          icon: labelIcon,
          interactive: false,
          zIndexOffset: 500
        }).addTo(map.current!);

        segmentLengthLabelsRef.current.push(labelMarker);
      }
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

      // Update visual state based on selection - will be updated via useEffect
      const updateMarkerVisualState = () => {
        const isSelected = selectedPointIndices.has(index);
        if (isSelected) {
          el.classList.add('is-selected');
        } else {
          el.classList.remove('is-selected');
        }
      };
      updateMarkerVisualState();
      
      // Store update function for later use
      (marker as any).__updateSelection = updateMarkerVisualState;

      // Store the last valid position for this marker
      let lastValidPosition: [number, number] = [point.lat, point.lng];
      let isDraggingWithLeftClick = false;
      let dragStartLatLng: L.LatLng | null = null;
      let dragStartClientX = 0;
      let dragStartClientY = 0;
      let hasStartedDragging = false; // Track if we've actually started dragging
      let isAltPressed = false; // Track ALT key state during drag
      let altConstraintToastShown = false; // Track if we've shown the toast for non-endpoint ALT

      // Pixels of movement below which we treat as a click (do not change point location)
      const CLICK_VS_DRAG_THRESHOLD_PX = 6;

      // Handle marker click for selection
      el.addEventListener('click', (e) => {
        // Only handle left mouse button (button 0)
        if (e.button !== 0) return;
        
        // Check for Ctrl (Windows/Linux) or Cmd (macOS) modifier
        const isModifierPressed = e.ctrlKey || e.metaKey;
        
        if (isModifierPressed) {
          // Toggle selection
          e.preventDefault();
          e.stopPropagation();
          togglePointSelection(index);
        } else {
          // Single click: select only this point (clear others)
          // But don't clear if we're about to drag
          if (!isDrawing) {
            setSelectedPointIndices(new Set([index]));
          }
        }
      });

      // Handle marker left-click to start dragging
      el.addEventListener('mousedown', (e) => {
        // Only handle left mouse button (button 0)
        if (e.button !== 0) return;
        // Don't interfere with rotate mode
        if (isRotateMode) return;
        // Always allow dragging when DTM is loaded (regardless of draw mode)
        if (!dtmLoaded) return;

        e.preventDefault();
        e.stopPropagation();
        
        // Disable map dragging immediately to prevent conflicts
        if (map.current) {
          map.current.dragging.disable();
        }

        const isModifierPressed = e.ctrlKey || e.metaKey;

        // If clicking on a point while holding Ctrl/Cmd, toggle selection (add or remove)
        if (isModifierPressed) {
          setSelectedPointIndices((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
              next.delete(index); // Deselect if already selected
            } else {
              next.add(index); // Select if not selected
            }
            return next;
          });
        } else {
          // No modifier: clicking a non-selected point should select ONLY that point
          if (!selectedPointIndices.has(index)) {
            setSelectedPointIndices(new Set([index]));
          }
        }

        // Start left-click drag mode (but don't disable interactions yet - wait for actual drag)
        isDraggingWithLeftClick = true;
        isMarkerDragActiveRef.current = true;
        hasStartedDragging = false; // Reset drag flag
        lastValidPosition = [point.lat, point.lng];
        el.style.cursor = 'grabbing';
        el.classList.add('is-dragging');
        marker.setZIndexOffset(1000);
        isAltPressed = e.altKey; // Capture initial ALT state
        altConstraintToastShown = false; // Reset toast flag

        // Store drag start position (map and screen) for threshold check
        dragStartLatLng = marker.getLatLng();
        dragStartClientX = e.clientX;
        dragStartClientY = e.clientY;

        // Store original positions of all selected points for group drag
        // Only enable group drag if MULTIPLE points are selected (not just one)
        if (selectedPointIndices.size > 1) {
          isGroupDraggingRef.current = true;
          dragStartPositionsRef.current.clear();
          selectedPointIndices.forEach((idx) => {
            if (idx >= 0 && idx < flightPath.length) {
              dragStartPositionsRef.current.set(idx, { ...flightPath[idx] });
            }
          });
        } else {
          isGroupDraggingRef.current = false;
          dragStartPositionsRef.current.clear();
          dragStartPositionsRef.current.set(index, { ...point });
        }

        // Use window-level events with capture phase to ensure we get all events
        // Disable map dragging first to prevent conflicts
        window.addEventListener('mousemove', handleMouseMove, true);
        window.addEventListener('mouseup', handleMouseUp, true);
        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('keyup', handleKeyUp, true);

        // Don't disable map interactions on mousedown - only disable when actual dragging starts (on mousemove)
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

      // Helper function to project a point onto a line direction in UTM coordinates
      // Returns the constrained point in lat/lng, or null if constraint cannot be applied
      const projectPointOntoLineDirection = (
        endpointLat: number,
        endpointLng: number,
        mouseLat: number,
        mouseLng: number,
        pointIndex: number,
        path: Coordinate[]
      ): { lat: number; lng: number } | null => {
        // Check if this is an endpoint
        const isFirstPoint = pointIndex === 0;
        const isLastPoint = pointIndex === path.length - 1;
        
        if (!isFirstPoint && !isLastPoint) {
          return null; // Not an endpoint, constraint doesn't apply
        }

        if (path.length < 2) {
          return null; // Need at least 2 points to determine direction
        }

        // Determine the direction vector
        let directionPoint: Coordinate;
        if (isFirstPoint) {
          // For first point: direction = normalize(P0 - P1), so movement extends the line
          directionPoint = path[1];
        } else {
          // For last point: direction = normalize(Pn - P(n-1))
          directionPoint = path[path.length - 2];
        }

        // Convert all points to UTM for vector math
        const endpointUtm = latLngToUTM(endpointLat, endpointLng);
        const directionPointUtm = latLngToUTM(directionPoint.lat, directionPoint.lng);
        const mouseUtm = latLngToUTM(mouseLat, mouseLng);

        if (!endpointUtm || !directionPointUtm || !mouseUtm) {
          return null; // Conversion failed
        }

        // Calculate direction vector in UTM (meters)
        const dirX = endpointUtm.easting - directionPointUtm.easting;
        const dirY = endpointUtm.northing - directionPointUtm.northing;
        const dirLength = Math.sqrt(dirX * dirX + dirY * dirY);

        if (dirLength < 0.001) {
          return null; // Points are too close, can't determine direction
        }

        // Normalize direction vector
        const dirUnitX = dirX / dirLength;
        const dirUnitY = dirY / dirLength;

        // Vector from endpoint to mouse position
        const mouseX = mouseUtm.easting - endpointUtm.easting;
        const mouseY = mouseUtm.northing - endpointUtm.northing;

        // Project mouse position onto the line direction
        const projectionLength = mouseX * dirUnitX + mouseY * dirUnitY;

        // Calculate constrained point in UTM
        const constrainedEasting = endpointUtm.easting + dirUnitX * projectionLength;
        const constrainedNorthing = endpointUtm.northing + dirUnitY * projectionLength;

        // Convert back to lat/lng
        const utmProjString = `+proj=utm +zone=${endpointUtm.zone} +${endpointUtm.hemisphere === 'N' ? 'north' : 'south'} +datum=WGS84 +units=m +no_defs`;
        try {
          const [lng, lat] = proj4(utmProjString, 'EPSG:4326', [constrainedEasting, constrainedNorthing]);
          return { lat, lng };
        } catch (error) {
          console.error('Failed to convert UTM back to lat/lng:', error);
          return null;
        }
      };

      // Handle ALT key state changes during drag
      const handleKeyDown = (e: KeyboardEvent) => {
        if (isDraggingWithLeftClick && e.key === 'Alt') {
          isAltPressed = true;
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        if (isDraggingWithLeftClick && e.key === 'Alt') {
          isAltPressed = false;
        }
      };

      // Handle mouse move to update marker position during drag
      const handleMouseMove = (e: MouseEvent) => {
        if (!isDraggingWithLeftClick || !map.current || !dragStartLatLng) return;

        // Update ALT state from event
        isAltPressed = e.altKey;

        // Disable map interactions only when dragging actually starts (first mousemove)
        if (!hasStartedDragging) {
          hasStartedDragging = true;
          if (map.current) {
            map.current.dragging.disable();
            map.current.touchZoom.disable();
            map.current.doubleClickZoom.disable();
            map.current.scrollWheelZoom.disable();
            map.current.boxZoom.disable();
            map.current.keyboard.disable();
          }
        }

        e.preventDefault();
        e.stopPropagation();

        // Use Leaflet's helper to convert the mouse event to map coordinates
        const currentLatLng = map.current.mouseEventToLatLng(e);
        const currentLng = currentLatLng.lng;
        const currentLat = currentLatLng.lat;

        // If group dragging, update all selected markers (ALT constraint doesn't apply to group drag)
        if (isGroupDraggingRef.current && selectedPointIndices.size > 1) {
          const deltaLng = currentLng - dragStartLatLng.lng;
          const deltaLat = currentLat - dragStartLatLng.lat;
          
          selectedPointIndices.forEach((idx) => {
            const originalPos = dragStartPositionsRef.current.get(idx);
            if (originalPos && idx >= 0 && idx < markersRef.current.length) {
              const newLng = originalPos.lng + deltaLng;
              const newLat = originalPos.lat + deltaLat;
              
              // Check bounds before updating
              if (isPointWithinBounds(newLng, newLat)) {
                const targetMarker = markersRef.current[idx];
                if (targetMarker) {
                  targetMarker.setLatLng([newLat, newLng]);
                }
              }
            }
          });
        } else {
          // Single point drag
          let targetLat = currentLat;
          let targetLng = currentLng;

          // Apply ALT constraint if ALT is pressed and this is an endpoint
          if (isAltPressed) {
            const isFirstPoint = index === 0;
            const isLastPoint = index === flightPath.length - 1;
            
            if (isFirstPoint || isLastPoint) {
              // Get original position from drag start
              const originalPos = dragStartPositionsRef.current.get(index);
              if (originalPos) {
                const constrained = projectPointOntoLineDirection(
                  originalPos.lat,
                  originalPos.lng,
                  currentLat,
                  currentLng,
                  index,
                  flightPath
                );
                
                if (constrained) {
                  targetLat = constrained.lat;
                  targetLng = constrained.lng;
                }
              }
            } else {
              // ALT pressed on non-endpoint: show toast once
              if (!altConstraintToastShown) {
                altConstraintToastShown = true;
                // Show a brief visual feedback
                setSuccessNotification({ 
                  isOpen: true, 
                  message: 'ALT constraint works only on first/last point' 
                });
              }
            }
          }

          // Check if point is within DTM bounds
          if (!isPointWithinBounds(targetLng, targetLat)) {
            return; // Don't update if outside bounds
          }

          // Update marker position (use markersRef to get the current marker,
          // which may have been re-created by React during drag)
          const currentDragMarker = markersRef.current[index];
          if (currentDragMarker) {
            currentDragMarker.setLatLng([targetLat, targetLng]);
          }
          lastValidPosition = [targetLat, targetLng];
        }
      };

      // Handle mouse up to end drag
      const handleMouseUp = (e: MouseEvent) => {
        if (!isDraggingWithLeftClick) return;

        // Remove window event listeners when drag ends (must match capture phase)
        window.removeEventListener('mousemove', handleMouseMove, true);
        window.removeEventListener('mouseup', handleMouseUp, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('keyup', handleKeyUp, true);

        e.preventDefault();
        e.stopPropagation();

        // Update ALT state from event
        isAltPressed = e.altKey;

        // Re-enable map interactions if they were disabled (only if we actually dragged)
        if (hasStartedDragging && map.current) {
          map.current.dragging.enable();
          map.current.touchZoom.enable();
          map.current.doubleClickZoom.enable();
          map.current.scrollWheelZoom.enable();
          map.current.boxZoom.enable();
          map.current.keyboard.enable();
        }

        if (!map.current || !dragStartLatLng) {
          // Clean up even if drag wasn't valid
          isDraggingWithLeftClick = false;
          isMarkerDragActiveRef.current = false;
          hasStartedDragging = false;
          isAltPressed = false;
          const curMarker = markersRef.current[index];
          const curEl = curMarker?.getElement() as HTMLElement | null;
          if (curEl) { curEl.style.cursor = ''; curEl.classList.remove('is-dragging'); }
          if (curMarker) curMarker.setZIndexOffset(0);
          return;
        }

        // Treat as click (do not edit location) if no drag or movement below threshold
        const moveDistancePx = Math.hypot(e.clientX - dragStartClientX, e.clientY - dragStartClientY);
        const isClickOnly = !hasStartedDragging || moveDistancePx < CLICK_VS_DRAG_THRESHOLD_PX;

        if (isClickOnly) {
          // Re-enable map if we had disabled it when drag started
          if (hasStartedDragging && map.current) {
            map.current.dragging.enable();
            map.current.touchZoom.enable();
            map.current.doubleClickZoom.enable();
            map.current.scrollWheelZoom.enable();
            map.current.boxZoom.enable();
            map.current.keyboard.enable();
          }
          // Revert all affected markers to original positions (selection only, no move)
          if (isGroupDraggingRef.current && selectedPointIndices.size > 0) {
            selectedPointIndices.forEach((idx) => {
              const originalPos = dragStartPositionsRef.current.get(idx);
              if (originalPos && idx < markersRef.current.length) {
                const m = markersRef.current[idx];
                if (m) m.setLatLng([originalPos.lat, originalPos.lng]);
              }
            });
          } else {
            const originalPos = dragStartPositionsRef.current.get(index);
            if (originalPos) {
              const dropMarker = markersRef.current[index];
              if (dropMarker) dropMarker.setLatLng([originalPos.lat, originalPos.lng]);
              lastValidPosition = [originalPos.lat, originalPos.lng];
            }
          }
          isDraggingWithLeftClick = false;
          isMarkerDragActiveRef.current = false;
          hasStartedDragging = false;
          isAltPressed = false;
          altConstraintToastShown = false;
          const cleanupMarker = markersRef.current[index];
          const cleanupEl = cleanupMarker?.getElement() as HTMLElement | null;
          if (cleanupEl) {
            cleanupEl.style.cursor = 'pointer';
            cleanupEl.classList.remove('is-dragging');
          }
          if (cleanupMarker) cleanupMarker.setZIndexOffset(0);
          isGroupDraggingRef.current = false;
          dragStartPositionsRef.current.clear();
          justFinishedDraggingRef.current = true;
          setTimeout(() => { justFinishedDraggingRef.current = false; }, 100);
          return;
        }

        // On release, drop the point where the mouse was released (or constrained position)
        const dropLatLng = map.current.mouseEventToLatLng(e);
        let dropLng = dropLatLng.lng;
        let dropLat = dropLatLng.lat;

        // If group dragging, update all selected points (ALT constraint doesn't apply to group drag)
        if (isGroupDraggingRef.current && selectedPointIndices.size > 0) {
          const deltaLng = dropLng - dragStartLatLng.lng;
          const deltaLat = dropLat - dragStartLatLng.lat;

          const updatedPath = [...flightPath];
          let allValid = true;
          const updates: Array<{ index: number; point: Coordinate }> = [];

          selectedPointIndices.forEach((idx) => {
            if (idx >= 0 && idx < flightPath.length) {
              const originalPos = dragStartPositionsRef.current.get(idx);
              if (originalPos) {
                const newLng = originalPos.lng + deltaLng;
                const newLat = originalPos.lat + deltaLat;
                
                if (isPointWithinBounds(newLng, newLat)) {
                  updatedPath[idx] = {
                    ...originalPos,
                    lng: newLng,
                    lat: newLat
                  };
                  updates.push({ index: idx, point: updatedPath[idx] });
                } else {
                  allValid = false;
                }
              }
            }
          });

          if (allValid && updates.length > 0) {
            // Batch update using onPathChange for single undo entry
            onPathChange(updatedPath);
            onGroupMoveCommitted?.(updatedPath);
          } else {
            // Revert all markers to original positions
            selectedPointIndices.forEach((idx) => {
              const originalPos = dragStartPositionsRef.current.get(idx);
              if (originalPos && idx < markersRef.current.length) {
                const targetMarker = markersRef.current[idx];
                if (targetMarker) {
                  targetMarker.setLatLng([originalPos.lat, originalPos.lng]);
                }
              }
            });
            alert('לא ניתן להזיז נקודות מחוץ לתיבת התוחם של ה-DTM. כל הנקודות אופסו למיקום החוקי הקודם.');
          }
        } else {
          // Single point drag
          // Apply ALT constraint if ALT is pressed and this is an endpoint
          if (isAltPressed) {
            const isFirstPoint = index === 0;
            const isLastPoint = index === flightPath.length - 1;
            
            if (isFirstPoint || isLastPoint) {
              const originalPos = dragStartPositionsRef.current.get(index);
              if (originalPos) {
                const constrained = projectPointOntoLineDirection(
                  originalPos.lat,
                  originalPos.lng,
                  dropLat,
                  dropLng,
                  index,
                  flightPath
                );
                
                if (constrained) {
                  dropLat = constrained.lat;
                  dropLng = constrained.lng;
                }
              }
            }
          }

          // Use markersRef to get the current marker (may have been re-created)
          const dropMarker = markersRef.current[index];
          if (isPointWithinBounds(dropLng, dropLat)) {
            if (dropMarker) dropMarker.setLatLng([dropLat, dropLng]);
            lastValidPosition = [dropLat, dropLng];
            // Update React state ONCE at the end to avoid re-rendering/remounting markers mid-drag
            onUpdatePoint(index, { lng: dropLng, lat: dropLat, height: point.height });
          }

          // Validate final position
          const finalMarker = markersRef.current[index];
          if (finalMarker) {
            const finalLatLng = finalMarker.getLatLng();
            if (!isPointWithinBounds(finalLatLng.lng, finalLatLng.lat)) {
              // Reset to last valid position if outside bounds
              finalMarker.setLatLng(lastValidPosition);
              onUpdatePoint(index, { lng: lastValidPosition[1], lat: lastValidPosition[0] });
              alert('לא ניתן להזיז נקודה מחוץ לתיבת התוחם של ה-DTM. הנקודה אופסה למיקום החוקי הקודם.');
            }
          }
        }

        isDraggingWithLeftClick = false;
        isMarkerDragActiveRef.current = false;
        hasStartedDragging = false;
        isAltPressed = false;
        altConstraintToastShown = false;
        // Use markersRef for cleanup (original el/marker may have been removed)
        const cleanupMarker = markersRef.current[index];
        const cleanupEl = cleanupMarker?.getElement() as HTMLElement | null;
        if (cleanupEl) {
          cleanupEl.style.cursor = 'pointer';
          cleanupEl.classList.remove('is-dragging');
        }
        if (cleanupMarker) cleanupMarker.setZIndexOffset(0);
        isGroupDraggingRef.current = false;
        dragStartPositionsRef.current.clear();

        // Map interactions are already re-enabled above if they were disabled

        // Set flag to prevent map click handler from creating a new point
        justFinishedDraggingRef.current = true;
        // Reset the flag after a short delay to allow the click event to be ignored
        setTimeout(() => {
          justFinishedDraggingRef.current = false;
        }, 100);
      };

      // Store cleanup function for when marker is removed
      marker.on('remove', () => {
        // Do NOT remove window listeners if a drag is in progress — the markers are being
        // re-created by React but the drag should survive the re-creation.
        if (isMarkerDragActiveRef.current) return;
        // Clean up any active window event listeners if marker is removed outside of drag
        window.removeEventListener('mousemove', handleMouseMove, true);
        window.removeEventListener('mouseup', handleMouseUp, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('keyup', handleKeyUp, true);
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

      // Store marker and element for selection updates
      markersRef.current.push(marker);

      // Add bright circle around point with radius = vertexProximityMeters
      if (showVertexRadius && climbConfig && climbConfig.vertexProximityMeters > 0) {
        const circle = L.circle([point.lat, point.lng], {
          radius: climbConfig.vertexProximityMeters,
          color: '#808080', // Gray
          fillColor: '#808080',
          fillOpacity: 0.2,
          weight: 2,
          opacity: 0.8
        }).addTo(map.current!);
        vertexProximityCirclesRef.current.push(circle);
      }
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
    isRotateMode,
    nominalFlightHeight,
    editingPointIndex,
    externalEditPointIndex,
    activeRouteColor,
    activeRouteLineWidth,
    climbMarkers,
    showClimbLabels,
    selectedPointIndices,
    togglePointSelection,
    climbConfig,
    showVertexRadius,
    showAzimuthDistanceLabels
  ]);

  // Update marker visual state when selection changes
  useEffect(() => {
    markersRef.current.forEach((marker) => {
      const updateFn = (marker as any).__updateSelection;
      if (updateFn && typeof updateFn === 'function') {
        updateFn();
      }
    });
  }, [selectedPointIndices]);

  // Keyboard shortcuts for multi-select
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: cancel active drag and revert to original positions
      if (e.key === 'Escape' && isGroupDraggingRef.current) {
        // Revert all selected markers to original positions
        selectedPointIndices.forEach((idx) => {
          const originalPos = dragStartPositionsRef.current.get(idx);
          if (originalPos && idx < markersRef.current.length) {
            const targetMarker = markersRef.current[idx];
            if (targetMarker) {
              targetMarker.setLatLng([originalPos.lat, originalPos.lng]);
            }
          }
        });
        isGroupDraggingRef.current = false;
        dragStartPositionsRef.current.clear();
        
        // Re-enable map interactions
        if (map.current) {
          map.current.dragging.enable();
          map.current.touchZoom.enable();
          map.current.doubleClickZoom.enable();
          map.current.scrollWheelZoom.enable();
          map.current.boxZoom.enable();
          map.current.keyboard.enable();
        }
        
        // Remove dragging class from all markers
        markersRef.current.forEach((marker) => {
          const icon = marker.getIcon();
          if (icon && (icon as any).options?.html) {
            const el = (icon as any).options.html as HTMLElement;
            if (el && el.classList) {
              el.classList.remove('is-dragging');
              el.style.cursor = 'pointer';
            }
          }
          marker.setZIndexOffset(0);
        });
      }
      
      // Delete: delete all selected points (only if not in input/textarea)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPointIndices.size > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return; // Don't delete if user is typing
        }
        
        e.preventDefault();
        
        // Confirm deletion if multiple points
        if (selectedPointIndices.size > 1) {
          if (!confirm(`האם למחוק ${selectedPointIndices.size} נקודות?`)) {
            return;
          }
        }
        
        // Delete points in reverse order to maintain indices
        const sortedIndices = Array.from(selectedPointIndices).sort((a, b) => b - a);
        sortedIndices.forEach((idx) => {
          if (idx >= 0 && idx < flightPath.length) {
            onDeletePoint(idx);
          }
        });
        
        // Clear selection
        setSelectedPointIndices(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedPointIndices, flightPath.length, onDeletePoint, setSelectedPointIndices]);

  // Ctrl+3 keyboard shortcut to cycle 3D view modes
  useEffect(() => {
    const handle3DShortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '3') {
        e.preventDefault();
        if (dtmLoaded) {
          setThreeDMode(prev => prev === 'off' ? 'full' : prev === 'full' ? 'float' : 'off');
        }
      }
    };
    window.addEventListener('keydown', handle3DShortcut);
    return () => window.removeEventListener('keydown', handle3DShortcut);
  }, [dtmLoaded]);

  // Re-validate Leaflet map size when returning from full-screen 3D mode
  useEffect(() => {
    if (threeDMode !== 'full' && map.current) {
      // Small delay to let display:none → visible transition complete
      const timer = setTimeout(() => {
        map.current?.invalidateSize();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [threeDMode]);

  // Render halos for selected lines in parallel mode
  // Halos are PERSISTENT - they remain visible until:
  // 1) User creates parallel lines (selection cleared after creation)
  // 2) User Ctrl/Cmd+clicks to unselect a line
  // 3) User exits parallel line mode
  // Halos do NOT disappear on normal clicks or other map interactions
  useEffect(() => {
    if (!map.current || !isParallelLineMode || flightPath.length < 2) {
      // Remove all halos if not in parallel mode or no flight path
      selectedLineHalosRef.current.forEach((halo) => halo.remove());
      selectedLineHalosRef.current = [];
      return;
    }

    // Remove existing halos (will be re-rendered below if still selected)
    selectedLineHalosRef.current.forEach((halo) => halo.remove());
    selectedLineHalosRef.current = [];

    // Add halos for selected lines - these persist until selection changes
    if (selectedLineIds.length > 0) {
      const selectedLineSet = new Set(selectedLineIds);
      for (let i = 0; i < flightPath.length - 1; i++) {
        const lineId = segmentIdByIndex[i];
        if (lineId && selectedLineSet.has(lineId)) {
          const start = flightPath[i];
          const end = flightPath[i + 1];
          const halo = L.polyline([[start.lat, start.lng], [end.lat, end.lng]], {
            color: '#0ea5e9',
            weight: 12,
            opacity: 0.4,
            interactive: false,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(map.current);
          selectedLineHalosRef.current.push(halo);
        }
      }
    }
  }, [isParallelLineMode, selectedLineIds, flightPath, segmentIdByIndex]);

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
    if (!showNextLineSuggestions) {
      // Still calculate spacing even when suggestions are hidden, but only if DTM is available
      if (flightPath.length >= 2 && dtmRasterDataRef.current) {
        const spacingValues: number[] = [];
        for (let i = 0; i < flightPath.length - 1; i++) {
          const start = flightPath[i];
          const end = flightPath[i + 1];
          const avgAGL = computeAvgAGLForSegment(start, end, i, i + 1, nominalFlightHeight);
          // DTM is required - if AGL is null, skip this segment
          if (avgAGL === null) {
            continue;
          }
          const effectiveAGL = avgAGL;
          const spacing = calculateNextLineSpacing(overlapPercentage, fovDegrees, effectiveAGL);
          // Only collect valid spacing values
          if (spacing !== null && spacing > 0 && Number.isFinite(spacing)) {
            spacingValues.push(spacing);
          }
        }
        // For single line use exact value, for multiple lines use average
        if (spacingValues.length === 0) {
          averageNextLineSpacingRef.current = 50;
        } else if (spacingValues.length === 1) {
          averageNextLineSpacingRef.current = Math.round(spacingValues[0] * 10) / 10;
        } else {
          const average = calculateAverageNextLineSpacing(spacingValues);
          averageNextLineSpacingRef.current = average !== null && average > 0
            ? Math.round(average * 10) / 10
            : 50;
        }
      } else if (flightPath.length >= 2 && !dtmRasterDataRef.current) {
        // DTM not available - set to default
        averageNextLineSpacingRef.current = 50;
      }
      return;
    }

    if (flightPath.length < 2) {
      averageNextLineSpacingRef.current = 50;
      return;
    }

    // Check if DTM is available - required for accurate calculations
    if (!dtmRasterDataRef.current) {
      averageNextLineSpacingRef.current = 50;
      return;
    }

    const spacingValues: number[] = [];

    for (let i = 0; i < flightPath.length - 1; i++) {
      const start = flightPath[i];
      const end = flightPath[i + 1];
      
      // Compute line-specific avgAGL
      const avgAGL = computeAvgAGLForSegment(start, end, i, i + 1, nominalFlightHeight);
      
      // DTM is required - if AGL is null, skip this segment
      if (avgAGL === null) {
        continue;
      }

      const effectiveAGL = avgAGL;

      // Use shared spacing calculation function with line-specific avgAGL
      const spacing = calculateNextLineSpacing(overlapPercentage, fovDegrees, effectiveAGL);
      
      if (spacing === null || spacing <= 0) {
        continue;
      }

      // Collect only valid spacing values for average calculation
      spacingValues.push(spacing);

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

    // Calculate and store spacing: for single line use exact value, for multiple lines use average
    if (spacingValues.length === 0) {
      averageNextLineSpacingRef.current = 50;
    } else if (spacingValues.length === 1) {
      // For a single line, use the exact distance to the dashed suggested line
      const singleSpacing = spacingValues[0];
      if (singleSpacing !== undefined && Number.isFinite(singleSpacing)) {
        averageNextLineSpacingRef.current = Math.round(singleSpacing * 10) / 10;
      } else {
        averageNextLineSpacingRef.current = 50;
      }
    } else {
      // For multiple lines, use the average of all valid spacing values
      const average = calculateAverageNextLineSpacing(spacingValues);
      averageNextLineSpacingRef.current = average !== null && average > 0
        ? Math.round(average * 10) / 10
        : 50;
    }

    return () => {
      suggestedLinesRef.current.forEach((line) => {
        map.current?.removeLayer(line);
      });
      suggestedLinesRef.current = [];
    };
  }, [flightPath, overlapPercentage, fovDegrees, nominalFlightHeight, activeRouteColor, showNextLineSuggestions, computeAvgAGLForSegment, elevationProfile, _climbRequests, kmlImports, showClimbLabels, climbMarkers]);

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
      const routeLineWidth = Number.isFinite(route.lineWidth) ? route.lineWidth : 3;
      if (existing) {
        existing.setLatLngs(latlngs);
        existing.setStyle({ color: route.color, weight: routeLineWidth });
      } else {
        passiveRouteLinesRef.current[route.id] = L.polyline(latlngs, {
          color: route.color,
          weight: routeLineWidth,
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
      } catch (error) {
        debug.warn('Failed to fit bounds to routes:', error);
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
    if (hoveredElevationPoint && (hoverSource === 'map' || hoverSource === 'profile' || hoverSource === 'overlap')) {
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
    } else if (isRotateMode) {
      map.current.getContainer().style.cursor = 'grab';
    } else if (!isDrawing && currentEditingIndex === null) {
      map.current.getContainer().style.cursor = 'grab'; // indicate map can be panned by dragging
    }
  }, [isParallelLineMode, isRotateMode, isDrawing, editingPointIndex, externalEditPointIndex]);

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
      setDtmLoadState('IDLE');
      setDtmLoadError(null);
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
      setDtmLoadState('LOADING'); // Set loading state when starting to load
      setDtmLoadError(null);
      setIsDtmProcessing(true);
      
      // Clear any existing polling
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      if (pollingAbortRef.current) {
        pollingAbortRef.current.abort();
        pollingAbortRef.current = null;
      }
      
      try {
        // Check if dtmSource is a clipped DTM API path or a filename
        let rasterUrl: string;
        let clippedId: string | null = null;
        const isClippedDtm = dtmSource.startsWith('/api/dtm/clipped/');
        
        if (isClippedDtm) {
          // For clipped DTMs, dtmSource is already the API endpoint path (e.g., /api/dtm/clipped/{clippedId}/raster)
          rasterUrl = dtmSource;
          // Extract clippedId from the path
          const match = dtmSource.match(/\/api\/dtm\/clipped\/([^\/]+)/);
          if (match) {
            clippedId = match[1];
          }
          
          // For clipped DTMs, poll readiness before proceeding
          if (clippedId) {
            debug.log(`Polling DTM readiness for clipped DTM: ${clippedId}`);
            try {
              const isReady = await pollDtmReadiness(clippedId, 120, 500);
              if (!isReady) {
                throw new Error('DTM readiness check failed or timed out');
              }
              debug.log(`DTM ${clippedId} is ready, proceeding with load`);
            } catch (pollError) {
              const errorMsg = pollError instanceof Error ? pollError.message : 'DTM readiness check failed';
              setDtmLoadState('FAILED');
              setDtmLoadError(errorMsg);
              setIsDtmProcessing(false);
              alert(`DTM is still preparing. Please wait a moment and try again.\n\nError: ${errorMsg}`);
              return;
            }
          }
        } else {
          // For uploaded DTMs, extract filename and construct API path
          const filename = dtmSource.split('/').pop();
          if (!filename) {
            setDtmLoadState('IDLE');
            setIsDtmProcessing(false);
            return;
          }
          rasterUrl = `/api/dtm/${filename}/raster`;
        }

        // Fetch raster data
        const response = await fetch(rasterUrl);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || `Failed to load DTM data: ${response.status}`);
        }

        const rasterData = await response.json();
        const { width, height, data, min, max, bounds, isProjected, epsg, crs } = rasterData;

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new Error('Invalid DTM data: empty or invalid data array');
        }

        if (!bounds || !Array.isArray(bounds) || bounds.length !== 4) {
          throw new Error('Invalid DTM bounds');
        }

        // Backend now returns bounds in WGS84, so no transformation needed
        const transformedBounds = bounds;

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

        // Helper function to add DTM layer
        // @ts-ignore
        const addDTMLayer = (img: HTMLImageElement, bounds: number[]) => {
          if (!map.current) {
            debug.error('Map not initialized');
            return;
          }

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

            // Only set READY state after DTM is fully rendered and ready
            setDtmLoadState('READY');
            setDtmLoadError(null);
            setDtmBounds(bounds); // Store bounds for the "Fit to DTM" button
            setIsDtmProcessing(false);
            
            debug.log('DTM loaded and ready for elevation queries');

            // Fit map to DTM bounds (now in WGS84)
            try {
              map.current.fitBounds(imageBounds, {
                padding: [50, 50],
                maxZoom: 18
              });
            } catch (fitError) {
              debug.error('Error fitting map to bounds:', fitError);
              // Fallback: try to center on the middle of the bounds
              const centerLng = (minX + maxX) / 2;
              const centerLat = (minY + maxY) / 2;
              map.current.setView([centerLat, centerLng], 13);
            }
          } catch (sourceError) {
            debug.error('Error adding DTM source/layer:', sourceError);
            setDtmLoadState('FAILED');
            setDtmLoadError(sourceError instanceof Error ? sourceError.message : 'Unknown error');
            setIsDtmProcessing(false);
            alert(`Can't add DTM: ${sourceError instanceof Error ? sourceError.message : 'Unknown error'}\nSee console for details.`);
          }
        };

        // Convert canvas to image
        const img = new Image();
        img.onload = () => {
          // Wait for map to be fully loaded
          if (!map.current) {
            debug.error('Map not initialized');
            return;
          }

          addDTMLayer(img, transformedBounds);
        };

        img.onerror = (error) => {
          debug.error('Error loading DTM image:', error);
          setDtmLoadState('FAILED');
          setDtmLoadError('Failed to create DTM image');
          setIsDtmProcessing(false);
          alert('לא ניתן ליצור תמונת DTM. ראה קונסולה.');
        };

        const dataUrl = canvas.toDataURL();
        if (dataUrl.length < 100) {
          debug.error('Canvas data URL seems too short, might be empty!');
        }
        img.src = dataUrl;
      } catch (error) {
        debug.error('Error loading DTM:', error);
        const errorMessage = error instanceof Error ? error.message : 'שגיאה לא ידועה';
        setDtmLoadState('FAILED');
        setDtmLoadError(errorMessage);
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
              onDtmLoad(data.path, data, undefined, {
                sourceType: 'local',
                originalFile: file
              });
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
      // Remove climb markers immediately so both start/end markers disappear right away.
      climbMarkersRef.current.forEach(marker => marker.remove());
      climbMarkersRef.current = [];

      // Source-of-truth cleanup in App: clear climb requests and route points together.
      onDeleteAllPoints();
      setIsRotateMode(false);
    }
  };

  const handleResetView = () => {
    if (!map.current) return;
    map.current.setView([31.0461, 34.8516], 6); // Israel default
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

    const { width, height, data, bounds, noDataValue } = viewshedRaster;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.createImageData(width, height);
    const alpha = 220;
    for (let i = 0; i < data.length; i++) {
      const value = Number(data[i]);
      const rgb = getViewshedClassColor(value, noDataValue, viewshedClassColors);
      const idx = i * 4;
      if (rgb === null) {
        imageData.data[idx] = 0;
        imageData.data[idx + 1] = 0;
        imageData.data[idx + 2] = 0;
        imageData.data[idx + 3] = 0;
      } else {
        imageData.data[idx] = rgb.r;
        imageData.data[idx + 1] = rgb.g;
        imageData.data[idx + 2] = rgb.b;
        imageData.data[idx + 3] = alpha;
      }
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
  }, [clearViewshedOverlay, viewshedRaster, viewshedVisible, viewshedOpacity, viewshedClassColors]);

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

    // Viewshed TIFF is now reprojected to WGS84 by the backend, so bounds should already be in WGS84
    // However, we still check the CRS in case of legacy files or if reprojection failed
    let bounds = bbox;
    if (sourceProj && sourceProj !== 'EPSG:4326') {
      // If viewshed is not in WGS84, try to transform (fallback for legacy files)
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
          console.warn('Viewshed bounds transformation failed, using original bounds');
        }
      }
    } else if (!sourceProj) {
      // If no CRS info, use fallback bounds
      const fallbackBounds = dtmRasterDataRef.current?.bounds ?? dtmBounds ?? null;
      if (fallbackBounds && fallbackBounds.length === 4) {
        bounds = fallbackBounds;
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
      setViewshedJobId(null);
    }
    skipViewshedReplaceConfirmRef.current = false;

    stopViewshedPolling();
    setIsViewshedProcessing(true);
    setViewshedStatus('running');
    setViewshedProgress(0);
    pendingViewshedRouteSnapshotRef.current = flightPath.map((point) => ({ ...point }));
    try {
      // Use flightPath (user waypoints only) so overlap leg pairs are based on legs between waypoints.
      // The backend interpolates between waypoints for the viewshed raster; segment boundaries
      // are derived from waypoints → 4 points → 1 pair, 6 points → 2 pairs, etc.
      const trajectory = buildViewshedTrajectory(flightPath, elevationProfile, nominalFlightHeight);

      const response = await fetch('/api/viewshed/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dtmPath: dtmSource,
          clippedId: propClippedId ?? undefined,
          coordinates: trajectory,
          samplingIntervalMeters: 50,
          outputHeight: resolutionHeight,
          fovDegrees: fovDegrees
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
        // Keep jobId for downloading the TIFF file
        return;
      }

      const startPayload = await response.json();
      const jobId = startPayload.jobId as string;
      setViewshedJobId(jobId);
      setViewshedOverlapByPoint(null);
      setViewshedPointDistances(null);

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
            const obp = statusJson.overlapByPoint;
            const overlapData = obp && typeof obp === 'object' && !Array.isArray(obp) ? obp : null;
            setViewshedOverlapByPoint(overlapData);
            // Prefer pointDistancesByPair (dict); fallback: build from flat pointDistances array
            let distByPair: Record<string, number[]> | null = null;
            if (statusJson.pointDistancesByPair && typeof statusJson.pointDistancesByPair === 'object' && !Array.isArray(statusJson.pointDistancesByPair)) {
              distByPair = statusJson.pointDistancesByPair as Record<string, number[]>;
            } else if (Array.isArray(statusJson.pointDistances) && overlapData) {
              const flat = statusJson.pointDistances as number[];
              distByPair = {};
              Object.keys(overlapData).forEach((label) => {
                const pts = overlapData[label] ?? [];
                distByPair![label] = pts.map(([idx1Based]: [number]) => {
                  const d = flat[idx1Based - 1];
                  return typeof d === 'number' ? d : (idx1Based - 1) * 1.0;
                });
              });
            }
            setViewshedPointDistances(distByPair);
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
            setViewshedJobId(null);
            setViewshedOverlapByPoint(null);
            setViewshedPointDistances(null);
            if (status === 'error') {
              alert(`שגיאה ביצירת שדה ראייה: ${statusJson.error || 'שגיאה לא ידועה'}`);
            }
          }
        } catch (pollError) {
          console.error('Viewshed status polling failed:', pollError);
          stopViewshedPolling();
          setIsViewshedProcessing(false);
          setViewshedStatus('error');
          setViewshedJobId(null);
          setViewshedOverlapByPoint(null);
          setViewshedPointDistances(null);
        }
      }, 1500);
    } catch (error) {
      console.error('Error generating viewshed:', error);
      alert(`שגיאה ביצירת שדה ראייה: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
      setViewshedStatus('error');
      setViewshedJobId(null);
    } finally {
      if (!viewshedPollRef.current) {
        setIsViewshedProcessing(false);
      }
    }
  }, [dtmSource, dtmLoaded, flightPath, isViewshedProcessing, nominalFlightHeight, propClippedId, stopViewshedPolling, viewshedStatus, loadViewshedFromArrayBuffer, flightPathSignature, resolutionHeight, fovDegrees]);

  const deactivateAllMeasurementModes = useCallback(() => {
    setIsInfoMode(false);
    setIsCoordMode(false);
    setIsMeasureLengthMode(false);
    setIsAzimuthMode(false);
    setCoordModePos(null);
    setCursorElevation(null);
    setMousePos(null);
    setMeasurePoint1(null);
    setMeasureResult(null);
    if (measureLineRef.current) { measureLineRef.current.remove(); measureLineRef.current = null; }
    if (measureMarker1Ref.current) { measureMarker1Ref.current.remove(); measureMarker1Ref.current = null; }
    if (measureMarker2Ref.current) { measureMarker2Ref.current.remove(); measureMarker2Ref.current = null; }
    if (measureLabelRef.current) { measureLabelRef.current.remove(); measureLabelRef.current = null; }
    elevationCacheRef.current.clear();
  }, []);

  const handleViewshedButtonClick = useCallback(() => {
    if (hasViewshedResult) {
      setViewshedModalMode('settings');
      setIsViewshedModalOpen(true);
      return;
    }
    // First click (no result yet): start calculation immediately; show progress modal so user can cancel
    setViewshedModalMode('progress');
    setIsViewshedModalOpen(true);
    handleGenerateViewshed();
  }, [handleGenerateViewshed, hasViewshedResult]);

  const handleCancelViewshed = useCallback(async () => {
    if (!viewshedJobId) return;
    try {
      await fetch(`/api/viewshed/cancel/${viewshedJobId}`, { method: 'POST' });
      setViewshedStatus('cancelled');
      setViewshedJobId(null);
    } catch (error) {
      console.error('Cancel viewshed failed:', error);
    } finally {
      stopViewshedPolling();
      setIsViewshedProcessing(false);
    }
  }, [viewshedJobId, stopViewshedPolling]);

  const handleDownloadViewshedTiff = useCallback(async () => {
    if (!viewshedJobId || viewshedStatus !== 'done') {
      alert('שדה ראייה לא זמין להורדה');
      return;
    }

    try {
      const response = await fetch(`/api/viewshed/result/${viewshedJobId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch viewshed TIFF file');
      }

      const blob = await response.blob();
      const defaultFilename = `viewshed_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.tif`;
      
      await saveFileWithLocation(blob, defaultFilename, 'image/tiff');
    } catch (error) {
      console.error('Error downloading viewshed TIFF:', error);
      if (error instanceof Error && error.message === 'User cancelled file save') {
        // User cancelled - don't show error
        return;
      }
      alert(`שגיאה בהורדת קובץ שדה הראייה: ${error instanceof Error ? error.message : 'שגיאה לא ידועה'}`);
    }
  }, [viewshedJobId, viewshedStatus]);

  const handleSaveOverlapGraphPng = useCallback(async () => {
    const svgEl = overlapChartRef.current?.querySelector('svg');
    if (!svgEl) {
      alert('אין גרף חפיפה לשמירה. הרץ שדה ראייה קודם.');
      return;
    }
    try {
      const svgData = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            reject(new Error('Canvas context unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          canvas.toBlob(async (blob) => {
            if (blob) {
              try {
                await saveFileWithLocation(blob, `viewshed_overlap_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 10)}.png`, 'image/png');
                resolve();
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error('Failed to create blob'));
            }
          }, 'image/png');
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to load SVG'));
        };
        img.src = url;
      });
    } catch (err) {
      console.error('Save overlap graph PNG failed:', err);
      alert(`שגיאה בשמירת גרף: ${err instanceof Error ? err.message : 'שגיאה לא ידועה'}`);
    }
  }, []);

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
    setViewshedJobId(null);
    setViewshedOverlapByPoint(null);
    setViewshedPointDistances(null);
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
      setOverlapGraphWindowOpen(true);
    }
  }, [viewshedStatus, isViewshedModalOpen, viewshedModalMode]);

  useEffect(() => {
    if (!dtmSource || !dtmLoaded) {
      setViewshedRaster(null);
      setViewshedVisible(false);
      setViewshedJobId(null);
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

  const U_TURN_REGULAR_MIN_RADIUS_M = 5;

  const handleOpenUTurn = () => {
    if (!dtmLoaded) {
      alert('טען DTM תחילה.');
      return;
    }
    if (flightPath.length < 2) {
      alert('הוסף לפחות שתי נקודות תחילה.');
      return;
    }
    let defaultDistance = averageNextLineSpacingRef.current ?? 50;
    try {
      const lastSegmentIndex = flightPath.length - 2;
      if (lastSegmentIndex >= 0) {
        defaultDistance = computeDefaultOffsetForSegmentIndex(lastSegmentIndex);
      }
    } catch {
      // keep defaultDistance fallback
    }
    const initialBetweenStart =
      consecutiveUTurnSelection != null ? String(consecutiveUTurnSelection.startIndex) : '';
    const initialBetweenEnd =
      consecutiveUTurnSelection != null ? String(consecutiveUTurnSelection.startIndex + 1) : '';
    setDialog({
      type: 'uTurn',
      title: 'הגדרות פרסה'
    });
    setDialogValues({
      uTurnMode: 'regular',
      radius: '150',
      distance: String(defaultDistance),
      uturnSide: 'right',
      startPointIndex: initialBetweenStart,
      endPointIndex: initialBetweenEnd
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
      const result = createParallelLineForSegmentIndex(segmentIndex, offset);
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      onAddPoints(result.points);
      // Remember last used distance for better defaults
      lastParallelOffsetRef.current = offset;
      const lineId = segmentIdByIndex[segmentIndex] ?? `seg-${segmentIndex}`;
      lastParallelOffsetByLineIdRef.current.set(lineId, offset);
      setIsParallelLineMode(false);
      resetDialog();
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
      const mode = dialogValues.uTurnMode || 'regular';
      const radius = parseFloat(dialogValues.radius || '');

      if (mode === 'regular') {
        const distance = parseFloat(dialogValues.distance || '');
        if (isNaN(radius) || radius < U_TURN_REGULAR_MIN_RADIUS_M) {
          setDialogError(`רדיוס מינימלי: ${U_TURN_REGULAR_MIN_RADIUS_M} מ'.`);
          return;
        }
        if (isNaN(distance) || distance <= 0) {
          setDialogError('מרחק חייב להיות > 0.');
          return;
        }
        const side: UTurnSide = dialogValues.uturnSide === 'left' ? 'L' : 'R';
        const radiusMeters = radius;
        const prev = flightPath[flightPath.length - 2];
        const start = flightPath[flightPath.length - 1];
        const numUTurnPoints = 10;
        const maxStartEndDistance = radiusMeters * 2;
        const clampedDistance = Math.min(distance, maxStartEndDistance);
        if (distance > maxStartEndDistance) {
          setDialogError(`מרחק מוגבל ל-${maxStartEndDistance}מ'.`);
          return;
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
        return;
      }

      if (mode === 'between') {
        const startPointIndex = parseInt(dialogValues.startPointIndex ?? '-1', 10);
        const endPointIndex = parseInt(dialogValues.endPointIndex ?? '-1', 10);
        if (startPointIndex < 0 || endPointIndex < 0) {
          setDialogError('בחר נקודת התחלה ונקודת סיום.');
          return;
        }
        if (startPointIndex === endPointIndex) {
          setDialogError('נקודת ההתחלה ונקודת הסיום חייבות להיות שונות.');
          return;
        }
        if (endPointIndex !== startPointIndex + 1) {
          setDialogError('הנקודות חייבות להיות רצופות (למשל נקודה 5 ונקודה 6).');
          return;
        }
        if (isNaN(radius) || radius <= 0) {
          setDialogError('רדיוס חייב להיות > 0.');
          return;
        }
        const startPoint = flightPath[startPointIndex];
        const endPoint = flightPath[endPointIndex];
        if (!startPoint || !endPoint) {
          setDialogError('נקודות לא נמצאו.');
          return;
        }
        const chordLength = calculateDistance(startPoint, endPoint);
        const minRadius = chordLength / 2;
        if (radius < minRadius) {
          setDialogError(`רדיוס מינימלי: חצי המרחק בין הנקודות (${Math.round(minRadius)} מ').`);
          return;
        }
        if (chordLength > radius * 2) {
          setDialogError(`מרחק בין הנקודות (${Math.round(chordLength)} מ') גדול מכפול רדיוס.`);
          return;
        }
        const numUTurnPoints = 10;
        const prev = startPointIndex > 0 ? flightPath[startPointIndex - 1] : null;
        const pts = generateUTurnPointsBetweenAhead(startPoint, endPoint, radius, numUTurnPoints, prev);
        if (pts.length === 0) {
          setDialogError('לא ניתן לבנות פרסה (רדיוס קטן מדי ביחס למרחק).');
          return;
        }
        const outOfBounds = pts.find(p => !isPointWithinBounds(p.lng, p.lat));
        if (outOfBounds) {
          setDialogError('פרסה מחוץ ל-DTM.');
          return;
        }
        const startHeight = startPoint.height;
        const uTurnPoints: Coordinate[] =
          startHeight !== undefined
            ? pts.map(p => ({ ...p, height: startHeight }))
            : pts;
        // Delete any climb points that sat on the segment being replaced by the U-turn arc.
        // Only targets the exact A→B segment; all other climb points are preserved.
        if (startPoint.id && endPoint.id && onDeleteClimbsOnSegment) {
          onDeleteClimbsOnSegment(startPoint.id, endPoint.id);
        }
        onInsertPoints(startPointIndex + 1, uTurnPoints);
        setSelectedPointIndices(new Set());
        resetDialog();
      }
    }
  };

  // Handle Enter key in quick add-point dialog
  useEffect(() => {
    if (!dialog) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleDialogSubmit();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [dialog]);

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
      const uTurnMode = dialogValues.uTurnMode || 'regular';
      const startPointIndex = parseInt(dialogValues.startPointIndex ?? '-1', 10);
      const endPointIndex = parseInt(dialogValues.endPointIndex ?? '-1', 10);
      const betweenValid =
        startPointIndex >= 0 &&
        endPointIndex === startPointIndex + 1 &&
        startPointIndex + 1 < flightPath.length;
      const chordLength =
        betweenValid && flightPath[startPointIndex] && flightPath[endPointIndex]
          ? calculateDistance(flightPath[startPointIndex], flightPath[endPointIndex])
          : 0;
      const betweenMinRadius = chordLength / 2;
      const betweenDirectionDeg =
        betweenValid && flightPath[startPointIndex] && flightPath[endPointIndex]
          ? Math.round(
              (calculateBearing(flightPath[startPointIndex], flightPath[endPointIndex]) * 180) / Math.PI
            )
          : null;

      return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <label className="quick-modal__label" style={{ margin: 0, minWidth: '90px' }}>
              מצב פרסה
            </label>
            <div className="quick-modal__segmented" style={{ flex: 1 }}>
              <button
                type="button"
                className={`quick-modal__pill ${uTurnMode === 'regular' ? 'active' : ''}`}
                onClick={() =>
                  setDialogValues((prev) => ({
                    ...prev,
                    uTurnMode: 'regular',
                    radius: prev.radius || '150'
                  }))
                }
              >
                פרסה רגילה
              </button>
              <button
                type="button"
                className={`quick-modal__pill ${uTurnMode === 'between' ? 'active' : ''}`}
                onClick={() =>
                  setDialogValues((prev) => ({
                    ...prev,
                    uTurnMode: 'between',
                    radius: prev.radius || '150'
                  }))
                }
              >
                בין נקודות
              </button>
            </div>
          </div>

          {uTurnMode === 'regular' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <label className="quick-modal__label" style={{ margin: 0, minWidth: '120px' }}>
                  כיוון
                </label>
                <div className="quick-modal__segmented">
                  <button
                    type="button"
                    className={`quick-modal__pill ${(dialogValues.uturnSide ?? 'right') === 'right' ? 'active' : ''}`}
                    onClick={() => setDialogValues((prev) => ({ ...prev, uturnSide: 'right' }))}
                  >
                    ימין
                  </button>
                  <button
                    type="button"
                    className={`quick-modal__pill ${dialogValues.uturnSide === 'left' ? 'active' : ''}`}
                    onClick={() => setDialogValues((prev) => ({ ...prev, uturnSide: 'left' }))}
                  >
                    שמאל
                  </button>
                </div>
              </div>
              <label className="quick-modal__label" htmlFor="distance-ut-input">
                מרחק ללג הבא (מ')
              </label>
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
                  const val = e.target.value;
                  if (val === '' || parseFloat(val) >= 0) {
                    setDialogValues((prev) => ({ ...prev, distance: val }));
                    validateDialogInput('distance-ut', val);
                  }
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
              <label className="quick-modal__label" htmlFor="radius-input">
                רדיוס (מ') — מינימום {U_TURN_REGULAR_MIN_RADIUS_M}
              </label>
              <input
                id="radius-input"
                type="number"
                min={U_TURN_REGULAR_MIN_RADIUS_M}
                max="10000"
                step="0.1"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.radius ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '' || parseFloat(val) >= 0) {
                    setDialogValues((prev) => ({ ...prev, radius: val }));
                    validateDialogInput('radius', val);
                  }
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
            </>
          )}

          {uTurnMode === 'between' && (
            <>
              <label className="quick-modal__label" htmlFor="uturn-start-point">
                נקודת התחלה
              </label>
              <select
                id="uturn-start-point"
                value={dialogValues.startPointIndex ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  const nextEnd = v === '' ? '' : String(parseInt(v, 10) + 1);
                  setDialogValues((prev) => ({
                    ...prev,
                    startPointIndex: v,
                    endPointIndex: nextEnd
                  }));
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              >
                <option value="">— בחר —</option>
                {flightPath.slice(0, Math.max(0, flightPath.length - 1)).map((_, i) => (
                  <option key={i} value={i}>
                    נקודה {i + 1}
                  </option>
                ))}
              </select>
              <label className="quick-modal__label" htmlFor="uturn-end-point">
                נקודת סיום
              </label>
              <select
                id="uturn-end-point"
                value={dialogValues.endPointIndex ?? ''}
                onChange={(e) =>
                  setDialogValues((prev) => ({ ...prev, endPointIndex: e.target.value }))
                }
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              >
                <option value="">— בחר קודם נקודת התחלה —</option>
                {startPointIndex >= 0 && startPointIndex + 1 < flightPath.length && (
                  <option value={startPointIndex + 1}>נקודה {startPointIndex + 2}</option>
                )}
              </select>
              {betweenValid && (
                <>
                  <div className="quick-modal__readonly-row">
                    <span className="quick-modal__label">כיוון (מחושב)</span>
                    <span className="quick-modal__value" aria-readonly>
                      {betweenDirectionDeg != null ? `${betweenDirectionDeg}°` : '—'}
                    </span>
                  </div>
                  <div className="quick-modal__readonly-row">
                    <span className="quick-modal__label">מרחק (מ') (מחושב)</span>
                    <span className="quick-modal__value" aria-readonly>
                      {Math.round(chordLength)}
                    </span>
                  </div>
                </>
              )}
              <label className="quick-modal__label" htmlFor="radius-between-input">
                רדיוס (מ') — מינימום {betweenValid ? Math.round(betweenMinRadius) : '…'} (לפי הנקודות)
              </label>
              <input
                id="radius-between-input"
                type="number"
                min={betweenValid ? betweenMinRadius : 0.1}
                step="0.1"
                required
                inputMode="decimal"
                aria-required="true"
                value={dialogValues.radius ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '' || parseFloat(val) >= 0) {
                    setDialogValues((prev) => ({ ...prev, radius: val }));
                  }
                }}
                className={`quick-modal__input ${dialogError ? 'error' : ''}`}
              />
            </>
          )}
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
          <div className="quick-modal__card viewshed-modal__card" onClick={(e) => e.stopPropagation()}>
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
                  <div className="viewshed-modal__icon-row" role="toolbar" aria-label="פעולות שדה ראייה">
                    <button
                      id="viewshed-visible-toggle"
                      type="button"
                      className={`btn btn-icon ${viewshedVisible ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setViewshedVisible(!viewshedVisible)}
                      disabled={!viewshedRaster}
                      aria-label={viewshedVisible ? 'הסתר שדה ראייה' : 'הצג שדה ראייה'}
                      title={viewshedVisible ? 'הסתר שדה ראייה מהמפה' : 'הצג שדה ראייה על המפה'}
                    >
                      <Icon name={viewshedVisible ? 'eye-off' : 'eye'} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      onClick={() => {
                        setOverlapGraphWindowOpen(true);
                        setIsViewshedModalOpen(false);
                        setViewshedModalMode(null);
                      }}
                      aria-label="גרף חפיפה"
                      title="גרף חפיפה (%) לאורך המסלול"
                    >
                      <Icon name="chart" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      onClick={handleDownloadViewshedTiff}
                      disabled={!viewshedJobId || viewshedStatus !== 'done'}
                      aria-label="הורד TIFF"
                      title="הורד קובץ TIFF של שדה הראייה"
                    >
                      <Icon name="download" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-tertiary btn-icon"
                      onClick={handleGenerateViewshed}
                      disabled={!dtmLoaded || flightPath.length < 2 || isViewshedProcessing}
                      aria-label="חשב מחדש"
                      title="חשב שדה ראייה מחדש לפי המסלול הנוכחי"
                    >
                      <Icon name="refresh" />
                    </button>
                  </div>

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
            {!hasViewshedResult && (
              <div className="quick-modal__actions viewshed-modal__actions">
                <button
                  type="button"
                  className="btn btn-destructive"
                  onClick={handleCancelViewshed}
                  disabled={!viewshedJobId || !isViewshedProcessing}
                >
                  בטל חישוב
                </button>
              </div>
            )}
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
        />
      )}
      {routeContextMenu && (
        <ContextMenu
          x={routeContextMenu.x}
          y={routeContextMenu.y}
          onClose={() => setRouteContextMenu(null)}
          onAddClimb={() => {
            onRequestClimbAtDistance?.(routeContextMenu.distance);
            setRouteContextMenu(null);
          }}
        />
      )}
      {(externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex) !== null && (
        <div className="edit-mode-indicator">
          מצב עריכה: לחץ על המפה כדי להזיז את נקודה {(externalEditPointIndex !== undefined ? externalEditPointIndex : editingPointIndex)! + 1}
        </div>
      )}
      {isParallelLineMode && (
        <div 
          ref={parallelWindowRef}
          className="parallel-lines-window"
          style={{
            left: parallelWindowPosition?.x ?? (window.innerWidth - 320),
            top: parallelWindowPosition?.y ?? 100,
            cursor: isDraggingParallelWindow ? 'grabbing' : 'default'
          }}
          onClick={(e) => {
            // Stop clicks on the window from triggering map click handler
            e.stopPropagation();
          }}
        >
          {/* Draggable header */}
          <div 
            className="parallel-lines-window__header"
            onMouseDown={handleParallelWindowDragStart}
            onTouchStart={handleParallelWindowDragStart}
            style={{ cursor: isDraggingParallelWindow ? 'grabbing' : 'grab' }}
          >
            <span className="parallel-lines-window__title">קווים מקבילים</span>
            <button
              type="button"
              className="parallel-lines-window__reset-btn"
              onClick={(e) => {
                e.stopPropagation();
                resetParallelWindowPosition();
              }}
              title="איפוס מיקום"
              aria-label="איפוס מיקום"
            >
              ↻
            </button>
          </div>

          {/* Window content */}
          <div className="parallel-lines-window__content">
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '10px', lineHeight: '1.4', fontFamily: 'inherit' }}>
              החזק Ctrl ולחץ על קווים כדי לבחור/לבטל בחירה.
            </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label className="quick-modal__label" htmlFor="parallel-batch-offset" style={{ margin: 0, minWidth: '120px' }}>
                מרחק בין קווים (מ')
              </label>
              <input
                id="parallel-batch-offset"
                className="quick-modal__input"
                type="number"
                min="0"
                max="10000"
                step="0.1"
                value={parallelBatchOffset}
                onChange={(e) => {
                  const val = e.target.value;
                  // Only allow positive numbers
                  if (val === '' || (parseFloat(val) >= 0)) {
                    setParallelBatchOffset(val);
                    setIsParallelBatchOffsetOverridden(true);
                    setParallelBatchError(null);
                  }
                }}
                disabled={selectedLineIds.length === 0}
                style={{ flex: 1, fontFamily: 'inherit' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label className="quick-modal__label" style={{ margin: 0, minWidth: '120px' }}>כיוון</label>
              <div className="quick-modal__segmented">
                <button
                  type="button"
                  className={`quick-modal__pill ${parallelBatchDirection === 'right' ? 'active' : ''}`}
                  onClick={() => setParallelBatchDirection('right')}
                >
                  ימין
                </button>
                <button
                  type="button"
                  className={`quick-modal__pill ${parallelBatchDirection === 'left' ? 'active' : ''}`}
                  onClick={() => setParallelBatchDirection('left')}
                >
                  שמאל
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedLineIds.length === 0}
              onClick={handleCreateParallelLinesBatch}
              style={{ width: '100%' }}
            >
              צור קווים מקבילים
            </button>
          </div>

            {parallelBatchError && (
              <div style={{ marginTop: '10px', color: '#dc2626', fontSize: '0.875rem', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecdd3', borderRadius: '8px', fontFamily: 'inherit' }}>
                {parallelBatchError}
              </div>
            )}
          </div>
        </div>
      )}
      {overlapGraphWindowOpen && (
        <div
          ref={overlapGraphWindowRef}
          className="overlap-graph-window"
          style={{
            left: overlapGraphWindowPosition?.x ?? (window.innerWidth - (overlapGraphWindowSize?.width ?? OVERLAP_GRAPH_DEFAULT_WIDTH)),
            top: overlapGraphWindowPosition?.y ?? 100,
            width: overlapGraphWindowSize?.width ?? OVERLAP_GRAPH_DEFAULT_WIDTH,
            height: overlapGraphWindowSize?.height ?? OVERLAP_GRAPH_DEFAULT_HEIGHT,
            cursor: isDraggingOverlapGraphWindow ? 'grabbing' : isResizingOverlapGraphWindow ? 'nwse-resize' : 'default'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="overlap-graph-window__header"
            onMouseDown={handleOverlapGraphWindowDragStart}
            onTouchStart={handleOverlapGraphWindowDragStart}
            style={{ cursor: isDraggingOverlapGraphWindow ? 'grabbing' : 'grab' }}
          >
            <span className="overlap-graph-window__title">גרף חפיפה (%)</span>
            <div className="overlap-graph-window__header-actions">
              <button
                type="button"
                className="overlap-graph-window__reset-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  resetOverlapGraphWindowPosition();
                }}
                title="איפוס מיקום"
                aria-label="איפוס מיקום"
              >
                ↻
              </button>
              <button
                type="button"
                className="overlap-graph-window__close-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setOverlapGraphWindowOpen(false);
                }}
                title="סגור"
                aria-label="סגור"
              >
                ×
              </button>
            </div>
          </div>
          <div className="overlap-graph-window__content">
            {overlapGraphLoading && (
              <div className="overlap-graph-window__loading">טוען גרף...</div>
            )}
            {overlapGraphError && (
              <div className="overlap-graph-window__error">
                {overlapGraphError}
                <button type="button" className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={() => setOverlapGraphWindowOpen(false)}>
                  סגור
                </button>
              </div>
            )}
            {!overlapGraphLoading && !overlapGraphError && viewshedOverlapByPoint && Object.keys(viewshedOverlapByPoint).length > 0 && (
              <div className="overlap-graph-window__chart-wrap" ref={overlapChartRef} />
            )}
            {!overlapGraphLoading && !overlapGraphError && viewshedOverlapByPoint && Object.keys(viewshedOverlapByPoint).length > 0 && (
              <div className="overlap-graph-window__actions">
                <button type="button" className="btn btn-primary" onClick={handleSaveOverlapGraphPng}>
                  שמור כ-PNG
                </button>
              </div>
            )}
          </div>
          <div
            className="overlap-graph-window__resize-handle"
            onMouseDown={handleOverlapGraphWindowResizeStart}
            onTouchStart={handleOverlapGraphWindowResizeStart}
            title="שנה גודל"
            aria-label="שנה גודל החלון"
          />
        </div>
      )}
      {heightLimitationWindowOpen && (
        <div
          ref={heightLimitationWindowRef}
          className="height-limitation-window"
          style={{
            left: heightLimitationWindowPosition?.x ?? 20,
            top: heightLimitationWindowPosition?.y ?? 100,
            width: heightLimitationWindowSize?.width ?? HEIGHT_LIMITATION_DEFAULT_WIDTH,
            height: heightLimitationWindowSize?.height ?? HEIGHT_LIMITATION_DEFAULT_HEIGHT,
            cursor: isDraggingHeightLimitationWindow ? 'grabbing' : isResizingHeightLimitationWindow ? 'nwse-resize' : 'default'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="height-limitation-window__header"
            onMouseDown={handleHeightLimitationWindowDragStart}
            onTouchStart={handleHeightLimitationWindowDragStart}
            style={{ cursor: isDraggingHeightLimitationWindow ? 'grabbing' : 'grab' }}
          >
            <span className="height-limitation-window__title">הגבלות גובה</span>
            <div className="height-limitation-window__header-actions">
              <button type="button" className="height-limitation-window__reset-btn" onClick={resetHeightLimitationWindowPosition} title="איפוס מיקום" aria-label="איפוס מיקום">↻</button>
              <button type="button" className="height-limitation-window__close-btn" onClick={() => setHeightLimitationWindowOpen(false)} title="סגור" aria-label="סגור">×</button>
            </div>
          </div>
          <div className="height-limitation-window__content">
            <div className="height-limitation-window__modes">
              <div className="quick-modal__segmented" style={{ width: '100%' }} role="group" aria-label="מצב הצגה">
                <button
                  type="button"
                  className={`quick-modal__pill ${heightLimitationMode === 'output' ? 'active' : ''}`}
                  onClick={() => setHeightLimitationMode('output')}
                  aria-pressed={heightLimitationMode === 'output'}
                >
                  גובה תוצר
                </button>
                <button
                  type="button"
                  className={`quick-modal__pill ${heightLimitationMode === 'safety' ? 'active' : ''}`}
                  onClick={() => setHeightLimitationMode('safety')}
                  aria-pressed={heightLimitationMode === 'safety'}
                >
                  גובה בטיחות
                </button>
              </div>
            </div>
            <div className="height-limitation-window__legend">
              <div className="height-limitation-window__legend-title">מקרא</div>
              {heightLimitationMode === 'output' && heightLimitationData.outputLegend && (
                <div className="height-limitation-window__legend-section">
                  <div className="height-limitation-window__legend-subtitle">גובה תוצר</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.green }} /> {heightLimitationData.outputLegend.green}</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.yellow }} /> {heightLimitationData.outputLegend.yellow}</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.red }} /> {heightLimitationData.outputLegend.red}</div>
                </div>
              )}
              {heightLimitationMode === 'safety' && heightLimitationData.safetyLegend && (
                <div className="height-limitation-window__legend-section">
                  <div className="height-limitation-window__legend-subtitle">גובה בטיחות</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.green }} /> {heightLimitationData.safetyLegend.green}</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.yellow }} /> {heightLimitationData.safetyLegend.yellow}</div>
                  <div><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.red }} /> {heightLimitationData.safetyLegend.red}</div>
                </div>
              )}
            </div>
            <div className="height-limitation-window__stats">
              <div className="height-limitation-window__stats-title">סטטיסטיקה</div>
              <div className="height-limitation-window__stats-line">
                {heightLimitationData.stats.total > 0 ? (
                  <>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.green }} /> {(100 * heightLimitationData.stats.green / heightLimitationData.stats.total).toFixed(0)}%</span>
                    <span className="height-limitation-window__stats-sep">|</span>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.yellow }} /> {(100 * heightLimitationData.stats.yellow / heightLimitationData.stats.total).toFixed(0)}%</span>
                    <span className="height-limitation-window__stats-sep">|</span>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.red }} /> {(100 * heightLimitationData.stats.red / heightLimitationData.stats.total).toFixed(0)}%</span>
                  </>
                ) : (
                  <>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.green }} /> —</span>
                    <span className="height-limitation-window__stats-sep">|</span>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.yellow }} /> —</span>
                    <span className="height-limitation-window__stats-sep">|</span>
                    <span><span className="height-limitation-window__dot" style={{ background: HEIGHT_LIMITATION_COLORS.red }} /> —</span>
                  </>
                )}
              </div>
            </div>
            <div className="height-limitation-window__actions">
              <button type="button" className="btn btn-primary" onClick={handleHeightLimitationExport} disabled={heightLimitationData.points.length === 0}>
                ייצוא PNG
              </button>
              <button type="button" className="btn btn-tertiary" onClick={() => setHeightLimitationWindowOpen(false)}>סגור</button>
            </div>
          </div>
          <div className="height-limitation-window__resize-handle" onMouseDown={handleHeightLimitationWindowResizeStart} onTouchStart={handleHeightLimitationWindowResizeStart} title="שנה גודל" aria-label="שנה גודל החלון" />
        </div>
      )}
      <SuccessNotification
        isOpen={successNotification.isOpen}
        message={successNotification.message}
        onClose={() => setSuccessNotification({ isOpen: false, message: '' })}
        autoCloseDelay={3500}
      />
      <div className="map-controls">
        <div className="control-group">
          <div className="group-title">ניהול נתונים</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              {/* Unified DTM Loader Button */}
              <Tooltip tooltip={propDtmSourceType === 'server' && dtmLoaded ? "שנה DTM מהשרת" : "טען DTM (מקומי או מהשרת)"}>
                <button
                  onClick={handleOpenDtmLoader}
                  className={`btn btn-tertiary btn-icon ${dtmLoaded && propDtmSourceType !== 'server' ? 'disabled' : ''}`}
                  disabled={(dtmLoaded && propDtmSourceType !== 'server') || isAoiSelectionMode}
                  aria-label={propDtmSourceType === 'server' && dtmLoaded ? "שנה DTM מהשרת" : "טעינת DTM"}
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
                  className="btn btn-secondary btn-icon"
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
                    const nextIsDrawing = !isDrawing;
                    setIsDrawing(nextIsDrawing);
                    setEditingPointIndex(null);
                    if (onEditPointIndexChange) {
                      onEditPointIndexChange(null);
                    }
                    setIsParallelLineMode(false);
                    if (nextIsDrawing) {
                      setIsRotateMode(false);
                      deactivateAllMeasurementModes();
                    }
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
              <Tooltip tooltip="פרסה: בסוף המסלול או בין שתי נקודות רצופות">
                <button
                  onClick={handleOpenUTurn}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length < 2}
                  aria-label="פרסה"
                  type="button"
                >
                  <Icon name="uturn" />
                  <span className="sr-only">פרסה</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="בחר את כל הנקודות">
                <button
                  onClick={selectAllPoints}
                  className="btn btn-secondary btn-icon"
                  disabled={!dtmLoaded || flightPath.length === 0}
                  aria-label="בחר את כל הנקודות"
                  type="button"
                >
                  <Icon name="checklist" />
                  <span className="sr-only">בחר הכל</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">מתקדם</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={isRotateMode ? 'עצור מצב סיבוב מסלול' : 'סובב את כל המסלול בעזרת גרירת העכבר'}>
                <button
                  onClick={() => {
                    const next = !isRotateMode;
                    setIsRotateMode(next);
                    // Turning on rotate mode should disable other interactive tools
                    if (next) {
                      setIsDrawing(false);
                      setIsParallelLineMode(false);
                      setEditingPointIndex(null);
                      deactivateAllMeasurementModes();
                      if (onEditPointIndexChange) {
                        onEditPointIndexChange(null);
                      }
                    } else {
                      isRotatingRef.current = false;
                    }
                  }}
                  className={isRotateMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  aria-label={isRotateMode ? 'עצור מצב סיבוב מסלול' : 'סובב מסלול'}
                  type="button"
                  disabled={!dtmLoaded || flightPath.length < 2}
                >
                  <Icon name="rotate" />
                  <span className="sr-only">{isRotateMode ? 'עצור מצב סיבוב מסלול' : 'סובב מסלול'}</span>
                </button>
              </Tooltip>
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
              <Tooltip tooltip="הצג חריגות על המפה">
                <button
                  onClick={() => setHeightLimitationWindowOpen(true)}
                  className={`btn btn-tertiary btn-icon ${heightLimitationWindowOpen ? 'active' : ''}`}
                  aria-label="הגבלות גובה"
                  type="button"
                  disabled={!dtmLoaded || flightPath.length < 2 || elevationProfile.length === 0}
                >
                  <Icon name="altitude" />
                  <span className="sr-only">הגבלות גובה</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="הפוך כיוון נקודות">
                <button
                  className="btn btn-tertiary btn-icon"
                  onClick={onReverseFlightPath}
                  title="הפוך כיוון נקודות"
                  disabled={!dtmLoaded || flightPath.length < 2}
                  aria-label="הפוך כיוון נקודות"
                  type="button"
                >
                  <Icon name="refresh" />
                  <span className="sr-only">הפוך כיוון נקודות</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">מדידה</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={isInfoMode ? 'כבה מצב גובה' : 'הצג גובה קרקע במיקום העכבר'}>
                <button
                  onClick={() => {
                    if (isInfoMode) {
                      deactivateAllMeasurementModes();
                    } else {
                      deactivateAllMeasurementModes();
                      setIsInfoMode(true);
                      onShowMetadataChange(false);
                    }
                  }}
                  className={isInfoMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  disabled={!dtmLoaded}
                  aria-label={isInfoMode ? 'כבה מצב גובה' : 'הצג גובה קרקע'}
                  type="button"
                >
                  <Icon name="pin" />
                  <span className="sr-only">{isInfoMode ? 'כבה מצב גובה' : 'הצג גובה קרקע'}</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={isCoordMode ? 'כבה תצוגת קואורדינטות' : 'הצג קואורדינטות UTM'}>
                <button
                  onClick={() => {
                    if (isCoordMode) {
                      deactivateAllMeasurementModes();
                    } else {
                      deactivateAllMeasurementModes();
                      setIsCoordMode(true);
                    }
                  }}
                  className={isCoordMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  aria-label={isCoordMode ? 'כבה תצוגת קואורדינטות' : 'הצג קואורדינטות UTM'}
                  type="button"
                >
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
                    <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.5"/>
                    <line x1="10" y1="2" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="10" y1="14" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="2" y1="10" x2="6" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="14" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span className="sr-only">{isCoordMode ? 'כבה תצוגת קואורדינטות' : 'הצג קואורדינטות UTM'}</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={isMeasureLengthMode ? 'כבה מדידת מרחק' : 'מדוד מרחק'}>
                <button
                  onClick={() => {
                    if (isMeasureLengthMode) {
                      deactivateAllMeasurementModes();
                    } else {
                      deactivateAllMeasurementModes();
                      setIsMeasureLengthMode(true);
                    }
                  }}
                  className={isMeasureLengthMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  aria-label={isMeasureLengthMode ? 'כבה מדידת מרחק' : 'מדוד מרחק'}
                  type="button"
                >
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
                    <rect x="2" y="7" width="16" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                    <line x1="5" y1="10" x2="5" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="8" y1="10" x2="8" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="11" y1="10" x2="11" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="14" y1="10" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span className="sr-only">{isMeasureLengthMode ? 'כבה מדידת מרחק' : 'מדוד מרחק'}</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={isAzimuthMode ? 'כבה מדידת אזימוט' : 'מדוד אזימוט ומרחק'}>
                <button
                  onClick={() => {
                    if (isAzimuthMode) {
                      deactivateAllMeasurementModes();
                    } else {
                      deactivateAllMeasurementModes();
                      setIsAzimuthMode(true);
                    }
                  }}
                  className={isAzimuthMode ? 'btn btn-primary btn-icon' : 'btn btn-tertiary btn-icon'}
                  aria-label={isAzimuthMode ? 'כבה מדידת אזימוט' : 'מדוד אזימוט'}
                  type="button"
                >
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
                    <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5"/>
                    <line x1="10" y1="3" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="10" y1="10" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="2,1.5"/>
                    <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
                  </svg>
                  <span className="sr-only">{isAzimuthMode ? 'כבה מדידת אזימוט' : 'מדוד אזימוט'}</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

      </div>
      <div
        ref={mapContainer}
        className="map-container"
        style={{ display: threeDMode === 'full' ? 'none' : undefined }}
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
                  <div key={route.id} className="route-card">
                    <div className="route-card-title-wrap">
                      {editingRouteId === route.id ? (
                        <input
                          className="route-name-input"
                          value={editingRouteName}
                          autoFocus
                          onChange={(e) => setEditingRouteName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => {
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
                          className="route-card-title"
                          title={`${route.name} (לחיצה כפולה לשינוי שם)`}
                          onClick={(e) => {
                            if (e.detail === 2) {
                              e.preventDefault();
                              e.stopPropagation();
                              if (editingRouteId !== route.id) {
                                setEditingRouteId(route.id);
                                setEditingRouteName(route.name);
                              }
                            } else {
                              e.stopPropagation();
                            }
                          }}
                        >
                          {route.name}
                        </button>
                      )}
                    </div>
                    <div
                      className={`route-row ${route.id === activeRouteId ? 'active' : ''} ${editingRouteId === route.id ? 'editing' : ''}`}
                      title={route.name}
                      onClick={(e) => {
                        const target = e.target as Element | null;
                        if (target?.closest('input, button, select, textarea, label, a, .route-actions')) {
                          return;
                        }
                        if (e.detail === 2) {
                          onActiveRouteChange(route.id);
                        }
                      }}
                      onDoubleClick={(e) => {
                        const target = e.target as Element | null;
                        if (target?.closest('input, button, select, textarea, label, a, .route-actions')) {
                          return;
                        }
                        onActiveRouteChange(route.id);
                      }}
                    >
                      <div
                        className="route-main"
                        title={route.name}
                        style={{ cursor: 'default' }}
                      >
                        <input
                          id={`route-color-${route.id}`}
                          type="color"
                          className="route-color-dot-input"
                          value={route.color}
                          onChange={(e) => {
                            e.stopPropagation();
                            onRouteColorChange(route.id, e.target.value);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.stopPropagation()}
                          aria-label={`צבע קו עבור ${route.name}`}
                          title="שינוי צבע קו"
                        />
                        <div className="route-style-field" onClick={(e) => e.stopPropagation()}>
                          <label
                            htmlFor={`route-width-${route.id}`}
                            className="route-height-label route-style-label"
                            title="עובי הקו למסלול זה"
                          >
                            עובי
                          </label>
                          <div className="route-width-input-wrap">
                            <input
                              id={`route-width-${route.id}`}
                              type="number"
                              min={1}
                              max={12}
                              step={0.5}
                              className="route-width-input"
                              value={Number.isFinite(route.lineWidth) ? route.lineWidth : 3}
                              onChange={(e) => {
                                e.stopPropagation();
                                const parsed = parseFloat(e.target.value);
                                if (Number.isFinite(parsed)) {
                                  onRouteLineWidthChange(route.id, parsed);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onFocus={(e) => e.stopPropagation()}
                              aria-label={`עובי קו עבור ${route.name}`}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="route-actions" onDoubleClick={(e) => e.stopPropagation()}>
                      <div className="route-height-field" onClick={(e) => e.stopPropagation()}>
                        <label
                          htmlFor={`route-height-${route.id}`}
                          className="route-height-label"
                          title="גובה כניסה למסלול זה"
                        >
                          גובה כניסה
                        </label>
                        <div className="route-height-input-wrap">
                          <input
                            id={`route-height-${route.id}`}
                            type="number"
                            min={0}
                            max={10000}
                            step={0.1}
                            className="route-height-input"
                            value={Number.isFinite(route.nominalFlightHeight) ? route.nominalFlightHeight : 0}
                            onChange={(e) => {
                              e.stopPropagation();
                              const parsed = parseFloat(e.target.value);
                              if (Number.isFinite(parsed)) {
                                onRouteNominalFlightHeightChange(route.id, parsed);
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onFocus={(e) => e.stopPropagation()}
                            aria-label={`גובה כניסה עבור ${route.name}`}
                          />
                          <span className="route-height-unit">מ׳</span>
                        </div>
                      </div>
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
        {(isDtmProcessing || dtmLoadState === 'LOADING') && !isUploading && (
          <div className="upload-progress-overlay">
            <div className="upload-progress-container">
              <div className="loading-spinner" />
              <div className="upload-progress-label">
                {dtmLoadState === 'LOADING' ? 'מכין DTM... אנא המתן' : 'טוען DTM...'}
              </div>
            </div>
          </div>
        )}
        {dtmLoadState === 'FAILED' && dtmLoadError && (
          <div className="upload-progress-overlay">
            <div className="upload-progress-container" style={{ background: '#fee', borderColor: '#f00' }}>
              <div className="upload-progress-label" style={{ color: '#c00' }}>
                שגיאה בטעינת DTM: {dtmLoadError}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setDtmLoadState('IDLE');
                  setDtmLoadError(null);
                }}
                style={{ marginTop: '10px' }}
              >
                סגור
              </button>
            </div>
          </div>
        )}
        {viewshedRaster && viewshedVisible && (
          <div className="viewshed-legend">
            <div className="viewshed-legend-title">שדה ראייה</div>
            <div className="viewshed-legend-classes">
              {([1, 2, 3, 4] as const).map((cls) => (
                <div key={cls} className="viewshed-legend-class">
                  <span
                    className="viewshed-legend-swatch"
                    style={{ backgroundColor: viewshedClassColors[cls - 1] }}
                  />
                  <span className="viewshed-legend-class-label">{cls === 4 ? '4+' : String(cls)}</span>
                </div>
              ))}
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
                      <Tooltip tooltip={showNextLineSuggestions ? 'הסתר הצעות לגים עוקבים' : 'הצג הצעות לגים עוקבים'}>
                        <button
                          type="button"
                          onClick={() => onShowNextLineSuggestionsChange(!showNextLineSuggestions)}
                          className={`display-settings-icon-toggle ${showNextLineSuggestions ? 'active' : ''}`}
                          aria-pressed={showNextLineSuggestions}
                          aria-label={showNextLineSuggestions ? 'הסתר הצעות קווים' : 'הצג הצעות קווים'}
                        >
                          <Icon name={showNextLineSuggestions ? 'eye' : 'eye-off'} />
                        </button>
                      </Tooltip>
                      <Tooltip tooltip={showVertexRadius ? 'הסתר רדיוס קודקוד' : 'הצג רדיוס קודקוד'}>
                        <button
                          type="button"
                          onClick={() => setShowVertexRadius(!showVertexRadius)}
                          className={`display-settings-icon-toggle ${showVertexRadius ? 'active' : ''}`}
                          aria-pressed={showVertexRadius}
                          aria-label={showVertexRadius ? 'הסתר רדיוס קודקוד' : 'הצג רדיוס קודקוד'}
                        >
                          <Icon name="circle" />
                        </button>
                      </Tooltip>
                      <Tooltip tooltip={showAzimuthDistanceLabels ? 'הסתר תוויות אזימוט ומרחק' : 'הצג תוויות אזימוט ומרחק'}>
                        <button
                          type="button"
                          onClick={() => setShowAzimuthDistanceLabels(!showAzimuthDistanceLabels)}
                          className={`display-settings-icon-toggle ${showAzimuthDistanceLabels ? 'active' : ''}`}
                          aria-pressed={showAzimuthDistanceLabels}
                          aria-label={showAzimuthDistanceLabels ? 'הסתר תוויות אזימוט ומרחק' : 'הצג תוויות אזימוט ומרחק'}
                        >
                          <Icon name="compass" />
                        </button>
                      </Tooltip>
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
            visibility: tooltipPosition ? 'visible' : 'visible',
            opacity: tooltipPosition ? 1 : 0,
            pointerEvents: tooltipPosition ? 'auto' : 'none'
          }}
        >
          <CoordinateTooltip point={hoveredElevationPoint} />
        </div>
      )}
      {isInfoMode && mousePos && cursorElevation && (
        <div
          ref={infoModeTooltipRef}
          className="hover-metadata-tooltip"
          style={{
            left: infoModeTooltipPosition?.left ?? mousePos.x + 15,
            top: infoModeTooltipPosition?.top ?? mousePos.y + 15,
            visibility: infoModeTooltipPosition ? 'visible' : 'visible',
            opacity: infoModeTooltipPosition ? 1 : 0,
            pointerEvents: infoModeTooltipPosition ? 'auto' : 'none'
          }}
        >
          <div className="tooltip-section">
            <span className="tooltip-label">גובה מפני הים:</span> {cursorElevation.elevation !== null ? `${cursorElevation.elevation.toFixed(1)} מ'` : '—'}
          </div>
        </div>
      )}

      {/* Coordinate mode tooltip */}
      {isCoordMode && coordModePos && (() => {
        const utm = latLngToUTM(coordModePos.lat, coordModePos.lng);
        if (!utm) return null;
        return (
          <div className="hover-metadata-tooltip" style={{ left: coordModePos.x + 15, top: coordModePos.y + 15, pointerEvents: 'none' }}>
            <div className="tooltip-section"><span className="tooltip-label">Northing:</span> {utm.northing.toFixed(2)}</div>
            <div className="tooltip-section"><span className="tooltip-label">Easting:</span> {utm.easting.toFixed(2)}</div>
            <div className="tooltip-section"><span className="tooltip-label">אזור:</span> {utm.zone}{utm.hemisphere}</div>
            <div className="tooltip-section" style={{ fontSize: '0.75em', opacity: 0.6 }}>לחצן ימני להעתקה</div>
          </div>
        );
      })()}

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

            {/* Step: Server Results (TIF selection after AOI) */}
            {dtmLoaderStep === 'server-results' && (
              <div className="dtm-loader-content">
                <button
                  type="button"
                  className="dtm-loader-back"
                  onClick={() => {
                    // Go back to AOI selection
                    setDtmLoaderOpen(false);
                    setDtmLoaderStep('source-choice');
                    // Keep AOI selection mode active
                  }}
                >
                  <Icon name="undo" />
                  חזרה לבחירת אזור
                </button>

                <div className="dtm-server-content">
                  {dtmOptionsLoading && (
                    <div className="dtm-modal-loading">
                      <div className="loading-spinner" />
                      <span>מחפש קבצי DTM חופפים...</span>
                    </div>
                  )}
                  
                  {dtmOptionsError && (
                    <div className="dtm-modal-error">
                      <span>⚠️ {dtmOptionsError}</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          // Retry by going back to AOI selection
                          setDtmLoaderOpen(false);
                        }}
                      >
                        נסה שוב
                      </button>
                    </div>
                  )}
                  
                  {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length === 0 && (
                    <div className="dtm-modal-empty">
                      <span>לא נמצאו קבצי DTM החופפים לאזור הנבחר.</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setDtmLoaderOpen(false);
                        }}
                      >
                        בחר אזור אחר
                      </button>
                    </div>
                  )}
                  
                  {!dtmOptionsLoading && !dtmOptionsError && filteredDtmOptions.length > 0 && (
                    <div className="dtm-options-list">
                      <p className="dtm-loader-subtitle" style={{ marginBottom: '1rem' }}>
                        נמצאו {filteredDtmOptions.length} קובצי DTM חופפים. בחר אחד:
                      </p>
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
                              {option.sizeMB && <span>{option.sizeMB} MB</span>}
                              {option.sizeMB && option.modifiedAt && <span>•</span>}
                              {option.modifiedAt && <span>{formatDate(option.modifiedAt)}</span>}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step: Server Area Selection (Legacy - kept for backward compatibility) */}
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
                onClick={() => {
                  // New flow: if server source and no TIF selected yet, fetch available TIFs
                  if (dtmSourceType === 'server' && !selectedDtmId) {
                    handleConfirmAoiForServer();
                  } else {
                    // Legacy flow or TIF already selected: proceed with clipping
                    handleClipDtm();
                  }
                }}
                disabled={(!aoiBounds && !aoiPolygon) || isClipping}
              >
                {isClipping ? (
                  <>
                    <div className="loading-spinner-small" />
                    חותך...
                  </>
                ) : (
                  dtmSourceType === 'server' && !selectedDtmId ? 'חפש קבצי DTM' : 'טען אזור נבחר'
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
            <div className="upload-progress-label">חותך DTM לאזור הנבחר... זה עשוי לקחת כמה רגעים</div>
          </div>
        </div>
      )}

      {/* Containment Warning Modal */}
      {containmentWarning.isOpen && (
        <div 
          className="dtm-loader-overlay" 
          onClick={() => setContainmentWarning({ isOpen: false })}
          role="dialog"
          aria-modal="true"
          aria-labelledby="containment-warning-title"
        >
          <div 
            className="dtm-loader-dialog" 
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setContainmentWarning({ isOpen: false });
              }
            }}
          >
            <div className="dtm-loader-header">
              <h2 id="containment-warning-title">אזהרה</h2>
              <button
                type="button"
                className="btn btn-icon btn-tertiary dtm-loader-close"
                onClick={() => setContainmentWarning({ isOpen: false })}
                aria-label="סגור"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="dtm-loader-content">
              <p style={{ marginBottom: '1rem', color: '#d32f2f', fontWeight: '500' }}>
                DTM change canceled: the new area does not fully include the current working area, so elevations might not match existing routes.
              </p>
              <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: '#666' }}>
                The old DTM remains loaded and usable. To replace the DTM, please select an area that fully contains the current working area.
              </p>
            </div>
            <div className="dtm-modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setContainmentWarning({ isOpen: false })}
              >
                הבנתי
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3D View Toggle — outside map-container so it stays visible in both modes */}
      <button
        type="button"
        className={`three-d-toggle-btn ${threeDMode !== 'off' ? 'active' : ''} ${is3DFloat ? 'float-mode' : ''}`}
        onClick={() => setThreeDMode(prev => prev === 'off' ? 'full' : prev === 'full' ? 'float' : 'off')}
        disabled={!dtmLoaded}
        title={threeDMode === 'off' ? 'תצוגת תלת-ממד — מסך מלא (Ctrl+3)' : threeDMode === 'full' ? 'תצוגת תלת-ממד — חלון צף (Ctrl+3)' : 'סגור תצוגת תלת-ממד (Ctrl+3)'}
      >
        <Icon name="cube" />
      </button>

      {/* 3D Terrain View — full screen */}
      {is3DFull && (
        <ThreeDView
          rasterData={dtmRasterDataRef.current}
          baseMaps={baseMaps}
          activeBaseMapId={threeDActiveBaseMapId}
          mapToken={mapToken}
          routes={routes.map(r => ({ id: r.id, name: r.name, points: r.points, color: r.color, visible: r.visible }))}
          activeRouteId={activeRouteId}
          elevationProfile={elevationProfile}
          onBaseMapCycle={handleCycle3DBaseMap}
          viewshedRaster={viewshedRaster}
          viewshedVisible={viewshedVisible}
          viewshedColormap={viewshedColormap}
          viewshedOpacity={viewshedOpacity}
          viewshedClassColors={viewshedClassColors}
          getViewshedClassColor={getViewshedClassColor}
        />
      )}

      {/* 3D Terrain View — floating window */}
      {is3DFloat && (
        <div
          ref={threeDFloatRef}
          className="three-d-float-window"
          style={{
            left: threeDFloatPosition?.x ?? (window.innerWidth - 660),
            top: threeDFloatPosition?.y ?? 60,
            width: threeDFloatSize.w,
            height: threeDFloatSize.h,
            cursor: isDraggingThreeDFloat ? 'grabbing' : 'default',
          }}
          onClick={e => e.stopPropagation()}
        >
          <div
            className="three-d-float-window__header"
            onMouseDown={handleThreeDFloatDragStart}
            onTouchStart={handleThreeDFloatDragStart}
          >
            <span className="three-d-float-window__title">תצוגת תלת-ממד</span>
            <div className="three-d-float-window__header-actions">
              <button
                className="three-d-float-window__expand-btn"
                onClick={() => setThreeDMode('full')}
                title="מסך מלא"
                aria-label="הרחב למסך מלא"
              >
                <Icon name="fit" />
              </button>
              <button
                className="three-d-float-window__close-btn"
                onClick={() => setThreeDMode('off')}
                title="סגור"
                aria-label="סגור"
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
          <div className="three-d-float-window__content">
            <ThreeDView
              rasterData={dtmRasterDataRef.current}
              baseMaps={baseMaps}
              activeBaseMapId={threeDActiveBaseMapId}
              mapToken={mapToken}
              routes={routes.map(r => ({ id: r.id, name: r.name, points: r.points, color: r.color, visible: r.visible }))}
              activeRouteId={activeRouteId}
              elevationProfile={elevationProfile}
              onBaseMapCycle={handleCycle3DBaseMap}
              viewshedRaster={viewshedRaster}
              viewshedVisible={viewshedVisible}
              viewshedColormap={viewshedColormap}
              viewshedOpacity={viewshedOpacity}
              viewshedClassColors={viewshedClassColors}
              getViewshedClassColor={getViewshedClassColor}
            />
            {/* Transparent overlay blocks Three.js canvas pointer events during resize/drag */}
            {(isResizingThreeDFloat || isDraggingThreeDFloat) && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 550, cursor: isResizingThreeDFloat ? 'se-resize' : 'grabbing' }} />
            )}
          </div>
          <div
            className="three-d-float-window__resize-handle"
            onMouseDown={handleThreeDFloatResizeStart}
          />
        </div>
      )}
    </div>
  );
};

export default MapPanel;

