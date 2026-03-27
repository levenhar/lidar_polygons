import { render, screen } from '@testing-library/react';
import type { Coordinate, ElevationPoint } from '../App';
import type { ClimbRequest } from '../utils/climbAnchors';
import type { ClimbConfig, ClimbPreset } from '../utils/climb';
import ElevationProfile from './ElevationProfile';

// Comprehensive chainable D3 mock — every method returns a new chainable proxy,
// every function call returns itself, so arbitrary method chains don't throw.
vi.mock('d3', () => {
  function chain(): any {
    let proxy: any;
    const fn: any = function(..._args: any[]) { return proxy; };
    proxy = new Proxy(fn, {
      get(_target, prop) {
        if (prop === 'node') return () => null;
        return chain();
      }
    });
    return proxy;
  }

  return {
    select: chain(),
    scaleLinear: chain(),
    area: chain(),
    line: chain(),
    axisBottom: chain(),
    axisLeft: chain(),
    // extent must return a real array so .domain() receives the right shape
    extent: (_arr: any[], _fn?: any) => [0, 100],
    zoom: chain(),
    zoomTransform: () => ({ k: 1, x: 0, y: 0 }),
    zoomIdentity: { k: 1, x: 0, y: 0, translate: chain(), scale: chain() },
    curveMonotoneX: {},
    pointer: () => [0, 0],
    bisectLeft: () => 0,
    format: () => () => '',
  };
});

const minimalClimbConfig: ClimbConfig = {
  climbRatio: 4,
  descentRatio: 8,
  allowTurnsDuringClimb: false,
  linkRatios: false,
  vertexProximityMeters: 30,
  minClimb: 11,
  maxClimb: 50
};

const minimalClimbPresets: ClimbPreset[] = [{ id: 'custom', name: 'Custom', ...minimalClimbConfig }];

const sampleProfile: ElevationPoint[] = [
  { distance: 0, elevation: 100, longitude: 35.0, latitude: 31.5, plannedAltitude: 350 },
  { distance: 200, elevation: 110, longitude: 35.002, latitude: 31.502, plannedAltitude: 360 },
];

const defaultProps = {
  elevationProfile: [] as ElevationPoint[],
  loading: false,
  nominalFlightHeight: 250,
  safetyHeight: 140,
  safetyRadius: 50,
  resolutionHeight: 270,
  overlapPercentage: 50,
  selectedPoint: null as Coordinate | null,
  flightPath: [] as Coordinate[],
  onDeletePoint: vi.fn(),
  onUpdatePoint: vi.fn(),
  onSetFlightHeight: vi.fn(),
  onEditPointRequest: vi.fn(),
  climbPresets: minimalClimbPresets,
  selectedClimbPresetId: 'custom',
  climbConfig: minimalClimbConfig,
  climbRequests: [] as ClimbRequest[],
  setClimbRequests: vi.fn(),
  climbWarnings: [] as string[],
  showMetadata: true
};

describe('ElevationProfile', () => {
  describe('loading state', () => {
    it('shows loading spinner text when loading is true', () => {
      render(<ElevationProfile {...defaultProps} loading={true} />);
      expect(screen.getByText('מחשב פרופיל גובה...')).toBeInTheDocument();
    });

    it('does not show loading text when loading is false', () => {
      render(<ElevationProfile {...defaultProps} loading={false} />);
      expect(screen.queryByText('מחשב פרופיל גובה...')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows draw-route prompt when profile is empty and no error', () => {
      render(<ElevationProfile {...defaultProps} />);
      expect(screen.getByText(/שרטט מסלול טיסה על המפה/)).toBeInTheDocument();
    });

    it('does not show draw-route prompt when loading', () => {
      render(<ElevationProfile {...defaultProps} loading={true} />);
      expect(screen.queryByText(/שרטט מסלול טיסה על המפה/)).not.toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error title when profileError is set and profile is empty', () => {
      const errorMessage = 'Profile point missing elevation, minElevation, or maxElevation';
      render(<ElevationProfile {...defaultProps} profileError={errorMessage} />);
      expect(screen.getByText('שגיאה ביצירת פרופיל הגובה')).toBeInTheDocument();
    });

    it('shows error details text when profileError is set', () => {
      const errorMessage = 'DTM file not found';
      render(<ElevationProfile {...defaultProps} profileError={errorMessage} />);
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });

    it('marks the error container with role alert', () => {
      render(<ElevationProfile {...defaultProps} profileError="some error" />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('does not show error when profileError is set but profile has data', () => {
      render(<ElevationProfile {...defaultProps} elevationProfile={sampleProfile} profileError="some error" />);
      expect(screen.queryByText('שגיאה ביצירת פרופיל הגובה')).not.toBeInTheDocument();
    });
  });

  describe('with elevation data', () => {
    it('renders without throwing when elevation profile has data', () => {
      expect(() =>
        render(<ElevationProfile {...defaultProps} elevationProfile={sampleProfile} />)
      ).not.toThrow();
    });

    it('renders the SVG chart element when profile has data', () => {
      const { container } = render(
        <ElevationProfile {...defaultProps} elevationProfile={sampleProfile} />
      );
      expect(container.querySelector('svg.elevation-chart')).not.toBeNull();
    });

    it('shows active route name above chart when provided', () => {
      render(
        <ElevationProfile
          {...defaultProps}
          elevationProfile={sampleProfile}
          activeRouteName="Northern Route"
        />
      );
      expect(screen.getByText(/Northern Route/)).toBeInTheDocument();
    });

    it('does not show route name section when activeRouteName is not provided', () => {
      render(<ElevationProfile {...defaultProps} elevationProfile={sampleProfile} />);
      expect(screen.queryByText(/מסלול:/)).not.toBeInTheDocument();
    });
  });

  describe('climb warnings', () => {
    it('shows warning chips when climbWarnings are present', () => {
      render(
        <ElevationProfile
          {...defaultProps}
          climbWarnings={['Climb too steep', 'Insufficient distance']}
        />
      );
      expect(screen.getByText('Climb too steep')).toBeInTheDocument();
      expect(screen.getByText('Insufficient distance')).toBeInTheDocument();
    });

    it('shows no warning chips when climbWarnings is empty', () => {
      const { container } = render(<ElevationProfile {...defaultProps} climbWarnings={[]} />);
      expect(container.querySelectorAll('.climb-warning-chip')).toHaveLength(0);
    });

    it('renders one chip per warning', () => {
      const warnings = ['Warning A', 'Warning B', 'Warning C'];
      const { container } = render(
        <ElevationProfile {...defaultProps} climbWarnings={warnings} />
      );
      expect(container.querySelectorAll('.climb-warning-chip')).toHaveLength(3);
    });
  });
});
