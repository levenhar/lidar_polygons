import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import InfoModeTooltip from './InfoModeTooltip';

const mousePos = { x: 200, y: 300 };
const cursorElevation = { elevation: 123.456, lat: 31.5, lng: 35.0 };

describe('InfoModeTooltip', () => {
  describe('visibility', () => {
    it('renders nothing when isInfoMode is false', () => {
      const { container } = render(
        <InfoModeTooltip
          isInfoMode={false}
          mousePos={mousePos}
          cursorElevation={cursorElevation}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when mousePos is null', () => {
      const { container } = render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={null}
          cursorElevation={cursorElevation}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when cursorElevation is null', () => {
      const { container } = render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={null}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders tooltip when isInfoMode is true and all data present', () => {
      render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={cursorElevation}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(screen.getByText(/גובה מפני הים/)).toBeInTheDocument();
    });
  });

  describe('elevation display', () => {
    it('shows elevation formatted to 1 decimal place', () => {
      render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={{ elevation: 123.456, lat: 31.5, lng: 35.0 }}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(screen.getByText(/123\.5/)).toBeInTheDocument();
    });

    it('shows em dash when elevation is null', () => {
      render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={{ elevation: null, lat: 31.5, lng: 35.0 }}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows zero elevation correctly', () => {
      render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={{ elevation: 0, lat: 31.5, lng: 35.0 }}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      expect(screen.getByText(/0\.0/)).toBeInTheDocument();
    });
  });

  describe('positioning', () => {
    it('uses mouse position offset as fallback when tooltipPosition is null', () => {
      const { container } = render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={{ x: 200, y: 300 }}
          cursorElevation={cursorElevation}
          tooltipRef={createRef()}
          tooltipPosition={null}
        />
      );
      const tooltip = container.firstChild as HTMLElement;
      expect(tooltip.style.left).toBe('215px');
      expect(tooltip.style.top).toBe('315px');
    });

    it('uses computed tooltipPosition when provided', () => {
      const { container } = render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={cursorElevation}
          tooltipRef={createRef()}
          tooltipPosition={{ left: 50, top: 80 }}
        />
      );
      const tooltip = container.firstChild as HTMLElement;
      expect(tooltip.style.left).toBe('50px');
      expect(tooltip.style.top).toBe('80px');
    });

    it('uses a separate ref from other tooltips', () => {
      const infoRef = createRef<HTMLDivElement>();
      const otherRef = createRef<HTMLDivElement>();
      render(
        <InfoModeTooltip
          isInfoMode={true}
          mousePos={mousePos}
          cursorElevation={cursorElevation}
          tooltipRef={infoRef}
          tooltipPosition={null}
        />
      );
      expect(infoRef.current).not.toBeNull();
      expect(otherRef.current).toBeNull();
    });
  });
});
