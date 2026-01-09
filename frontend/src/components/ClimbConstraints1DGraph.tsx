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
    const { dL, dR, left, right } = constraintResult;
    
    // Determine the view range (how much distance to show on each side of s0)
    // Show at least 50m on each side, or extend to the nearest constraint + 20%
    const minViewRange = 50;
    const leftViewRange = Math.max(minViewRange, dL * 1.2);
    const rightViewRange = Math.max(minViewRange, dR * 1.2);
    
    // Calculate absolute distance range (from route start)
    const viewStart = Math.max(0, s0 - leftViewRange);
    const viewEnd = Math.min(totalRouteLength, s0 + rightViewRange);
    const viewRange = viewEnd - viewStart;
    
    // Padding for the SVG
    const padding = { left: 40, right: 20, top: 25, bottom: 40 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Calculate pixels per meter for absolute distances
    const pixelsPerMeter = chartWidth / viewRange;
    
    // Convert absolute distance (from route start) to pixel X coordinate
    // RTL layout: 0 (route start) is on the right, higher distances on the left
    const distanceToPixelX = (absDist: number) => {
      return padding.left + chartWidth - (absDist - viewStart) * pixelsPerMeter;
    };
    
    // Position of s0 (selected point) in pixels
    const centerX = distanceToPixelX(s0);
    
    // Build visualization data for constraints
    const constraintVis: ConstraintVisualization[] = [];
    
    // Add turns (potentially non-limiting if allowTurnsDuringClimb is true)
    const isLimitingTurn = !config.allowTurnsDuringClimb;
    
    if (allConstraints.nearestLeftTurn) {
      const absDist = allConstraints.nearestLeftTurn.distance;
      const relDist = absDist - s0;
      constraintVis.push({
        constraint: allConstraints.nearestLeftTurn,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(absDist),
        isLimiting: isLimitingTurn,
        label: `Turn (${absDist.toFixed(0)} מ')`
      });
    }
    
    if (allConstraints.nearestRightTurn) {
      const absDist = allConstraints.nearestRightTurn.distance;
      const relDist = absDist - s0;
      constraintVis.push({
        constraint: allConstraints.nearestRightTurn,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(absDist),
        isLimiting: isLimitingTurn,
        label: `Turn (${absDist.toFixed(0)} מ')`
      });
    }
    
    // Add climb points (always limiting)
    if (allConstraints.nearestLeftClimbPoint) {
      const absDist = allConstraints.nearestLeftClimbPoint.distance;
      const relDist = absDist - s0;
      constraintVis.push({
        constraint: allConstraints.nearestLeftClimbPoint,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(absDist),
        isLimiting: true,
        label: `Climb (${absDist.toFixed(0)} מ')`
      });
    }
    
    if (allConstraints.nearestRightClimbPoint) {
      const absDist = allConstraints.nearestRightClimbPoint.distance;
      const relDist = absDist - s0;
      constraintVis.push({
        constraint: allConstraints.nearestRightClimbPoint,
        relativeDistance: relDist,
        pixelX: distanceToPixelX(absDist),
        isLimiting: true,
        label: `Climb (${absDist.toFixed(0)} מ')`
      });
    }
    
    // Calculate exclusion zone extents (buffer areas from constraints)
    // Mark in red only the buffer length extending from each constraint toward s0
    const exclusionZones: { x1: number; x2: number; side: 'left' | 'right' }[] = [];
    const buffer = config.vertexProximityMeters;
    
    if (left && (left.type === 'climbPoint' || !config.allowTurnsDuringClimb)) {
      // Left exclusion zone: buffer area from left constraint extending toward s0
      const bufferStart = left.distance;
      const bufferEnd = Math.min(s0, left.distance + buffer);
      exclusionZones.push({
        x1: distanceToPixelX(bufferStart),
        x2: distanceToPixelX(bufferEnd),
        side: 'left'
      });
    } else if (!left) {
      // No left constraint: buffer zone from route start
      const bufferStart = 0;
      const bufferEnd = Math.min(s0, buffer);
      exclusionZones.push({
        x1: distanceToPixelX(bufferStart),
        x2: distanceToPixelX(bufferEnd),
        side: 'left'
      });
    }
    
    if (right && (right.type === 'climbPoint' || !config.allowTurnsDuringClimb)) {
      // Right exclusion zone: buffer area from right constraint extending toward s0
      const bufferStart = Math.max(s0, right.distance - buffer);
      const bufferEnd = right.distance;
      exclusionZones.push({
        x1: distanceToPixelX(bufferStart),
        x2: distanceToPixelX(bufferEnd),
        side: 'right'
      });
    } else if (!right) {
      // No right constraint: buffer zone from route end
      const bufferStart = Math.max(s0, totalRouteLength - buffer);
      const bufferEnd = totalRouteLength;
      exclusionZones.push({
        x1: distanceToPixelX(bufferStart),
        x2: distanceToPixelX(bufferEnd),
        side: 'right'
      });
    }
    
    // Generate axis tick marks (absolute distances from route start)
    const axisY = padding.top + chartHeight;
    const tickInterval = getTickInterval(viewRange);
    const ticks: { x: number; label: string }[] = [];
    
    // Get all constraint distances and s0 to exclude from axis ticks
    const constraintDistances = new Set(
      constraintVis.map(cv => cv.constraint.distance)
    );
    
    // Generate ticks for absolute distances within view range
    // Exclude ticks that are at constraint marker positions or at s0 (selected point)
    const startTick = Math.ceil(viewStart / tickInterval) * tickInterval;
    for (let d = startTick; d <= viewEnd; d += tickInterval) {
      // Skip if this distance matches a constraint marker (within 0.5m tolerance)
      const isConstraintDistance = Array.from(constraintDistances).some(
        constraintDist => Math.abs(d - constraintDist) < 0.5
      );
      // Skip if this distance matches s0 (selected point) - it has its own marker
      const isSelectedPoint = Math.abs(d - s0) < 0.5;
      if (isConstraintDistance || isSelectedPoint) continue;
      
      const x = distanceToPixelX(d);
      if (x >= padding.left && x <= width - padding.right) {
        ticks.push({ x, label: `${d.toFixed(0)} מ'` });
      }
    }
    
    // Don't add s0 as an axis tick - it's already marked with the purple circle
    // and has the "נקודה נבחרת" label above
    
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
      dL,
      dR,
      viewStart,
      viewEnd
    };
  }, [constraintResult, allConstraints, s0, config, width, height, totalRouteLength]);

  // Helper to get appropriate tick interval based on range
  function getTickInterval(range: number): number {
    if (range <= 100) return 20;
    if (range <= 250) return 50;
    if (range <= 500) return 100;
    if (range <= 1000) return 200;
    return 500;
  }

  const { padding, chartHeight, centerX, axisY, constraintVis, exclusionZones, ticks, dL, dR } = graphData;

  return (
    <div className="climb-constraints-graph">
      <div className="climb-constraints-title">אילוצי עלייה</div>
      
      <svg width={width} height={height} className="climb-constraints-svg">
        {/* Background */}
        <rect x={0} y={0} width={width} height={height} fill="#fafafa" rx={4} />
        
        {/* Exclusion zones (buffer areas in red) */}
        <defs>
          <pattern id="hatch-red" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#dc2626" strokeWidth="1" opacity="0.4" />
          </pattern>
        </defs>
        
        {exclusionZones.map((zone, idx) => (
          <g key={`zone-${idx}`}>
            {/* Red background for buffer zone */}
            <rect
              x={Math.min(zone.x1, zone.x2)}
              y={padding.top}
              width={Math.abs(zone.x2 - zone.x1)}
              height={chartHeight}
              fill="#fee2e2"
              opacity={0.8}
            />
            {/* Hatched pattern overlay */}
            <rect
              x={Math.min(zone.x1, zone.x2)}
              y={padding.top}
              width={Math.abs(zone.x2 - zone.x1)}
              height={chartHeight}
              fill="url(#hatch-red)"
            />
          </g>
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
        {/* Distance from selected point to nearest constraints */}
        {(() => {
          const { left, right } = constraintResult;
          const distToLeft = left ? s0 - left.distance : s0;
          //@ts-ignore
          const distToRight = right ? right.distance - s0 : totalRouteLength - s0;
          
          const leftLabel = left 
            ? `${left.type === 'turn' ? 'פנייה' : 'עלייה'}: ${distToLeft.toFixed(0)} מ'`
            : `${distToLeft.toFixed(0)} מ'`;
          
          return (
            <>
              <text
                x={centerX}
                y={padding.top + 10}
                textAnchor="middle"
                fontSize="12"
                fill="#64748b"
              >
                {leftLabel}
              </text>
            </>
          );
        })()}
        
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
              
              {/* Label with distance for climb points, separate for turns */}
              {isTurn ? (
                <>
                  {/* Distance label above for turns */}
                  <text
                    x={cv.pixelX}
                    y={labelY - 17}
                    textAnchor="middle"
                    fontSize="9"
                    fill="#64748b"
                  >
                    {cv.constraint.distance.toFixed(0)} מ'
                  </text>
                  {/* Type label for turns */}
                  <text
                    x={cv.pixelX}
                    y={labelY}
                    textAnchor="middle"
                    fontSize="9"
                    fill={fillColor}
                    fontWeight={cv.isLimiting ? 'bold' : 'normal'}
                  >
                    פנייה
                  </text>
                </>
              ) : (
                <>
                  {/* Combined label for climb points: type and distance */}
                  <text
                    x={cv.pixelX}
                    y={labelY}
                    textAnchor="middle"
                    fontSize="9"
                    fill={fillColor}
                    fontWeight={cv.isLimiting ? 'bold' : 'normal'}
                  >
                    עלייה ({cv.constraint.distance.toFixed(0)} מ')
                  </text>
                </>
              )}
            </g>
          );
        })}
        
        {/* Legend */}
        <g transform={`translate(${width - padding.right - 100}, ${height - 14})`}>
          {/* Turn legend */}
          <polygon
            points="0,-4 4,0 0,4 -4,0"
            fill={config.allowTurnsDuringClimb ? '#9ca3af' : '#dc2626'}
            transform="translate(-17, 0)"
          />
          <text x={-25} y={3} fontSize="12" fill="#64748b">
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
          <text x={80} y={3} fontSize="12" fill="#64748b">
            נק' עלייה (מגביל)
          </text>
        </g>
      </svg>
      
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
        <span>מרחק מהתחלה: {dL === Infinity ? '∞' : dL.toFixed(1)} מ'</span>
        <span>מרחק לסיום: {dR === Infinity ? '∞' : dR.toFixed(1)} מ'</span>
      </div>
    </div>
  );
};

export default ClimbConstraints1DGraph;

