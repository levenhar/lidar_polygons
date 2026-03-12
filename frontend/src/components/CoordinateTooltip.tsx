import React from 'react';
import { ElevationPoint } from '../App';

interface CoordinateTooltipProps {
  point: ElevationPoint;
}

const CoordinateTooltip: React.FC<CoordinateTooltipProps> = ({ point }) => {
  return (
    <>
      <div className="tooltip-section">
        <span className="tooltip-label">גובה מפני הים:</span> {(point.elevation + (point.flightHeight ?? 0)).toFixed(1)} מ'
      </div>
      {point.minElevation !== undefined && (
        <div className="tooltip-section">
          <span className="tooltip-label">גובה ממינימום:</span> {((point.elevation + (point.flightHeight || 0)) - point.minElevation).toFixed(1)} מ'
        </div>
      )}
      {point.maxElevation !== undefined && (
        <div className="tooltip-section">
          <span className="tooltip-label">גובה ממקסימום:</span> {((point.elevation + (point.flightHeight || 0)) - point.maxElevation).toFixed(1)} מ'
        </div>
      )}
      {point.minElevation !== undefined && (
        <div className="tooltip-section">
          <span className="tooltip-label">נקודת קרקע נמוכה:</span> {point.minElevation.toFixed(1)} מ'
        </div>
      )}
      {point.maxElevation !== undefined && (
        <div className="tooltip-section">
          <span className="tooltip-label">נקודת קרקע גבוהה:</span> {point.maxElevation.toFixed(1)} מ'
        </div>
      )}
    </>
  );
};

export default CoordinateTooltip;

