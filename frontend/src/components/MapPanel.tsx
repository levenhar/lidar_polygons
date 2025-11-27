import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import { calculateParallelLine, findClosestPointOnLine, calculateDestination } from '../utils/geometry';
import './MapPanel.css';

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
  const map = useRef<maplibregl.Map | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isParallelLineMode, setIsParallelLineMode] = useState(false);
  const [dtmLoaded, setDtmLoaded] = useState(false);
  const [dtmBounds, setDtmBounds] = useState<number[] | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoveredPointRef = useRef<number | null>(null);
  const dtmImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [editingPointIndex, setEditingPointIndex] = useState<number | null>(null);

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
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: [
              'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [
          {
            id: 'osm-layer',
            type: 'raster',
            source: 'osm-tiles',
            minzoom: 0,
            maxzoom: 19
          }
        ]
      },
      center: [34.8516, 31.0461], // Israel default
      zoom: 6
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    return () => {
      if (map.current) {
        // Clean up DTM layer
        if (map.current.getLayer('dtm-layer')) {
          map.current.removeLayer('dtm-layer');
        }
        if (map.current.getSource('dtm-source')) {
          map.current.removeSource('dtm-source');
        }
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Set up click handler for adding points, editing points, and parallel line creation
  useEffect(() => {
    if (!map.current) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      // If editing a point, move it to the new location
      if (editingPointIndex !== null && dtmLoaded) {
        const lng = e.lngLat.lng;
        const lat = e.lngLat.lat;
        
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
        // Use MapLibre's queryRenderedFeatures to detect clicks on the line
        const features = map.current.queryRenderedFeatures(e.point, {
          layers: ['flight-path-clickable']
        });
        
        if (features.length > 0) {
          // Find which segment was clicked by calculating distance to each segment
          const clickPoint = { lng: e.lngLat.lng, lat: e.lngLat.lat };
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
        } else {
          alert('Please click on a line segment to create a parallel line.');
        }
        return;
      }

      // Otherwise, add new point if drawing
      if (isDrawing && dtmLoaded) {
        const lng = e.lngLat.lng;
        const lat = e.lngLat.lat;
        
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
  }, [isDrawing, isParallelLineMode, dtmLoaded, onAddPoint, onUpdatePoint, isPointWithinBounds, editingPointIndex, flightPath]);

  // Update flight path on map
  useEffect(() => {
    if (!map.current) return;

    // Remove existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Remove existing flight path source and layers
    if (map.current.getLayer('flight-path-clickable')) {
      map.current.removeLayer('flight-path-clickable');
    }
    if (map.current.getSource('flight-path')) {
      map.current.removeLayer('flight-path');
      map.current.removeSource('flight-path');
    }

    if (flightPath.length === 0) return;

    // Add flight path line
    map.current.addSource('flight-path', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: flightPath.map(p => [p.lng, p.lat])
        }
      }
    });

    // Add invisible clickable layer for line segment selection (wide stroke)
    map.current.addLayer({
      id: 'flight-path-clickable',
      type: 'line',
      source: 'flight-path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 20, // Wide invisible line for easier clicking
        'line-opacity': 0
      }
    });

    // Add flight path layer (will be on top)
    map.current.addLayer({
      id: 'flight-path',
      type: 'line',
      source: 'flight-path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#ff0000',
        'line-width': 3,
        'line-opacity': 0.8
      }
    });
    
    // Ensure flight path is above DTM if DTM exists (DTM stays visible below)
    if (map.current.getLayer('dtm-layer')) {
      // Move flight path to the top to ensure it's above DTM (DTM remains visible)
      map.current.moveLayer('flight-path');
    }

    // Update cursor style for clickable line layer when in parallel line mode
    if (isParallelLineMode) {
      map.current.getCanvas().style.cursor = 'crosshair';
    }

    // Add markers for each point
    flightPath.forEach((point, index) => {
      const el = document.createElement('div');
      el.className = 'flight-point-marker';
      el.innerHTML = `${index + 1}`;
      el.style.cursor = 'pointer';

      const marker = new maplibregl.Marker({
        element: el,
        draggable: true
      })
        .setLngLat([point.lng, point.lat])
        .addTo(map.current!);

      // Store the last valid position for this marker
      let lastValidPosition: [number, number] = [point.lng, point.lat];

      // Handle drag start - store initial position
      marker.on('dragstart', () => {
        lastValidPosition = [point.lng, point.lat];
      });

      // Handle marker drag
      marker.on('drag', () => {
        const lngLat = marker.getLngLat();
        const lng = lngLat.lng;
        const lat = lngLat.lat;
        
        // Check if point is within DTM bounds
        if (!isPointWithinBounds(lng, lat)) {
          // Reset marker to last valid position
          marker.setLngLat(lastValidPosition);
          return;
        }
        
        // Update last valid position and state
        lastValidPosition = [lng, lat];
        onUpdatePoint(index, { lng, lat });
      });
      
      // Handle drag end to show message if dragged outside bounds
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        const lng = lngLat.lng;
        const lat = lngLat.lat;
        
        // Check if final position is within bounds
        if (!isPointWithinBounds(lng, lat)) {
          // Reset to last valid position
          marker.setLngLat(lastValidPosition);
          onUpdatePoint(index, { lng: lastValidPosition[0], lat: lastValidPosition[1] });
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
      map.current.getCanvas().style.cursor = 'crosshair';
    } else if (!isDrawing && editingPointIndex === null) {
      map.current.getCanvas().style.cursor = '';
    }
  }, [isParallelLineMode, isDrawing, editingPointIndex]);

  // Handle DTM source changes - load and display DTM
  useEffect(() => {
    if (!map.current || !dtmSource) {
      // Remove DTM layer if source is cleared
      if (map.current && map.current.getLayer('dtm-layer')) {
        map.current.removeLayer('dtm-layer');
      }
      if (map.current && map.current.getSource('dtm-source')) {
        map.current.removeSource('dtm-source');
      }
      // Restore OSM opacity to full when DTM is unloaded
      if (map.current && map.current.getLayer('osm-layer')) {
        map.current.setPaintProperty('osm-layer', 'raster-opacity', 1.0);
      }
      // Reset file input so it can be used again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      dtmImageRef.current = null;
      setDtmLoaded(false);
      setDtmBounds(null);
      return;
    }

    const loadDTM = async () => {
      setDtmLoaded(false); // Reset loading state when starting to load
      try {
        // Extract filename from path
        const filename = dtmSource.split('/').pop();
        if (!filename) return;

        // Fetch raster data
        const response = await fetch(`http://localhost:5000/api/dtm/${filename}/raster`);
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
        const addDTMLayer = (img: HTMLImageElement, bounds: number[], wasProjected: boolean) => {
          if (!map.current) {
            console.error('Map not initialized');
            return;
          }

          console.log('Adding DTM layer to map...');
          console.log('Bounds (WGS84):', bounds);
          console.log('Was Projected:', wasProjected);

          // Remove existing DTM layer if present
          if (map.current.getLayer('dtm-layer')) {
            map.current.removeLayer('dtm-layer');
          }
          if (map.current.getSource('dtm-source')) {
            map.current.removeSource('dtm-source');
          }

          // Get bounds (now in WGS84 lat/lon)
          const [minX, minY, maxX, maxY] = bounds;

          try {
            const imageUrl = canvas.toDataURL();
            console.log('Image URL length:', imageUrl.length);
            console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);
            console.log('Coordinates to use:', [
              [minX, maxY], // top-left
              [maxX, maxY], // top-right
              [maxX, minY], // bottom-right
              [minX, minY]  // bottom-left
            ]);

            // Remove existing source if present
            if (map.current.getSource('dtm-source')) {
              map.current.removeSource('dtm-source');
            }

            // Add image source with geographic coordinates
            map.current.addSource('dtm-source', {
              type: 'image',
              url: imageUrl,
              coordinates: [
                [minX, maxY], // top-left (west, north)
                [maxX, maxY], // top-right (east, north)
                [maxX, minY], // bottom-right (east, south)
                [minX, minY]  // bottom-left (west, south)
              ]
            });
            
            // Verify source was added and wait for it to load
            const source = map.current.getSource('dtm-source');
            console.log('Source added, type:', source?.type);
            if (source && 'coordinates' in source) {
              console.log('Source coordinates:', (source as any).coordinates);
            }
            
            // Check if source has an image property (for image sources)
            if (source && 'image' in source) {
              const imageSource = source as any;
              console.log('Image source image property:', imageSource.image);
              if (imageSource.image) {
                console.log('Image loaded:', imageSource.image.complete);
                console.log('Image dimensions:', imageSource.image.width, 'x', imageSource.image.height);
              }
            }

            console.log('DTM source added successfully');

            // Add raster layer to display the image
            // Place DTM layer above OSM but below flight path
            // Determine where to place it
            let beforeId: string | undefined = undefined;
            if (map.current.getLayer('flight-path')) {
              // If flight path exists, place DTM before it (so flight path stays on top)
              beforeId = 'flight-path';
            }
            // If no flight path, add at top (will be above OSM)
            
            map.current.addLayer({
              id: 'dtm-layer',
              type: 'raster',
              source: 'dtm-source',
              paint: {
                'raster-opacity': 1.0  // Full opacity for maximum visibility
              }
            }, beforeId);
            
            // If flight path layer exists, ensure it's above DTM (move to top)
            if (map.current.getLayer('flight-path')) {
              map.current.moveLayer('flight-path');
            }
            
            // Reduce OSM opacity significantly to make DTM clearly visible
            // Since DTM is grayscale, we want it to be the dominant layer
            if (map.current.getLayer('osm-layer')) {
              const currentOpacity = map.current.getPaintProperty('osm-layer', 'raster-opacity');
              console.log('Current OSM opacity:', currentOpacity);
              // Set OSM to 30% opacity so DTM grayscale is clearly visible on top
              map.current.setPaintProperty('osm-layer', 'raster-opacity', 0.3);
            }
            
            // Force map to repaint
            map.current.triggerRepaint();
            
            // Verify layer order and visibility
            console.log('Layer order after DTM addition:');
            const style = map.current.getStyle();
            if (style && style.layers) {
              style.layers.forEach((layer: any, index: number) => {
                const layerObj = map.current!.getLayer(layer.id);
                const visibility = layerObj ? 'visible' : 'not found';
                console.log(`  ${index}: ${layer.id} (${layer.type}) - ${visibility}`);
              });
            }
            
            // Verify DTM layer exists and is visible
            const dtmLayer = map.current.getLayer('dtm-layer');
            if (dtmLayer) {
              console.log('DTM layer verified:', dtmLayer);
              const opacity = map.current.getPaintProperty('dtm-layer', 'raster-opacity');
              console.log('DTM layer paint properties - opacity:', opacity);
            } else {
              console.error('DTM layer not found after addition!');
            }
            
            // Verify source
            const dtmSource = map.current.getSource('dtm-source');
            if (dtmSource && 'coordinates' in dtmSource) {
              console.log('DTM source verified:', dtmSource);
              console.log('DTM source coordinates:', (dtmSource as any).coordinates);
            } else {
              console.error('DTM source not found after addition!');
            }
            
            // Check current map bounds vs DTM bounds
            const mapBounds = map.current.getBounds();
            const mapBoundsArray = mapBounds.toArray();
            console.log('Current map bounds:', mapBoundsArray);
            console.log('DTM bounds:', bounds);
            
            // Check if DTM bounds are within map viewport
            const [mapMinLng, mapMinLat, mapMaxLng, mapMaxLat] = [
              mapBoundsArray[0][0], mapBoundsArray[0][1],
              mapBoundsArray[1][0], mapBoundsArray[1][1]
            ];
            const [dtmMinLng, dtmMinLat, dtmMaxLng, dtmMaxLat] = bounds;
            
            const dtmInViewport = !(
              dtmMaxLng < mapMinLng || dtmMinLng > mapMaxLng ||
              dtmMaxLat < mapMinLat || dtmMinLat > mapMaxLat
            );
            console.log('DTM in viewport:', dtmInViewport);
            if (!dtmInViewport) {
              console.warn('DTM bounds are outside current map viewport! Use "Fit to DTM" button to see it.');
            }

            console.log('DTM layer added successfully');
            dtmImageRef.current = img;
            setDtmLoaded(true);
            setDtmBounds(bounds); // Store bounds for the "Fit to DTM" button

            // Fit map to DTM bounds (now in WGS84)
            console.log('Fitting map to DTM bounds (WGS84):', bounds);
            try {
              map.current.fitBounds(
                [[minX, minY], [maxX, maxY]],
                { 
                  padding: { top: 50, bottom: 50, left: 50, right: 50 },
                  duration: 1500,
                  maxZoom: 18
                }
              );
              console.log('Map fitted to DTM bounds successfully');
            } catch (fitError) {
              console.error('Error fitting map to bounds:', fitError);
              // Fallback: try to center on the middle of the bounds
              const centerLng = (minX + maxX) / 2;
              const centerLat = (minY + maxY) / 2;
              console.log('Falling back to center:', centerLng, centerLat);
              map.current.flyTo({
                center: [centerLng, centerLat],
                zoom: 13,
                duration: 1500
              });
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

          if (!map.current.loaded()) {
            console.log('Map not loaded yet, waiting...');
            map.current.once('load', () => {
              console.log('Map loaded, adding DTM layer...');
              addDTMLayer(img, transformedBounds, isProjected);
            });
          } else {
            addDTMLayer(img, transformedBounds, isProjected);
          }
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

    try {
      const response = await fetch('http://localhost:5000/api/upload-dtm', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (data.success) {
        onDtmLoad(data.path, data);
      }
    } catch (error) {
      console.error('Error uploading DTM:', error);
      alert('Failed to upload DTM file');
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
      map.current.fitBounds(
        [[minX, minY], [maxX, maxY]],
        { 
          padding: { top: 50, bottom: 50, left: 50, right: 50 },
          duration: 1500,
          maxZoom: 18
        }
      );
    } catch (fitError) {
      console.error('Error fitting map to DTM bounds:', fitError);
      // Fallback: center on the middle of the bounds
      const centerLng = (minX + maxX) / 2;
      const centerLat = (minY + maxY) / 2;
      map.current.flyTo({
        center: [centerLng, centerLat],
        zoom: 13,
        duration: 1500
      });
    }
  };

  const handleDeleteAllPoints = () => {
    if (window.confirm('Are you sure you want to delete all points?')) {
      onPathChange([]);
    }
  };

  const handleResetView = () => {
    if (!map.current) return;
    map.current.flyTo({
      center: [34.8516, 31.0461], // Israel default
      zoom: 6,
      duration: 1500
    });
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
      <div ref={mapContainer} className="map-container" />
    </div>
  );
};

export default MapPanel;

