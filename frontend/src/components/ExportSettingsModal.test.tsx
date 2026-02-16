import { render, screen, fireEvent } from '@testing-library/react';
import ExportSettingsModal from './ExportSettingsModal';
import { FlightRoute } from '../hooks/useFlightPath';

const mockRoutes: FlightRoute[] = [
  { id: 'r1', name: 'Route 1', color: '#f00', lineWidth: 3, visible: true, points: [{ lng: 34, lat: 31 }, { lng: 35, lat: 32 }], nominalFlightHeight: 250 },
  { id: 'r2', name: 'Route 2', color: '#0f0', lineWidth: 3, visible: true, points: [{ lng: 34, lat: 31 }, { lng: 35, lat: 31 }], nominalFlightHeight: 250 }
];

describe('ExportSettingsModal', () => {
  it('returns null when not open', () => {
    const { container } = render(
      <ExportSettingsModal
        isOpen={false}
        routes={mockRoutes}
        activeRouteId="r1"
        onClose={() => {}}
        onExport={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when open and calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <ExportSettingsModal
        isOpen={true}
        routes={mockRoutes}
        activeRouteId="r1"
        onClose={onClose}
        onExport={() => {}}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onExport with selected route ids when export clicked', () => {
    const onExport = vi.fn();
    render(
      <ExportSettingsModal
        isOpen={true}
        routes={mockRoutes}
        activeRouteId="r1"
        onClose={() => {}}
        onExport={onExport}
      />
    );
    const exportButton = screen.getByRole('button', { name: /ייצא/ });
    fireEvent.click(exportButton);
    expect(onExport).toHaveBeenCalled();
    expect(Array.isArray(onExport.mock.calls[0][0])).toBe(true);
  });
});
