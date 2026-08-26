import { render, screen, fireEvent } from '@testing-library/react';
import ThreeDView, { ThreeDViewProps } from './ThreeDView';

// ── Mocks ──────────────────────────────────────────────────────────────

// Three.js uses WebGL which jsdom doesn't support — stub every constructor/method.
vi.mock('three', () => {
  const makeObj = () => ({
    position: { set: vi.fn() },
    up: { set: vi.fn() },
    add: vi.fn(),
    traverse: vi.fn(),
    dispose: vi.fn(),
    target: { set: vi.fn() },
    background: null,
    aspect: 1,
    far: 1000,
    updateProjectionMatrix: vi.fn(),
  });

  return {
    Scene: vi.fn(makeObj),
    Color: vi.fn(() => ({})),
    PerspectiveCamera: vi.fn(makeObj),
    WebGLRenderer: vi.fn(() => ({
      ...makeObj(),
      domElement: document.createElement('canvas'),
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    })),
    DirectionalLight: vi.fn(makeObj),
    AmbientLight: vi.fn(makeObj),
    HemisphereLight: vi.fn(makeObj),
    Mesh: vi.fn(makeObj),
    Line: vi.fn(makeObj),
    Group: vi.fn(makeObj),
    PlaneGeometry: vi.fn(() => ({
      attributes: { position: { setZ: vi.fn() } },
      computeVertexNormals: vi.fn(),
      dispose: vi.fn(),
    })),
    MeshStandardMaterial: vi.fn(() => ({ dispose: vi.fn(), map: null })),
    LineBasicMaterial: vi.fn(() => ({ dispose: vi.fn() })),
    CanvasTexture: vi.fn(() => ({ dispose: vi.fn(), needsUpdate: false })),
    BufferGeometry: vi.fn(() => ({ setAttribute: vi.fn(), dispose: vi.fn() })),
    BufferAttribute: vi.fn(),
    DoubleSide: 'DoubleSide',
  };
});

vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: vi.fn(() => ({
    enableDamping: false,
    dampingFactor: 0,
    maxPolarAngle: 0,
    minDistance: 0,
    maxDistance: 0,
    target: { set: vi.fn() },
    update: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../utils/threeDHelpers', () => ({
  boundsToMetric: vi.fn(() => ({ widthMeters: 1000, heightMeters: 800 })),
  downsampleRaster: vi.fn(() => new Float32Array([100, 110, 105, 115])),
  geoToLocal: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
  elevationToColor: vi.fn(() => ({ r: 128, g: 128, b: 128 })),
  computeTileRange: vi.fn(() => ({
    zoom: 10,
    minTile: { x: 0, y: 0 },
    maxTile: { x: 1, y: 1 },
    cols: 2,
    rows: 2,
  })),
  tileToLng: vi.fn(() => 35.0),
  tileToLat: vi.fn(() => 31.5),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const twoBaseMaps = [
  { id: 'streets', name: 'Streets', url: 'https://tiles.example.com/{z}/{x}/{y}.png' },
  { id: 'satellite', name: 'Satellite', url: 'https://sat.example.com/{z}/{x}/{y}.png' },
];

const sampleViewshedRaster = {
  width: 4,
  height: 4,
  data: new Float32Array(16).fill(1),
  bounds: [35.0, 31.5, 35.1, 31.6],
  min: 0,
  max: 4,
  noDataValue: -9999,
  isProjected: false,
  crs: 'EPSG:4326',
};

const defaultProps: ThreeDViewProps = {
  rasterData: null,
  baseMaps: [],
  activeBaseMapId: null,
  routes: [],
  activeRouteId: '',
  elevationProfile: [],
  onBaseMapCycle: vi.fn(),
  viewshedRaster: null,
  viewshedVisible: false,
  viewshedColormap: 'default',
  viewshedOpacity: 1,
  viewshedClassColors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'],
  getViewshedClassColor: vi.fn(() => null),
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('ThreeDView', () => {
  describe('container and banner', () => {
    it('renders the three-d-view-container element', () => {
      const { container } = render(<ThreeDView {...defaultProps} />);
      expect(container.querySelector('.three-d-view-container')).not.toBeNull();
    });

    it('always shows the read-only banner text', () => {
      render(<ThreeDView {...defaultProps} />);
      expect(screen.getByText('תצוגה בלבד — לעריכה חזור ל-2D')).toBeInTheDocument();
    });

    it('renders without throwing even when rasterData is null', () => {
      expect(() => render(<ThreeDView {...defaultProps} rasterData={null} />)).not.toThrow();
    });
  });

  describe('basemap toggle button', () => {
    it('does not show the toggle when baseMaps is empty', () => {
      const { container } = render(<ThreeDView {...defaultProps} baseMaps={[]} />);
      expect(container.querySelector('.three-d-basemap-toggle')).toBeNull();
    });

    it('does not show the toggle when only one basemap is available', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} baseMaps={[twoBaseMaps[0]]} activeBaseMapId="streets" />
      );
      expect(container.querySelector('.three-d-basemap-toggle')).toBeNull();
    });

    it('shows the toggle when two or more basemaps are available', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} baseMaps={twoBaseMaps} activeBaseMapId="streets" />
      );
      expect(container.querySelector('.three-d-basemap-toggle')).not.toBeNull();
    });

    it('toggle button title mentions the next basemap name', () => {
      render(
        <ThreeDView {...defaultProps} baseMaps={twoBaseMaps} activeBaseMapId="streets" />
      );
      // Active is "streets" (index 0), so next is "satellite" (index 1)
      expect(screen.getByTitle(/Satellite/)).toBeInTheDocument();
    });

    it('calls onBaseMapCycle when the basemap toggle button is clicked', () => {
      const onCycle = vi.fn();
      const { container } = render(
        <ThreeDView {...defaultProps} baseMaps={twoBaseMaps} activeBaseMapId="streets" onBaseMapCycle={onCycle} />
      );
      fireEvent.click(container.querySelector('.three-d-basemap-toggle')!);
      expect(onCycle).toHaveBeenCalledTimes(1);
    });

    it('wraps around to first basemap when last one is active', () => {
      render(
        <ThreeDView {...defaultProps} baseMaps={twoBaseMaps} activeBaseMapId="satellite" />
      );
      // Active is "satellite" (last), so next wraps to "streets" (first)
      expect(screen.getByTitle(/Streets/)).toBeInTheDocument();
    });
  });

  describe('north button', () => {
    it('renders the return to north button with compass icon', () => {
      const { container } = render(<ThreeDView {...defaultProps} />);
      const btn = container.querySelector('.three-d-north-btn');
      expect(btn).not.toBeNull();
      expect(screen.getByTitle('החזר למצב ההתחלתי')).toBeInTheDocument();
    });

    it('clicking the north button does not throw error', () => {
      const { container } = render(<ThreeDView {...defaultProps} />);
      const btn = container.querySelector('.three-d-north-btn');
      expect(() => fireEvent.click(btn!)).not.toThrow();
    });
  });

  describe('viewshed legend', () => {
    it('does not show the legend when viewshedRaster is null', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} viewshedRaster={null} viewshedVisible={true} />
      );
      expect(container.querySelector('.viewshed-legend')).toBeNull();
    });

    it('does not show the legend when viewshedVisible is false even if raster is present', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={false} />
      );
      expect(container.querySelector('.viewshed-legend')).toBeNull();
    });

    it('shows the legend when viewshedRaster is present and viewshedVisible is true', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={true} />
      );
      expect(container.querySelector('.viewshed-legend')).not.toBeNull();
    });

    it('shows the legend title שדה ראייה', () => {
      render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={true} />
      );
      expect(screen.getByText('שדה ראייה')).toBeInTheDocument();
    });

    it('renders exactly 4 class swatches in the legend', () => {
      const { container } = render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={true} />
      );
      expect(container.querySelectorAll('.viewshed-legend-class')).toHaveLength(4);
    });

    it('applies viewshedClassColors to the legend swatches', () => {
      const colors: [string, string, string, string] = ['#aa0000', '#00aa00', '#0000aa', '#aaaa00'];
      const { container } = render(
        <ThreeDView
          {...defaultProps}
          viewshedRaster={sampleViewshedRaster}
          viewshedVisible={true}
          viewshedClassColors={colors}
        />
      );
      const swatches = container.querySelectorAll<HTMLElement>('.viewshed-legend-swatch');
      // jsdom converts hex to rgb()
      expect(swatches[0].style.backgroundColor).toBe('rgb(170, 0, 0)');
      expect(swatches[1].style.backgroundColor).toBe('rgb(0, 170, 0)');
    });

    it('shows "4+" label for the 4th class swatch', () => {
      render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={true} />
      );
      expect(screen.getByText('4+')).toBeInTheDocument();
    });

    it('shows numeric labels 1, 2, 3 for the first three class swatches', () => {
      render(
        <ThreeDView {...defaultProps} viewshedRaster={sampleViewshedRaster} viewshedVisible={true} />
      );
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });
});
