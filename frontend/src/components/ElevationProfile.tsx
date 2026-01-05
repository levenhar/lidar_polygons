import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import './ElevationProfile.css';
import { BaseAltitudeSample, ClimbConfig, ClimbProfilePoint, computeClimbProfile } from '../utils/climb';

const ExportIcon: React.FC<{ type: 'png' | 'csv' }> = ({ type }) => {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  };
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };

  if (type === 'png') {
    return (
      <svg {...common}>
        <rect {...stroke} x="4" y="5" width="16" height="14" rx="2" />
        <path {...stroke} d="M8 13l2-2 3 3 2-2 3 3" />
        <circle {...stroke} cx="9" cy="10" r="1" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path {...stroke} d="M7 3h10v18H7z" />
      <path {...stroke} d="M9 7h6" />
      <path {...stroke} d="M9 11h6" />
      <path {...stroke} d="M9 15h6" />
    </svg>
  );
};

const ClimbIcon: React.FC = () => {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  };
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };
  return (
    <svg {...common}>
      <path {...stroke} d="M4 18l6-10 4 7 3-5" />
      <path {...stroke} d="M17 10h3v-3" />
    </svg>
  );
};

const TrashIcon: React.FC = () => {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  };
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };
  return (
    <svg {...common}>
      <path {...stroke} d="M3 6h18" />
      <path {...stroke} d="M8 6V4h8v2" />
      <path {...stroke} d="M19 6l-1 14H6L5 6" />
      <path {...stroke} d="M10 11v6" />
      <path {...stroke} d="M14 11v6" />
    </svg>
  );
};

interface ElevationProfileProps {
  elevationProfile: ElevationPoint[];
  loading: boolean;
  nominalFlightHeight: number;
  safetyHeight: number;
  resolutionHeight: number;
  selectedPoint: Coordinate | null;
  flightPath: Coordinate[];
  onDeletePoint: (index: number) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onSetFlightHeight: (index: number) => void;
  onEditPointRequest: (index: number) => void;
  onElevationPointHover?: (point: ElevationPoint | null) => void;
}

const ElevationProfile: React.FC<ElevationProfileProps> = ({
  elevationProfile,
  loading,
  nominalFlightHeight,
  safetyHeight,
  resolutionHeight,
  selectedPoint,
  flightPath,
  onDeletePoint,
  onUpdatePoint,
  onSetFlightHeight,
  onEditPointRequest,
  onElevationPointHover
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clipPathIdRef = useRef(`elevation-clip-${Math.random().toString(36).slice(2, 8)}`);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [climbConfig, setClimbConfig] = useState<ClimbConfig>({ hvRatio: 10, allowTurnsDuringClimb: true });
  const [isClimbConfigOpen, setIsClimbConfigOpen] = useState(false);
  const [isClimbAmountOpen, setIsClimbAmountOpen] = useState(false);
  const [pendingClimbEnd, setPendingClimbEnd] = useState<number | null>(null);
  const [climbAmountInput, setClimbAmountInput] = useState<string>('');
  const [climbAmountError, setClimbAmountError] = useState<string | null>(null);
  const [climbRequests, setClimbRequests] = useState<{ endDistance: number; climbAmount: number }[]>([]);
  const [climbWarnings, setClimbWarnings] = useState<string[]>([]);
  const [climbConfigDraft, setClimbConfigDraft] = useState<{ hvRatio: string; allowTurnsDuringClimb: boolean }>({
    hvRatio: climbConfig.hvRatio.toString(),
    allowTurnsDuringClimb: climbConfig.allowTurnsDuringClimb
  });
  const [climbConfigError, setClimbConfigError] = useState<string | null>(null);
  const [climbValidationPopup, setClimbValidationPopup] = useState<string | null>(null);
  const [climbContextMenu, setClimbContextMenu] = useState<{ x: number; y: number; endDistance: number; climbAmount: number } | null>(null);
  const climbContextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!climbContextMenu) return;
    const handleGlobalClose = (event: MouseEvent) => {
      if (climbContextMenuRef.current && !climbContextMenuRef.current.contains(event.target as Node)) {
        setClimbContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleGlobalClose);
    document.addEventListener('contextmenu', handleGlobalClose);
    return () => {
      document.removeEventListener('mousedown', handleGlobalClose);
      document.removeEventListener('contextmenu', handleGlobalClose);
    };
  }, [climbContextMenu]);

  const baseAltitudeProfile = useMemo<BaseAltitudeSample[]>(() => {
    if (!elevationProfile.length) return [];
    const startElevation = elevationProfile[0].elevation;
    const constantAltitude = startElevation + nominalFlightHeight;
    return elevationProfile.map((p) => ({
      distance: p.distance,
      baseAltitude: constantAltitude,
      ground: p.elevation
    }));
  }, [elevationProfile, nominalFlightHeight]);

  const basePlanPoints = useMemo<ClimbProfilePoint[]>(() => {
    return baseAltitudeProfile.map((p) => ({
      ...p,
      plannedAltitude: p.baseAltitude,
      climbDelta: 0,
      isClimbPhase: false
    }));
  }, [baseAltitudeProfile]);

  const climbResult = useMemo(() => {
    if (baseAltitudeProfile.length === 0 || flightPath.length === 0) {
      return { points: basePlanPoints, warnings: [] as string[] };
    }

    // Each climb uses endDistance as the point where climb finishes; start is derived from hvRatio.
    const sortedClimbs = [...climbRequests].sort((a, b) => a.endDistance - b.endDistance);
    let currentBase = baseAltitudeProfile;
    let currentPlanned = basePlanPoints;
    const warnings: string[] = [];

    sortedClimbs.forEach((climb, idx) => {
      const requiredHorizontal = Math.abs(climb.climbAmount) * climbConfig.hvRatio;
      const startDistance = Math.max(0, climb.endDistance - requiredHorizontal);
      const res = computeClimbProfile(
        startDistance,
        climb.climbAmount,
        climbConfig.hvRatio,
        climbConfig.allowTurnsDuringClimb,
        flightPath,
        currentBase,
        climb.endDistance
      );
      warnings.push(...res.warnings.map((w) => `Climb ${idx + 1}: ${w}`));
      currentPlanned = res.points.map((p, i) => ({
        ...p,
        // track total climb from the original base plan
        climbDelta: p.plannedAltitude - (basePlanPoints[i]?.baseAltitude ?? p.baseAltitude),
        isClimbPhase: p.plannedAltitude !== p.baseAltitude && p.plannedAltitude !== (currentBase[i]?.baseAltitude ?? p.baseAltitude)
      }));
      // Next climb starts from the planned altitude of this step
      currentBase = res.points.map((p) => ({
        distance: p.distance,
        baseAltitude: p.plannedAltitude,
        ground: p.ground
      }));
    });

    return { points: currentPlanned, warnings };
  }, [baseAltitudeProfile, flightPath, climbRequests, climbConfig, basePlanPoints]);

  useEffect(() => {
    setClimbWarnings(climbResult.warnings ?? []);
  }, [climbResult]);

  const plannedProfilePoints = useMemo<ClimbProfilePoint[]>(() => {
    return climbResult.points ?? basePlanPoints;
  }, [climbResult, basePlanPoints]);

  const getPlannedAltitudeAtDistance = useCallback(
    (distance: number) => {
      if (plannedProfilePoints.length === 0) return nominalFlightHeight;
      let closest = plannedProfilePoints[0];
      let minDelta = Math.abs(closest.distance - distance);
      for (const p of plannedProfilePoints) {
        const delta = Math.abs(p.distance - distance);
        if (delta < minDelta) {
          closest = p;
          minDelta = delta;
        }
      }
      return closest.plannedAltitude;
    },
    [plannedProfilePoints, nominalFlightHeight]
  );

  const activeClimbStartDistance = null;

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || elevationProfile.length === 0) {
      return;
    }

    console.log(`ElevationProfile: Rendering with ${elevationProfile.length} points, updating min/max and safety/resolution lines`);
    
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous render

    const margin = { top: 20, right: 30, bottom: 60, left: 80 };
    const legendWidth = 160; // Space for legend outside the graph
    const width = containerRef.current.clientWidth - margin.left - margin.right - legendWidth;
    const height = 400 - margin.top - margin.bottom;

    // Set SVG dimensions (include space for legend)
    svg.attr('width', width + margin.left + margin.right + legendWidth)
       .attr('height', height + margin.top + margin.bottom);

    const g: d3.Selection<SVGGElement, unknown, null, undefined> = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Clip area to avoid drawing outside the plot when zooming/panning
    svg.append('defs')
      .append('clipPath')
      .attr('id', clipPathIdRef.current)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height);

    const chartArea: d3.Selection<SVGGElement, unknown, null, undefined> = g.append('g')
      .attr('clip-path', `url(#${clipPathIdRef.current})`);

    // Create scales
    const baseXScale = d3.scaleLinear()
      .domain(d3.extent(elevationProfile, d => d.distance) as [number, number])
      .range([0, width]);

    const plannedAltitudes = plannedProfilePoints.map((p) => p.plannedAltitude);
    const baseAltitudes = basePlanPoints.map((p) => p.baseAltitude);

    // @ts-ignore
    const getSafetyThreshold = (d: ElevationPoint) => {
      const maxElev = d.maxElevation !== undefined ? d.maxElevation : d.elevation;
      return maxElev + safetyHeight;
    };

    const getResolutionThreshold = (d: ElevationPoint) => {
      const minElev = d.minElevation !== undefined ? d.minElevation : d.elevation;
      return minElev + resolutionHeight;
    };

    // Calculate domain including min/max elevations within radius
    const allMinElevations = elevationProfile
      .map(d => d.minElevation)
      .filter((v): v is number => v !== undefined);
    const allMaxElevations = elevationProfile
      .map(d => d.maxElevation)
      .filter((v): v is number => v !== undefined);
    
    // Calculate max elevation including safety line (maxElevation + safetyHeight)
    const maxWithSafety = allMaxElevations.length > 0 
      ? Math.max(...allMaxElevations.map(e => e + safetyHeight))
      : 0;
    
    // Calculate max elevation including resolution line (minElevation + resolutionHeight)
    const maxWithResolution = allMinElevations.length > 0
      ? Math.max(...allMinElevations.map(e => e + resolutionHeight))
      : 0;
    
    const maxElevation = Math.max(
      ...elevationProfile.map(d => d.elevation),
      ...(baseAltitudes.length ? baseAltitudes : [0]),
      ...(plannedAltitudes.length ? plannedAltitudes : [0]),
      ...(allMaxElevations.length > 0 ? allMaxElevations : [0]),
      maxWithSafety,
      maxWithResolution
    );
    const minElevation = Math.min(
      ...elevationProfile.map(d => d.elevation),
      ...(baseAltitudes.length ? baseAltitudes : [Infinity]),
      ...(plannedAltitudes.length ? plannedAltitudes : [Infinity]),
      ...(allMinElevations.length > 0 ? allMinElevations : [Infinity])
    );

    const baseYScale = d3.scaleLinear()
      .domain([minElevation - 20, maxElevation + 20])
      .range([height, 0]);

    let currentXScale = baseXScale;
    let currentYScale = baseYScale;

    // Selections we need to update on zoom/pan
    let rangeBars: d3.Selection<SVGLineElement, ElevationPoint, any, any> | null = null;
    let minMarkers: d3.Selection<SVGCircleElement, ElevationPoint, any, any> | null = null;
    let maxMarkers: d3.Selection<SVGCircleElement, ElevationPoint, any, any> | null = null;
    let selectedDistanceLine: d3.Selection<SVGLineElement, unknown, any, any> | null = null;
    let selectedDistance: number | null = null;
    let resolutionViolationAreas: d3.Selection<SVGPathElement, typeof profileWithPlan[0][], any, any> | null = null;
    let safetyViolationAreas: d3.Selection<SVGPathElement, typeof profileWithPlan[0][], any, any> | null = null;
    let climbAreas: d3.Selection<SVGPathElement, typeof profileWithPlan[0][], any, any> | null = null;
    let climbEndMarkers: d3.Selection<SVGGElement, any, any, any> | null = null;
    const profileWithPlan = elevationProfile.map((p, idx) => {
      const planned = plannedProfilePoints[idx]?.plannedAltitude ?? (p.elevation + nominalFlightHeight);
      const baseAltitude = basePlanPoints[idx]?.baseAltitude ?? planned;
      const climbDelta = planned - baseAltitude;
      return {
        ...p,
        plannedAltitude: planned,
        baseAltitude,
        climbDelta
      };
    });

    // Draw ground elevation line
    const groundLine = d3.line<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.elevation))
      .curve(d3.curveMonotoneX);

    const groundPath = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#8B4513')
      .attr('stroke-width', 2)
      .attr('d', groundLine);

    // Draw base (pre-climb) and planned (post-climb) altitude lines
    const baseFlightLine = d3.line<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.baseAltitude))
      .curve(d3.curveMonotoneX);

    const plannedFlightLine = d3.line<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.plannedAltitude))
      .curve(d3.curveMonotoneX);

    const baseFlightPathLine = chartArea.append('path')
      .datum(profileWithPlan)
      .attr('fill', 'none')
      .attr('stroke', '#1E90FF')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', climbResult ? '6,4' : '0')
      .attr('d', baseFlightLine);

    const plannedFlightPathLine = chartArea.append('path')
      .datum(profileWithPlan)
      .attr('fill', 'none')
      .attr('stroke', '#6f42c1')
      .attr('stroke-width', 2.5)
      .attr('d', plannedFlightLine);

    // Draw safety line (red) - safetyHeight meters above max elevation
    // Use maxElevation if available, otherwise use regular elevation
    const safetyLine = d3.line<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y(d => {
        const maxElev = d.maxElevation !== undefined ? d.maxElevation : d.elevation;
        return currentYScale(maxElev + safetyHeight);
      })
      .curve(d3.curveMonotoneX);

    const safetyPath = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#DC2626')
      .attr('stroke-width', 3)
      .attr('stroke-dasharray', '10,6')
      .attr('d', safetyLine);

    // Draw resolution line (green) - resolutionHeight meters above min elevation
    // Use minElevation if available, otherwise use regular elevation
    const resolutionLine = d3.line<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y(d => {
        const minElev = d.minElevation !== undefined ? d.minElevation : d.elevation;
        return currentYScale(minElev + resolutionHeight);
      })
      .curve(d3.curveMonotoneX);

    const resolutionPath = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#16A34A')
      .attr('stroke-width', 3)
      .attr('stroke-dasharray', '10,6')
      .attr('d', resolutionLine);

    // Add grid lines
    const xAxisGrid = d3.axisBottom(currentXScale)
      .ticks(10)
      .tickSize(-height)
      .tickFormat(() => '');

    const yAxisGrid = d3.axisLeft(currentYScale)
      .ticks(10)
      .tickSize(-width)
      .tickFormat(() => '');

    const xGridGroup = g.append('g')
      .attr('class', 'grid')
      .attr('stroke', '#ddd')
      .attr('stroke-width', 0.5)
      .attr('stroke-dasharray', '3,3')
      .call(xAxisGrid);

    const yGridGroup = g.append('g')
      .attr('class', 'grid')
      .attr('stroke', '#ddd')
      .attr('stroke-width', 0.5)
      .attr('stroke-dasharray', '3,3')
      .call(yAxisGrid);

    // Draw min/max elevation range bars (behind everything else)
    const pointsWithMinMax = elevationProfile.filter(
      d => d.minElevation !== undefined && d.maxElevation !== undefined
    );
    
    console.log(`ElevationProfile render: ${elevationProfile.length} total points, ${pointsWithMinMax.length} with min/max`);
    
    if (pointsWithMinMax.length > 0) {
      console.log(`Drawing min/max range bars for ${pointsWithMinMax.length} points`);
      
      // Draw vertical range bars for min/max elevation - make them more visible
      rangeBars = chartArea.selectAll<SVGLineElement, ElevationPoint>('.elevation-range-bar')
        .data(pointsWithMinMax)
        .enter()
        .append('line')
        .attr('class', 'elevation-range-bar')
        .attr('x1', d => currentXScale(d.distance))
        .attr('x2', d => currentXScale(d.distance))
        .attr('y1', d => currentYScale(d.minElevation!))
        .attr('y2', d => currentYScale(d.maxElevation!))
        .attr('stroke', '#FBBF24')
        .attr('stroke-width', 2)
        .attr('opacity', 0.6);

      // Draw min elevation markers
      minMarkers = chartArea.selectAll<SVGCircleElement, ElevationPoint>('.min-elevation-marker')
        .data(pointsWithMinMax)
        .enter()
        .append('circle')
        .attr('class', 'min-elevation-marker')
        .attr('cx', d => currentXScale(d.distance))
        .attr('cy', d => currentYScale(d.minElevation!))
        .attr('r', 2.5)
        .attr('fill', '#FBBF24')
        .attr('opacity', 0.8);

      // Draw max elevation markers
      maxMarkers = chartArea.selectAll<SVGCircleElement, ElevationPoint>('.max-elevation-marker')
        .data(pointsWithMinMax)
        .enter()
        .append('circle')
        .attr('class', 'max-elevation-marker')
        .attr('cx', d => currentXScale(d.distance))
        .attr('cy', d => currentYScale(d.maxElevation!))
        .attr('r', 2.5)
        .attr('fill', '#FBBF24')
        .attr('opacity', 0.8);
    } else {
      // Remove any existing min/max elements if there are no points
      g.selectAll('.elevation-range-bar').remove();
      g.selectAll('.min-elevation-marker').remove();
      g.selectAll('.max-elevation-marker').remove();
      rangeBars = null;
      minMarkers = null;
      maxMarkers = null;
    }

    // Fill area under ground
    const groundAreaGenerator = d3.area<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y0(height)
      .y1(d => currentYScale(d.elevation))
      .curve(d3.curveMonotoneX);

    const groundArea = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', '#8B4513')
      .attr('fill-opacity', 0.3)
      .attr('d', groundAreaGenerator);

    const buildSegments = <T,>(points: T[], predicate: (d: T) => boolean) => {
      const segments: T[][] = [];
      let current: T[] = [];
      points.forEach((p) => {
        if (predicate(p)) {
          current.push(p);
        } else if (current.length) {
          segments.push(current);
          current = [];
        }
      });
      if (current.length) segments.push(current);
      return segments;
    };

    const resolutionSegments = buildSegments(profileWithPlan, (d) => d.plannedAltitude > getResolutionThreshold(d));
    const safetySegments = buildSegments(profileWithPlan, (d) => d.plannedAltitude < getSafetyThreshold(d));

    const resolutionViolationGroup = chartArea.append('g').attr('class', 'resolution-violations');
    const safetyViolationGroup = chartArea.append('g').attr('class', 'safety-violations');

    const resolutionAreaGenerator = d3.area<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y0(d => currentYScale(getResolutionThreshold(d)))
      .y1(d => currentYScale(d.plannedAltitude))
      .curve(d3.curveMonotoneX);

    const safetyAreaGenerator = d3.area<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y0(d => currentYScale(d.plannedAltitude))
      .y1(d => currentYScale(getSafetyThreshold(d)))
      .curve(d3.curveMonotoneX);

    resolutionViolationAreas = resolutionViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(resolutionSegments)
      .enter()
      .append('path')
      .attr('fill', '#16A34A')
      .attr('fill-opacity', 0.18)
      .attr('d', d => resolutionAreaGenerator(d));

    safetyViolationAreas = safetyViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(safetySegments)
      .enter()
      .append('path')
      .attr('fill', '#DC2626')
      .attr('fill-opacity', 0.2)
      .attr('d', d => safetyAreaGenerator(d));

    // Climb visualization (shaded area between base and climbed altitude)
    const climbSegments = buildSegments(profileWithPlan, (d) => Math.abs(d.climbDelta) > 0.05);
    const climbGroup = chartArea.append('g').attr('class', 'climb-areas');
    const climbAreaGenerator = d3.area<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y0(d => currentYScale(d.baseAltitude))
      .y1(d => currentYScale(d.plannedAltitude))
      .curve(d3.curveMonotoneX);

    climbAreas = climbGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(climbSegments)
      .enter()
      .append('path')
      .attr('fill', '#6f42c1')
      .attr('fill-opacity', 0.18)
      .attr('stroke', 'none')
      .attr('d', d => climbAreaGenerator(d));

    // Find original flight path vertices in the elevation profile
    // Match by coordinates (with small tolerance for floating point precision)
    const originalVertices = flightPath.map((vertex: Coordinate, vertexIndex: number) => {
      // Find the closest elevation point to this vertex
      let closestPoint = elevationProfile[0];
      let closestDistance = Infinity;
      
      for (const point of elevationProfile) {
        const dist = Math.sqrt(
          Math.pow(point.longitude - vertex.lng, 2) + 
          Math.pow(point.latitude - vertex.lat, 2)
        );
        if (dist < closestDistance) {
          closestDistance = dist;
          closestPoint = point;
        }
      }
      
      return { point: closestPoint, index: vertexIndex };
    });

    // Add data points only for original flight path vertices
    const groundPoints = chartArea.selectAll<SVGCircleElement, { point: ElevationPoint; index: number }>('.ground-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'ground-point')
      .attr('cx', d => currentXScale(d.point.distance))
      .attr('cy', d => currentYScale(d.point.elevation))
      .attr('r', 3)
      .attr('fill', '#8B4513')
      .style('cursor', 'pointer');

    // Add right-click handler for ground points
    groundPoints.on('contextmenu', function(event: any, d: { point: ElevationPoint; index: number }) {
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      setContextMenu({
        x: clickX,
        y: clickY,
        pointIndex: d.index
      });
    });

    const flightPoints = chartArea.selectAll<SVGCircleElement, { point: ElevationPoint; index: number }>('.flight-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'flight-point')
      .attr('cx', d => currentXScale(d.point.distance))
      .attr('cy', d => currentYScale(getPlannedAltitudeAtDistance(d.point.distance)))
      .attr('r', 3)
      .attr('fill', '#1E90FF')
      .style('cursor', 'pointer');

    // Add right-click handler for flight points
    flightPoints.on('contextmenu', function(event: any, d: { point: ElevationPoint; index: number }) {
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      setContextMenu({
        x: clickX,
        y: clickY,
        pointIndex: d.index
      });
    });

    // Add point number labels only for original vertices
    const pointLabels = chartArea.selectAll<SVGTextElement, { point: ElevationPoint; index: number }>('.point-label')
      .data(originalVertices)
      .enter()
      .append('text')
      .attr('class', 'point-label')
      .attr('x', d => currentXScale(d.point.distance))
      .attr('y', d => currentYScale(d.point.elevation) - 8)
      .attr('text-anchor', 'middle')
      .attr('fill', '#666')
      .style('font-size', '12px')
      .style('font-weight', '500')
      .text(d => d.index + 1);

    // Add axes
    const xAxis = d3.axisBottom(currentXScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    const yAxis = d3.axisLeft(currentYScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    const xAxisGroup = g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);
    
    xAxisGroup.selectAll('text')
      .style('font-size', '12px');
    
    const yAxisGroup = g.append('g')
      .call(yAxis);
    
    yAxisGroup.selectAll('text')
      .style('font-size', '12px');
    
    // Axis labels (outside axis groups to avoid being cleared on zoom redraw)
    g.append('text')
      .attr('class', 'x-axis-label')
      .attr('x', width / 2)
      .attr('y', height + 50)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .style('font-size', '14px')
      .text('Distance (meters)');

    g.append('text')
      .attr('class', 'y-axis-label')
      .attr('transform', 'rotate(-90)')
      .attr('y', -60)
      .attr('x', -height / 2)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .style('font-size', '14px')
      .text('Elevation (meters)');

    // Highlight selected point (only for user-imported points, not interpolated ones)
    if (selectedPoint && flightPath.length > 0) {
      // Find the selected point in the original vertices (user-imported points only)
      const selectedVertex = originalVertices.find(
        v => Math.abs(v.point.longitude - selectedPoint.lng) < 0.0001 &&
             Math.abs(v.point.latitude - selectedPoint.lat) < 0.0001
      );

      if (selectedVertex) {
        // Draw vertical line at selected point's distance
        selectedDistance = selectedVertex.point.distance;
        selectedDistanceLine = chartArea.append('line')
          .attr('x1', currentXScale(selectedVertex.point.distance))
          .attr('x2', currentXScale(selectedVertex.point.distance))
          .attr('y1', 0)
          .attr('y2', height)
          .attr('stroke', '#ff0000')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '5,5');
      }
    }

    const endMarkersData = climbRequests.map((c) => ({ endDistance: c.endDistance, climbAmount: c.climbAmount }));

    climbEndMarkers = chartArea.selectAll<SVGGElement, any>('.climb-end-marker')
      .data(endMarkersData)
      .enter()
      .append('g')
      .attr('class', 'climb-end-marker')
      .on('contextmenu', (event, d) => {
        event.preventDefault();
        event.stopPropagation();
        const clickX = (event as MouseEvent).clientX;
        const clickY = (event as MouseEvent).clientY;
        setClimbContextMenu({ x: clickX, y: clickY, endDistance: d.endDistance, climbAmount: d.climbAmount });
      });

    climbEndMarkers.append('circle')
      .attr('cx', d => currentXScale(d.endDistance))
      .attr('cy', d => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)))
      .attr('r', 5)
      .attr('fill', '#6f42c1')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .style('cursor', 'context-menu');

    // Add legend outside the graph area
    const legend = svg.append('g')
      .attr('transform', `translate(${width + margin.left + 10}, ${margin.top + 20})`);

    const legendData = [
      { label: 'Ground Elevation', color: '#8B4513', style: 'solid' },
      { label: climbResult ? 'Flight Altitude (base)' : 'Flight Altitude', color: '#1E90FF', style: climbResult ? 'dashed' : 'solid' },
      ...(climbResult ? [{ label: 'Flight Altitude (with climb)', color: '#6f42c1', style: 'solid' }] : []),
      ...(pointsWithMinMax.length > 0 ? [{ label: 'Min/Max Elevation', color: '#FBBF24', style: 'solid' }] : []),
      { label: `Safety (+${safetyHeight}m)`, color: '#DC2626', style: 'dashed' },
      { label: `Resolution (+${resolutionHeight}m)`, color: '#16A34A', style: 'dashed' }
    ];

    // Calculate the width of the longest label
    const tempText = svg.append('text')
      .style('font-size', '14px')
      .style('visibility', 'hidden');
    
    let maxTextWidth = 0;
    legendData.forEach(item => {
      tempText.text(item.label);
      const textWidth = (tempText.node() as SVGTextElement)?.getBBox().width || 0;
      if (textWidth > maxTextWidth) {
        maxTextWidth = textWidth;
      }
    });
    tempText.remove();

    // Add white background rectangle for legend
    // Width = line width (20px) + spacing (5px) + text width + padding (10px on each side)
    const legendHeight = legendData.length * 20;
    const legendBoxWidth = 20 + 5 + maxTextWidth + 20; // line + spacing + text + padding
    legend.append('rect')
      .attr('x', -5)
      .attr('y', -12)
      .attr('width', legendBoxWidth)
      .attr('height', legendHeight + 4)
      .attr('fill', '#ffffff')
      .attr('stroke', '#e5e7eb')
      .attr('stroke-width', 1)
      .attr('rx', 4)
      .attr('opacity', 0.95);

    legendData.forEach((item, i) => {
      const legendItem = legend.append('g')
        .attr('transform', `translate(0, ${i * 20})`);

      legendItem.append('line')
        .attr('x1', 0)
        .attr('x2', 20)
        .attr('y1', 0)
        .attr('y2', 0)
        .attr('stroke', item.color)
        .attr('stroke-width', item.style === 'dashed' ? 3 : 2)
        .attr('stroke-dasharray', item.style === 'dashed' ? '8,5' : '0');

      legendItem.append('text')
        .attr('x', 25)
        .attr('y', 4)
        .attr('fill', 'black')
        .style('font-size', '14px')
        .text(item.label);
    });

    // Interaction overlay captures zoom/pan and hover without showing a visible layer
    const overlay = g.append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .style('pointer-events', 'all');
    overlay.lower();

    const zoomBehavior = d3.zoom<SVGRectElement, unknown>()
      .scaleExtent([1, 12])
      .translateExtent([[0, 0], [width, height]])
      .extent([[0, 0], [width, height]])
      .on('zoom', (event) => {
        const newXScale = event.transform.rescaleX(baseXScale);
        const newYScale = event.transform.rescaleY(baseYScale);

        currentXScale = newXScale;
        currentYScale = newYScale;

        xAxis.scale(currentXScale);
        yAxis.scale(currentYScale);
        xAxisGrid.scale(currentXScale);
        yAxisGrid.scale(currentYScale);

        xGridGroup.call(xAxisGrid);
        yGridGroup.call(yAxisGrid);
        xAxisGroup.call(xAxis);
        yAxisGroup.call(yAxis);
        xAxisGroup.selectAll('text').style('font-size', '12px');
        yAxisGroup.selectAll('text').style('font-size', '12px');

        groundPath.attr('d', groundLine);
        baseFlightPathLine.attr('d', baseFlightLine);
        plannedFlightPathLine.attr('d', plannedFlightLine);
        safetyPath.attr('d', safetyLine);
        resolutionPath.attr('d', resolutionLine);
        groundArea.attr('d', groundAreaGenerator);

        if (resolutionViolationAreas) {
          const resolutionAreaGenerator = d3.area<typeof profileWithPlan[0]>()
            .x(d => currentXScale(d.distance))
            .y0(d => currentYScale(getResolutionThreshold(d)))
            .y1(d => currentYScale(d.plannedAltitude))
            .curve(d3.curveMonotoneX);
          resolutionViolationAreas.attr('d', d => resolutionAreaGenerator(d));
        }

        if (safetyViolationAreas) {
          const safetyAreaGenerator = d3.area<typeof profileWithPlan[0]>()
            .x(d => currentXScale(d.distance))
            .y0(d => currentYScale(d.plannedAltitude))
            .y1(d => currentYScale(getSafetyThreshold(d)))
            .curve(d3.curveMonotoneX);
          safetyViolationAreas.attr('d', d => safetyAreaGenerator(d));
        }

        if (climbAreas) {
          const climbAreaGenerator = d3.area<typeof profileWithPlan[0]>()
            .x(d => currentXScale(d.distance))
            .y0(d => currentYScale(d.baseAltitude))
            .y1(d => currentYScale(d.plannedAltitude))
            .curve(d3.curveMonotoneX);
          climbAreas.attr('d', d => climbAreaGenerator(d));
        }

        if (rangeBars) {
          rangeBars
            .attr('x1', d => currentXScale(d.distance))
            .attr('x2', d => currentXScale(d.distance))
            .attr('y1', d => currentYScale(d.minElevation!))
            .attr('y2', d => currentYScale(d.maxElevation!));
        }
        if (minMarkers) {
          minMarkers
            .attr('cx', d => currentXScale(d.distance))
            .attr('cy', d => currentYScale(d.minElevation!));
        }
        if (maxMarkers) {
          maxMarkers
            .attr('cx', d => currentXScale(d.distance))
            .attr('cy', d => currentYScale(d.maxElevation!));
        }

        groundPoints
          .attr('cx', d => currentXScale(d.point.distance))
          .attr('cy', d => currentYScale(d.point.elevation));

        flightPoints
          .attr('cx', d => currentXScale(d.point.distance))
          .attr('cy', (d) => currentYScale(getPlannedAltitudeAtDistance(d.point.distance)));

        pointLabels
          .attr('x', d => currentXScale(d.point.distance))
          .attr('y', d => currentYScale(d.point.elevation) - 8);

        if (selectedDistanceLine && selectedDistance !== null) {
          selectedDistanceLine
            .attr('x1', currentXScale(selectedDistance))
            .attr('x2', currentXScale(selectedDistance));
        }

        climbEndMarkers?.selectAll<SVGCircleElement, any>('circle')
          .attr('cx', (d: any) => currentXScale(d.endDistance))
          .attr('cy', (d: any) => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)));
      });

    overlay.call(zoomBehavior as any);

    const vertexDistances = new Set(originalVertices.map(v => v.point.distance));

    overlay.on('click', function(event: MouseEvent) {
      if (profileWithPlan.length === 0) return;
      const [mouseX] = d3.pointer(event, g.node() as SVGGElement);
      let closestPoint: typeof profileWithPlan[0] | null = null;
      let closestDistance = Infinity;
      for (const point of profileWithPlan) {
        if (Array.from(vertexDistances).some(d => Math.abs(d - point.distance) < 1e-6)) {
          continue; // skip original user vertices
        }
        const dx = Math.abs(currentXScale(point.distance) - mouseX);
        if (dx < closestDistance) {
          closestDistance = dx;
          closestPoint = point;
        }
      }
      // Fallback to any point if all were vertices
      if (!closestPoint) {
        closestPoint = profileWithPlan.reduce((acc, point) => {
          const dx = Math.abs(currentXScale(point.distance) - mouseX);
          if (dx < closestDistance) {
            closestDistance = dx;
            return point;
          }
          return acc;
        }, profileWithPlan[0]);
      }

      setPendingClimbEnd(closestPoint.distance);
      setClimbAmountInput('');
      setClimbAmountError(null);
      setIsClimbAmountOpen(true);
    });

    // Allow right-click to open the existing point context menu even with the overlay present
    overlay.on('contextmenu', function(event: MouseEvent) {
      // Check if we're clicking on an input point
      const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
      let clickedInputPoint: { point: ElevationPoint; index: number; isFlight: boolean } | null = null;
      
      if (originalVertices.length > 0) {
        for (const vertex of originalVertices) {
          const pointX = currentXScale(vertex.point.distance);
          const groundY = currentYScale(vertex.point.elevation);
          const flightY = currentYScale(getPlannedAltitudeAtDistance(vertex.point.distance));
          
          // Check if click is within 10 pixels of ground or flight point
          const distToGround = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(groundY - mouseY, 2));
          const distToFlight = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(flightY - mouseY, 2));
          
          if (distToGround < 10) {
            clickedInputPoint = { point: vertex.point, index: vertex.index, isFlight: false };
            break;
          } else if (distToFlight < 10) {
            clickedInputPoint = { point: vertex.point, index: vertex.index, isFlight: true };
            break;
          }
        }
      }
      
      // If clicking on an input point, trigger the context menu for that point
      if (clickedInputPoint) {
        event.preventDefault();
        event.stopPropagation();
        const clickX = event.clientX || (event as MouseEvent).clientX;
        const clickY = event.clientY || (event as MouseEvent).clientY;
        setContextMenu({
          x: clickX,
          y: clickY,
          pointIndex: clickedInputPoint.index
        });
      } else {
        // If not clicking on an input point, prevent default to avoid browser context menu
        event.preventDefault();
      }
    });

    // Hover interactions reuse the same overlay
    if (onElevationPointHover) {
      overlay.on('mousemove', function(event: MouseEvent) {
        const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
        
        // Check if we're near any input point (ground or flight points)
        // If so, don't interfere with their right-click events
        let isNearInputPoint = false;
        if (originalVertices.length > 0) {
          for (const vertex of originalVertices) {
            const pointX = currentXScale(vertex.point.distance);
            const groundY = currentYScale(vertex.point.elevation);
            const flightY = currentYScale(getPlannedAltitudeAtDistance(vertex.point.distance));
            
            // Check if mouse is within 10 pixels of ground or flight point
            const distToGround = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(groundY - mouseY, 2));
            const distToFlight = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(flightY - mouseY, 2));
            
            if (distToGround < 10 || distToFlight < 10) {
              isNearInputPoint = true;
              break;
            }
          }
        }
        
        // Only update hover if not near an input point
        if (!isNearInputPoint) {
          // Find the closest point based on distance (x-coordinate)
          let closestPoint: ElevationPoint | null = null;
          let closestDistance = Infinity;
          
          for (const point of elevationProfile) {
            const pointX = currentXScale(point.distance);
            const distance = Math.abs(pointX - mouseX);
            
            if (distance < closestDistance) {
              closestDistance = distance;
              closestPoint = point;
            }
          }
          
          if (closestPoint) {
            onElevationPointHover(closestPoint);
          }
        }
      });

      overlay.on('mouseleave', () => {
        if (onElevationPointHover) {
          onElevationPointHover(null);
        }
      });
    }

  }, [
    elevationProfile,
    nominalFlightHeight,
    safetyHeight,
    resolutionHeight,
    selectedPoint,
    flightPath,
    onDeletePoint,
    onUpdatePoint,
    onSetFlightHeight,
    onEditPointRequest,
    onElevationPointHover,
    plannedProfilePoints,
    basePlanPoints,
    climbResult,
    activeClimbStartDistance,
    getPlannedAltitudeAtDistance
  ]);

  const handleConfirmClimb = useCallback(() => {
    if (pendingClimbEnd === null) {
      setClimbAmountError('Click a point on the profile to choose a climb end.');
      return;
    }
    const parsed = parseFloat(climbAmountInput);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setClimbAmountError('Enter a non-zero climb value (positive or negative).');
      return;
    }
    // Simulate existing climbs to get the current base before adding this climb
    const baseAfterExisting = (() => {
      let currentBase = baseAltitudeProfile;
      const sorted = [...climbRequests].sort((a, b) => a.endDistance - b.endDistance);
      sorted.forEach((c) => {
        const requiredHorizontal = Math.abs(c.climbAmount) * climbConfig.hvRatio;
        const startDistance = Math.max(0, c.endDistance - requiredHorizontal);
        const res = computeClimbProfile(
          startDistance,
          c.climbAmount,
          climbConfig.hvRatio,
          climbConfig.allowTurnsDuringClimb,
          flightPath,
          currentBase,
          c.endDistance
        );
        currentBase = res.points.map((p) => ({
          distance: p.distance,
          baseAltitude: p.plannedAltitude,
          ground: p.ground
        }));
      });
      return currentBase;
    })();

    const requiredHorizontal = Math.abs(parsed) * climbConfig.hvRatio;
    const startDistance = Math.max(0, pendingClimbEnd - requiredHorizontal);
    const preview = computeClimbProfile(
      startDistance,
      parsed,
      climbConfig.hvRatio,
      climbConfig.allowTurnsDuringClimb,
      flightPath,
      baseAfterExisting,
      pendingClimbEnd
    );

    const notReachable =
      !climbConfig.allowTurnsDuringClimb &&
      (Math.abs(preview.appliedClimb - parsed) > 1e-3 || (preview.warnings?.length ?? 0) > 0);

    if (notReachable) {
      const msg = 'Climb cancelled: turns are disabled and the requested elevation change cannot be reached at this point.';
      setClimbAmountError('Cannot reach requested climb with turns disabled; adjust amount or enable turns.');
      setClimbValidationPopup(msg);
      return;
    }

    setClimbRequests((prev) => {
      const filtered = prev.filter((c) => Math.abs(c.endDistance - pendingClimbEnd) > 0.01);
      return [...filtered, { endDistance: pendingClimbEnd, climbAmount: parsed }].sort((a, b) => a.endDistance - b.endDistance);
    });
    setIsClimbAmountOpen(false);
    setPendingClimbEnd(null);
    setClimbAmountError(null);
  }, [climbAmountInput, pendingClimbEnd, baseAltitudeProfile, climbRequests, climbConfig, flightPath]);

  const handleRemoveClimb = useCallback(() => {
    setClimbRequests([]);
    setPendingClimbEnd(null);
    setClimbWarnings([]);
  }, []);

  const handleRemoveSingleClimb = useCallback((endDistance: number) => {
    setClimbRequests((prev) => prev.filter((c) => Math.abs(c.endDistance - endDistance) > 0.001));
  }, []);

  const openClimbConfig = useCallback(() => {
    setClimbConfigDraft({
      hvRatio: climbConfig.hvRatio.toString(),
      allowTurnsDuringClimb: climbConfig.allowTurnsDuringClimb
    });
    setClimbConfigError(null);
    setIsClimbConfigOpen(true);
  }, [climbConfig]);

  const handleSaveClimbConfig = useCallback(() => {
    const parsed = parseFloat(climbConfigDraft.hvRatio);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setClimbConfigError('Horizontal-to-vertical ratio must be greater than 0.');
      return;
    }
    setClimbConfig({
      hvRatio: parsed,
      allowTurnsDuringClimb: climbConfigDraft.allowTurnsDuringClimb
    });
    setIsClimbConfigOpen(false);
    setClimbConfigError(null);
  }, [climbConfigDraft]);

  const exportPNG = () => {
    if (!svgRef.current) return;

    const svgData = new XMLSerializer().serializeToString(svgRef.current);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      
      // Fill canvas with white background
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      }
      
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          
          // Open image in new tab
          window.open(url, '_blank');
          
          // Also download the image
          const a = document.createElement('a');
          a.href = url;
          a.download = `elevation-profile-${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          
          // Clean up the URL after a delay to allow the new tab to load
          setTimeout(() => URL.revokeObjectURL(url), 100);
        }
      });
    };

    img.src = url;
  };

  const exportCSV = () => {
    if (elevationProfile.length === 0) return;

    const headers = ['Distance (m)', 'Ground Elevation (m)', 'Flight Altitude (m)', 'AGL (m)', 'Longitude', 'Latitude'];
    const rows = elevationProfile.map((point, idx) => {
      const planned = plannedProfilePoints[idx]?.plannedAltitude ?? point.elevation + nominalFlightHeight;
      const flightAltitude = planned;
      const agl = flightAltitude - point.elevation;
      return [
        point.distance.toFixed(2),
        point.elevation.toFixed(2),
        flightAltitude.toFixed(2),
        agl.toFixed(2),
        point.longitude.toFixed(6),
        point.latitude.toFixed(6)
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elevation-profile-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSetFlightHeight = (pointIndex: number) => {
    onSetFlightHeight(pointIndex);
  };

  return (
    <div className="elevation-panel">
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            onDeletePoint(contextMenu.pointIndex);
            setContextMenu(null);
          }}
          onEdit={() => {
            onEditPointRequest(contextMenu.pointIndex);
            setContextMenu(null);
          }}
          onSetHeight={() => {
            handleSetFlightHeight(contextMenu.pointIndex);
            setContextMenu(null);
          }}
        />
      )}
      <div className="elevation-header">
        <h2>Elevation Profile</h2>
        <div className="elevation-controls">
          <div className="control-group">
            <div className="group-title">Climb</div>
            <div className="group-buttons">
              <Tooltip tooltip="Climb settings">
                <button
                  onClick={openClimbConfig}
                  className="btn btn-secondary btn-icon"
                  type="button"
                  aria-label="Climb settings"
                >
                  <ClimbIcon />
                </button>
              </Tooltip>
              <Tooltip tooltip={climbRequests.length ? 'Remove all climbs.' : 'No climb applied yet.'}>
                <button
                  onClick={handleRemoveClimb}
                  disabled={climbRequests.length === 0}
                  className="btn btn-tertiary btn-icon"
                  type="button"
                  aria-label="Remove climbs"
                >
                  <TrashIcon />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="control-group">
            <div className="group-title">Export</div>
            <div className="group-buttons">
              <Tooltip tooltip={elevationProfile.length === 0 ? 'No profile to export yet.' : 'Export the elevation chart as PNG.'}>
                <button
                  onClick={exportPNG}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="Export PNG"
                  type="button"
                >
                  <ExportIcon type="png" />
                  <span className="sr-only">Export PNG</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={elevationProfile.length === 0 ? 'No profile to export yet.' : 'Export the elevation data as CSV.'}>
                <button
                  onClick={exportCSV}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="Export CSV"
                  type="button"
                >
                  <ExportIcon type="csv" />
                  <span className="sr-only">Export CSV</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
      <div className="climb-banner">
        <div className="climb-policy-text">
          Click the profile to add climbs; click marks where the climb ends.
        </div>
        {climbWarnings.length > 0 && (
          <div className="climb-warning-list">
            {climbWarnings.map((warning, idx) => (
              <span key={idx} className="climb-warning-chip">{warning}</span>
            ))}
          </div>
        )}
      </div>
      <div ref={containerRef} className="elevation-chart-container">
        {loading ? (
          <div className="loading">
            <div className="loading-spinner"></div>
            <div className="loading-text">Calculating elevation profile...</div>
          </div>
        ) : elevationProfile.length === 0 ? (
          <div className="no-data">
            Draw a flight path on the map to see the elevation profile
          </div>
        ) : (
          <svg ref={svgRef} className="elevation-chart"></svg>
        )}
      </div>
      {isClimbAmountOpen && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">Apply climb</div>
              <button className="climb-modal__close" onClick={() => { setIsClimbAmountOpen(false); setClimbAmountError(null); setPendingClimbEnd(null); }}>×</button>
            </div>
            <div className="climb-modal__body">
              <div className="climb-modal__label">Climb end distance</div>
              <div className="climb-modal__hint">{pendingClimbEnd !== null ? `${pendingClimbEnd.toFixed(1)} m` : 'Click the profile to pick a climb end.'}</div>
              <label className="climb-modal__label" htmlFor="climb-amount-input">Change in altitude (m)</label>
              <input
                id="climb-amount-input"
                type="number"
                step="0.1"
                min="0"
                value={climbAmountInput}
                onChange={(e) => setClimbAmountInput(e.target.value)}
                className="climb-modal__input"
              />
              <div className="climb-modal__hint">
                Climb starts earlier by {climbConfig.hvRatio}:1 (horizontal:vertical) to finish at this point.
                {climbConfig.allowTurnsDuringClimb ? ' Climb continues through turns.' : ' Climb pauses while turning.'}
              </div>
              {climbAmountError && <div className="climb-modal__error">{climbAmountError}</div>}
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-tertiary" type="button" onClick={() => setIsClimbAmountOpen(false)}>Cancel</button>
              {climbRequests.length > 0 && (
                <button className="btn btn-tertiary" type="button" onClick={handleRemoveClimb}>
                  Remove all climbs
                </button>
              )}
              <button className="btn btn-primary" type="button" onClick={handleConfirmClimb}>Apply climb</button>
            </div>
          </div>
        </div>
      )}
      {climbValidationPopup && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">Climb warning</div>
              <button className="climb-modal__close" onClick={() => setClimbValidationPopup(null)}>×</button>
            </div>
            <div className="climb-modal__body">
              <div className="climb-modal__error" role="alert">{climbValidationPopup}</div>
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-primary" type="button" onClick={() => setClimbValidationPopup(null)}>OK</button>
            </div>
          </div>
        </div>
      )}
      {isClimbConfigOpen && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">Climb settings</div>
              <button className="climb-modal__close" onClick={() => setIsClimbConfigOpen(false)}>×</button>
            </div>
            <div className="climb-modal__body">
              <label className="climb-modal__label" htmlFor="hv-ratio-input">Horizontal meters per 1 m climb</label>
              <input
                id="hv-ratio-input"
                type="number"
                step="0.1"
                min="0.1"
                value={climbConfigDraft.hvRatio}
                onChange={(e) => setClimbConfigDraft((prev) => ({ ...prev, hvRatio: e.target.value }))}
                className="climb-modal__input"
              />
              <label className="climb-modal__toggle">
                <input
                  type="checkbox"
                  checked={climbConfigDraft.allowTurnsDuringClimb}
                  onChange={(e) => setClimbConfigDraft((prev) => ({ ...prev, allowTurnsDuringClimb: e.target.checked }))}
                />
                Allow climb through turns (otherwise, climb pauses until the turn ends)
              </label>
              <div className="climb-modal__hint">
                Changes apply immediately to new climbs. Existing climbs are recalculated with the new policy.
              </div>
              {climbConfigError && <div className="climb-modal__error">{climbConfigError}</div>}
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-tertiary" type="button" onClick={() => setIsClimbConfigOpen(false)}>Cancel</button>
              <button className="btn btn-primary" type="button" onClick={handleSaveClimbConfig}>Save</button>
            </div>
          </div>
        </div>
      )}
      {climbContextMenu && (
        <div
          className="climb-context-menu"
          style={{ left: climbContextMenu.x, top: climbContextMenu.y }}
          ref={climbContextMenuRef}
          role="menu"
        >
          <button
            type="button"
            className="climb-context-item"
            onClick={() => {
              setClimbContextMenu(null);
              setPendingClimbEnd(climbContextMenu.endDistance);
              setClimbAmountInput(climbContextMenu.climbAmount.toString());
              setClimbAmountError(null);
              setIsClimbAmountOpen(true);
            }}
          >
            Edit climb
          </button>
          <button
            type="button"
            className="climb-context-item destructive"
            onClick={() => {
              handleRemoveSingleClimb(climbContextMenu.endDistance);
              setClimbContextMenu(null);
            }}
          >
            Delete climb
          </button>
        </div>
      )}
      {elevationProfile.length > 0 && (
        <div className="elevation-stats">
          <div className="stat">
            <span className="stat-label">Min Elevation:</span>
            <span className="stat-value">
              {Math.min(...elevationProfile.map(p => p.elevation)).toFixed(1)} m
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Max Elevation:</span>
            <span className="stat-value">
              {Math.max(...elevationProfile.map(p => p.elevation)).toFixed(1)} m
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Elevation Range:</span>
            <span className="stat-value">
              {(Math.max(...elevationProfile.map(p => p.elevation)) -
                Math.min(...elevationProfile.map(p => p.elevation))).toFixed(1)} m
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Total Distance:</span>
            <span className="stat-value">
              {elevationProfile[elevationProfile.length - 1]?.distance.toFixed(1)} m
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ElevationProfile;


