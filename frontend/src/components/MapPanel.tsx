import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { Coordinate, ElevationPoint } from '../App';
import { FlightRoute } from '../hooks/useFlightPath';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import CoordinateTooltip from './CoordinateTooltip';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination, generateUTurnPoints, UTurnSide, calculateDistance, calculateBearing } from '../utils/geometry';
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
  | 'home'
  | 'folder'
  | 'crop'
  | 'search'
  | 'close'
  | 'rectangle'
  | 'polygon'
  | 'file'
  | 'info';

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
    case 'info':
      return (
        <svg {...common}>
          <circle {...stroke} cx="12" cy="12" r="10" />
          <path {...stroke} d="M12 16v-4" />
          <path {...stroke} d="M12 8h.01" />
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
  onDtmLoad: (source: string, info?: any, clippedId?: string) => void;
  onDtmUnload: () => void;
  nominalFlightHeight: number;
  overlapPercentage: number;
  fovDegrees: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  editPointIndex?: number | null;
  onEditPointIndexChange?: (index: number | null) => void;
  hoveredElevationPoint?: ElevationPoint | null;
  hoverSource?: 'map' | 'profile' | null;
  showMetadata: boolean;
  onShowMetadataChange: (show: boolean) => void;
  climbRequests?: { endDistance: number; climbAmount: number }[];
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
  nominalFlightHeight,
  overlapPercentage,
  fovDegrees,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  climbMarkers,
  onShowClimbLabelsChange,
  showClimbLabels,
  editPointIndex: externalEditPointIndex,
  onEditPointIndexChange,
  hoveredElevationPoint,
  hoverSource,
  showMetadata,
  onShowMetadataChange,
  climbRequests = []
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
  const climbMarkersRef = useRef<L.Marker[]>([]);
  const flightPathLineRef = useRef<L.Polyline | null>(null);
  const flightPathClickableLineRef = useRef<L.Polyline | null>(null);
  const flightPathBufferRef = useRef<L.Polyline | null>(null);
  const segmentLengthLabelsRef = useRef<L.Marker[]>([]);
  const hoveredPointRef = useRef<number | null>(null);
  const justFinishedDraggingRef = useRef<boolean>(false);
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
  const passiveRouteLinesRef = useRef<Record<string, L.Polyline>>({});
  const suggestedLinesRef = useRef<L.Polyline[]>([]);
  const [isRoutesPanelOpen, setIsRoutesPanelOpen] = useState<boolean>(false);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editingRouteName, setEditingRouteName] = useState<string>('');
  const [dialog, setDialog] = useState<{
    type: 'height' | 'azimuthDistance' | 'coordinates' | 'uTurn' | 'parallelOffset';
    title: string;
  } | null>(null);
  const [dialogValues, setDialogValues] = useState<Record<string, string>>({});
  const [dialogError, setDialogError] = useState<string | null>(null);

  // New DTM loading flow state
  const [showDtmOptionsModal, setShowDtmOptionsModal] = useState(false);
  const [dtmOptions, setDtmOptions] = useState<DTMOption[]>([]);
  const [dtmOptionsLoading, setDtmOptionsLoading] = useState(false);
  const [dtmOptionsError, setDtmOptionsError] = useState<string | null>(null);
  const [dtmSearchQuery, setDtmSearchQuery] = useState('');
  const [selectedDtmId, setSelectedDtmId] = useState<string | null>(null);
  
  // AOI selection state
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
  const [activeClippedId, setActiveClippedId] = useState<string | null>(propClippedId || null);

  const resetDialog = () => {
    setDialog(null);
    setDialogValues({});
    setDialogError(null);
  };

  // ============================================================================
  // NEW DTM LOADING FLOW FUNCTIONS
  // ============================================================================

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
      setDtmOptionsError(error instanceof Error ? error.message : 'שגיאה בטעינת רשימת DTM');
    } finally {
      setDtmOptionsLoading(false);
    }
  }, []);

  // Open DTM options modal
  const handleOpenDtmOptionsModal = useCallback(() => {
    setShowDtmOptionsModal(true);
    setDtmSearchQuery('');
    setSelectedDtmId(null);
    fetchDtmOptions();
  }, [fetchDtmOptions]);

  // Close DTM options modal
  const handleCloseDtmOptionsModal = useCallback(() => {
    setShowDtmOptionsModal(false);
    setSelectedDtmId(null);
    setDtmSearchQuery('');
  }, []);

  // Select a DTM and enter AOI selection mode
  const handleSelectDtm = useCallback((dtmId: string) => {
    setSelectedDtmId(dtmId);
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

  // Cancel AOI selection
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
      }, clipResult.clippedId);

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

  const activeRoute = routes.find((route) => route.id === activeRouteId) || routes[0];
  const activeRouteColor = activeRoute?.color || '#ff0000';
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
          crs: leafletCrs
          // crs: L.CRS.EPSG4326
        });
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

  // Cleanup clipped DTM on unload or navigation
  useEffect(() => {
    const cleanupClippedDtm = () => {
      if (activeClippedId) {
        try {
          // Use fetch with keepalive for reliable cleanup on page unload
          // sendBeacon only supports POST, so we use fetch with keepalive for DELETE
          fetch(`/api/dtm/clipped/${activeClippedId}`, {
            method: 'DELETE',
            keepalive: true
          }).catch(() => {
            // Ignore errors during cleanup - page might be unloading
          });
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
    };

    const handleBeforeUnload = () => {
      cleanupClippedDtm();
    };

    const handlePageHide = (event: PageTransitionEvent) => {
      // Only cleanup if page is not being cached (e.g., back/forward navigation)
      if (!event.persisted) {
        cleanupClippedDtm();
      }
    };

    const handleVisibilityChange = () => {
      // Cleanup when page becomes hidden (user switching tabs, closing window, etc.)
      if (document.visibilityState === 'hidden') {
        cleanupClippedDtm();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeClippedId]);

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
          setDialog({
            type: 'parallelOffset',
            title: 'היסט מקביל'
          });
          setDialogValues({
            segmentIndex: closestSegmentIndex.toString(),
            offset: '50'
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

    map.current.on('click', handleClick);

    return () => {
      if (map.current) {
        map.current.off('click', handleClick);
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
    // Only works when Shift+LeftClick is pressed.
    const handleClickableLineClick = (e: L.LeafletMouseEvent) => {
      const originalEvent = e.originalEvent as MouseEvent | undefined;
      if (originalEvent && originalEvent.button !== 0) return; // left-click only
      if (!dtmLoaded) return;
      if (isParallelLineMode) return;
      
      // Only insert points when Shift key is pressed
      if (!originalEvent || !originalEvent.shiftKey) return;

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
            // Check if point position actually changed
            const positionChanged = Math.abs(dropLng - point.lng) > 1e-9 || Math.abs(dropLat - point.lat) > 1e-9;
            
            // If position changed and there are climb points, show warning
            if (positionChanged && climbRequests.length > 0) {
              const confirmed = window.confirm(
                'אזהרה: עריכת מיקום הנקודה תמחק את נקודות העלייה במסלול הרלוונטי.\n\nהאם אתה בטוח שברצונך להמשיך?'
              );
              
              if (!confirmed) {
                // User cancelled - reset marker to original position
                marker.setLatLng([point.lat, point.lng]);
                lastValidPosition = [point.lat, point.lng];
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
                
                // Set flag to prevent map click handler from creating a new point
                justFinishedDraggingRef.current = true;
                setTimeout(() => {
                  justFinishedDraggingRef.current = false;
                }, 100);
                return;
              }
            }
            
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

    if (flightPath.length < 2) return;

    const safeOverlap = Math.max(0, Math.min(overlapPercentage, 99.9));
    const overlapFraction = safeOverlap / 100;
    const safeFov = Math.max(1, Math.min(fovDegrees, 179.9));
    const fovRadians = (safeFov * Math.PI) / 180;
    const spacingFactor = 1 - overlapFraction;

    if (!(spacingFactor > 0) || !(fovRadians > 0)) return;

    for (let i = 0; i < flightPath.length - 1; i++) {
      const start = flightPath[i];
      const end = flightPath[i + 1];
      const startHeight = start.height ?? nominalFlightHeight;
      const endHeight = end.height ?? nominalFlightHeight;
      const avgHeight = (startHeight + endHeight) / 2;

      // Calculate half-width based on user request (height * tan(fov/2))
      const swathWidth = avgHeight * Math.tan(fovRadians / 2);
      const spacing = swathWidth * spacingFactor;

      if (!Number.isFinite(spacing) || spacing <= 0) continue;

      [spacing, -spacing].forEach((offset) => {
        const [parallelStart, parallelEnd] = calculateParallelLine(start, end, offset);
        const suggestion = L.polyline(
          [
            [parallelStart.lat, parallelStart.lng],
            [parallelEnd.lat, parallelEnd.lng]
          ],
          {
            color: activeRouteColor,
            weight: 2,
            opacity: 0.25,
            dashArray: '4 8',
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
  }, [flightPath, overlapPercentage, fovDegrees, nominalFlightHeight, activeRouteColor]);

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
      alert('פרוק את ה-DTM הנוכחי לפני טעינת אחר.');
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
  };

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
            אזימוט (0-360)
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
            מרחק (מ')
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
            היסט (מ')
            <Tooltip tooltip="חיובי = ימינה, שלילי = שמאלה">
              <span className="quick-modal__info" aria-label="מידע כיוון היסט">i</span>
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
                step="0.000001"
                value={dialogValues.lng ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, lng: e.target.value }))}
                className="quick-modal__input"
              />
              <label className="quick-modal__label" htmlFor="lat-input">קו רוחב</label>
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
              <label className="quick-modal__label" htmlFor="easting-input">מזרחית (מ')</label>
              <input
                id="easting-input"
                type="number"
                step="1"
                value={dialogValues.easting ?? ''}
                onChange={(e) => setDialogValues((prev) => ({ ...prev, easting: e.target.value }))}
                className="quick-modal__input"
              />
              <label className="quick-modal__label" htmlFor="northing-input">צפונית (מ')</label>
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
                  <label className="quick-modal__label" htmlFor="zone-input">אזור</label>
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
                  <label className="quick-modal__label" htmlFor="hemisphere-input">חצי כדור</label>
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
            רדיוס (מ')
            <Tooltip tooltip="חיובי = ימינה, שלילי = שמאלה">
              <span className="quick-modal__info" aria-label="מידע כיוון רדיוס">i</span>
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
          <label className="quick-modal__label" htmlFor="distance-ut-input">מרווח (מ')</label>
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
        <div className={`control-group routes-panel ${isRoutesPanelOpen ? 'open' : 'closed'}`}>
          <div className="routes-panel-header">
            <span className="group-title">מסלולים</span>
            <button
              type="button"
              className="btn btn-tertiary btn-compact"
              onClick={() => setIsRoutesPanelOpen((prev) => !prev)}
              aria-label={isRoutesPanelOpen ? 'סגירת לוח המסלולים' : 'פתיחת לוח המסלולים'}
            >
              {isRoutesPanelOpen ? 'הסתר' : 'הצג'}
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
                    <div className="route-main" title="בחר מסלול פעיל">
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
                            placeholder={`מסלול ${idx + 1}`}
                          />
                        ) : (
                          <button
                            type="button"
                            className="route-name-button"
                            onDoubleClick={() => {
                              setEditingRouteId(route.id);
                              setEditingRouteName(route.name);
                            }}
                            title={`${route.name} (לחיצה כפולה לשינוי שם)`}
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
                            ? 'המסלול הפעיל נשאר גלוי.'
                            : route.visible
                              ? 'הסתר מסלול'
                              : 'הצג מסלול'
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
                      <Tooltip tooltip={routes.length <= 1 ? 'השאר לפחות מסלול אחד' : 'מחק מסלול'}>
                        <button
                          type="button"
                          className="btn btn-destructive btn-icon btn-compact"
                          onClick={() => {
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
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onAddRoute}
                  aria-label="הוסף מסלול חדש"
                >
                  + מסלול חדש
                </button>
                <div className="route-bulk-actions">
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    onClick={onShowAllRoutes}
                    disabled={routes.length === 0}
                    aria-label="הצג את כל המסלולים"
                  >
                    הצג הכול
                  </button>
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    onClick={onHideNonActiveRoutes}
                    disabled={routes.length === 0}
                    aria-label="הסתר מסלולים לא פעילים"
                  >
                    הצג פעיל בלבד
                  </button>
                  <button
                    type="button"
                    className="btn btn-destructive"
                    onClick={() => {
                      if (window.confirm('לאפס למסלול ריק אחד? ימחק את כל המסלולים והנקודות.')) {
                        onResetToSingleRoute();
                      }
                    }}
                    aria-label="איפוס למסלול אחד"
                  >
                    איפוס מסלולים
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="control-group">
          <div className="group-title">ניהול נתונים</div>
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
              {/* New: Load DTM from server options */}
              <Tooltip tooltip={dtmLoaded ? 'פרוק תחילה את ה‑DTM הנוכחי' : 'בחר DTM מהשרת'}>
                <button
                  onClick={handleOpenDtmOptionsModal}
                  className={`btn btn-primary btn-icon ${dtmLoaded ? 'disabled' : ''}`}
                  disabled={dtmLoaded || isAoiSelectionMode}
                  aria-label="טעינת DTM מהשרת"
                  type="button"
                >
                  <Icon name="folder" />
                  <span className="sr-only">טעינת DTM מהשרת</span>
                </button>
              </Tooltip>
              {/* Legacy: Upload DTM file */}
              <Tooltip tooltip={dtmLoaded ? 'פרוק תחילה את ה‑DTM הנוכחי' : 'העלאת קובץ DTM (GeoTIFF)'}>
                <label
                  htmlFor="dtm-upload"
                  className={`btn btn-secondary btn-icon ${dtmLoaded ? 'disabled' : ''}`}
                  style={dtmLoaded ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
                  aria-label="העלאת DTM"
                >
                  <Icon name="upload" />
                  <span className="sr-only">העלאת DTM</span>
                </label>
              </Tooltip>
              <Tooltip
                tooltip={
                  !dtmSource || !dtmLoaded
                    ? 'לא נטען DTM'
                    : 'פרוק DTM ונקה מסלולים'
                }
              >
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
            </div>
            <div className="group-column group-column-icons">
              <Tooltip tooltip={flightPath.length === 0 ? 'אין נקודות למחיקה' : 'נקה את כל הנקודות'}>
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
              <Tooltip tooltip={!dtmLoaded ? 'טען DTM תחילה' : isDrawing ? 'עצור שרטוט' : 'צייר מסלול (קליק על המפה)'}>
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
                  aria-label={isDrawing ? 'עצירת שרטוט' : 'שרטט מסלול'}
                  type="button"
                >
                  <Icon name="pencil" />
                  <span className="sr-only">{isDrawing ? 'עצירת שרטוט' : 'שרטט מסלול'}</span>
                </button>
              </Tooltip>
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'טען DTM תחילה'
                    : flightPath.length < 2
                      ? 'הוסף לפחות שתי נקודות תחילה'
                      : isParallelLineMode
                        ? 'עצור מצב קו מקביל'
                        : 'קו מקביל: לחץ על מקטע, קבע היסט'
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
                  aria-label={isParallelLineMode ? 'בטל קו מקביל' : 'צור קו מקביל'}
                  type="button"
                >
                  <Icon name="parallel" />
                  <span className="sr-only">{isParallelLineMode ? 'בטל קו מקביל' : 'צור קו מקביל'}</span>
                </button>
              </Tooltip>
            </div>
            <div className="group-column group-column-icons">
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'טען DTM תחילה'
                    : flightPath.length === 0
                      ? 'הוסף נקודה תחילה'
                      : 'הוסף נקודה לפי אזימוט + מרחק'
                }
              >
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
              <Tooltip tooltip={!dtmLoaded ? 'טען DTM תחילה' : 'הוסף נקודה לפי קואורדינטות'}>
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
              <Tooltip
                tooltip={
                  !dtmLoaded
                    ? 'טען DTM תחילה'
                    : flightPath.length < 2
                      ? 'הוסף לפחות שתי נקודות תחילה'
                      : 'הוסף פרסה עם רדיוס + מרחק'
                }
              >
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
          <div className="group-title">היסטוריה</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={flightPath.length === 0 ? 'צייר נקודות תחילה' : 'בטל (Ctrl+Z)'}>
                <button
                  onClick={onUndo}
                  disabled={!canUndo || flightPath.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="בטל"
                  type="button"
                >
                  <Icon name="undo" />
                  <span className="sr-only">בטל</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={flightPath.length === 0 ? 'צייר נקודות תחילה' : 'בצע שוב (Ctrl+Y או Ctrl+Shift+Z)'}>
                <button
                  onClick={onRedo}
                  disabled={!canRedo || flightPath.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="בצע שוב"
                  type="button"
                >
                  <Icon name="redo" />
                  <span className="sr-only">בצע שוב</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">בקרות תצוגה</div>
          <div className="group-columns">
            <div className="group-column group-column-icons">
              <Tooltip tooltip={!dtmLoaded ? 'טען DTM תחילה' : 'התאם תצוגה ל‑DTM'}>
                <button
                  onClick={handleFitToDTM}
                  className="btn btn-tertiary btn-icon"
                  disabled={!dtmLoaded}
                  aria-label="התאם ל‑DTM"
                  type="button"
                >
                  <Icon name="fit" />
                  <span className="sr-only">התאם ל‑DTM</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="אפס תצוגת מפה לברירת מחדל">
                <button
                  onClick={handleResetView}
                  className="btn btn-tertiary btn-icon"
                  aria-label="איפוס תצוגה"
                  type="button"
                >
                  <Icon name="home" />
                  <span className="sr-only">איפוס תצוגה</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={!dtmLoaded ? 'טען DTM תחילה' : isInfoMode ? 'כבה מצב מידע' : 'הצג גובה קרקע במיקום העכבר'}>
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
                  <Icon name="info" />
                  <span className="sr-only">{isInfoMode ? 'כבה מצב מידע' : 'הצג גובה קרקע'}</span>
                </button>
              </Tooltip>
            </div>
            <div
              className="group-column group-column-icons"
              style={{ display: 'flex', flexDirection: 'row', gap: '12px', alignItems: 'center' }}
            >
              <Tooltip tooltip="הצג/הסתר נתונים בזמן ריחוף">
                <label
                  className="switch"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', transform: 'scale(0.95)', transformOrigin: 'left center' }}
                >
                  <input
                    type="checkbox"
                    checked={showMetadata}
                    onChange={(e) => {
                      const newShowMetadata = e.target.checked;
                      onShowMetadataChange(newShowMetadata);
                      if (newShowMetadata) {
                        // Turn off info mode when turning on route info
                        setIsInfoMode(false);
                        setCursorElevation(null);
                        setMousePos(null);
                        elevationCacheRef.current.clear();
                      }
                    }}
                  />
                  <span className="switch-slider" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>נתונים</span>
                </label>
              </Tooltip>
              <Tooltip tooltip="הצג/הסתר תווית ליד נקודות הגבהה">
                <label
                  className="switch"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', transform: 'scale(0.95)', transformOrigin: 'left center' }}
                >
                  <input
                    type="checkbox"
                    checked={showClimbLabels}
                    onChange={(e) => onShowClimbLabelsChange(e.target.checked)}
                  />
                  <span className="switch-slider" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>נקודות הגבהה</span>
                </label>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
      <div className="map-instruction-banner">
        <div className="map-instruction-text">
          לחץ Shift על מנת להוסיף נקודה בין נקודות קיימות
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
        {dtmLoaded && (
          <div
            ref={dtmTransparencyControlRef}
            className="dtm-transparency-control"
          >
            <label htmlFor="dtm-opacity-slider" className="dtm-opacity-label">
              שקפיות {Math.round((1 - dtmOpacity) * 100)}%
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
            title={`החלף ל‑${nextBaseMap.name}`}
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
