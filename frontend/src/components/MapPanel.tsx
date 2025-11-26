import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
// @ts-ignore - proj4 types may not be perfect
import proj4 from 'proj4';
import { Coordinate } from '../App';
import './MapPanel.css';

interface MapPanelProps {
  dtmSource: string | null;
  flightPath: Coordinate[];
  onPathPointHover: (point: Coordinate | null) => void;
  onPathChange: (path: Coordinate[]) => void;
  onAddPoint: (point: Coordinate) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onDeletePoint: (index: number) => void;
  onDtmLoad: (source: string, info?: any) => void;
}

const MapPanel: React.FC<MapPanelProps> = ({
  dtmSource,
  flightPath,
  onPathPointHover,
  onPathChange,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onDtmLoad
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [dtmLoaded, setDtmLoaded] = useState(false);
  const [dtmBounds, setDtmBounds] = useState<number[] | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoveredPointRef = useRef<number | null>(null);
  const dtmImageRef = useRef<HTMLImageElement | null>(null);

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
      center: [-122.4194, 37.7749], // San Francisco default
      zoom: 13
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

  // Set up click handler for adding points (separate effect to use latest bounds)
  useEffect(() => {
    if (!map.current) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
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
  }, [isDrawing, dtmLoaded, onAddPoint, isPointWithinBounds]);

  // Update flight path on map
  useEffect(() => {
    if (!map.current) return;

    // Remove existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Remove existing flight path source and layer
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

      // Handle marker click for deletion (right-click or Ctrl+click)
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onDeletePoint(index);
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

    // Fit map to bounds if path exists
    if (flightPath.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      flightPath.forEach(point => bounds.extend([point.lng, point.lat]));
      map.current.fitBounds(bounds, { padding: 50 });
    }
  }, [flightPath, onUpdatePoint, onDeletePoint, onPathPointHover, isPointWithinBounds]);

  // Exit drawing mode if DTM is unloaded
  useEffect(() => {
    if (!dtmLoaded && isDrawing) {
      setIsDrawing(false);
    }
  }, [dtmLoaded, isDrawing]);

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

  return (
    <div className="map-panel">
      <div className="map-controls">
        <button
          onClick={() => setIsDrawing(!isDrawing)}
          className={isDrawing ? 'active' : ''}
          disabled={!dtmLoaded}
          title={!dtmLoaded ? 'Please load a DTM first' : ''}
        >
          {isDrawing ? 'Stop Drawing' : 'Draw Path'}
        </button>
        <input
          type="file"
          accept=".tif,.tiff,.geotiff"
          onChange={handleFileUpload}
          id="dtm-upload"
          style={{ display: 'none' }}
        />
        <label htmlFor="dtm-upload" className="button-label">
          Load DTM
        </label>
        {dtmSource && dtmLoaded && (
          <>
            <span className="dtm-status">DTM Loaded</span>
            <button
              onClick={handleFitToDTM}
              title="Fit map to DTM extent"
            >
              Fit to DTM
            </button>
          </>
        )}
      </div>
      <div ref={mapContainer} className="map-container" />
    </div>
  );
};

export default MapPanel;

