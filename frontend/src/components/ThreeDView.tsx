/**
 * ThreeDView — self-contained Three.js 3D terrain viewer.
 * Read-only: no route editing, orbit/pan/zoom only.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  GeoBounds,
  boundsToMetric,
  downsampleRaster,
  geoToLocal,
  elevationToColor,
  computeTileRange,
  tileToLng,
  tileToLat,
} from '../utils/threeDHelpers';

// ── Types ─────────────────────────────────────────────────────────────

interface RasterData {
  width: number;
  height: number;
  data: ArrayLike<number>;
  bounds: number[];
  noDataValue: number | null;
  crs: string | null;
  isProjected: boolean;
}

interface BaseMapConfig {
  id: string;
  name: string;
  url: string;
}

interface RouteCoord {
  lng: number;
  lat: number;
  height?: number;
  id?: string;
}

interface RouteData {
  id: string;
  name: string;
  points: RouteCoord[];
  color: string;
  visible: boolean;
}

interface ElevationPoint3D {
  distance: number;
  longitude: number;
  latitude: number;
  plannedAltitude?: number;
}

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

export interface ThreeDViewProps {
  rasterData: RasterData | null;
  baseMaps: BaseMapConfig[];
  activeBaseMapId: string | null;
  mapToken?: string;
  routes: RouteData[];
  activeRouteId: string;
  elevationProfile: ElevationPoint3D[];
  onBaseMapCycle: () => void;
  viewshedRaster: ViewshedRasterData | null;
  viewshedVisible: boolean;
  viewshedColormap: string;
  viewshedOpacity: number;
  viewshedClassColors: [string, string, string, string];
  getViewshedClassColor: (
    value: number,
    noDataValue: number | null,
    classColors: [string, string, string, string]
  ) => { r: number; g: number; b: number } | null;
}

// ── Constants ─────────────────────────────────────────────────────────

const MAX_MESH_SIZE = 512;
const VERTICAL_EXAGGERATION = 1.5;
const TEXTURE_SIZE = 2048;
const ROUTE_OFFSET_ABOVE_TERRAIN = 5;

// ── Component ─────────────────────────────────────────────────────────

const ThreeDView: React.FC<ThreeDViewProps> = ({
  rasterData,
  baseMaps,
  activeBaseMapId,
  mapToken = '',
  routes,
  activeRouteId,
  elevationProfile,
  onBaseMapCycle,
  viewshedRaster,
  viewshedVisible,
  viewshedColormap: _viewshedColormap,
  viewshedOpacity,
  viewshedClassColors,
  getViewshedClassColor,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number>(0);
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const routeGroupRef = useRef<THREE.Group | null>(null);
  const [terrainMetrics, setTerrainMetrics] = useState<{ widthMeters: number; heightMeters: number; bounds: GeoBounds; minElev: number; maxElev: number } | null>(null);
  const elevDataRef = useRef<Float32Array | null>(null);
  const elevColsRef = useRef(0);
  const elevRowsRef = useRef(0);

  // Refs so async tile-load callbacks always read latest viewshed state
  const viewshedRasterRef = useRef(viewshedRaster);
  const viewshedVisibleRef = useRef(viewshedVisible);
  const viewshedClassColorsRef = useRef(viewshedClassColors);
  const viewshedOpacityRef = useRef(viewshedOpacity);
  const getViewshedClassColorRef = useRef(getViewshedClassColor);

  // Keep viewshed refs in sync
  useEffect(() => { viewshedRasterRef.current = viewshedRaster; }, [viewshedRaster]);
  useEffect(() => { viewshedVisibleRef.current = viewshedVisible; }, [viewshedVisible]);
  useEffect(() => { viewshedClassColorsRef.current = viewshedClassColors; }, [viewshedClassColors]);
  useEffect(() => { viewshedOpacityRef.current = viewshedOpacity; }, [viewshedOpacity]);
  useEffect(() => { getViewshedClassColorRef.current = getViewshedClassColor; }, [getViewshedClassColor]);

  // ── Build terrain mesh ────────────────────────────────────────────

  const buildTerrain = useCallback(() => {
    if (!rasterData || !sceneRef.current) return;

    const bounds: GeoBounds = [
      rasterData.bounds[0], rasterData.bounds[1],
      rasterData.bounds[2], rasterData.bounds[3],
    ];
    const metrics = boundsToMetric(bounds);

    // Determine downsampled size (max 512 per axis, preserve aspect ratio)
    const aspect = rasterData.width / rasterData.height;
    let cols: number, rows: number;
    if (aspect >= 1) {
      cols = Math.min(rasterData.width, MAX_MESH_SIZE);
      rows = Math.round(cols / aspect);
    } else {
      rows = Math.min(rasterData.height, MAX_MESH_SIZE);
      cols = Math.round(rows * aspect);
    }
    cols = Math.max(cols, 2);
    rows = Math.max(rows, 2);

    const elev = downsampleRaster(
      rasterData.data, rasterData.width, rasterData.height,
      cols, rows, rasterData.noDataValue
    );
    elevDataRef.current = elev;
    elevColsRef.current = cols;
    elevRowsRef.current = rows;

    // Find elevation range
    let minElev = Infinity, maxElev = -Infinity;
    for (let i = 0; i < elev.length; i++) {
      if (Number.isFinite(elev[i])) {
        if (elev[i] < minElev) minElev = elev[i];
        if (elev[i] > maxElev) maxElev = elev[i];
      }
    }
    if (!Number.isFinite(minElev)) { minElev = 0; maxElev = 100; }

    setTerrainMetrics({ widthMeters: metrics.widthMeters, heightMeters: metrics.heightMeters, bounds, minElev, maxElev });

    // Remove old mesh
    if (terrainMeshRef.current) {
      sceneRef.current.remove(terrainMeshRef.current);
      terrainMeshRef.current.geometry.dispose();
      (terrainMeshRef.current.material as THREE.Material).dispose();
    }

    // Create plane geometry and set Z from elevation
    const geom = new THREE.PlaneGeometry(
      metrics.widthMeters, metrics.heightMeters,
      cols - 1, rows - 1
    );
    const posAttr = geom.attributes.position;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const z = (Number.isFinite(elev[idx]) ? elev[idx] : minElev) * VERTICAL_EXAGGERATION;
        // PlaneGeometry lays out vertices top-to-bottom (row 0 = +Y)
        posAttr.setZ(idx, z);
      }
    }
    geom.computeVertexNormals();

    // Fallback elevation-based texture
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = cols;
    fallbackCanvas.height = rows;
    const ctx = fallbackCanvas.getContext('2d')!;
    const imgData = ctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const { r: cr, g, b } = elevationToColor(elev[idx], minElev, maxElev);
        const px = idx * 4;
        imgData.data[px] = cr;
        imgData.data[px + 1] = g;
        imgData.data[px + 2] = b;
        imgData.data[px + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    const fallbackTex = new THREE.CanvasTexture(fallbackCanvas);

    const mat = new THREE.MeshStandardMaterial({
      map: fallbackTex,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    sceneRef.current.add(mesh);
    terrainMeshRef.current = mesh;

    // Position camera to frame the terrain
    if (cameraRef.current && controlsRef.current) {
      const maxDim = Math.max(metrics.widthMeters, metrics.heightMeters);
      const elevRange = (maxElev - minElev) * VERTICAL_EXAGGERATION;
      const camDist = maxDim * 0.8;
      const targetZ = (minElev + maxElev) / 2 * VERTICAL_EXAGGERATION;
      cameraRef.current.position.set(0, -maxDim * 0.5, elevRange + camDist * 0.5);
      cameraRef.current.far = maxDim * 5;
      cameraRef.current.updateProjectionMatrix();
      controlsRef.current.target.set(0, 0, targetZ);
      controlsRef.current.update();
    }

    // Load map tiles asynchronously
    loadMapTileTexture(bounds);
  }, [rasterData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load map tile texture ─────────────────────────────────────────

  const loadMapTileTexture = useCallback((bounds: GeoBounds) => {
    const activeMap = baseMaps.find(b => b.id === activeBaseMapId) ?? baseMaps[0];
    if (!activeMap || !terrainMeshRef.current) return;

    const { zoom, minTile, maxTile, cols: tileCols, rows: tileRows } = computeTileRange(bounds);

    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d')!;


    let loaded = 0;
    let succeeded = 0;
    const total = tileCols * tileRows;
    // Capture reference so async callbacks don't apply to a replaced mesh
    const meshRef = terrainMeshRef.current;

    const applyTexture = () => {
      const vsRaster = viewshedRasterRef.current;
      const vsVisible = viewshedVisibleRef.current;

      // Draw viewshed overlay on top of tiles canvas
      if (vsVisible && vsRaster) {
        const vsCanvas = document.createElement('canvas');
        vsCanvas.width = vsRaster.width;
        vsCanvas.height = vsRaster.height;
        const vsCtx = vsCanvas.getContext('2d')!;
        const vsImg = vsCtx.createImageData(vsRaster.width, vsRaster.height);
        const vsClassColors = viewshedClassColorsRef.current;
        const vsOpacity = viewshedOpacityRef.current;
        const getVsColor = getViewshedClassColorRef.current;

        for (let i = 0; i < vsRaster.data.length; i++) {
          const rgb = getVsColor(vsRaster.data[i], vsRaster.noDataValue, vsClassColors);
          const px = i * 4;
          if (rgb) {
            vsImg.data[px]     = rgb.r;
            vsImg.data[px + 1] = rgb.g;
            vsImg.data[px + 2] = rgb.b;
            vsImg.data[px + 3] = Math.round(vsOpacity * 255);
          } else {
            vsImg.data[px + 3] = 0; // transparent → map tile shows through
          }
        }
        vsCtx.putImageData(vsImg, 0, 0);

        // Map viewshed geographic bounds → canvas pixel rect.
        // The PlaneGeometry UV is linear/equirectangular (not Mercator), so we must
        // interpolate linearly using terrain geographic bounds — not tile-frac coords.
        // Canvas: x=0 = west (minLng), x=TEXTURE_SIZE = east (maxLng)
        //         y=0 = north (maxLat), y=TEXTURE_SIZE = south (minLat)  [flipY in texture]
        const [minLng, minLat, maxLng, maxLat] = bounds;
        const vsMinLng = vsRaster.bounds[0], vsMinLat = vsRaster.bounds[1];
        const vsMaxLng = vsRaster.bounds[2], vsMaxLat = vsRaster.bounds[3];
        const dx = (vsMinLng - minLng) / (maxLng - minLng) * TEXTURE_SIZE;
        const dy = (maxLat - vsMaxLat) / (maxLat - minLat) * TEXTURE_SIZE;
        const dw = (vsMaxLng - vsMinLng) / (maxLng - minLng) * TEXTURE_SIZE;
        const dh = (vsMaxLat - vsMinLat) / (maxLat - minLat) * TEXTURE_SIZE;
        ctx.drawImage(vsCanvas, dx, dy, dw, dh);
      }

      // Apply combined texture (tiles + optional viewshed)
      if (succeeded === 0 && !(vsVisible && vsRaster)) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = meshRef.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.dispose();
      mat.map = tex;
      mat.needsUpdate = true;
    };

    for (let ty = minTile.y; ty <= maxTile.y; ty++) {
      for (let tx = minTile.x; tx <= maxTile.x; tx++) {
        let tileUrl = activeMap.url
          .replace('{z}', String(zoom))
          .replace('{x}', String(tx))
          .replace('{y}', String(ty))
          .replace('{s}', 'a');
        if (mapToken.trim()) {
          const sep = tileUrl.includes('?') ? '&' : '?';
          tileUrl = `${tileUrl}${sep}token=${mapToken}`;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const [minLng, minLat, maxLng, maxLat] = bounds;
          const tileLngMin = tileToLng(tx, zoom);
          const tileLngMax = tileToLng(tx + 1, zoom);
          const tileLatMax = tileToLat(ty, zoom);       // north edge (ty increases southward)
          const tileLatMin = tileToLat(ty + 1, zoom);   // south edge
          const px = (tileLngMin - minLng) / (maxLng - minLng) * TEXTURE_SIZE;
          const py = (maxLat - tileLatMax) / (maxLat - minLat) * TEXTURE_SIZE;
          const pw = (tileLngMax - tileLngMin) / (maxLng - minLng) * TEXTURE_SIZE;
          const ph = (tileLatMax - tileLatMin) / (maxLat - minLat) * TEXTURE_SIZE;
          ctx.drawImage(img, px, py, pw, ph);
          loaded++;
          succeeded++;
          if (loaded === total) applyTexture();
        };
        img.onerror = () => {
          loaded++;
          if (loaded === total) applyTexture();
        };
        img.src = tileUrl;
      }
    }
  }, [baseMaps, activeBaseMapId, mapToken]);

  // ── Rebuild texture on basemap change ─────────────────────────────

  useEffect(() => {
    if (terrainMetrics && terrainMeshRef.current) {
      loadMapTileTexture(terrainMetrics.bounds);
    }
  }, [activeBaseMapId, loadMapTileTexture, terrainMetrics]);

  // ── Render flight routes ──────────────────────────────────────────

  useEffect(() => {
    if (!sceneRef.current || !terrainMetrics) return;
    const m = terrainMetrics;

    // Remove old routes
    if (routeGroupRef.current) {
      sceneRef.current.remove(routeGroupRef.current);
      routeGroupRef.current.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        } else if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }
    const group = new THREE.Group();
    routeGroupRef.current = group;

    for (const route of routes) {
      if (!route.visible || route.points.length < 2) continue;

      const isActive = route.id === activeRouteId;
      const color = route.color || '#ff0000';

      // Active route: render dense 3D polyline from elevation profile (accurate flight altitude)
      if (isActive && elevationProfile.length >= 2) {
        const profilePoints = elevationProfile.filter(ep => ep.plannedAltitude != null);
        if (profilePoints.length >= 2) {
          const positions: number[] = [];
          for (const ep of profilePoints) {
            const local = geoToLocal(ep.longitude, ep.latitude, m.bounds, m.widthMeters, m.heightMeters);
            const z = (ep.plannedAltitude! * VERTICAL_EXAGGERATION) + ROUTE_OFFSET_ABOVE_TERRAIN;
            positions.push(local.x, local.y, z);
          }
          const lineGeom = new THREE.BufferGeometry();
          lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          const lineMat = new THREE.LineBasicMaterial({ color });
          group.add(new THREE.Line(lineGeom, lineMat));

          // Waypoint markers at actual waypoint positions
          for (const pt of route.points) {
            const local = geoToLocal(pt.lng, pt.lat, m.bounds, m.widthMeters, m.heightMeters);
            const z = ((pt.height ?? m.minElev) * VERTICAL_EXAGGERATION) + ROUTE_OFFSET_ABOVE_TERRAIN;
            const sphere = new THREE.Mesh(
              new THREE.SphereGeometry(m.widthMeters * 0.005, 8, 8),
              new THREE.MeshStandardMaterial({ color })
            );
            sphere.position.set(local.x, local.y, z);
            group.add(sphere);
          }
          continue; // skip fallback waypoint-based rendering
        }
      }

      // Fallback: render from waypoint heights (non-active routes or no profile)
      const positions: number[] = [];
      for (const pt of route.points) {
        const local = geoToLocal(pt.lng, pt.lat, m.bounds, m.widthMeters, m.heightMeters);
        const z = ((pt.height ?? m.minElev) * VERTICAL_EXAGGERATION) + ROUTE_OFFSET_ABOVE_TERRAIN;
        positions.push(local.x, local.y, z);
      }
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const lineMat = new THREE.LineBasicMaterial({ color });
      group.add(new THREE.Line(lineGeom, lineMat));
    }
    sceneRef.current.add(group);
  }, [routes, activeRouteId, elevationProfile, terrainMetrics]);

  // ── Recomposite terrain texture when viewshed state changes ──────

  useEffect(() => {
    if (terrainMetrics && terrainMeshRef.current) {
      loadMapTileTexture(terrainMetrics.bounds);
    }
  }, [viewshedRaster, viewshedVisible, viewshedClassColors, viewshedOpacity, loadMapTileTexture, terrainMetrics]);

  // ── Initialize Three.js scene ─────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb); // sky blue
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(
      50,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      1,
      500000
    );
    camera.position.set(0, -5000, 5000);
    camera.up.set(0, 0, 1); // Z is up in our coordinate system
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.maxPolarAngle = Math.PI * 0.48; // prevent going below terrain
    controls.minDistance = 50;
    controls.maxDistance = 100000;
    controlsRef.current = controls;

    // Lighting
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(1, -0.5, 2);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0x404040, 1.0));
    scene.add(new THREE.HemisphereLight(0x87ceeb, 0x8b6914, 0.4));

    // Animation loop
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Handle resize — use entry.contentRect for accurate dimensions at callback time
    const handleResize = (entries: ResizeObserverEntry[]) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false); // false = don't touch canvas CSS, we handle it in CSS
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);

    // Build terrain now if data available
    // (buildTerrain will be called from its own effect)

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animFrameRef.current);
      controls.dispose();

      // Dispose everything in scene
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        } else if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });

      renderer.dispose();
      if (containerRef.current && renderer.domElement.parentNode === containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }

      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      rendererRef.current = null;
      terrainMeshRef.current = null;
      routeGroupRef.current = null;
      elevDataRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build terrain when rasterData changes (after scene is initialized)
  useEffect(() => {
    if (sceneRef.current && rasterData) {
      buildTerrain();
    }
  }, [rasterData, buildTerrain]);

  // Compute next basemap for the toggle button (cycle through available basemaps)
  const currentBaseIndex = baseMaps.findIndex(b => b.id === activeBaseMapId);
  const nextBaseMap = baseMaps.length > 1
    ? baseMaps[(Math.max(currentBaseIndex, 0) + 1) % baseMaps.length]
    : null;
  const nextBaseMapPreviewUrl = nextBaseMap
    ? (() => {
        let url = nextBaseMap.url
          .replace('{z}', '1')
          .replace('{x}', '1')
          .replace('{y}', '0')
          .replace('{s}', 'a');
        if (mapToken.trim()) {
          const sep = url.includes('?') ? '&' : '?';
          url = `${url}${sep}token=${mapToken}`;
        }
        return url;
      })()
    : null;

  return (
    <div className="three-d-view-container" ref={containerRef}>
      <div className="three-d-view-banner">
        תצוגה בלבד — לעריכה חזור ל-2D
      </div>
      {nextBaseMap && nextBaseMapPreviewUrl && (
        <button
          type="button"
          className="basemap-toggle three-d-basemap-toggle"
          onClick={onBaseMapCycle}
          title={`החלף ל‑${nextBaseMap.name}`}
        >
          <div
            className="basemap-preview"
            style={{ backgroundImage: `url(${nextBaseMapPreviewUrl})` }}
          />
        </button>
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
    </div>
  );
};

export default ThreeDView;
