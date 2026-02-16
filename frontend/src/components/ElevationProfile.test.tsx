import React from 'react';
import { render } from '@testing-library/react';
import type { Coordinate, ElevationPoint } from '../App';
import type { ClimbRequest } from '../utils/climbAnchors';
import type { ClimbConfig, ClimbPreset } from '../utils/climb';
import ElevationProfile from './ElevationProfile';

vi.mock('d3', () => ({
  select: () => ({
    selectAll: () => ({ remove: () => {}, data: () => ({ enter: () => ({ append: () => ({ attr: () => ({ style: () => ({}) }) }) }) }) }),
    append: () => ({ attr: () => ({ style: () => ({}) }), call: () => {} }),
    attr: () => ({ style: () => ({}) }),
    style: () => ({}),
    on: () => ({}),
    remove: () => {}
  })
}));

const minimalClimbPresets: ClimbPreset[] = [{ id: 'custom', name: 'Custom', climbRatio: 4, descentRatio: 8 }];
const minimalClimbConfig: ClimbConfig = {
  climbRatio: 4,
  descentRatio: 8,
  allowTurnsDuringClimb: false,
  linkRatios: false,
  vertexProximityMeters: 30,
  minClimb: 11,
  maxClimb: 50
};

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
  it('renders without throwing with minimal props', () => {
    expect(() => render(<ElevationProfile {...defaultProps} />)).not.toThrow();
  });

  it('shows empty state or placeholder when no profile', () => {
    render(<ElevationProfile {...defaultProps} />);
    expect(document.body.textContent).toBeTruthy();
  });
});
