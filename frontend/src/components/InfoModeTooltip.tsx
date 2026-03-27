import React from 'react';

interface Props {
  isInfoMode: boolean;
  mousePos: { x: number; y: number } | null;
  cursorElevation: { elevation: number | null; lat: number; lng: number } | null;
  tooltipRef: React.RefObject<HTMLDivElement>;
  tooltipPosition: { left: number; top: number } | null;
}

export default function InfoModeTooltip({ isInfoMode, mousePos, cursorElevation, tooltipRef, tooltipPosition }: Props) {
  if (!isInfoMode || !mousePos || !cursorElevation) return null;
  return (
    <div
      ref={tooltipRef}
      className="hover-metadata-tooltip"
      style={{
        left: tooltipPosition?.left ?? mousePos.x + 15,
        top: tooltipPosition?.top ?? mousePos.y + 15,
        visibility: tooltipPosition ? 'visible' : 'visible',
        opacity: tooltipPosition ? 1 : 0,
        pointerEvents: tooltipPosition ? 'auto' : 'none',
      }}
    >
      <div className="tooltip-section">
        <span className="tooltip-label">גובה מפני הים:</span>{' '}
        {cursorElevation.elevation !== null ? `${cursorElevation.elevation.toFixed(1)} מ'` : '—'}
      </div>
    </div>
  );
}
