import React from 'react';
import { ElevationPoint } from '../App';
import { UTMCoordinate } from '../utils/coordinates';

interface CoordinateTooltipProps {
  point: ElevationPoint;
  utm: UTMCoordinate | null;
}

const CoordinateTooltip: React.FC<CoordinateTooltipProps> = ({ point, utm }) => {
  return (
    <>
      {utm ? (
        <>
          <div className="tooltip-section">
            <span className="tooltip-label">אזור UTM:</span> {utm.zone}{utm.hemisphere}
          </div>
          <div className="tooltip-section">
            <span className="tooltip-label">Northing:</span> {utm.northing.toFixed(1)} מ'
          </div>
          <div className="tooltip-section">
            <span className="tooltip-label">Easting:</span> {utm.easting.toFixed(1)} מ'
          </div>
        </>
      ) : (
        <>
          <div className="tooltip-section">
            <span className="tooltip-label">קו רוחב:</span> {point.latitude.toFixed(6)}
          </div>
          <div className="tooltip-section">
            <span className="tooltip-label">קו אורך:</span> {point.longitude.toFixed(6)}
          </div>
        </>
      )}
      <div className="tooltip-divider" />
      <div className="tooltip-section">
        <span className="tooltip-label">גובה מהקרקע:</span> {point.flightHeight?.toFixed(1)} מ'
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
    </>
  );
};

export default CoordinateTooltip;

