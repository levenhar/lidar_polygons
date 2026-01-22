import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import CoordinateTooltip from './CoordinateTooltip';
import ClimbConstraints1DGraph from './ClimbConstraints1DGraph';
import './ElevationProfile.css';
import './ClimbConstraints1DGraph.css';
import { ClimbConfig, computeClimbProfile, BaseAltitudeSample, ClimbPreset } from '../utils/climb';
import { latLngToUTM } from '../utils/coordinates';
import { computeCumulativeDistances, getNearestConstraints } from '../utils/constraints';

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

const ZoomResetIcon: React.FC = () => {
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
      <path {...stroke} d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline {...stroke} points="9 22 9 12 15 12 15 22" />
    </svg>
  );
};

const ZoomInIcon: React.FC = () => {
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
      <circle {...stroke} cx="11" cy="11" r="8" />
      <path {...stroke} d="M21 21l-4.35-4.35" />
      <path {...stroke} d="M11 8v6" />
      <path {...stroke} d="M8 11h6" />
    </svg>
  );
};

const ZoomOutIcon: React.FC = () => {
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
      <circle {...stroke} cx="11" cy="11" r="8" />
      <path {...stroke} d="M21 21l-4.35-4.35" />
      <path {...stroke} d="M8 11h6" />
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
  hoveredPoint?: ElevationPoint | null;
  hoverSource?: 'map' | 'profile' | null;
  climbPresets: ClimbPreset[];
  selectedClimbPresetId: string;
  climbConfig: ClimbConfig;
  climbRequests: { endDistance: number; climbAmount: number }[];
  setClimbRequests: React.Dispatch<React.SetStateAction<{ endDistance: number; climbAmount: number }[]>>;
  climbWarnings: string[];
  showMetadata: boolean;
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
  onElevationPointHover,
  hoveredPoint,
  hoverSource,
  climbPresets,
  selectedClimbPresetId,
  climbConfig,
  climbRequests,
  setClimbRequests,
  climbWarnings,
  showMetadata
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const clipPathIdRef = useRef(`elevation-clip-${Math.random().toString(36).slice(2, 8)}`);
  const savedZoomTransformRef = useRef<d3.ZoomTransform | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGRectElement, unknown> | null>(null);
  const overlayRef = useRef<d3.Selection<SVGRectElement, unknown, null, undefined> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [isClimbAmountOpen, setIsClimbAmountOpen] = useState(false);
  const [pendingClimbEnd, setPendingClimbEnd] = useState<number | null>(null);
  const [climbAmountInput, setClimbAmountInput] = useState<string>('');
  const [climbAmountError, setClimbAmountError] = useState<string | null>(null);
  const [climbValidationPopup, setClimbValidationPopup] = useState<string | null>(null);
  const [showDeleteAllConfirmation, setShowDeleteAllConfirmation] = useState(false);
  const [climbContextMenu, setClimbContextMenu] = useState<{ x: number; y: number; endDistance: number; climbAmount: number } | null>(null);
  const climbContextMenuRef = useRef<HTMLDivElement | null>(null);
  // Track the climb being edited to exclude it from constraint checks
  const [editingClimb, setEditingClimb] = useState<{ endDistance: number; climbAmount: number } | null>(null);

  // Log state changes for debugging
  useEffect(() => {
    console.log('[STATE] contextMenu changed:', contextMenu ? { x: contextMenu.x, y: contextMenu.y, pointIndex: contextMenu.pointIndex } : null);
  }, [contextMenu]);

  useEffect(() => {
    console.log('[STATE] climbContextMenu changed:', climbContextMenu ? { x: climbContextMenu.x, y: climbContextMenu.y, endDistance: climbContextMenu.endDistance, climbAmount: climbContextMenu.climbAmount } : null);
  }, [climbContextMenu]);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const hoveredUtm = useMemo(() => {
    if (!hoveredPoint) return null;
    return latLngToUTM(hoveredPoint.latitude, hoveredPoint.longitude);
  }, [hoveredPoint]);

  const selectedPreset = useMemo(
    () => climbPresets.find((p) => p.id === selectedClimbPresetId),
    [climbPresets, selectedClimbPresetId]
  );

  // Precompute cumulative distances at each vertex for constraint calculations
  const vertexDistances = useMemo(() => {
    return computeCumulativeDistances(flightPath);
  }, [flightPath]);

  // Function to check if a location is too close to a turn vertex, start point, or end point
  const isTooCloseToTurnVertex = useCallback((distance: number): { isValid: boolean; message: string | null } => {
    // Check distance to all vertices (including start, end, and turn points)
    for (let i = 0; i < vertexDistances.length; i++) {
      const vertexDistance = vertexDistances[i];
      const distanceToVertex = Math.abs(distance - vertexDistance);
      
      if (distanceToVertex < climbConfig.vertexProximityMeters) {
        let pointType: string;
        if (i === 0) {
          pointType = 'נקודת התחלה';
        } else if (i === vertexDistances.length - 1) {
          pointType = 'נקודת סיום';
        } else {
          pointType = 'נקודת פנייה';
        }
        
        const msg = `לא ניתן ליצור נקודת עלייה ב-${distance.toFixed(1)} מ'. מיקום זה קרוב מדי ל${pointType} ` +
          `ב-${vertexDistance.toFixed(1)} מ'. המרחק המינימלי הנדרש: ${climbConfig.vertexProximityMeters} מ' (נוכחי: ${distanceToVertex.toFixed(1)} מ').`;
        return { isValid: false, message: msg };
      }
    }
    return { isValid: true, message: null };
  }, [vertexDistances, climbConfig]);

  // Function to check if a location is within a forbidden climb area (climb area + buffer)
  const isLocationInForbiddenClimbArea = useCallback((distance: number): { isValid: boolean; message: string | null } => {
    for (const existingClimb of climbRequests) {
      // Skip the climb being edited (if any)
      if (editingClimb && 
          Math.abs(existingClimb.endDistance - editingClimb.endDistance) < 0.01 &&
          Math.abs(existingClimb.climbAmount - editingClimb.climbAmount) < 0.01) {
        continue;
      }
      
      const existingRatio = existingClimb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const existingRequiredHorizontal = Math.abs(existingClimb.climbAmount) * existingRatio;
      const existingStart = Math.max(0, existingClimb.endDistance - existingRequiredHorizontal);
      const existingEnd = existingClimb.endDistance;
      
      // Calculate forbidden area: climb area + buffer before and after
      const forbiddenStart = existingStart - climbConfig.vertexProximityMeters;
      const forbiddenEnd = existingEnd + climbConfig.vertexProximityMeters;
      
      // Check if the location falls within the forbidden area
      if (distance >= forbiddenStart && distance <= forbiddenEnd) {
        const msg = `לא ניתן ליצור נקודת עלייה ב-${distance.toFixed(1)} מ'. מיקום זה נמצא באזור האסור של עלייה קיימת ` +
          `(${existingStart.toFixed(1)} מ' - ${existingEnd.toFixed(1)} מ') והחיץ שלה (±${climbConfig.vertexProximityMeters} מ').`;
        return { isValid: false, message: msg };
      }
    }
    return { isValid: true, message: null };
  }, [climbRequests, climbConfig, editingClimb]);

  // Get total route length from elevation profile
  const totalRouteLength = useMemo(() => {
    if (elevationProfile.length === 0) return 0;
    return elevationProfile[elevationProfile.length - 1].distance;
  }, [elevationProfile]);

  // Calculate max climb/descent values for display
  const maxValues = useMemo(() => {
    if (pendingClimbEnd === null || totalRouteLength === 0 || vertexDistances.length === 0) {
      return { maxClimbUp: 0, maxDescend: 0 };
    }
    
    const constraintResult = getNearestConstraints(
      pendingClimbEnd,
      climbConfig,
      vertexDistances,
      climbRequests,
      totalRouteLength
    );
    // @ts-ignore
    const { left, right } = constraintResult;
    
    // Calculate distances to constraints with buffer (same logic as ClimbConstraints1DGraph)
    const distanceToLeftConstraint = left 
      ? Math.max(0, pendingClimbEnd - left.distance - climbConfig.vertexProximityMeters)
      : Math.max(0, pendingClimbEnd - climbConfig.vertexProximityMeters);
    // const distanceToRightConstraint = right
    //   ? Math.max(0, right.distance - pendingClimbEnd - climbConfig.vertexProximityMeters)
    //   : Math.max(0, (totalRouteLength - pendingClimbEnd) - climbConfig.vertexProximityMeters);
    
    // Always use distance from start or from the previous limit point (left constraint)
    const dAvail = distanceToLeftConstraint;
    
    // Calculate maximum climb/descent based on available distance to constraints
    // Always round down (floor) to ensure we don't exceed the limit
    const maxClimbUp = Math.floor((dAvail / climbConfig.climbRatio) * 10) / 10;
    const maxDescend = Math.floor((dAvail / climbConfig.descentRatio) * 10) / 10;
    
    return { maxClimbUp, maxDescend };
  }, [pendingClimbEnd, totalRouteLength, vertexDistances, climbConfig, climbRequests]);

  // Calculate tooltip position to keep it on screen
  useLayoutEffect(() => {
    if (!mousePos || !tooltipRef.current || !showMetadata || !hoveredPoint || hoverSource !== 'profile') {
      setTooltipPosition(null);
      return;
    }

    // Use requestAnimationFrame to ensure the tooltip is rendered and measured
    requestAnimationFrame(() => {
      if (!tooltipRef.current) return;
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const windowWidth = window.innerWidth;
      const padding = 8;
      const offset = 15;

      let left = mousePos.x + offset;
      
      // Check if tooltip would go off the right edge of the screen
      if (left + tooltipRect.width > windowWidth - padding) {
        // Position at the start of the window with padding
        left = padding;
      }

      // Also check if it would go off the left edge (shouldn't happen, but just in case)
      if (left < padding) {
        left = padding;
      }

      setTooltipPosition({ left, top: mousePos.y + offset });
    });
  }, [mousePos, showMetadata, hoveredPoint, hoverSource]);

  useEffect(() => {
    if (!climbContextMenu) {
      console.log('[CLIMB_MENU] useEffect: climbContextMenu is null, not setting up listeners');
      return;
    }
    console.log('[CLIMB_MENU] useEffect: climbContextMenu is set, setting up global close listeners');
    const handleGlobalClose = (event: MouseEvent) => {
      const target = event.target as Node;
      const contains = climbContextMenuRef.current?.contains(target);
      console.log('[CLIMB_MENU] Global close handler triggered', {
        eventType: event.type,
        target: (target as any)?.tagName,
        contains: contains,
        willClose: !contains
      });
      if (climbContextMenuRef.current && !climbContextMenuRef.current.contains(target)) {
        console.log('[CLIMB_MENU] Closing climb context menu (clicked outside)');
        setClimbContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleGlobalClose);
    document.addEventListener('contextmenu', handleGlobalClose);
    return () => {
      console.log('[CLIMB_MENU] useEffect cleanup: removing global close listeners');
      document.removeEventListener('mousedown', handleGlobalClose);
      document.removeEventListener('contextmenu', handleGlobalClose);
    };
  }, [climbContextMenu]);

  const getPlannedAltitudeAtDistance = useCallback(
    (distance: number) => {
      if (elevationProfile.length === 0) return nominalFlightHeight;
      let closest = elevationProfile[0];
      let minDelta = Math.abs(closest.distance - distance);
      for (const p of elevationProfile) {
        const delta = Math.abs(p.distance - distance);
        if (delta < minDelta) {
          closest = p;
          minDelta = delta;
        }
      }
      return closest.plannedAltitude ?? (closest.elevation + nominalFlightHeight);
    },
    [elevationProfile, nominalFlightHeight]
  );

  const activeClimbStartDistance = null;

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || elevationProfile.length === 0 || loading) {
      return;
    }

    console.log(`ElevationProfile: Rendering with ${elevationProfile.length} points, updating min/max and safety/resolution lines`);

    const svg = d3.select(svgRef.current);
    // Save zoom transform before clearing (use existing transform if available, otherwise use saved one)
    const existingOverlay = svg.select('rect[fill="transparent"]').node() as SVGRectElement | null;
    const existingTransform = existingOverlay ? d3.zoomTransform(existingOverlay) : null;
    if (existingTransform && (existingTransform.k !== 1 || existingTransform.x !== 0 || existingTransform.y !== 0)) {
      savedZoomTransformRef.current = existingTransform;
    }
    svg.selectAll('*').remove(); // Clear previous render

    const margin = { top: 20, right: 80, bottom: 110, left: 30 };
    const legendWidth = 0; // Move legend under the plot
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

    // Create scales
    const baseXScale = d3.scaleLinear()
      .domain(d3.extent(elevationProfile, d => d.distance) as [number, number])
      .range([width, 0]);

    const chartArea: d3.Selection<SVGGElement, unknown, null, undefined> = g.append('g')
      .attr('clip-path', `url(#${clipPathIdRef.current})`);

    const plannedAltitudes = elevationProfile.map((p) => p.plannedAltitude || (p.elevation + nominalFlightHeight));
    const baseAltitudes = elevationProfile.map((p) => p.baseAltitude || (p.elevation + nominalFlightHeight));

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

    // Calculate max elevation including safety line (maxElevation + safetyHeight or elevation + safetyHeight)
    const maxWithSafety = Math.max(
      ...(allMaxElevations.length > 0 
        ? allMaxElevations.map(e => e + safetyHeight)
        : elevationProfile.map(d => d.elevation + safetyHeight))
    );

    // Calculate max elevation including resolution line (minElevation + resolutionHeight or elevation + resolutionHeight)
    const maxWithResolution = Math.max(
      ...(allMinElevations.length > 0
        ? allMinElevations.map(e => e + resolutionHeight)
        : elevationProfile.map(d => d.elevation + resolutionHeight))
    );

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

    // Add grid lines first (behind all other elements)
    const xAxisGrid = d3.axisBottom(currentXScale)
      .ticks(10)
      .tickSize(-height)
      .tickFormat(() => '');

    const yAxisGrid = d3.axisRight(currentYScale)
      .ticks(10)
      .tickSize(-width)
      .tickFormat(() => '');

    const xGridGroup = chartArea.append('g')
      .attr('class', 'grid')
      .attr('stroke', '#e5e7eb')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,4')
      .attr('opacity', 0.6)
      .lower() // Ensure grid is behind other elements
      .call(xAxisGrid);

    const yGridGroup = chartArea.append('g')
      .attr('class', 'grid')
      .attr('stroke', '#e5e7eb')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,4')
      .attr('opacity', 0.6)
      .attr('transform', `translate(${width},0)`)
      .lower() // Ensure grid is behind other elements
      .call(yAxisGrid);

    // Selections we need to update on zoom/pan
    /* 
    let rangeBars: d3.Selection<SVGLineElement, ElevationPoint, any, any> | null = null;
    let minMarkers: d3.Selection<SVGCircleElement, ElevationPoint, any, any> | null = null;
    let maxMarkers: d3.Selection<SVGCircleElement, ElevationPoint, any, any> | null = null;
    */
    let selectedDistanceLine: d3.Selection<SVGLineElement, unknown, any, any> | null = null;
    let selectedDistance: number | null = null;
    let climbEndMarkers: d3.Selection<SVGGElement, any, any, any> | null = null;
    let climbStartMarkers: d3.Selection<SVGGElement, any, any, any> | null = null;
    let climbLabels: d3.Selection<SVGTextElement, any, any, any> | null = null;
    const profileWithPlan = elevationProfile.map((p) => {
      const planned = p.plannedAltitude ?? (p.elevation + nominalFlightHeight);
      const baseAltitude = p.baseAltitude ?? planned;
      const climbDelta = p.climbDelta ?? 0;
      return {
        ...p,
        plannedAltitude: planned,
        baseAltitude,
        climbDelta
      };
    });

    // Fill area under ground (draw before line so line appears on top)
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

    // Draw violation areas (resolution and safety) - before flight path so it appears behind
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

    resolutionViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(resolutionSegments)
      .enter()
      .append('path')
      .attr('fill', '#16A34A')
      .attr('fill-opacity', 0.18)
      .attr('d', d => resolutionAreaGenerator(d));

    safetyViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(safetySegments)
      .enter()
      .append('path')
      .attr('fill', '#DC2626')
      .attr('fill-opacity', 0.2)
      .attr('d', d => safetyAreaGenerator(d));

    // Draw base (pre-climb) and planned (post-climb) altitude lines
    /*
    const baseFlightLine = d3.line<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.baseAltitude))
      .curve(d3.curveMonotoneX);
    */

    const plannedFlightLine = d3.line<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.plannedAltitude))
      .curve(d3.curveMonotoneX);

    /* 
    const baseFlightPathLine = chartArea.append('path')
      .datum(profileWithPlan)
      .attr('fill', 'none')
      .attr('stroke', '#1E90FF')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', climbRequests.length > 0 ? '6,4' : '0')
      .attr('d', baseFlightLine);
    */

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

    // Draw min/max elevation range bars (behind everything else)
    const pointsWithMinMax = elevationProfile.filter(
      d => d.minElevation !== undefined && d.maxElevation !== undefined
    );

    console.log(`ElevationProfile render: ${elevationProfile.length} total points, ${pointsWithMinMax.length} with min/max`);

    if (pointsWithMinMax.length > 0) {
      console.log(`Drawing min/max range bars for ${pointsWithMinMax.length} points`);

      /*
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
      */
    } else {
      // Remove any existing min/max elements if there are no points
      g.selectAll('.elevation-range-bar').remove();
      g.selectAll('.min-elevation-marker').remove();
      g.selectAll('.max-elevation-marker').remove();
      /*
      rangeBars = null;
      minMarkers = null;
      maxMarkers = null;
      */
    }

    // Climb visualization (shaded area between base and climbed altitude)
    /*
    const climbSegments = buildSegments(profileWithPlan, (d) => Math.abs(d.climbDelta) > 0.05);
    const climbGroup = chartArea.append('g').attr('class', 'climb-areas');
    const climbAreaGenerator = d3.area<typeof profileWithPlan[0]>()
      .x(d => currentXScale(d.distance))
      .y0(d => currentYScale(d.baseAltitude))
      .y1(d => currentYScale(d.plannedAltitude))
      .curve(d3.curveMonotoneX);
    */

    /*
    _climbAreas = climbGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(climbSegments)
      .enter()
      .append('path')
      .attr('fill', '#6f42c1')
      .attr('fill-opacity', 0.18)
      .attr('stroke', 'none')
      .attr('d', d => climbAreaGenerator(d));
    */

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
    groundPoints.on('contextmenu', function (event: any, d: { point: ElevationPoint; index: number }) {
      console.log('[GROUND_POINT] Ground point contextmenu event fired', {
        pointIndex: d.index,
        distance: d.point.distance,
        elevation: d.point.elevation,
        eventType: event.type
      });
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      console.log('[GROUND_POINT] Closing climb context menu, opening regular context menu');
      // Close climb context menu if open
      setClimbContextMenu(null);
      setContextMenu({
        x: clickX,
        y: clickY,
        pointIndex: d.index
      });
      console.log('[GROUND_POINT] Regular context menu set for point index:', d.index);
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
    flightPoints.on('contextmenu', function (event: any, d: { point: ElevationPoint; index: number }) {
      console.log('[FLIGHT_POINT] Flight point contextmenu event fired', {
        pointIndex: d.index,
        distance: d.point.distance,
        elevation: d.point.elevation,
        eventType: event.type
      });
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      console.log('[FLIGHT_POINT] Closing climb context menu, opening regular context menu');
      // Close climb context menu if open
      setClimbContextMenu(null);
      setContextMenu({
        x: clickX,
        y: clickY,
        pointIndex: d.index
      });
      console.log('[FLIGHT_POINT] Regular context menu set for point index:', d.index);
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
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .style('font-weight', '500')
      .text(d => d.index + 1);

    // Add axes
    const xAxis = d3.axisBottom(currentXScale)
      .ticks(10)
      .tickFormat(d => `${d} מ'`);

    const yAxis = d3.axisRight(currentYScale)
      .ticks(10)
      .tickFormat(d => `${d} מ'`)
      .tickPadding(40);

    const xAxisGroup = g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);

    xAxisGroup.selectAll('text')
      .style('font-size', '12px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');

    const yAxisGroup = g.append('g')
      .attr('transform', `translate(${width},0)`)
      .call(yAxis);

    yAxisGroup.selectAll('text')
      .style('font-size', '12px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .attr('dx', '-0.5em');

    // Axis labels (outside axis groups to avoid being cleared on zoom redraw)
    g.append('text')
      .attr('class', 'x-axis-label')
      .attr('x', width / 2)
      .attr('y', height + 50)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .style('font-size', '14px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .text('מרחק (מטרים)');


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

    // Highlight hovered point
    let hoveredDistanceLine: d3.Selection<SVGLineElement, unknown, any, any> | null = null;
    let hoveredPointMarker: d3.Selection<SVGCircleElement, unknown, any, any> | null = null;
    let hoveredDistance: number | null = null;

    if (hoveredPoint) {
      hoveredDistance = hoveredPoint.distance;
      hoveredDistanceLine = chartArea.append('line')
        .attr('x1', currentXScale(hoveredPoint.distance))
        .attr('x2', currentXScale(hoveredPoint.distance))
        .attr('y1', 0)
        .attr('y2', height)
        .attr('stroke', '#9B59B6')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '3,3');

      hoveredPointMarker = chartArea.append('circle')
        .attr('cx', currentXScale(hoveredPoint.distance))
        .attr('cy', currentYScale(getPlannedAltitudeAtDistance(hoveredPoint.distance)))
        .attr('r', 5)
        .attr('fill', '#9B59B6')
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 2);
    }

    const endMarkersData = climbRequests.map((c) => ({ endDistance: c.endDistance, climbAmount: c.climbAmount }));

    climbEndMarkers = chartArea.selectAll<SVGGElement, any>('.climb-end-marker')
      .data(endMarkersData)
      .enter()
      .append('g')
      .attr('class', 'climb-end-marker')
      .on('contextmenu', (event, d) => {
        console.log('[CLIMB_MARKER] Direct climb marker contextmenu event fired', {
          endDistance: d.endDistance,
          climbAmount: d.climbAmount,
          eventType: event.type,
          target: (event.target as any)?.tagName
        });
        event.preventDefault();
        event.stopPropagation();
        const clickX = (event as MouseEvent).clientX;
        const clickY = (event as MouseEvent).clientY;
        console.log('[CLIMB_MARKER] Setting climb context menu, closing regular context menu');
        // Close regular context menu if open
        setContextMenu(null);
        setClimbContextMenu({ x: clickX, y: clickY, endDistance: d.endDistance, climbAmount: d.climbAmount });
        console.log('[CLIMB_MARKER] Climb context menu set:', { x: clickX, y: clickY, endDistance: d.endDistance, climbAmount: d.climbAmount });
      });

    climbEndMarkers.append('circle')
      .attr('cx', d => currentXScale(d.endDistance))
      .attr('cy', d => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)))
      .attr('r', 5)
      .attr('fill', '#6f42c1')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .style('cursor', 'context-menu');

    // Add start markers for each climb point
    const startMarkersData = climbRequests.map((c) => {
      const activeRatio = c.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const requiredHorizontal = Math.abs(c.climbAmount) * activeRatio;
      const startDistance = Math.max(0, c.endDistance - requiredHorizontal);
      return { startDistance, endDistance: c.endDistance, climbAmount: c.climbAmount };
    });

    climbStartMarkers = chartArea.selectAll<SVGGElement, any>('.climb-start-marker')
      .data(startMarkersData)
      .enter()
      .append('g')
      .attr('class', 'climb-start-marker');

    climbStartMarkers.append('rect')
      .attr('x', d => currentXScale(d.startDistance) - 4)
      .attr('y', d => currentYScale(getPlannedAltitudeAtDistance(d.startDistance)) - 4)
      .attr('width', 8)
      .attr('height', 8)
      .attr('fill', '#6f42c1')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .attr('rx', 1)
      .style('cursor', 'default');

    // Add climb amount labels
    climbLabels = chartArea.selectAll<SVGTextElement, any>('.climb-label')
      .data(endMarkersData)
      .enter()
      .append('text')
      .attr('class', 'climb-label')
      .attr('x', d => currentXScale(d.endDistance))
      .attr('y', d => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)) - 8)
      .attr('text-anchor', 'middle')
      .attr('fill', '#6f42c1')
      .attr('font-size', '12px')
      .attr('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .attr('font-weight', 'bold')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', '3')
      .attr('paint-order', 'stroke')
      .text(d => {
        const sign = d.climbAmount >= 0 ? '+' : '';
        return `${sign}${d.climbAmount.toFixed(0)} מ'`;
      });

    // Add legend under the graph area
    const legendOffset = 80; // Increased spacing
    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${height + margin.top + legendOffset})`);

    const legendData = [
      { label: 'גובה קרקע', color: '#8B4513', style: 'solid' },
      { label: 'גובה טיסה', color: '#6f42c1', style: 'solid' },
      { label: `בטיחות (+${safetyHeight}מ')`, color: '#DC2626', style: 'dashed' },
      { label: `רזולוציה (+${resolutionHeight}מ')`, color: '#16A34A', style: 'dashed' }
    ];

    // Calculate the width of each label and total width
    const tempText = svg.append('text')
      .style('font-size', '14px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .style('visibility', 'hidden');

    const spacing = 30;
    const lineWidth = 100;
    const lineToTextGap = 10;
    const itemWidths: number[] = [];
    let totalLegendWidth = 0;

    legendData.forEach(item => {
      tempText.text(item.label);
      const textWidth = (tempText.node() as SVGTextElement)?.getBBox().width || 0;
      const itemWidth = lineWidth + lineToTextGap + textWidth;
      itemWidths.push(itemWidth);
      totalLegendWidth += itemWidth;
    });
    totalLegendWidth += spacing * (legendData.length - 1); // Add spacing between items
    tempText.remove();

    // Layout legend items horizontally from right to left
    let currentX = width - totalLegendWidth; // Start from the right

    legendData.forEach((item, index) => {
      const legendItem = legend.append('g')
        .attr('transform', `translate(${currentX}, 0)`);

      // Line marker on the left
      legendItem.append('line')
        .attr('x1', 0)
        .attr('x2', lineWidth)
        .attr('y1', 0)
        .attr('y2', 0)
        .attr('stroke', item.color)
        .attr('stroke-width', item.style === 'dashed' ? 3 : 2)
        .attr('stroke-dasharray', item.style === 'dashed' ? '8,5' : '0');

      // Text label right after the line marker
      legendItem.append('text')
        .attr('class', 'legend-text')
        .attr('x', lineWidth + lineToTextGap)
        .attr('y', 4)
        .attr('fill', 'black')
        .style('font-size', '14px')
        .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
        .style('text-anchor', 'end')
        .text(item.label);

      currentX += itemWidths[index] + spacing;
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
        // Save the transform so it persists across re-renders
        savedZoomTransformRef.current = event.transform;
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
        xAxisGroup.selectAll('text')
          .style('font-size', '12px')
          .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
        yAxisGroup.selectAll('text')
          .style('font-size', '12px')
          .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
          .attr('dx', '-0.5em');

        const updatedGroundAreaGenerator = d3.area<ElevationPoint>()
          .x(d => currentXScale(d.distance))
          .y0(height)
          .y1(d => currentYScale(d.elevation))
          .curve(d3.curveMonotoneX);
        groundArea.attr('d', updatedGroundAreaGenerator);
        groundPath.attr('d', groundLine);
        // baseFlightPathLine.attr('d', baseFlightLine);
        plannedFlightPathLine.attr('d', plannedFlightLine);
        safetyPath.attr('d', safetyLine);
        resolutionPath.attr('d', resolutionLine);

        /*
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
        */

        /*
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
        */

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

        if (hoveredDistanceLine && hoveredDistance !== null) {
          hoveredDistanceLine
            .attr('x1', currentXScale(hoveredDistance))
            .attr('x2', currentXScale(hoveredDistance));
        }

        if (hoveredPointMarker && hoveredPoint) {
          hoveredPointMarker
            .attr('cx', currentXScale(hoveredPoint.distance))
            .attr('cy', currentYScale(getPlannedAltitudeAtDistance(hoveredPoint.distance)));
        }

        climbEndMarkers?.selectAll<SVGCircleElement, any>('circle')
          .attr('cx', (d: any) => currentXScale(d.endDistance))
          .attr('cy', (d: any) => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)));

        climbStartMarkers?.selectAll<SVGRectElement, any>('rect')
          .attr('x', (d: any) => currentXScale(d.startDistance) - 4)
          .attr('y', (d: any) => currentYScale(getPlannedAltitudeAtDistance(d.startDistance)) - 4);

        climbLabels
          ?.attr('x', (d: any) => currentXScale(d.endDistance))
          .attr('y', (d: any) => currentYScale(getPlannedAltitudeAtDistance(d.endDistance)) - 8);
      });

    // Store references for zoom controls
    zoomBehaviorRef.current = zoomBehavior;
    overlayRef.current = overlay;
    
    overlay.call(zoomBehavior as any);

    const vertexDistances = new Set(originalVertices.map(v => v.point.distance));

    overlay.on('click', function (event: MouseEvent) {
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

      const clickedDistance = closestPoint.distance;
      
      // Validate that the location is not too close to a turn vertex
      const turnVertexValidation = isTooCloseToTurnVertex(clickedDistance);
      if (!turnVertexValidation.isValid) {
        setClimbValidationPopup(turnVertexValidation.message || 'לא ניתן ליצור נקודת עלייה במיקום זה - קרוב מדי לנקודת פנייה.');
        return;
      }
      
      // Validate that the location is not within a forbidden climb area
      const validation = isLocationInForbiddenClimbArea(clickedDistance);
      if (!validation.isValid) {
        setClimbValidationPopup(validation.message || 'לא ניתן ליצור נקודת עלייה במיקום זה.');
        return;
      }
      
      setPendingClimbEnd(clickedDistance);
      setClimbAmountInput('');
      setClimbAmountError(null);
      setEditingClimb(null); // Clear any editing state when creating a new climb
      setIsClimbAmountOpen(true);
    });

    // Allow right-click to open the existing point context menu even with the overlay present
    overlay.on('contextmenu', function (event: MouseEvent) {
      console.log('[OVERLAY] Overlay contextmenu event fired', {
        clientX: event.clientX,
        clientY: event.clientY,
        target: (event.target as any)?.tagName,
        currentTarget: (event.currentTarget as any)?.tagName
      });
      
      // Check if we're clicking on a climb marker first - if so, show climb context menu
      // Use a larger threshold (15px) to ensure we catch clicks on climb markers even if slightly off
      const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
      console.log('[OVERLAY] Mouse position in SVG coordinates:', { mouseX, mouseY });
      
      let clickedClimb: { endDistance: number; climbAmount: number } | null = null;

      // Check for climb end markers with higher priority and larger threshold
      console.log('[OVERLAY] Checking', climbRequests.length, 'climb requests for proximity');
      for (const climb of climbRequests) {
        const climbX = currentXScale(climb.endDistance);
        const climbY = currentYScale(getPlannedAltitudeAtDistance(climb.endDistance));
        const distToClimb = Math.sqrt(Math.pow(climbX - mouseX, 2) + Math.pow(climbY - mouseY, 2));
        
        console.log('[OVERLAY] Climb check:', {
          endDistance: climb.endDistance,
          climbAmount: climb.climbAmount,
          climbX,
          climbY,
          distToClimb,
          threshold: 15,
          withinThreshold: distToClimb < 15
        });
        
        // Use 15px threshold to ensure we catch clicks on climb markers
        if (distToClimb < 15) {
          clickedClimb = { endDistance: climb.endDistance, climbAmount: climb.climbAmount };
          console.log('[OVERLAY] ✓ Click detected on climb marker:', clickedClimb);
          break;
        }
      }

      // If clicking on a climb marker, show the climb context menu and prevent regular menu
      if (clickedClimb) {
        console.log('[OVERLAY] Processing climb marker click - preventing default and showing climb menu');
        event.preventDefault();
        event.stopPropagation();
        const clickX = event.clientX || (event as MouseEvent).clientX;
        const clickY = event.clientY || (event as MouseEvent).clientY;
        // Close regular context menu if open
        console.log('[OVERLAY] Closing regular context menu, opening climb context menu');
        setContextMenu(null);
        setClimbContextMenu({ x: clickX, y: clickY, endDistance: clickedClimb.endDistance, climbAmount: clickedClimb.climbAmount });
        console.log('[OVERLAY] Climb context menu set, returning early');
        return; // Don't show regular context menu
      } else {
        console.log('[OVERLAY] No climb marker detected, checking for regular points');
      }

      // Check if we're clicking on an input point
      let clickedInputPoint: { point: ElevationPoint; index: number; isFlight: boolean } | null = null;

      console.log('[OVERLAY] Checking', originalVertices.length, 'original vertices for proximity');
      if (originalVertices.length > 0) {
        for (const vertex of originalVertices) {
          const pointX = currentXScale(vertex.point.distance);
          const groundY = currentYScale(vertex.point.elevation);
          const flightY = currentYScale(getPlannedAltitudeAtDistance(vertex.point.distance));

          // Check if click is within 10 pixels of ground or flight point
          const distToGround = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(groundY - mouseY, 2));
          const distToFlight = Math.sqrt(Math.pow(pointX - mouseX, 2) + Math.pow(flightY - mouseY, 2));

          console.log('[OVERLAY] Vertex check:', {
            index: vertex.index,
            distance: vertex.point.distance,
            pointX,
            groundY,
            flightY,
            distToGround,
            distToFlight,
            withinGroundThreshold: distToGround < 10,
            withinFlightThreshold: distToFlight < 10
          });

          if (distToGround < 10) {
            clickedInputPoint = { point: vertex.point, index: vertex.index, isFlight: false };
            console.log('[OVERLAY] ✓ Click detected on ground point, index:', vertex.index);
            break;
          } else if (distToFlight < 10) {
            clickedInputPoint = { point: vertex.point, index: vertex.index, isFlight: true };
            console.log('[OVERLAY] ✓ Click detected on flight point, index:', vertex.index);
            break;
          }
        }
      }

      // If clicking on an input point, trigger the context menu for that point
      if (clickedInputPoint) {
        console.log('[OVERLAY] Processing regular point click - showing regular context menu');
        event.preventDefault();
        event.stopPropagation();
        const clickX = event.clientX || (event as MouseEvent).clientX;
        const clickY = event.clientY || (event as MouseEvent).clientY;
        // Close climb context menu if open
        console.log('[OVERLAY] Closing climb context menu, opening regular context menu for point index:', clickedInputPoint.index);
        setClimbContextMenu(null);
        setContextMenu({
          x: clickX,
          y: clickY,
          pointIndex: clickedInputPoint.index
        });
        console.log('[OVERLAY] Regular context menu set');
      } else {
        // If not clicking on an input point, prevent default to avoid browser context menu
        console.log('[OVERLAY] No point detected, preventing default browser menu');
        event.preventDefault();
      }
    });

    // Hover interactions reuse the same overlay
    if (onElevationPointHover) {
      overlay.on('mousemove', function (event: MouseEvent) {
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
          // Convert mouse X position to distance using inverse scale
          const hoverDistance = currentXScale.invert(mouseX);
          
          // Clamp to valid range
          const minDistance = elevationProfile[0]?.distance ?? 0;
          const maxDistance = elevationProfile[elevationProfile.length - 1]?.distance ?? 0;
          const clampedDistance = Math.max(minDistance, Math.min(maxDistance, hoverDistance));
          
          // Find the two points that bracket this distance
          let p1: ElevationPoint | null = null;
          let p2: ElevationPoint | null = null;
          
          for (let i = 0; i < elevationProfile.length - 1; i++) {
            if (clampedDistance >= elevationProfile[i].distance && clampedDistance <= elevationProfile[i + 1].distance) {
              p1 = elevationProfile[i];
              p2 = elevationProfile[i + 1];
              break;
            }
          }
          
          // If we're at or beyond the endpoints, use the nearest endpoint
          if (!p1 || !p2) {
            if (clampedDistance <= minDistance) {
              p1 = elevationProfile[0];
              p2 = elevationProfile[0];
            } else if (clampedDistance >= maxDistance) {
              p1 = elevationProfile[elevationProfile.length - 1];
              p2 = elevationProfile[elevationProfile.length - 1];
            }
          }
          
          if (p1 && p2) {
            // Interpolate between the two points
            let interpolatedPoint: ElevationPoint;
            
            if (p1.distance === p2.distance) {
              // Same point, use it directly
              interpolatedPoint = p1;
            } else {
              const t = (clampedDistance - p1.distance) / (p2.distance - p1.distance);
              
              // Interpolate all properties
              interpolatedPoint = {
                distance: clampedDistance,
                latitude: p1.latitude + (p2.latitude - p1.latitude) * t,
                longitude: p1.longitude + (p2.longitude - p1.longitude) * t,
                elevation: p1.elevation + (p2.elevation - p1.elevation) * t,
              };
              
              // Interpolate optional properties if they exist
              if (p1.minElevation !== undefined && p2.minElevation !== undefined) {
                interpolatedPoint.minElevation = p1.minElevation + (p2.minElevation - p1.minElevation) * t;
              }
              if (p1.maxElevation !== undefined && p2.maxElevation !== undefined) {
                interpolatedPoint.maxElevation = p1.maxElevation + (p2.maxElevation - p1.maxElevation) * t;
              }
              if (p1.plannedAltitude !== undefined && p2.plannedAltitude !== undefined) {
                interpolatedPoint.plannedAltitude = p1.plannedAltitude + (p2.plannedAltitude - p1.plannedAltitude) * t;
              }
              if (p1.baseAltitude !== undefined && p2.baseAltitude !== undefined) {
                interpolatedPoint.baseAltitude = p1.baseAltitude + (p2.baseAltitude - p1.baseAltitude) * t;
              }
              if (p1.climbDelta !== undefined && p2.climbDelta !== undefined) {
                interpolatedPoint.climbDelta = p1.climbDelta + (p2.climbDelta - p1.climbDelta) * t;
              }
              // Calculate flightHeight the same way as in map hover: plannedAltitude - elevation
              if (interpolatedPoint.plannedAltitude !== undefined) {
                interpolatedPoint.flightHeight = interpolatedPoint.plannedAltitude - interpolatedPoint.elevation;
              } else if (p1.flightHeight !== undefined && p2.flightHeight !== undefined) {
                // Fallback: interpolate flightHeight if plannedAltitude is not available
                interpolatedPoint.flightHeight = p1.flightHeight + (p2.flightHeight - p1.flightHeight) * t;
              }
            }
            
            // Ensure flightHeight is set for same point case (if it wasn't already set)
            if (interpolatedPoint.flightHeight === undefined && interpolatedPoint.plannedAltitude !== undefined) {
              interpolatedPoint.flightHeight = interpolatedPoint.plannedAltitude - interpolatedPoint.elevation;
            }
            
            setMousePos({ x: event.clientX, y: event.clientY });
            onElevationPointHover(interpolatedPoint);
          }
        }
      });

      overlay.on('mouseleave', () => {
        setMousePos(null);
        if (onElevationPointHover) {
          onElevationPointHover(null);
        }
      });
    }

    // Restore saved zoom transform after all elements and event handlers are set up
    if (savedZoomTransformRef.current) {
      // Use requestAnimationFrame to ensure DOM is fully ready
      requestAnimationFrame(() => {
        d3.select(overlay.node() as any).call(zoomBehavior.transform as any, savedZoomTransformRef.current!);
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
    hoveredPoint,
    activeClimbStartDistance,
    getPlannedAltitudeAtDistance,
    isLocationInForbiddenClimbArea,
    climbRequests,
    climbConfig
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
    const absClimbAmount = Math.abs(parsed);
    if (absClimbAmount < climbConfig.minClimb || absClimbAmount > climbConfig.maxClimb) {
      setClimbAmountError(
        `ערך העלייה חייב להיות בין ${climbConfig.minClimb} ל-${climbConfig.maxClimb} מטרים (ערך נוכחי: ${absClimbAmount.toFixed(1)} מ').`
      );
      return;
    }
    const baseAfterExisting = (() => {
      const startElevation = elevationProfile[0].elevation;
      const constantAltitude = startElevation + nominalFlightHeight;
      let currentBase: BaseAltitudeSample[] = elevationProfile.map((p) => ({
        distance: p.distance,
        baseAltitude: constantAltitude,
        // For new climb point, use maxElevation if available to ensure only maximum value limits the elevation
        ground: p.maxElevation !== undefined ? p.maxElevation : p.elevation
      }));
      // Exclude the climb being edited (if any) from base calculation
      const climbsToProcess = editingClimb
        ? climbRequests.filter(
            (c) =>
              !(Math.abs(c.endDistance - editingClimb.endDistance) < 0.01 &&
                Math.abs(c.climbAmount - editingClimb.climbAmount) < 0.01)
          )
        : climbRequests;
      const sorted = [...climbsToProcess].sort((a, b) => a.endDistance - b.endDistance);
      sorted.forEach((c) => {
        const activeRatio = c.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
        const requiredHorizontal = Math.abs(c.climbAmount) * activeRatio;
        const startDistance = Math.max(0, c.endDistance - requiredHorizontal);
        const res = computeClimbProfile(
          startDistance,
          c.climbAmount,
          climbConfig.climbRatio,
          climbConfig.descentRatio,
          climbConfig.allowTurnsDuringClimb,
          flightPath,
          currentBase,
          climbConfig.vertexProximityMeters,
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

    const activeRatio = parsed > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
    const requiredHorizontal = Math.abs(parsed) * activeRatio;
    const startDistance = Math.max(0, pendingClimbEnd - requiredHorizontal);
    const preview = computeClimbProfile(
      startDistance,
      parsed,
      climbConfig.climbRatio,
      climbConfig.descentRatio,
      climbConfig.allowTurnsDuringClimb,
      flightPath,
      baseAfterExisting,
      climbConfig.vertexProximityMeters,
      pendingClimbEnd
    );

    // Validate that new climb point is far enough from existing climb points
    // This validation ALWAYS applies, regardless of allowTurnsDuringClimb setting
    const newClimbStart = startDistance;
    const newClimbEnd = pendingClimbEnd;

    console.log('Validating climb spacing:', {
      newClimbStart,
      newClimbEnd,
      existingClimbsCount: climbRequests.length,
      vertexProximityMeters: climbConfig.vertexProximityMeters
    });

    for (const existingClimb of climbRequests) {
      // Skip the climb being edited (if any)
      if (editingClimb && 
          Math.abs(existingClimb.endDistance - editingClimb.endDistance) < 0.01 &&
          Math.abs(existingClimb.climbAmount - editingClimb.climbAmount) < 0.01) {
        continue;
      }
      
      const existingRatio = existingClimb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
      const existingRequiredHorizontal = Math.abs(existingClimb.climbAmount) * existingRatio;
      const existingStart = Math.max(0, existingClimb.endDistance - existingRequiredHorizontal);
      const existingEnd = existingClimb.endDistance;

      // Check if intervals overlap or are too close
      // Intervals [newClimbStart, newClimbEnd] and [existingStart, existingEnd]
      // They overlap if: newClimbStart < existingEnd AND newClimbEnd > existingStart
      const intervalsOverlap = newClimbStart < existingEnd && newClimbEnd > existingStart;

      // Calculate minimum distance between intervals
      let minDist;
      if (intervalsOverlap) {
        // Overlapping intervals have 0 distance
        minDist = 0;
      } else if (newClimbEnd <= existingStart) {
        // New climb is entirely before existing climb
        minDist = existingStart - newClimbEnd;
      } else {
        // New climb is entirely after existing climb
        minDist = newClimbStart - existingEnd;
      }

      console.log('Checking against existing climb:', {
        existingStart,
        existingEnd,
        intervalsOverlap,
        minDist,
        threshold: climbConfig.vertexProximityMeters
      });

      if (minDist < climbConfig.vertexProximityMeters) {
        const msg = intervalsOverlap
          ? `New climb (${newClimbStart.toFixed(1)} מ' - ${newClimbEnd.toFixed(1)} מ') overlaps with existing climb ` +
          `(${existingStart.toFixed(1)} מ' - ${existingEnd.toFixed(1)} מ'). Climbs cannot overlap.`
          : `New climb (${newClimbStart.toFixed(1)} מ' - ${newClimbEnd.toFixed(1)} מ') is too close to existing climb ` +
          `(${existingStart.toFixed(1)} מ' - ${existingEnd.toFixed(1)} מ'). ` +
          `Minimum distance required: ${climbConfig.vertexProximityMeters} מ' (current: ${minDist.toFixed(1)} מ').`;
        console.log('VALIDATION FAILED:', msg);
        setClimbAmountError(msg);
        setClimbValidationPopup(msg);
        return;
      }
    }

    const notReachable =
      !climbConfig.allowTurnsDuringClimb &&
      (Math.abs(preview.appliedClimb - parsed) > 1e-3 || (preview.warnings?.length ?? 0) > 0);

    if (notReachable) {
      console.log('Climb not reachable:', {
        appliedClimb: preview.appliedClimb,
        parsed,
        warnings: preview.warnings,
        notReachable
      });
      const msg = 'Climb cancelled: turns are disabled and the requested elevation change cannot be reached at this point.';
      setClimbAmountError('Cannot reach requested climb with turns disabled; adjust amount or enable turns.');
      setClimbValidationPopup(msg);
      return;
    }

    setClimbRequests((prev) => {
      // If editing, remove the specific climb being edited; otherwise remove any climb at the same endDistance
      const filtered = editingClimb
        ? prev.filter(
            (c) =>
              !(Math.abs(c.endDistance - editingClimb.endDistance) < 0.01 &&
                Math.abs(c.climbAmount - editingClimb.climbAmount) < 0.01)
          )
        : prev.filter((c) => Math.abs(c.endDistance - pendingClimbEnd) > 0.01);
      return [...filtered, { endDistance: pendingClimbEnd, climbAmount: parsed }].sort((a, b) => a.endDistance - b.endDistance);
    });
    setIsClimbAmountOpen(false);
    setPendingClimbEnd(null);
    setClimbAmountError(null);
    setEditingClimb(null); // Clear editing state after confirming
  }, [climbAmountInput, pendingClimbEnd, climbRequests, climbConfig, flightPath, elevationProfile, nominalFlightHeight, setClimbRequests, editingClimb]);

  const handleRemoveClimb = useCallback(() => {
    setShowDeleteAllConfirmation(true);
  }, []);

  const handleConfirmDeleteAll = useCallback(() => {
    setClimbRequests([]);
    setPendingClimbEnd(null);
    setShowDeleteAllConfirmation(false);
  }, [setClimbRequests]);

  const handleCancelDeleteAll = useCallback(() => {
    setShowDeleteAllConfirmation(false);
  }, []);

  const handleRemoveSingleClimb = useCallback((endDistance: number, climbAmount: number) => {
    console.log('========================================');
    console.log('[DELETE_CLIMB] handleRemoveSingleClimb CALLED');
    console.log('[DELETE_CLIMB] Target to delete:', { endDistance, climbAmount });
    console.log('[DELETE_CLIMB] Stack trace:', new Error().stack);
    
    // Validate inputs
    if (!Number.isFinite(endDistance) || !Number.isFinite(climbAmount)) {
      console.error('[DELETE_CLIMB] Invalid parameters:', { endDistance, climbAmount });
      return;
    }
    
    // Clear editing state if the deleted climb was being edited
    setEditingClimb((currentEditing) => {
      if (currentEditing &&
          Math.abs(currentEditing.endDistance - endDistance) < 0.01 &&
          Math.abs(currentEditing.climbAmount - climbAmount) < 0.01) {
        console.log('[DELETE_CLIMB] Clearing editing state for deleted climb');
        return null;
      }
      return currentEditing;
    });
    
    setClimbRequests((prev) => {
      // Safety check: ensure we have a valid array
      if (!Array.isArray(prev)) {
        console.error('[DELETE_CLIMB] prev is not an array:', prev);
        return prev;
      }
      
      console.log('[DELETE_CLIMB] Current climb requests before filter:', prev);
      console.log('[DELETE_CLIMB] Total climbs before filter:', prev.length);
      
      // Find the exact climb to remove (must match both endDistance AND climbAmount)
      let matchCount = 0;
      const filtered = prev.filter((c, index) => {
        // Validate climb object
        if (!c || typeof c.endDistance !== 'number' || typeof c.climbAmount !== 'number') {
          console.warn(`[DELETE_CLIMB] Invalid climb object at index ${index}:`, c);
          return true; // Keep invalid entries to avoid data loss
        }
        
        // Check if this climb matches the one we want to delete
        // Use 0.01 tolerance for consistency with other comparisons
        // Ensure both values are valid numbers before comparing
        if (!Number.isFinite(c.endDistance) || !Number.isFinite(c.climbAmount) || 
            !Number.isFinite(endDistance) || !Number.isFinite(climbAmount)) {
          console.warn(`[DELETE_CLIMB] Non-finite values detected in comparison. Climb:`, c, `Target:`, { endDistance, climbAmount });
          return true; // Keep this climb if values are invalid
        }
        
        const endDistDiff = Math.abs(c.endDistance - endDistance);
        const climbAmountDiff = Math.abs(c.climbAmount - climbAmount);
        const endDistMatches = endDistDiff <= 0.01;
        const climbAmountMatches = climbAmountDiff <= 0.01;
        
        // If BOTH match, this is the climb to delete, so filter it out (return false)
        // Otherwise, keep it (return true)
        const shouldKeep = !(endDistMatches && climbAmountMatches);
        
        if (!shouldKeep) {
          matchCount++;
        }
        
        console.log(`[DELETE_CLIMB] Climb ${index}:`, {
          endDistance: c.endDistance,
          climbAmount: c.climbAmount,
          targetEndDistance: endDistance,
          targetClimbAmount: climbAmount,
          endDistDiff,
          climbAmountDiff,
          endDistMatches,
          climbAmountMatches,
          shouldKeep: shouldKeep ? 'KEEP' : 'DELETE'
        });
        
        if (!shouldKeep) {
          console.log('[DELETE_CLIMB] ✓ MATCH FOUND - This climb will be deleted:', c);
        }
        return shouldKeep;
      });
      
      // Additional safety check: ensure we're only deleting exactly one climb
      // Exception: If there's only one climb and it matches, allow deletion (result will be empty array)
      if (matchCount === prev.length && prev.length > 1) {
        console.error(`[DELETE_CLIMB] ERROR: ALL climbs (${matchCount}/${prev.length}) match the deletion criteria! This should not happen. Aborting deletion.`);
        console.log('[DELETE_CLIMB] Target values:', { endDistance, climbAmount, typeEndDistance: typeof endDistance, typeClimbAmount: typeof climbAmount });
        console.log('[DELETE_CLIMB] All climbs:', prev);
        console.log('[DELETE_CLIMB] This suggests the target values match all climbs. Check if:');
        console.log('[DELETE_CLIMB] 1. All climbs have identical values');
        console.log('[DELETE_CLIMB] 2. The tolerance (0.01) is too large');
        console.log('[DELETE_CLIMB] 3. The target values are incorrect');
        return prev; // Return original array to prevent data loss
      }
      
      // If there's only one climb and it matches, allow deletion
      if (matchCount === 1 && prev.length === 1) {
        console.log('[DELETE_CLIMB] Deleting the only climb point. Result will be empty array.');
        return filtered; // This will be an empty array, which is correct
      }
      
      if (matchCount > 1) {
        console.error(`[DELETE_CLIMB] ERROR: Multiple climbs (${matchCount}) match the deletion criteria! This should not happen. Aborting deletion.`);
        return prev; // Return original array to prevent data loss
      }
      
      if (matchCount === 0) {
        console.warn('[DELETE_CLIMB] WARNING: No climb matched the deletion criteria. Nothing will be deleted.');
        console.log('[DELETE_CLIMB] Target values:', { endDistance, climbAmount });
        console.log('[DELETE_CLIMB] Available climbs:', prev);
        // Return the original array since no match was found (filtered === prev in this case)
        return prev;
      }
      
      // Safety check: ensure we didn't accidentally delete everything
      // Exception: If there's only one climb and it matches, allow deletion (result will be empty array)
      if (filtered.length === 0 && prev.length > 1) {
        console.error('[DELETE_CLIMB] WARNING: All climbs would be deleted! Aborting deletion.');
        console.log('[DELETE_CLIMB] This should not happen if matchCount === 1. matchCount:', matchCount);
        return prev; // Return original array to prevent data loss
      }
      
      // If there's only one climb and it matches, allow deletion (result will be empty array)
      if (filtered.length === 0 && prev.length === 1 && matchCount === 1) {
        console.log('[DELETE_CLIMB] Deleting the only climb point. Result will be empty array.');
        return filtered; // This will be an empty array, which is correct
      }
      
      console.log('[DELETE_CLIMB] Filtered climb requests:', filtered);
      console.log('[DELETE_CLIMB] Total climbs after filter:', filtered.length);
      console.log('[DELETE_CLIMB] Climbs removed:', prev.length - filtered.length);
      console.log('========================================');
      
      return filtered;
    });
  }, [setClimbRequests]);

  const resetZoom = useCallback(() => {
    if (!zoomBehaviorRef.current || !overlayRef.current) return;
    const identity = d3.zoomIdentity;
    savedZoomTransformRef.current = identity;
    d3.select(overlayRef.current.node() as any).call(zoomBehaviorRef.current.transform as any, identity);
  }, []);

  const zoomIn = useCallback(() => {
    if (!zoomBehaviorRef.current || !overlayRef.current) return;
    const currentTransform = d3.zoomTransform(overlayRef.current.node() as any);
    const newTransform = currentTransform.scale(1.5);
    // Ensure we don't exceed max zoom
    const maxZoom = 12;
    if (newTransform.k <= maxZoom) {
      savedZoomTransformRef.current = newTransform;
      d3.select(overlayRef.current.node() as any).call(zoomBehaviorRef.current.transform as any, newTransform);
    }
  }, []);

  const zoomOut = useCallback(() => {
    if (!zoomBehaviorRef.current || !overlayRef.current) return;
    const currentTransform = d3.zoomTransform(overlayRef.current.node() as any);
    const newTransform = currentTransform.scale(1 / 1.5);
    // Ensure we don't go below min zoom
    const minZoom = 1;
    if (newTransform.k >= minZoom) {
      savedZoomTransformRef.current = newTransform;
      d3.select(overlayRef.current.node() as any).call(zoomBehaviorRef.current.transform as any, newTransform);
    }
  }, []);

  const exportPNG = () => {
    if (!svgRef.current) return;

    // Calculate statistics based on flight altitude (planned altitude)
    let totalAscent = 0;
    let totalDescent = 0;
    for (let i = 1; i < elevationProfile.length; i++) {
      const prevAltitude = elevationProfile[i - 1].plannedAltitude ?? (elevationProfile[i - 1].elevation + nominalFlightHeight);
      const currAltitude = elevationProfile[i].plannedAltitude ?? (elevationProfile[i].elevation + nominalFlightHeight);
      const altitudeDiff = currAltitude - prevAltitude;
      if (altitudeDiff > 0) {
        totalAscent += altitudeDiff;
      } else if (altitudeDiff < 0) {
        totalDescent += Math.abs(altitudeDiff);
      }
    }

    const minElevation = Math.min(...elevationProfile.map(p => p.elevation));
    const maxElevation = Math.max(...elevationProfile.map(p => p.elevation));
    const elevationRange = maxElevation - minElevation;
    const totalDistance = elevationProfile[elevationProfile.length - 1]?.distance || 0;

    // Find minimum flight height across all points (considering climb points)
    const minFlightHeight = Math.min(
      ...elevationProfile.map(p => {
        const plannedAlt = p.plannedAltitude ?? (p.elevation + nominalFlightHeight);
        return plannedAlt - p.elevation;
      })
    );

    // Find point with minimum elevation
    const minElevationPoint = elevationProfile.reduce((min, p) => 
      p.elevation < min.elevation ? p : min
    );
    const minElevationFlightAltitude = minElevationPoint.plannedAltitude ?? (minElevationPoint.elevation + nominalFlightHeight);
    const maxHeightFromMinPoint = minElevationFlightAltitude - minElevationPoint.elevation;

    // Change legend text-anchor to 'start' for PNG export
    const legendTexts = svgRef.current.querySelectorAll('.legend-text');
    const originalTextAnchors: string[] = [];
    legendTexts.forEach((text, index) => {
      const svgText = text as SVGTextElement;
      originalTextAnchors[index] = svgText.style.textAnchor || 'end';
      svgText.style.textAnchor = 'start';
    });

    const svgData = new XMLSerializer().serializeToString(svgRef.current);

    // Restore original text-anchor for web display
    legendTexts.forEach((text, index) => {
      const svgText = text as SVGTextElement;
      svgText.style.textAnchor = originalTextAnchors[index];
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      // Add extra height for statistics
      const statsHeight = 100;
      canvas.width = img.width;
      canvas.height = img.height + statsHeight;

      if (ctx) {
        // Fill canvas with white background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw the SVG image
        ctx.drawImage(img, 0, 0);

        // Draw statistics background
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, img.height, canvas.width, statsHeight);

        // Draw statistics border
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, img.height);
        ctx.lineTo(canvas.width, img.height);
        ctx.stroke();

        // Configure text style - use Apple system font and right alignment for RTL
        ctx.fillStyle = '#111827';
        ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'right';
        // Set text direction to RTL if supported
        if ('direction' in ctx) {
          (ctx as any).direction = 'rtl';
        }

        // Calculate positions for statistics (right-to-left layout)
        const statPadding = 20;
        const statSpacing = 120;
        const labelY = img.height + 30;
        const valueY = img.height + 55;

        // Draw statistics in RTL order (first item on the right)
        const stats = [
          { label: 'גובה קרקע מינימלי:', value: `${minElevation.toFixed(1)} מ'` },
          { label: 'גובה קרקע מקסימלי:', value: `${maxElevation.toFixed(1)} מ'` },
          { label: 'טווח גובה:', value: `${elevationRange.toFixed(1)} מ'` },
          { label: 'מרחק כולל:', value: `${totalDistance.toFixed(1)} מ'` },
          { label: 'עלייה כוללת:', value: `${totalAscent.toFixed(1)} מ'` },
          { label: 'ירידה כוללת:', value: `${totalDescent.toFixed(1)} מ'` },
          { label: 'גובה טיסה מקסימלי:', value: `${maxHeightFromMinPoint.toFixed(1)} מ'` },
          { label: 'גובה טיסה מינימלי:', value: `${minFlightHeight.toFixed(1)} מ'` }
        ];

        let xPos = canvas.width - statPadding;
        stats.forEach((stat) => {
          // Draw label - right aligned with Apple system font, RTL direction
          ctx.fillStyle = '#6b7280';
          ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'right';
          if ('direction' in ctx) {
            (ctx as any).direction = 'rtl';
          }
          ctx.fillText(stat.label, xPos, labelY);

          // Draw value - right aligned with Apple system font, RTL direction
          ctx.fillStyle = '#111827';
          ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'right';
          if ('direction' in ctx) {
            (ctx as any).direction = 'rtl';
          }
          ctx.fillText(stat.value, xPos, valueY);

          xPos -= statSpacing;
        });
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

    const headers = ['Distance (מ\')', 'Ground Elevation (מ\')', 'Flight Altitude (מ\')', 'AGL (מ\')', 'Longitude', 'Latitude'];
    const rows = elevationProfile.map((point) => {
      const flightAltitude = point.plannedAltitude ?? (point.elevation + nominalFlightHeight);
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

  // Clear hover state when mouse leaves the entire panel
  useEffect(() => {
    if (!panelRef.current) return;

    const handleMouseLeave = () => {
      setMousePos(null);
      if (hoverSource === 'profile' && onElevationPointHover) {
        onElevationPointHover(null);
      }
    };

    const panel = panelRef.current;
    panel.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      panel.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [hoverSource, onElevationPointHover]);

  return (
    <div className="elevation-panel" ref={panelRef}>
      {contextMenu && !climbContextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => {
            console.log('[REGULAR_MENU] Context menu closed');
            setContextMenu(null);
          }}
          onDelete={() => {
            console.log('========================================');
            console.log('[REGULAR_MENU] DELETE POINT BUTTON CLICKED');
            console.log('[REGULAR_MENU] Point index to delete:', contextMenu.pointIndex);
            console.log('[REGULAR_MENU] Stack trace:', new Error().stack);
            console.log('[REGULAR_MENU] Calling onDeletePoint with index:', contextMenu.pointIndex);
            onDeletePoint(contextMenu.pointIndex);
            console.log('[REGULAR_MENU] onDeletePoint call completed');
            setContextMenu(null);
            console.log('========================================');
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
        <div className="elevation-controls">
          <div className="control-group">
            <div className="group-title">נקודות הגבהה</div>
            <div className="group-buttons">
              <Tooltip tooltip={climbRequests.length ? 'הסר את כל העליות' : 'טרם הוגדרה עלייה'}>
                <button
                  onClick={handleRemoveClimb}
                  disabled={climbRequests.length === 0}
                  className="btn btn-destructive btn-icon"
                  type="button"
                  aria-label="הסר עליות"
                >
                  <TrashIcon />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="control-group">
            <div className="group-title">זום</div>
            <div className="group-buttons">
              <Tooltip tooltip="איפוס זום">
                <button
                  onClick={resetZoom}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="איפוס זום"
                  type="button"
                >
                  <ZoomResetIcon />
                  <span className="sr-only">איפוס זום</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="זום פנימה">
                <button
                  onClick={zoomIn}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="זום פנימה"
                  type="button"
                >
                  <ZoomInIcon />
                  <span className="sr-only">זום פנימה</span>
                </button>
              </Tooltip>
              <Tooltip tooltip="זום החוצה">
                <button
                  onClick={zoomOut}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="זום החוצה"
                  type="button"
                >
                  <ZoomOutIcon />
                  <span className="sr-only">זום החוצה</span>
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="control-group">
            <div className="group-title">ייצוא</div>
            <div className="group-buttons">
              <Tooltip tooltip={elevationProfile.length === 0 ? 'אין פרופיל לייצוא עדיין' : 'ייצא את תרשים הגובה כ-PNG'}>
                <button
                  onClick={exportPNG}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="ייצוא PNG"
                  type="button"
                >
                  <ExportIcon type="png" />
                  <span className="sr-only">ייצוא PNG</span>
                </button>
              </Tooltip>
              <Tooltip tooltip={elevationProfile.length === 0 ? 'אין פרופיל לייצוא עדיין' : 'ייצא את נתוני הגובה כ-CSV'}>
                <button
                  onClick={exportCSV}
                  disabled={elevationProfile.length === 0}
                  className="btn btn-secondary btn-icon"
                  aria-label="ייצוא CSV"
                  type="button"
                >
                  <ExportIcon type="csv" />
                  <span className="sr-only">ייצוא CSV</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
      <div className="climb-banner">
        <div className="climb-policy-text">
          לחץ על הפרופיל כדי להוסיף עליות; הקליק מסמן היכן העלייה מסתיימת.
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
            <div className="loading-text">מחשב פרופיל גובה...</div>
          </div>
        ) : elevationProfile.length === 0 ? (
          <div className="no-data">
            שרטט מסלול טיסה על המפה כדי לראות את פרופיל הגובה
          </div>
        ) : (
          <svg ref={svgRef} className="elevation-chart"></svg>
        )}
      </div>
      {isClimbAmountOpen && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">החל עלייה</div>
              <button className="climb-modal__close" onClick={() => { setIsClimbAmountOpen(false); setClimbAmountError(null); setPendingClimbEnd(null); setEditingClimb(null); }}>×</button>
            </div>
            <div className="climb-modal__body">
              <div className="climb-modal__title-row">
                
                <label className="climb-modal__label" htmlFor="climb-amount-input">שינוי בגובה (מ')</label>
                <div className="climb-modal__config-name">
                  {selectedPreset ? `תבנית: ${selectedPreset.name}` : 'תבנית: מותאם אישית'}
                </div>
              </div>
              <input
                id="climb-amount-input"
                type="number"
                step="0.1"
                min="0"
                value={climbAmountInput}
                onChange={(e) => setClimbAmountInput(e.target.value)}
                className="climb-modal__input"
              />
              {/* Maximum values display */}
              {pendingClimbEnd !== null && totalRouteLength > 0 && (
                <div className="climb-modal__max-values">
                  <div className="climb-modal__max-value">
                    <span className="climb-modal__max-label">עלייה מקס':</span>
                    <span className="climb-modal__max-number">
                      {maxValues.maxClimbUp.toFixed(1)} מ'
                    </span>
                  </div>
                  <div className="climb-modal__max-value">
                    <span className="climb-modal__max-label">ירידה מקס':</span>
                    <span className="climb-modal__max-number">
                      {maxValues.maxDescend.toFixed(1)} מ'
                    </span>
                  </div>
                </div>
              )}
              <div className="climb-modal__hint">
                יחס {parseFloat(climbAmountInput) > 0 ? climbConfig.climbRatio : climbConfig.descentRatio} : 1 (אופקי:אנכי).
                {climbConfig.allowTurnsDuringClimb ? '  מאפשר עליה דרך פניות.' : '  אין עליה דרך פניות.'}
              </div>
              {climbAmountError && <div className="climb-modal__error">{climbAmountError}</div>}
              
              {/* Climb Constraints 1D Graph */}
              {pendingClimbEnd !== null && totalRouteLength > 0 && (
                <ClimbConstraints1DGraph
                  selectedDistance={pendingClimbEnd}
                  totalRouteLength={totalRouteLength}
                  vertexDistances={vertexDistances}
                  climbRequests={
                    // Exclude the climb being edited from constraint visualization
                    editingClimb
                      ? climbRequests.filter(
                          (c) =>
                            !(Math.abs(c.endDistance - editingClimb.endDistance) < 0.01 &&
                              Math.abs(c.climbAmount - editingClimb.climbAmount) < 0.01)
                        )
                      : climbRequests
                  }
                  config={climbConfig}
                />
              )}
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-tertiary" type="button" onClick={() => { setIsClimbAmountOpen(false); setEditingClimb(null); }}>ביטול</button>
              <button className="btn btn-primary" type="button" onClick={handleConfirmClimb}>החל עלייה</button>
            </div>
          </div>
        </div>
      )}
      {climbValidationPopup && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">אזהרת עלייה</div>
              <button className="climb-modal__close" onClick={() => setClimbValidationPopup(null)}>×</button>
            </div>
            <div className="climb-modal__body">
              <div className="climb-modal__error" role="alert">{climbValidationPopup}</div>
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-primary" type="button" onClick={() => setClimbValidationPopup(null)}>אישור</button>
            </div>
          </div>
        </div>
      )}
      {showDeleteAllConfirmation && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">מחיקת כל נקודות העלייה</div>
              <button className="climb-modal__close" onClick={handleCancelDeleteAll}>×</button>
            </div>
            <div className="climb-modal__body">
              <div className="climb-modal__error" role="alert">
                האם אתה בטוח שברצונך למחוק את כל נקודות העלייה? פעולה זו לא ניתנת לביטול.
              </div>
            </div>
            <div className="climb-modal__actions">
              <button className="btn btn-tertiary" type="button" onClick={handleCancelDeleteAll}>ביטול</button>
              <button className="btn btn-primary" type="button" onClick={handleConfirmDeleteAll}>מחק הכל</button>
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
          onContextMenu={(e) => {
            console.log('[CLIMB_MENU] Context menu div received contextmenu event - preventing');
            e.preventDefault();
          }}
        >
          <button
            type="button"
            className="climb-context-item"
            onClick={() => {
              setClimbContextMenu(null);
              setPendingClimbEnd(climbContextMenu.endDistance);
              setClimbAmountInput(climbContextMenu.climbAmount.toString());
              setClimbAmountError(null);
              // Track the climb being edited to exclude it from constraint checks
              setEditingClimb({ endDistance: climbContextMenu.endDistance, climbAmount: climbContextMenu.climbAmount });
              setIsClimbAmountOpen(true);
            }}
          >
            ערוך עלייה
          </button>
          <button
            type="button"
            className="climb-context-item destructive"
            onClick={(e) => {
              console.log('========================================');
              console.log('[CLIMB_MENU] DELETE CLIMB BUTTON CLICKED');
              console.log('[CLIMB_MENU] Current flightPath length:', flightPath.length);
              console.log('[CLIMB_MENU] Current climbRequests length:', climbRequests.length);
              console.log('[CLIMB_MENU] Event:', {
                type: e.type,
                target: (e.target as any)?.tagName,
                currentTarget: (e.currentTarget as any)?.tagName,
                button: (e as any).button,
                defaultPrevented: e.defaultPrevented
              });
              
              // CRITICAL: Stop all event propagation immediately
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent?.stopImmediatePropagation?.();
              
              // Validate we have valid climb context menu data
              if (!climbContextMenu || !Number.isFinite(climbContextMenu.endDistance) || !Number.isFinite(climbContextMenu.climbAmount)) {
                console.error('[CLIMB_MENU] Invalid climb context menu data:', climbContextMenu);
                setClimbContextMenu(null);
                return;
              }
              
              console.log('[CLIMB_MENU] Climb context menu data:', {
                endDistance: climbContextMenu.endDistance,
                climbAmount: climbContextMenu.climbAmount,
                x: climbContextMenu.x,
                y: climbContextMenu.y
              });
              console.log('[CLIMB_MENU] Stack trace:', new Error().stack);
              
              // Store the values before closing the menu
              const targetEndDistance = climbContextMenu.endDistance;
              const targetClimbAmount = climbContextMenu.climbAmount;
              
              // Close menus first to prevent any interference
              setClimbContextMenu(null);
              setContextMenu(null);
              
              console.log('[CLIMB_MENU] Calling handleRemoveSingleClimb with:', {
                endDistance: targetEndDistance,
                climbAmount: targetClimbAmount
              });
              
              // Call the delete function with the stored values
              handleRemoveSingleClimb(targetEndDistance, targetClimbAmount);
              
              console.log('[CLIMB_MENU] handleRemoveSingleClimb call completed');
              console.log('========================================');
            }}
            onMouseDown={(e) => {
              // Also prevent propagation on mousedown to catch any early events
              e.stopPropagation();
            }}
          >
            מחק עלייה
          </button>
        </div>
      )}
      {elevationProfile.length > 0 && (() => {
        // Calculate ascent and descent based on flight altitude (planned altitude)
        let totalAscent = 0;
        let totalDescent = 0;
        for (let i = 1; i < elevationProfile.length; i++) {
          const prevAltitude = elevationProfile[i - 1].plannedAltitude ?? (elevationProfile[i - 1].elevation + nominalFlightHeight);
          const currAltitude = elevationProfile[i].plannedAltitude ?? (elevationProfile[i].elevation + nominalFlightHeight);
          const altitudeDiff = currAltitude - prevAltitude;
          if (altitudeDiff > 0) {
            totalAscent += altitudeDiff;
          } else if (altitudeDiff < 0) {
            totalDescent += Math.abs(altitudeDiff);
          }
        }

        // Find minimum flight height across all points (considering climb points)
        const minFlightHeight = Math.min(
          ...elevationProfile.map(p => {
            const plannedAlt = p.plannedAltitude ?? (p.elevation + nominalFlightHeight);
            return plannedAlt - p.elevation;
          })
        );

        // Find point with minimum elevation
        const minElevationPoint = elevationProfile.reduce((min, p) => 
          p.elevation < min.elevation ? p : min
        );
        const minElevationFlightAltitude = minElevationPoint.plannedAltitude ?? (minElevationPoint.elevation + nominalFlightHeight);
        const maxHeightFromMinPoint = minElevationFlightAltitude - minElevationPoint.elevation;

        return (
          <div className="elevation-stats">
            <div className="stat">
              <span className="stat-label">גובה קרקע מינימלי:</span>
              <span className="stat-value">
                {Math.min(...elevationProfile.map(p => p.elevation)).toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">גובה קרקע מקסימלי:</span>
              <span className="stat-value">
                {Math.max(...elevationProfile.map(p => p.elevation)).toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">טווח גובה:</span>
              <span className="stat-value">
                {(Math.max(...elevationProfile.map(p => p.elevation)) -
                  Math.min(...elevationProfile.map(p => p.elevation))).toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">מרחק כולל:</span>
              <span className="stat-value">
                {elevationProfile[elevationProfile.length - 1]?.distance.toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">עלייה כוללת:</span>
              <span className="stat-value">
                {totalAscent.toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">ירידה כוללת:</span>
              <span className="stat-value">
                {totalDescent.toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">גובה טיסה מינימלי :</span>
              <span className="stat-value">
                {minFlightHeight.toFixed(1)} מ'
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">גובה טיסה מקסימלי :</span>
              <span className="stat-value">
                {maxHeightFromMinPoint.toFixed(1)} מ'
              </span>
            </div>
          </div>
        );
      })()}
      {showMetadata && hoveredPoint && mousePos && hoverSource === 'profile' && !contextMenu && !climbContextMenu && (
        <div
          ref={tooltipRef}
          className="hover-metadata-tooltip"
          style={{
            left: tooltipPosition?.left ?? mousePos.x + 15,
            top: tooltipPosition?.top ?? mousePos.y + 15,
            visibility: tooltipPosition ? 'visible' : 'hidden'
          }}
        >
          <CoordinateTooltip point={hoveredPoint} utm={hoveredUtm} />
        </div>
      )}
    </div>
  );
};

export default ElevationProfile;


