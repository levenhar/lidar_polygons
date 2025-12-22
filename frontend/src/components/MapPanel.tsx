import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination } from '../utils/geometry';
import './MapPanel.css';
import { TileLayerOptions } from 'leaflet';


type TileLayerOptionsWithAgent = TileLayerOptions & {
  httpsAgent?: any;
};

// Fix for default marker icons in Leaflet with webpack/vite
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

interface MapPanelProps {
  dtmSource: string | null;
  flightPath: Coordinate[];
  onPathPointHover: (point: Coordinate | null) => void;
  onPathChange: (path: Coordinate[]) => void;
  onAddPoint: (point: Coordinate) => void;
  onAddPoints: (points: Coordinate[]) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onDeletePoint: (index: number) => void;
  onDtmLoad: (source: string, info?: any) => void;
  onDtmUnload: () => void;
  nominalFlightHeight: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const MapPanel: React.FC<MapPanelProps> = ({
  dtmSource,
  flightPath,
  onPathPointHover,
  onPathChange,
  onAddPoint,
  onAddPoints,
  onUpdatePoint,
  onDeletePoint,
  onDtmLoad,
  onDtmUnload,
  nominalFlightHeight,
  onUndo,
  onRedo,
  canUndo,
  canRedo
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Helper function to check if a point is within DTM bounds
  const isPointWithinBounds = useCallback((lng: number, lat: number): boolean => {
    if (!dtmBounds || dtmBounds.length !== 4) {
      return false;
    }
    const [minLng, minLat, maxLng, maxLat] = dtmBounds;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  }, [dtmBounds]);

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
      if (mapContainer.current) {
        map.current = L.map(mapContainer.current, {
          center: [31.50, 35.02], // israel defulat
          zoom: 7 ,
          // crs: L.CRS.EPSG4326
        });
      }

      // Create option *after* httpsAgent_f is define
      const options: TileLayerOptionsWithAgent = {
        maxZoom:19,
        httpsAgent:httpsAgent_f
      };

      const response_token = await fetch('/api/token')

      if (!response_token.ok){
        const errorData = await response_token.json().catch(() => ({error: 'Unknown error'}));
        throw new Error(errorData.error || 'Failed to get token for maps ${response.status}');
      }
      const MAPS_TOKEN = await response_token.json();


      const response_url = await fetch('/api/url')

      if (!response_url.ok){
        const errorData = await response_url.json().catch(() => ({error: 'Unknown error'}));
        throw new Error(errorData.error || 'Failed to get token for maps ${response.status}');
      }
      const raw_url = await response_url.json();
      const url = `${raw_url.url}?token=${MAPS_TOKEN.token}`;
      
      if (map.current) {
        L.tileLayer(url,options).addTo(map.current)
      }
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Set up click handler for adding points, editing points, and parallel line creation
  useEffect(() => {
    if (!map.current) return;

    const handleClick = (e: L.LeafletMouseEvent) => {
      // If editing a point, move it to the new location
      if (editingPointIndex !== null && dtmLoaded) {
        const lng = e.latlng.lng;
        const lat = e.latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('Cannot move point outside DTM bounding box. Please select a point within the DTM extent.');
          return;
        }
        
        const currentPoint = flightPath[editingPointIndex];
        onUpdatePoint(editingPointIndex, {
          lng,
          lat,
          height: currentPoint.height // Preserve height
        });
        setEditingPointIndex(null);
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
          // Prompt for offset distance
          const distanceInput = prompt(
            `Enter offset distance in meters for parallel line:\n(Positive = right side, Negative = left side)`,
            '50'
          );
          
          if (distanceInput !== null) {
            const offsetDistance = parseFloat(distanceInput);
            if (!isNaN(offsetDistance)) {
              const segmentStart = flightPath[closestSegmentIndex];
              const segmentEnd = flightPath[closestSegmentIndex + 1];
              
              // Calculate parallel line
              const [parallelStart, parallelEnd] = calculateParallelLine(
                segmentStart,
                segmentEnd,
                offsetDistance
              );
              
              // Check if parallel points are within bounds
              if (
                isPointWithinBounds(parallelStart.lng, parallelStart.lat) &&
                isPointWithinBounds(parallelEnd.lng, parallelEnd.lat)
              ) {
                // Add parallel line points at the end of the flight path as a single operation
                // Point 3 should be closer to point 2, so we add parallelEnd first (which corresponds to point 2)
                // Then add parallelStart (which corresponds to point 1)
                onAddPoints([parallelEnd, parallelStart]); // Add both points in a single undoable action
                setIsParallelLineMode(false);
                alert(`Parallel line created with offset of ${offsetDistance}m. Added 2 new points at the end of the path.`);
              } else {
                alert('Parallel line points would be outside DTM bounds. Please use a smaller offset.');
              }
            } else {
              alert('Invalid distance. Please enter a number.');
            }
          }
        } else {
          alert('Could not determine which line segment was clicked. Please click closer to a line segment.');
        }
        return;
      }

      // Otherwise, add new point if drawing
      if (isDrawing && dtmLoaded) {
        const lng = e.latlng.lng;
        const lat = e.latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          alert('Cannot add point outside DTM bounding box. Please select a point within the DTM extent.');
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

    // Add flight path line (will be on top)
    flightPathLineRef.current = L.polyline(latlngs, {
      color: '#ff0000',
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

      const icon = L.divIcon({
        className: 'flight-point-marker-container',
        html: el,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const marker = L.marker([point.lat, point.lng], {
        icon: icon,
        draggable: true
      }).addTo(map.current!);

      // Store the last valid position for this marker
      let lastValidPosition: [number, number] = [point.lat, point.lng];

      // Handle drag start - store initial position
      marker.on('dragstart', () => {
        lastValidPosition = [point.lat, point.lng];
      });

      // Handle marker drag
      marker.on('drag', (e: L.LeafletEvent) => {
        const latlng = e.target.getLatLng();
        const lng = latlng.lng;
        const lat = latlng.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          // Reset marker to last valid position
          marker.setLatLng(lastValidPosition);
          return;
        }
        
        // Update last valid position and state
        lastValidPosition = [lat, lng];
        onUpdatePoint(index, { lng, lat });
      });
      
      // Handle drag end to show message if dragged outside bounds
      marker.on('dragend', (e: L.LeafletEvent) => {
        const latlng = e.target.getLatLng();
        const lng = latlng.lng;
        const lat = latlng.lat;
        
        // Check if final position is within bounds
        if (!isPointWithinBounds(lng, lat)) {
          // Reset to last valid position
          marker.setLatLng(lastValidPosition);
          onUpdatePoint(index, { lng: lastValidPosition[1], lat: lastValidPosition[0] });
          alert('Cannot move point outside DTM bounding box. Point has been reset to the previous valid position.');
        }
      });

      // Handle marker right-click for context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        setContextMenu({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          pointIndex: index
        });
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
  }, [flightPath, onUpdatePoint, onDeletePoint, onPathPointHover, isPointWithinBounds, isParallelLineMode]);

  // Exit drawing mode if DTM is unloaded
  useEffect(() => {
    if (!dtmLoaded && isDrawing) {
      setIsDrawing(false);
    }
    if (!dtmLoaded && isParallelLineMode) {
      setIsParallelLineMode(false);
    }
  }, [dtmLoaded, isDrawing, isParallelLineMode]);

  // Update cursor when parallel line mode changes
  useEffect(() => {
    if (!map.current) return;
    if (isParallelLineMode) {
      map.current.getContainer().style.cursor = 'crosshair';
    } else if (!isDrawing && editingPointIndex === null) {
      map.current.getContainer().style.cursor = '';
    }
  }, [isParallelLineMode, isDrawing, editingPointIndex]);

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
      // Keep opacity setting - don't reset it so user preference persists
      return;
    }

    const loadDTM = async () => {
      setDtmLoaded(false); // Reset loading state when starting to load
      try {
        // Extract filename from path
        const filename = dtmSource.split('/').pop();
        if (!filename) return;

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
              alert(`Failed to transform coordinates: ${transformError instanceof Error ? transformError.message : 'Unknown error'}\n\nSource projection: ${sourceProj}\n\nPlease check that the EPSG code in your GeoTIFF is correct.`);
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
            alert(`Failed to add DTM to map: ${sourceError instanceof Error ? sourceError.message : 'Unknown error'}\n\nCheck browser console for details.`);
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
          alert('Failed to create DTM image from canvas. Check console for details.');
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
        alert(`Failed to load DTM: ${errorMessage}\n\nPlease ensure the file is a valid GeoTIFF with elevation data.`);
      }
    };

    loadDTM();
  }, [dtmSource]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Prevent uploading if a DTM is already loaded
    if (dtmLoaded) {
      alert('A DTM is already loaded. Please unload it first before loading a new one.');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
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
        setIsUploading(false);
        setUploadProgress(0);
      });

      // Handle errors
      xhr.addEventListener('error', () => {
        console.error('Error uploading DTM:', xhr.statusText);
        alert('Failed to upload DTM file');
        setIsUploading(false);
        setUploadProgress(0);
      });

      // Handle abort
      xhr.addEventListener('abort', () => {
        setIsUploading(false);
        setUploadProgress(0);
      });

      // Send request
      xhr.open('POST', '/api/upload-dtm');
      xhr.send(formData);
    } catch (error) {
      console.error('Error uploading DTM:', error);
      alert('Failed to upload DTM file');
      setIsUploading(false);
      setUploadProgress(0);
    } finally {
      // Reset file input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
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
    if (window.confirm('Are you sure you want to delete all points?')) {
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
    const heightInput = prompt(`Enter flight height (AGL in meters) for point ${pointIndex + 1}:`, currentHeight.toString());
    
    if (heightInput !== null) {
      const height = parseFloat(heightInput);
      if (!isNaN(height) && height >= 0) {
        onUpdatePoint(pointIndex, {
          ...currentPoint,
          height
        });
      } else {
        alert('Invalid height. Please enter a positive number.');
      }
    }
  };

  const handleCreatePointFromAzimuthDistance = () => {
    if (flightPath.length === 0) {
      alert('Please add at least one point first before creating a point from azimuth and distance.');
      return;
    }

    if (!dtmLoaded) {
      alert('Please load a DTM first.');
      return;
    }

    const lastPoint = flightPath[flightPath.length - 1];
    
    // Prompt for azimuth (in degrees, 0-360, measured from north)
    const azimuthInput = prompt(
      `Enter azimuth in degrees (0-360, measured from north):\n` +
      `0° = North, 90° = East, 180° = South, 270° = West`,
      '0'
    );
    
    if (azimuthInput === null) return;
    
    const azimuth = parseFloat(azimuthInput);
    if (isNaN(azimuth) || azimuth < 0 || azimuth >= 360) {
      alert('Invalid azimuth. Please enter a number between 0 and 360.');
      return;
    }

    // Prompt for distance (in meters)
    const distanceInput = prompt('Enter distance in meters:', '100');
    
    if (distanceInput === null) return;
    
    const distance = parseFloat(distanceInput);
    if (isNaN(distance) || distance <= 0) {
      alert('Invalid distance. Please enter a positive number.');
      return;
    }

    // Convert azimuth (degrees from north) to bearing (radians from north)
    // Azimuth and bearing are the same, just need to convert to radians
    const bearing = (azimuth * Math.PI) / 180;

    // Calculate new point
    const newPoint = calculateDestination(lastPoint, bearing, distance);

    // Check if new point is within DTM bounds
    if (!isPointWithinBounds(newPoint.lng, newPoint.lat)) {
      alert('The calculated point is outside DTM bounding box. Please use a smaller distance or different azimuth.');
      return;
    }

    // Add the new point
    onAddPoint(newPoint);
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
      alert('Please load a DTM first.');
      return;
    }

    // Prompt user to choose coordinate system
    const coordTypeInput = prompt(
      `Select coordinate system:\n` +
      `1 - Geographic (Lat/Lng)\n` +
      `2 - UTM\n\n` +
      `Enter 1 or 2:`,
      '1'
    );

    if (coordTypeInput === null) return;

    const coordType = coordTypeInput.trim();
    let lng: number, lat: number;

    if (coordType === '1') {
      // Geographic coordinates (Lat/Lng)
      const lngInput = prompt('Enter Longitude (decimal degrees, -180 to 180):', '');
      if (lngInput === null) return;

      const latInput = prompt('Enter Latitude (decimal degrees, -90 to 90):', '');
      if (latInput === null) return;

      lng = parseFloat(lngInput);
      lat = parseFloat(latInput);

      if (isNaN(lng) || isNaN(lat)) {
        alert('Invalid coordinates. Please enter valid numbers.');
        return;
      }

      if (lng < -180 || lng > 180) {
        alert('Invalid longitude. Please enter a value between -180 and 180.');
        return;
      }

      if (lat < -90 || lat > 90) {
        alert('Invalid latitude. Please enter a value between -90 and 90.');
        return;
      }
    } else if (coordType === '2') {
      // UTM coordinates
      const eastingInput = prompt('Enter UTM Easting (meters):', '');
      if (eastingInput === null) return;

      const northingInput = prompt('Enter UTM Northing (meters):', '');
      if (northingInput === null) return;

      const zoneInput = prompt('Enter UTM Zone (1-60):', '36');
      if (zoneInput === null) return;

      const hemisphereInput = prompt('Enter Hemisphere (N for North, S for South):', 'N');
      if (hemisphereInput === null) return;

      const easting = parseFloat(eastingInput);
      const northing = parseFloat(northingInput);
      const zone = parseInt(zoneInput, 10);
      const hemisphere = hemisphereInput.trim().toUpperCase();

      if (isNaN(easting) || isNaN(northing) || isNaN(zone)) {
        alert('Invalid UTM coordinates. Please enter valid numbers.');
        return;
      }

      if (zone < 1 || zone > 60) {
        alert('Invalid UTM zone. Please enter a value between 1 and 60.');
        return;
      }

      if (hemisphere !== 'N' && hemisphere !== 'S') {
        alert('Invalid hemisphere. Please enter N for North or S for South.');
        return;
      }

      // Convert UTM to WGS84 using proj4
      try {
        // Define UTM projection using proj4 string format
        // UTM zones: central meridian at 6° intervals, false easting 500,000m, false northing 10,000,000m for Southern hemisphere
        const utmProjString = `+proj=utm +zone=${zone} +${hemisphere === 'N' ? 'north' : 'south'} +datum=WGS84 +units=m +no_defs`;
        
        // Define WGS84 (EPSG:4326) projection
        const wgs84Proj = '+proj=longlat +datum=WGS84 +no_defs';
        
        // Transform from UTM to WGS84
        const [transformedLng, transformedLat] = proj4(utmProjString, wgs84Proj, [easting, northing]);
        lng = transformedLng;
        lat = transformedLat;
        
        console.log(`Converted UTM (Zone ${zone}${hemisphere}, ${easting}, ${northing}) to WGS84: (${lng}, ${lat})`);
      } catch (transformError) {
        console.error('Error transforming UTM coordinates:', transformError);
        alert(`Failed to convert UTM coordinates: ${transformError instanceof Error ? transformError.message : 'Unknown error'}`);
        return;
      }
    } else {
      alert('Invalid selection. Please enter 1 for Geographic or 2 for UTM.');
      return;
    }

    // Check if point is within DTM bounds
    if (!isPointWithinBounds(lng, lat)) {
      alert('The specified point is outside DTM bounding box. Please enter coordinates within the DTM extent.');
      return;
    }

    // Create and add the new point
    const newPoint: Coordinate = {
      lng,
      lat
    };
    onAddPoint(newPoint);
  };

  return (
    <div className="map-panel">
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            onDeletePoint(contextMenu.pointIndex);
            setContextMenu(null);
          }}
          onEdit={() => {
            setEditingPointIndex(contextMenu.pointIndex);
            setContextMenu(null);
            alert(`Edit mode enabled for point ${contextMenu.pointIndex + 1}. Click on the map to move the point.`);
          }}
          onSetHeight={() => {
            handleSetFlightHeight(contextMenu.pointIndex);
            setContextMenu(null);
          }}
        />
      )}
      {editingPointIndex !== null && (
        <div className="edit-mode-indicator">
          Edit mode: Click on the map to move point {editingPointIndex + 1}
        </div>
      )}
      {isParallelLineMode && (
        <div className="edit-mode-indicator">
          Parallel Line mode: Click on a line segment to create a parallel line
        </div>
      )}
      <div className="map-controls">
        <div className="control-group">
          <div className="group-title">Data Management</div>
          <div className="group-columns">
            <div className="group-column">
              <input
                ref={fileInputRef}
                type="file"
                accept=".tif,.tiff,.geotiff"
                onChange={handleFileUpload}
                id="dtm-upload"
                style={{ display: 'none' }}
                disabled={dtmLoaded}
              />
              <label 
                htmlFor="dtm-upload" 
                className={`btn btn-secondary ${dtmLoaded ? 'disabled' : ''}`}
                style={dtmLoaded ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
                title={dtmLoaded ? 'A DTM is already loaded. Unload it first to load a new one.' : 'Load a Digital Terrain Model file'}
              >
                Load DTM
              </label>
              <button
                onClick={onDtmUnload}
                className="btn btn-destructive"
                disabled={!dtmSource || !dtmLoaded}
                title={!dtmSource || !dtmLoaded ? 'No DTM loaded' : 'Unload DTM from map'}
              >
                Unload DTM
              </button>
            </div>
            <div className="group-column">
              <button
                onClick={handleDeleteAllPoints}
                className="btn btn-destructive"
                disabled={flightPath.length === 0}
                title={flightPath.length === 0 ? 'No points to delete' : 'Delete all flight path points'}
              >
                Delete All Points
              </button>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">Planning Options</div>
          <div className="group-columns">
            <div className="group-column">
              <button
                onClick={() => {
                  setIsDrawing(!isDrawing);
                  setEditingPointIndex(null);
                  setIsParallelLineMode(false);
                }}
                className={`btn btn-primary ${isDrawing ? 'active' : ''}`}
                disabled={!dtmLoaded}
                title={!dtmLoaded ? 'Load a DTM first to enable drawing' : 'Click on the map to add points to your flight path'}
              >
                {isDrawing ? 'Stop Drawing' : 'Draw Path'}
              </button>
              <button
                onClick={() => {
                  setIsParallelLineMode(!isParallelLineMode);
                  setIsDrawing(false);
                  setEditingPointIndex(null);
                }}
                className={`btn btn-secondary ${isParallelLineMode ? 'active' : ''}`}
                disabled={!dtmLoaded || flightPath.length < 2}
                title={
                  !dtmLoaded 
                    ? 'Load a DTM first to enable parallel line creation'
                    : flightPath.length < 2 
                      ? 'Flight path must have at least 2 points' 
                      : 'Create a parallel line to an existing segment'
                }
              >
                {isParallelLineMode ? 'Cancel Parallel Line' : 'Create Parallel Line'}
              </button>
            </div>
            <div className="group-column">
              <button
                onClick={handleCreatePointFromAzimuthDistance}
                className="btn btn-secondary"
                disabled={!dtmLoaded || flightPath.length === 0}
                title={
                  !dtmLoaded 
                    ? 'Load a DTM first to enable azimuth/distance point creation'
                    : flightPath.length === 0 
                      ? 'Add at least one point first' 
                      : 'Create a new point from the last point using azimuth and distance'
                }
              >
                Azimuth + Distance
              </button>
              <button
                onClick={handleCreatePointFromCoordinates}
                className="btn btn-secondary"
                disabled={!dtmLoaded}
                title={
                  !dtmLoaded 
                    ? 'Load a DTM first to enable coordinate-based point creation'
                    : 'Add a new point by entering coordinates (UTM or Geographic)'
                }
              >
                Point by Coordinate
              </button>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">History</div>
          <div className="group-columns">
            <div className="group-column">
              <button
                onClick={onUndo}
                disabled={!canUndo || flightPath.length === 0}
                className="btn btn-secondary"
                title={flightPath.length === 0 ? 'Draw points first to enable undo' : 'Undo last action (Ctrl+Z)'}
              >
                Undo
              </button>
              <button
                onClick={onRedo}
                disabled={!canRedo || flightPath.length === 0}
                className="btn btn-secondary"
                title={flightPath.length === 0 ? 'Draw points first to enable redo' : 'Redo last action (Ctrl+Y or Ctrl+Shift+Z)'}
              >
                Redo
              </button>
            </div>
          </div>
        </div>

        <div className="control-group">
          <div className="group-title">View Controls</div>
          <div className="group-columns">
            <div className="group-column">
              <button
                onClick={handleFitToDTM}
                className="btn btn-tertiary"
                disabled={!dtmLoaded}
                title={!dtmLoaded ? 'Load a DTM first to fit to its extent' : 'Fit map to DTM extent'}
              >
                Fit to DTM
              </button>
              <button
                onClick={handleResetView}
                className="btn btn-tertiary"
                title="Reset map view to default extent"
              >
                Reset View
              </button>
            </div>
          </div>
        </div>
      </div>
      <div ref={mapContainer} className="map-container">
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
      </div>
    </div>
  );
};

export default MapPanel;
