import React, { useMemo } from 'react';
import { ClimbConfig } from '../utils/climb';
import {
  getNearestConstraints,
  getAllConstraintsForVisualization,
  NearestConstraintsResult,
  Constraint
} from '../utils/constraints';

interface ClimbConstraints1DGraphProps {
  /** Distance of the selected climb point along the route (s0) */
  selectedDistance: number;
  /** Total length of the route in meters */
  totalRouteLength: number;
  /** Precomputed cumulative distances at each vertex */
  vertexDistances: number[];
  /** Existing climb requests (excluding the current point being edited) */
  climbRequests: { endDistance: number; climbAmount: number }[];
  /** Current climb configuration */
  config: ClimbConfig;
  /** Width of the graph in pixels */
  width?: number;
  /** Height of the graph in pixels */
  height?: number;
}

interface ConstraintVisualization {
  constraint: Constraint;
  relativeDistance: number; // Relative to s0 (negative = left, positive = right)
  pixelX: number;
  isLimiting: boolean;
  label: string;
}

const ClimbConstraints1DGraph: React.FC<ClimbConstraints1DGraphProps> = ({
  selectedDistance,
  totalRouteLength,
  vertexDistances,
  climbRequests,
  config,
  width = 380,
  height = 120
}) => {
  const s0 = selectedDistance;
  
  // Compute nearest constraints and limits
  const constraintResult: NearestConstraintsResult = useMemo(() => {
    return getNearestConstraints(
      s0,
      config,
      vertexDistances,
      climbRequests,
      totalRouteLength
    );
  }, [s0, config, vertexDistances, climbRequests, totalRouteLength]);

  // Get all constraints for visualization (including non-limiting turns if allowTurnsDuringClimb)
  const allConstraints = useMemo(() => {
    return getAllConstraintsForVisualization(
      s0,
      vertexDistances,
      climbRequests,
      config
    );
  }, [s0, vertexDistances, climbRequests, config]);

  // Compute graph bounds and scale
  const graphData = useMemo(() => {
    const { dL, dR, maxDeltaZ, left, right } = constraintResult;
    
    // Determine the view range (how much distance to show on each side)
    // Show at least 50m on each side, or extend to the nearest constraint + 20%
    const minViewRange = 50;
    const leftViewRange = Math.max(minViewRange, dL * 1.2);
    const rightViewRange = Math.max(minViewRange, dR * 1.2);
    
    // Padding for the SVG
    const padding = { left: 40, right: 20, top: 25, bottom: 40 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Center the s0 point
    const totalRange = leftViewRange + rightViewRange;
    const pixelsPerMeter = chartWidth / totalRange;
    const centerX = padding.left + (leftViewRange / totalRange) * chartWidth;
    
    // Convert distance relative to s0 to pixel X coordinate
    const distanceToPixelX = (relDist: number) => {
      return centerX + relDist * pixelsPerMeter;
    };
    
    // Build visualization data for constraints
    const constraintVis: ConstraintVisualization[] = [];
    
    // Add turns (potentially non-limiting if allowTurnsDuringClimb is true)
    const isLimitingTurn = !config.allowTurnsDuringClimb;
    
    if (allConstraints.nearestLeftTurn) {
      const relDist = allConstraints.nearestLeftTurn.distance - s0;
      constraintVis.push({
        constraint: allConstraints.nearestLeftTurn,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(relDist),
        isLimiting: isLimitingTurn,
        label: `Turn (${Math.abs(relDist).toFixed(0)}m)`
      });
    }
    
    if (allConstraints.nearestRightTurn) {
      const relDist = allConstraints.nearestRightTurn.distance - s0;
      constraintVis.push({
        constraint: allConstraints.nearestRightTurn,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(relDist),
        isLimiting: isLimitingTurn,
        label: `Turn (${Math.abs(relDist).toFixed(0)}m)`
      });
    }
    
    // Add climb points (always limiting)
    if (allConstraints.nearestLeftClimbPoint) {
      const relDist = allConstraints.nearestLeftClimbPoint.distance - s0;
      constraintVis.push({
        constraint: allConstraints.nearestLeftClimbPoint,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(relDist),
        isLimiting: true,
        label: `Climb (${Math.abs(relDist).toFixed(0)}m)`
      });
    }
    
    if (allConstraints.nearestRightClimbPoint) {
      const relDist = allConstraints.nearestRightClimbPoint.distance - s0;
      constraintVis.push({
        constraint: allConstraints.nearestRightClimbPoint,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(relDist),
        isLimiting: true,
        label: `Climb (${Math.abs(relDist).toFixed(0)}m)`
      });
    }
    
    // Calculate exclusion zone extents (regions where climb is limited)
    // The exclusion zone extends from each limiting constraint toward s0
    const exclusionZones: { x1: number; x2: number; side: 'left' | 'right' }[] = [];
    
    if (left && (left.type === 'climbPoint' || !config.allowTurnsDuringClimb)) {
      // Left exclusion zone: from left constraint to s0
      exclusionZones.push({
        x1: distanceToPixelX(left.distance - s0),
        x2: centerX,
        side: 'left'
      });
    }
    
    if (right && (right.type === 'climbPoint' || !config.allowTurnsDuringClimb)) {
      // Right exclusion zone: from s0 to right constraint
      exclusionZones.push({
        x1: centerX,
        x2: distanceToPixelX(right.distance - s0),
        side: 'right'
      });
    }
    
    // Generate axis tick marks
    const axisY = padding.top + chartHeight;
    const tickInterval = getTickInterval(totalRange);
    const ticks: { x: number; label: string }[] = [];
    
    // Generate ticks from negative to positive
    for (let d = -Math.ceil(leftViewRange / tickInterval) * tickInterval; d <= rightViewRange; d += tickInterval) {
      if (Math.abs(d) < tickInterval * 0.1) continue; // Skip near-zero (will show 0 separately)
      const x = distanceToPixelX(d);
      if (x >= padding.left && x <= width - padding.right) {
        const label = d >= 0 ? `+${d.toFixed(0)}m` : `${d.toFixed(0)}m`;
        ticks.push({ x, label });
      }
    }
    
    // Always add 0 (s0)
    ticks.push({ x: centerX, label: '0' });
    
    return {
      padding,
      chartWidth,
      chartHeight,
      centerX,
      axisY,
      pixelsPerMeter,
      constraintVis,
      exclusionZones,
      ticks,
      maxDeltaZ,
      dL,
      dR,
      leftViewRange,
      rightViewRange
    };
  }, [constraintResult, allConstraints, s0, config, width, height]);

  // Helper to get appropriate tick interval based on range
  function getTickInterval(range: number): number {
    if (range <= 100) return 20;
    if (range <= 250) return 50;
    if (range <= 500) return 100;
    if (range <= 1000) return 200;
    return 500;
  }

  const { padding, chartHeight, centerX, axisY, constraintVis, exclusionZones, ticks, maxDeltaZ, dL, dR } = graphData;

  // Format max climb/descent values
  const maxClimbUp = maxDeltaZ;
  const maxDescend = maxDeltaZ; // Symmetric for now (could use different ratios)

  return (
    <div className="climb-constraints-graph">
      <div className="climb-constraints-title">אילוצי עלייה (1D)</div>
      
      <svg width={width} height={height} className="climb-constraints-svg">
        {/* Background */}
        <rect x={0} y={0} width={width} height={height} fill="#fafafa" rx={4} />
        
        {/* Exclusion zones (shaded regions) */}
        {exclusionZones.map((zone, idx) => (
          <rect
            key={`zone-${idx}`}
            x={Math.min(zone.x1, zone.x2)}
            y={padding.top}
            width={Math.abs(zone.x2 - zone.x1)}
            height={chartHeight}
            fill={zone.side === 'left' ? '#fee2e2' : '#fef3c7'}
            opacity={0.7}
          />
        ))}
        
        {/* Hatched pattern for exclusion zones */}
        <defs>
          <pattern id="hatch-left" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#dc2626" strokeWidth="1" opacity="0.3" />
          </pattern>
          <pattern id="hatch-right" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#d97706" strokeWidth="1" opacity="0.3" />
          </pattern>
        </defs>
        
        {exclusionZones.map((zone, idx) => (
          <rect
            key={`hatch-${idx}`}
            x={Math.min(zone.x1, zone.x2)}
            y={padding.top}
            width={Math.abs(zone.x2 - zone.x1)}
            height={chartHeight}
            fill={zone.side === 'left' ? 'url(#hatch-left)' : 'url(#hatch-right)'}
          />
        ))}
        
        {/* Main axis line */}
        <line
          x1={padding.left}
          y1={axisY - chartHeight / 2}
          x2={width - padding.right}
          y2={axisY - chartHeight / 2}
          stroke="#64748b"
          strokeWidth={2}
        />
        
        {/* Tick marks and labels */}
        {ticks.map((tick, idx) => (
          <g key={`tick-${idx}`}>
            <line
              x1={tick.x}
              y1={axisY - chartHeight / 2 - 4}
              x2={tick.x}
              y2={axisY - chartHeight / 2 + 4}
              stroke="#64748b"
              strokeWidth={1}
            />
            <text
              x={tick.x}
              y={axisY + 2}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
            >
              {tick.label}
            </text>
          </g>
        ))}
        
        {/* Center point (s0) marker */}
        <circle
          cx={centerX}
          cy={axisY - chartHeight / 2}
          r={6}
          fill="#6f42c1"
          stroke="#fff"
          strokeWidth={2}
        />
        <text
          x={centerX}
          y={padding.top - 6}
          textAnchor="middle"
          fontSize="11"
          fontWeight="bold"
          fill="#6f42c1"
        >
          נקודה נבחרת
        </text>
        
        {/* Constraint markers */}
        {constraintVis.map((cv, idx) => {
          const isTurn = cv.constraint.type === 'turn';
          const markerY = axisY - chartHeight / 2;
          const fillColor = isTurn
            ? (cv.isLimiting ? '#dc2626' : '#9ca3af')
            : '#d97706';
          const labelY = cv.relativeDistance < 0 ? markerY - 18 : markerY - 18;
          
          return (
            <g key={`constraint-${idx}`}>
              {/* Vertical line from axis */}
              <line
                x1={cv.pixelX}
                y1={markerY - 12}
                x2={cv.pixelX}
                y2={markerY + 12}
                stroke={fillColor}
                strokeWidth={2}
                strokeDasharray={cv.isLimiting ? '0' : '4,2'}
              />
              
              {/* Marker shape: triangle for turns, diamond for climb points */}
              {isTurn ? (
                <polygon
                  points={`${cv.pixelX},${markerY - 10} ${cv.pixelX - 6},${markerY} ${cv.pixelX},${markerY + 10} ${cv.pixelX + 6},${markerY}`}
                  fill={fillColor}
                  stroke="#fff"
                  strokeWidth={1}
                />
              ) : (
                <rect
                  x={cv.pixelX - 5}
                  y={markerY - 5}
                  width={10}
                  height={10}
                  fill={fillColor}
                  stroke="#fff"
                  strokeWidth={1}
                  transform={`rotate(45, ${cv.pixelX}, ${markerY})`}
                />
              )}
              
              {/* Label */}
              <text
                x={cv.pixelX}
                y={labelY}
                textAnchor="middle"
                fontSize="9"
                fill={fillColor}
                fontWeight={cv.isLimiting ? 'bold' : 'normal'}
              >
                {isTurn ? 'פנייה' : 'עלייה'}
              </text>
              
              {/* Distance label below */}
              <text
                x={cv.pixelX}
                y={axisY + 14}
                textAnchor="middle"
                fontSize="9"
                fill="#64748b"
              >
                {cv.relativeDistance >= 0 ? '+' : ''}{cv.relativeDistance.toFixed(0)}מ'
              </text>
            </g>
          );
        })}
        
        {/* Legend */}
        <g transform={`translate(${padding.left}, ${height - 14})`}>
          {/* Turn legend */}
          <polygon
            points="0,-4 4,0 0,4 -4,0"
            fill={config.allowTurnsDuringClimb ? '#9ca3af' : '#dc2626'}
          />
          <text x={8} y={3} fontSize="9" fill="#64748b">
            {config.allowTurnsDuringClimb ? 'פנייה (מידע)' : 'פנייה (מגביל)'}
          </text>
          
          {/* Climb point legend */}
          <rect
            x={85}
            y={-4}
            width={6}
            height={6}
            fill="#d97706"
            transform="rotate(45, 88, -1)"
          />
          <text x={98} y={3} fontSize="9" fill="#64748b">
            נק' עלייה (מגביל)
          </text>
        </g>
      </svg>
      
      {/* Computed values */}
      <div className="climb-constraints-values">
        <div className="climb-value">
          <span className="climb-value-label">עלייה מקס':</span>
          <span className="climb-value-number positive">+{maxClimbUp.toFixed(1)} מ'</span>
        </div>
        <div className="climb-value">
          <span className="climb-value-label">ירידה מקס':</span>
          <span className="climb-value-number negative">-{maxDescend.toFixed(1)} מ'</span>
        </div>
      </div>
      
      {/* Limiting reasons */}
      <div className="climb-constraints-reasons">
        {constraintResult.limitingReasons.map((reason, idx) => (
          <div key={idx} className="climb-reason">
            {reason}
          </div>
        ))}
        {constraintResult.left === null && constraintResult.right === null && (
          <div className="climb-reason info">
            אין אילוצים מגבילים. המגבלה היא גבול המסלול.
          </div>
        )}
      </div>
      
      {/* Available distances */}
      <div className="climb-distances">
        <span>מרחק שמאלה: {dL === Infinity ? '∞' : dL.toFixed(1)}מ'</span>
        <span>מרחק ימינה: {dR === Infinity ? '∞' : dR.toFixed(1)}מ'</span>
      </div>
    </div>
  );
};

export default ClimbConstraints1DGraph;

