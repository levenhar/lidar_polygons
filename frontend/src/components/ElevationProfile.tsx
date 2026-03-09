import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import CoordinateTooltip from './CoordinateTooltip';
import ClimbConstraints1DGraph from './ClimbConstraints1DGraph';
import SaveFileDialog from './SaveFileDialog';
import './ElevationProfile.css';
import './ClimbConstraints1DGraph.css';
import { ClimbConfig, computeClimbProfile, BaseAltitudeSample, ClimbPreset } from '../utils/climb';
import { latLngToUTM } from '../utils/coordinates';
import { computeCumulativeDistances, getNearestConstraints } from '../utils/constraints';
import { findAnchorPointsForClimb, ClimbRequest } from '../utils/climbAnchors';
import { clampZoomTransform } from '../utils/elevationProfileZoom';

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
  safetyRadius: number;
  resolutionHeight: number;
  overlapPercentage: number;
  selectedPoint: Coordinate | null;
  flightPath: Coordinate[];
  onDeletePoint: (index: number) => void;
  onUpdatePoint: (index: number, point: Coordinate) => void;
  onSetFlightHeight: (index: number) => void;
  onEditPointRequest: (index: number) => void;
  onElevationPointHover?: (point: ElevationPoint | null) => void;
  hoveredPoint?: ElevationPoint | null;
  hoverSource?: 'map' | 'profile' | 'overlap' | null;
  climbPresets: ClimbPreset[];
  selectedClimbPresetId: string;
  climbConfig: ClimbConfig;
  climbRequests: ClimbRequest[];
  setClimbRequests: React.Dispatch<React.SetStateAction<ClimbRequest[]>>;
  climbWarnings: string[];
  showMetadata: boolean;
  activeRouteName?: string;
  dtmName?: string;
  profileError?: string | null;
}

const ElevationProfile: React.FC<ElevationProfileProps> = ({
  elevationProfile,
  loading,
  nominalFlightHeight,
  safetyHeight,
  safetyRadius,
  resolutionHeight,
  overlapPercentage,
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
  showMetadata,
  activeRouteName,
  dtmName,
  profileError
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const clipPathIdRef = useRef(`elevation-clip-${Math.random().toString(36).slice(2, 8)}`);
  const savedZoomTransformRef = useRef<d3.ZoomTransform | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGRectElement, unknown> | null>(null);
  const overlayRef = useRef<d3.Selection<SVGRectElement, unknown, null, undefined> | null>(null);
  
  // Track drag state for click vs pan detection
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartTransformRef = useRef<d3.ZoomTransform | null>(null);
  const isPanningRef = useRef(false); // Track if we're actually panning (after threshold)
  // Track container width to trigger chart re-render when it changes (for export)
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pointIndex: number } | null>(null);
  const [isClimbAmountOpen, setIsClimbAmountOpen] = useState(false);
  const [pendingClimbEnd, setPendingClimbEnd] = useState<number | null>(null);
  const [climbAmountInput, setClimbAmountInput] = useState<string>('');
  const [climbAmountError, setClimbAmountError] = useState<string | null>(null);
  const [climbValidationPopup, setClimbValidationPopup] = useState<string | null>(null);
  const [showDeleteAllConfirmation, setShowDeleteAllConfirmation] = useState(false);
  const [climbContextMenu, setClimbContextMenu] = useState<{ x: number; y: number; endDistance: number; climbAmount: number; climbRatio?: number; descentRatio?: number } | null>(null);
  const climbContextMenuRef = useRef<HTMLDivElement | null>(null);
  // Track the climb being edited to exclude it from constraint checks
  const [editingClimb, setEditingClimb] = useState<{ endDistance: number; climbAmount: number } | null>(null);
  // Per-point ratio overrides for the modal (empty string = use global config)
  const [customClimbRatio, setCustomClimbRatio] = useState<string>('');
  const [customDescentRatio, setCustomDescentRatio] = useState<string>('');

  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const [saveFileDialog, setSaveFileDialog] = useState<{
    isOpen: boolean;
    defaultFilename: string;
    fileContent: string | Blob;
    mimeType: string;
  } | null>(null);

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
      
      const existingRatio = existingClimb.climbAmount > 0
        ? (existingClimb.climbRatio ?? climbConfig.climbRatio)
        : (existingClimb.descentRatio ?? climbConfig.descentRatio);
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

  // Effective ratios for the current modal climb point (custom override or global default)
  const modalClimbRatio = parseFloat(customClimbRatio) > 0 ? parseFloat(customClimbRatio) : climbConfig.climbRatio;
  const modalDescentRatio = parseFloat(customDescentRatio) > 0 ? parseFloat(customDescentRatio) : climbConfig.descentRatio;

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
    // Always round down (floor) to ensure we don't exceed the limit, then subtract 0.1 as safety margin
    const maxClimbUp = Math.floor((dAvail / modalClimbRatio) * 10) / 10 - 0.1;
    const maxDescend = Math.floor((dAvail / modalDescentRatio) * 10) / 10 - 0.1;

    return { maxClimbUp, maxDescend };
  }, [pendingClimbEnd, totalRouteLength, vertexDistances, climbConfig, climbRequests, modalClimbRatio, modalDescentRatio]);

  // Calculate tooltip position to keep it on screen
  useLayoutEffect(() => {
    if (!mousePos || !tooltipRef.current || !showMetadata || !hoveredPoint || (hoverSource !== 'profile' && hoverSource !== 'overlap')) {
      setTooltipPosition(null);
      return;
    }

    // Use double requestAnimationFrame to ensure the tooltip is fully rendered and measured
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!tooltipRef.current) return;
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const padding = 8;
        const offset = 15;

        let left = mousePos.x + offset;
        
        // Check if tooltip would go off the right edge of the screen
        if (left + tooltipRect.width > windowWidth - padding) {
          // Position on the left side of the cursor instead of the left side of the window
          left = mousePos.x - tooltipRect.width - offset;
        }

        // Also check if it would go off the left edge after repositioning
        if (left < padding) {
          left = padding;
        }

        setTooltipPosition({ left, top: mousePos.y + offset });
      });
    });
  }, [mousePos, showMetadata, hoveredPoint, hoverSource]);

  useEffect(() => {
    if (!climbContextMenu) {
      return;
    }
    const handleGlobalClose = (event: MouseEvent) => {
      const target = event.target as Node;
      if (climbContextMenuRef.current && !climbContextMenuRef.current.contains(target)) {
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
      // Entry height (nominalFlightHeight) is ASL, so return it directly if no planned altitude
      return closest.plannedAltitude ?? nominalFlightHeight;
    },
    [elevationProfile, nominalFlightHeight]
  );

  const activeClimbStartDistance = null;

  // Update container width state when container resizes (for export functionality)
  useEffect(() => {
    if (!containerRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    
    resizeObserver.observe(containerRef.current);
    
    // Set initial width
    if (containerRef.current) {
      setContainerWidth(containerRef.current.clientWidth);
    }
    
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || elevationProfile.length === 0 || loading) {
      return;
    }

    // Store component-level vertexDistances early to avoid temporal dead zone issues
    const componentVertexDistances = vertexDistances;

    const svg = d3.select(svgRef.current);
    // Save zoom transform before clearing (preserve zoom state across re-renders)
    const existingOverlay = svg.select('rect[fill="transparent"]').node() as SVGRectElement | null;
    if (existingOverlay) {
      const existingTransform = d3.zoomTransform(existingOverlay);
      // Only update if it's actually zoomed/translated (not identity)
      if (existingTransform.k !== 1 || existingTransform.x !== 0 || existingTransform.y !== 0) {
        savedZoomTransformRef.current = existingTransform;
      }
    }
    // If no existing transform, keep the saved one (don't reset to null)
    svg.selectAll('*').remove(); // Clear previous render

    const margin = { top: 20, right: 80, bottom: 110, left: 80 }; // left fits y-axis ticks + labels (PNG export)
    const legendWidth = 0; // Move legend under the plot
    const width = containerRef.current.clientWidth - margin.left - margin.right - legendWidth;
    const height = 400 - margin.top - margin.bottom;

    // Set SVG dimensions (include space for legend)
    // Height will be adjusted later if legend needs two rows
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
      .range([0, width]);

    const chartArea: d3.Selection<SVGGElement, unknown, null, undefined> = g.append('g')
      .attr('clip-path', `url(#${clipPathIdRef.current})`);

    // Entry height (nominalFlightHeight) is ASL, so base altitude is nominalFlightHeight directly
    const plannedAltitudes = elevationProfile.map((p) => p.plannedAltitude ?? nominalFlightHeight);
    const baseAltitudes = elevationProfile.map((p) => p.baseAltitude ?? nominalFlightHeight);

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

    const yAxisGrid = d3.axisLeft(currentYScale)
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
      .attr('transform', 'translate(0,0)')
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
    // Entry height (nominalFlightHeight) is ASL, so base altitude is nominalFlightHeight directly
    const profileWithPlan = elevationProfile.map((p) => {
      const planned = p.plannedAltitude ?? nominalFlightHeight;
      const baseAltitude = p.baseAltitude ?? nominalFlightHeight;
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

    const resolutionViolationPaths = resolutionViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
      .data(resolutionSegments)
      .enter()
      .append('path')
      .attr('fill', '#16A34A')
      .attr('fill-opacity', 0.18)
      .attr('d', d => resolutionAreaGenerator(d));

    const safetyViolationPaths = safetyViolationGroup.selectAll<SVGPathElement, typeof profileWithPlan[0][]>('path')
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

    if (pointsWithMinMax.length > 0) {

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
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      // Close climb context menu if open
      setClimbContextMenu(null);
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
    flightPoints.on('contextmenu', function (event: any, d: { point: ElevationPoint; index: number }) {
      event.preventDefault();
      event.stopPropagation();
      // Get the click position in screen coordinates
      const clickX = event.clientX || (event as MouseEvent).clientX;
      const clickY = event.clientY || (event as MouseEvent).clientY;
      // Close climb context menu if open
      setClimbContextMenu(null);
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
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .style('font-weight', '500')
      .text(d => d.index + 1);

    // Add axes
    const xAxis = d3.axisBottom(currentXScale)
      .ticks(10)
      .tickFormat(d => `${d} מ'`);

    const yAxis = d3.axisLeft(currentYScale)
      .ticks(10)
      .tickFormat(d => `${d} מ'`)
      .tickPadding(52);

    const xAxisGroup = g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);

    xAxisGroup.selectAll('text')
      .style('font-size', '12px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');

    const yAxisGroup = g.append('g')
      .attr('class', 'y-axis')
      .attr('transform', 'translate(0,0)')
      .call(yAxis);

    yAxisGroup.selectAll('text')
      .style('font-size', '12px')
      .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif')
      .attr('dx', '0.5em');

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

    // Add gray shaded areas around each vertex to show vertex proximity zones
    if (climbConfig && climbConfig.vertexProximityMeters > 0 && componentVertexDistances.length > 0) {
      const vertexProximityZones = componentVertexDistances.map(vertexDistance => {
        const zoneStart = Math.max(0, vertexDistance - climbConfig.vertexProximityMeters);
        const zoneEnd = Math.min(
          elevationProfile.length > 0 ? elevationProfile[elevationProfile.length - 1].distance : vertexDistance + climbConfig.vertexProximityMeters,
          vertexDistance + climbConfig.vertexProximityMeters
        );
        return { start: zoneStart, end: zoneEnd };
      });

      // Merge overlapping zones
      const mergedZones: { start: number; end: number }[] = [];
      const sortedZones = [...vertexProximityZones].sort((a, b) => a.start - b.start);
      
      for (const zone of sortedZones) {
        if (mergedZones.length === 0) {
          mergedZones.push({ ...zone });
        } else {
          const lastZone = mergedZones[mergedZones.length - 1];
          if (zone.start <= lastZone.end) {
            lastZone.end = Math.max(lastZone.end, zone.end);
          } else {
            mergedZones.push({ ...zone });
          }
        }
      }

      // Draw rectangles for each merged zone
      chartArea.selectAll<SVGRectElement, { start: number; end: number }>('.vertex-proximity-zone')
        .data(mergedZones)
        .enter()
        .append('rect')
        .attr('class', 'vertex-proximity-zone')
        .attr('x', d => {
          const xStart = currentXScale(d.start);
          const xEnd = currentXScale(d.end);
          return Math.min(xStart, xEnd);
        })
        .attr('y', 0)
        .attr('width', d => {
          const xStart = currentXScale(d.start);
          const xEnd = currentXScale(d.end);
          return Math.abs(xStart - xEnd);
        })
        .attr('height', height)
        .attr('fill', '#808080')
        .attr('fill-opacity', 0.2)
        .attr('stroke', '#808080')
        .attr('stroke-width', 1)
        .attr('stroke-opacity', 0.4);
    }

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

    const endMarkersData = climbRequests.map((c) => ({ endDistance: c.endDistance, climbAmount: c.climbAmount, climbRatio: c.climbRatio, descentRatio: c.descentRatio }));

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
        // Close regular context menu if open
        setContextMenu(null);
        setClimbContextMenu({ x: clickX, y: clickY, endDistance: d.endDistance, climbAmount: d.climbAmount, climbRatio: d.climbRatio, descentRatio: d.descentRatio });
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
      const activeRatio = c.climbAmount > 0
        ? (c.climbRatio ?? climbConfig.climbRatio)
        : (c.descentRatio ?? climbConfig.descentRatio);
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
    const legend = svg.append('g');

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

    // Check if legend needs to wrap to two rows
    const availableWidth = width;
    const rowHeight = 25; // Height of each row including spacing
    const needsTwoRows = totalLegendWidth > availableWidth * 0.9; // Use 90% of available width as threshold
    
    // Adjust SVG height if legend needs two rows
    if (needsTwoRows) {
      const additionalHeight = rowHeight;
      svg.attr('height', height + margin.top + margin.bottom + additionalHeight);
    }
    
    // Calculate layout for one or two rows
    let row1Items: typeof legendData = [];
    let row2Items: typeof legendData = [];
    let row1Width = 0;
    let row2Width = 0;
    
    if (needsTwoRows) {
      // Split into two rows: first 2 items in row 1, last 2 items in row 2
      row1Items = legendData.slice(0, 2);
      row2Items = legendData.slice(2);
      
      // Calculate widths for each row
      row1Items.forEach((_, idx) => {
        const origIdx = idx;
        row1Width += itemWidths[origIdx];
        if (idx < row1Items.length - 1) row1Width += spacing;
      });
      
      row2Items.forEach((_, idx) => {
        const origIdx = idx + 2;
        row2Width += itemWidths[origIdx];
        if (idx < row2Items.length - 1) row2Width += spacing;
      });
    } else {
      // Single row
      row1Items = legendData;
      row1Width = totalLegendWidth;
    }

    // Align legend to the right side of the chart
    // Use the wider row width for positioning
    const maxRowWidth = Math.max(row1Width, row2Width);
    const legendX = width - maxRowWidth;

    // Update legend group position
    const legendY = height + margin.top + legendOffset;
    legend.attr('transform', `translate(${margin.left + legendX}, ${legendY})`);

    // Function to render a row of legend items
    const renderLegendRow = (items: typeof legendData, startIndex: number, yOffset: number) => {
      let currentX = 0;
      
      items.forEach((item, idx) => {
        const origIndex = startIndex + idx;
        const legendItem = legend.append('g')
          .attr('transform', `translate(${currentX}, ${yOffset})`);

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

        currentX += itemWidths[origIndex] + spacing;
      });
    };

    // Render legend rows
    renderLegendRow(row1Items, 0, 0);
    if (needsTwoRows) {
      renderLegendRow(row2Items, 2, rowHeight);
    }

    // Interaction overlay captures zoom/pan and hover without showing a visible layer
    const overlay = g.append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .style('pointer-events', 'all');
    function clampTransform(t: d3.ZoomTransform, w: number, h: number): d3.ZoomTransform {
      const clamped = clampZoomTransform(t.x, t.y, t.k, w, h);
      return d3.zoomIdentity.translate(clamped.x, clamped.y).scale(clamped.k);
    }

    // Function to update all elements based on current transform
    const updateElementsWithTransform = (transform: d3.ZoomTransform) => {
      const newXScale = transform.rescaleX(baseXScale);
      const newYScale = transform.rescaleY(baseYScale);

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
        .attr('dx', '0.5em');

      // Update all paths and elements
      const updatedGroundAreaGenerator = d3.area<ElevationPoint>()
        .x(d => currentXScale(d.distance))
        .y0(height)
        .y1(d => currentYScale(d.elevation))
        .curve(d3.curveMonotoneX);
      groundArea.attr('d', updatedGroundAreaGenerator);
      
      const updatedGroundLine = d3.line<ElevationPoint>()
        .x(d => currentXScale(d.distance))
        .y(d => currentYScale(d.elevation))
        .curve(d3.curveMonotoneX);
      groundPath.attr('d', updatedGroundLine);
      
      const updatedPlannedFlightLine = d3.line<typeof profileWithPlan[0]>()
        .x(d => currentXScale(d.distance))
        .y(d => currentYScale(d.plannedAltitude))
        .curve(d3.curveMonotoneX);
      plannedFlightPathLine.attr('d', updatedPlannedFlightLine);
      
      const updatedSafetyLine = d3.line<ElevationPoint>()
        .x(d => currentXScale(d.distance))
        .y(d => {
          const maxElev = d.maxElevation !== undefined ? d.maxElevation : d.elevation;
          return currentYScale(maxElev + safetyHeight);
        })
        .curve(d3.curveMonotoneX);
      safetyPath.attr('d', updatedSafetyLine);
      
      const updatedResolutionLine = d3.line<ElevationPoint>()
        .x(d => currentXScale(d.distance))
        .y(d => {
          const minElev = d.minElevation !== undefined ? d.minElevation : d.elevation;
          return currentYScale(minElev + resolutionHeight);
        })
        .curve(d3.curveMonotoneX);
      resolutionPath.attr('d', updatedResolutionLine);

      // Update resolution violation fill areas
      const updatedResolutionAreaGenerator = d3.area<typeof profileWithPlan[0]>()
        .x(d => currentXScale(d.distance))
        .y0(d => currentYScale(getResolutionThreshold(d)))
        .y1(d => currentYScale(d.plannedAltitude))
        .curve(d3.curveMonotoneX);
      resolutionViolationPaths.attr('d', d => updatedResolutionAreaGenerator(d));

      // Update safety violation fill areas
      const updatedSafetyAreaGenerator = d3.area<typeof profileWithPlan[0]>()
        .x(d => currentXScale(d.distance))
        .y0(d => currentYScale(d.plannedAltitude))
        .y1(d => currentYScale(getSafetyThreshold(d)))
        .curve(d3.curveMonotoneX);
      safetyViolationPaths.attr('d', d => updatedSafetyAreaGenerator(d));

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

      // Update legend position
      const availableWidth = width;
      const needsTwoRows = totalLegendWidth > availableWidth * 0.9;
      let maxRowWidth = totalLegendWidth;
      
      if (needsTwoRows) {
        let row1Width = 0;
        let row2Width = 0;
        
        for (let i = 0; i < 2; i++) {
          row1Width += itemWidths[i];
          if (i < 1) row1Width += spacing;
        }
        
        for (let i = 2; i < legendData.length; i++) {
          row2Width += itemWidths[i];
          if (i < legendData.length - 1) row2Width += spacing;
        }
        
        maxRowWidth = Math.max(row1Width, row2Width);
      }
      
      const legendX = width - maxRowWidth;
      legend.attr('transform', `translate(${margin.left + legendX}, ${height + margin.top + legendOffset})`);

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

      // Update gray vertex proximity zones
      // Recalculate zones and update existing rectangles
      if (climbConfig && climbConfig.vertexProximityMeters > 0 && componentVertexDistances.length > 0) {
        const vertexProximityZones = componentVertexDistances.map(vertexDistance => {
          const zoneStart = Math.max(0, vertexDistance - climbConfig.vertexProximityMeters);
          const zoneEnd = Math.min(
            elevationProfile.length > 0 ? elevationProfile[elevationProfile.length - 1].distance : vertexDistance + climbConfig.vertexProximityMeters,
            vertexDistance + climbConfig.vertexProximityMeters
          );
          return { start: zoneStart, end: zoneEnd };
        });

        // Merge overlapping zones
        const mergedZones: { start: number; end: number }[] = [];
        const sortedZones = [...vertexProximityZones].sort((a, b) => a.start - b.start);
        
        for (const zone of sortedZones) {
          if (mergedZones.length === 0) {
            mergedZones.push({ ...zone });
          } else {
            const lastZone = mergedZones[mergedZones.length - 1];
            if (zone.start <= lastZone.end) {
              lastZone.end = Math.max(lastZone.end, zone.end);
            } else {
              mergedZones.push({ ...zone });
            }
          }
        }

        // Update existing zones with new data and positions
        chartArea.selectAll<SVGRectElement, { start: number; end: number }>('.vertex-proximity-zone')
          .data(mergedZones)
          .attr('x', d => {
            const xStart = currentXScale(d.start);
            const xEnd = currentXScale(d.end);
            return Math.min(xStart, xEnd);
          })
          .attr('width', d => {
            const xStart = currentXScale(d.start);
            const xEnd = currentXScale(d.end);
            return Math.abs(xStart - xEnd);
          });
      }
    };

    // Raise overlay to top so it captures all pointer events (wheel, click, hover)
    // above every drawn chart element (areas, lines, markers, etc.)
    overlay.raise();

    // Setup zoom behavior - only for wheel zoom, not for panning
    const zoomBehavior = d3.zoom<SVGRectElement, unknown>()
      .scaleExtent([1, 20])
      .extent([[0, 0], [width, height]])
      .translateExtent([[0, 0], [width, height]])
      .on('zoom', (event) => {
        // Handle wheel zoom and programmatic transforms (like reset button)
        const isWheelEvent = event.sourceEvent && event.sourceEvent.type === 'wheel';
        const isProgrammatic = !event.sourceEvent; // No source event means it's programmatic
        
        if (isWheelEvent || isProgrammatic) {
          // If zoomed out to scale 1 or less, reset to identity (no translation either)
          if (event.transform.k <= 1) {
            const identity = d3.zoomIdentity;
            savedZoomTransformRef.current = identity;
            updateElementsWithTransform(identity);
            // Only reset the transform if it's a wheel event (to avoid infinite loop)
            if (isWheelEvent && (event.transform.k < 1 || event.transform.x !== 0 || event.transform.y !== 0)) {
              overlay.call(zoomBehavior.transform as any, identity);
            }
          } else {
            // Save the transform so it persists across re-renders
            const clamped = clampTransform(event.transform, width, height);
            savedZoomTransformRef.current = clamped;
            updateElementsWithTransform(clamped);
          }
        }
      })
      // Only allow wheel zoom, disable drag panning from d3.zoom
      .filter(function(event) {
        // Only allow wheel events for zooming
        return event.type === 'wheel';
      });

    // Store references for zoom controls
    zoomBehaviorRef.current = zoomBehavior;
    overlayRef.current = overlay;
    
    // Apply the zoom behavior first
    overlay.call(zoomBehavior as any);
    
    // Restore saved zoom transform AFTER applying zoom behavior (to maintain zoom state across re-renders)
    if (savedZoomTransformRef.current) {
      // Restore the transform immediately to maintain zoom/pan state
      overlay.call(zoomBehavior.transform as any, savedZoomTransformRef.current);
    }
    
    // Update cursor based on zoom state
    const transform = savedZoomTransformRef.current || d3.zoomIdentity;
    if (transform.k > 1) {
      overlay.style('cursor', 'grab');
    }
    
    // Custom panning handlers - calculate translation vector from mouse click to mouse location
    overlay.on('mousedown', function(event: MouseEvent) {
      // Only allow panning when zoomed in
      const currentTransform = savedZoomTransformRef.current || d3.zoomIdentity;
      if (currentTransform.k <= 1) {
        return; // Don't pan when not zoomed
      }
      
      // Prevent right-click and ctrl+click from panning
      if (event.button !== 0 || event.ctrlKey) {
        return;
      }
      
      event.preventDefault();
      event.stopPropagation();
      
      const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
      dragStartRef.current = { x: mouseX, y: mouseY };
      panStartTransformRef.current = currentTransform;
      isDraggingRef.current = false;
      isPanningRef.current = false; // Not panning yet, waiting for drag threshold
      overlay.style('cursor', 'grab'); // Keep grab cursor until we actually start panning
    });
    
    // Combined mousemove handler for panning and hover
    overlay.on('mousemove', function(event: MouseEvent) {
      // Handle panning if mouse is down
      if (dragStartRef.current && panStartTransformRef.current) {
        const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
        
        // Calculate translation vector (delta from start position)
        const dx = mouseX - dragStartRef.current.x;
        const dy = mouseY - dragStartRef.current.y;
        
        // Check if we've moved beyond the drag threshold (5 pixels)
        const dragDistance = Math.sqrt(dx * dx + dy * dy);
        const dragThreshold = 5;
        
        if (dragDistance >= dragThreshold) {
          // Start panning only after threshold is crossed
          if (!isPanningRef.current) {
            isPanningRef.current = true;
            overlay.style('cursor', 'grabbing');
          }
          
          event.preventDefault();
          isDraggingRef.current = true;
          
          // Create new transform by adding translation to the start transform
          const newTransform = clampTransform(panStartTransformRef.current.translate(dx, dy), width, height);

          // Update the transform and render in real-time
          savedZoomTransformRef.current = newTransform;
          updateElementsWithTransform(newTransform);
          return; // Don't process hover when panning
        }
        // If below threshold, don't pan yet but also don't process hover
        return;
      }
      
      // Continue with hover handling if not panning (will be handled by hover handler below)
    });
    
    overlay.on('mouseup', function(event: MouseEvent) {
      if (!dragStartRef.current || !panStartTransformRef.current) {
        return;
      }
      
      // Only apply translation if we actually panned (crossed threshold)
      if (isPanningRef.current) {
        event.preventDefault();
        event.stopPropagation();
        
        const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
        
        // Calculate final translation vector
        const dx = mouseX - dragStartRef.current.x;
        const dy = mouseY - dragStartRef.current.y;
        
        // Apply final translation
        const finalTransform = clampTransform(panStartTransformRef.current.translate(dx, dy), width, height);
        savedZoomTransformRef.current = finalTransform;
        
        // Update the d3.zoom behavior's transform so it persists
        overlay.call(zoomBehavior.transform as any, finalTransform);
        
        // Update elements with final transform
        updateElementsWithTransform(finalTransform);
      }
      
      // Update cursor
      const currentTransform = savedZoomTransformRef.current || d3.zoomIdentity;
      if (currentTransform.k > 1) {
        overlay.style('cursor', 'grab');
      } else {
        overlay.style('cursor', 'crosshair');
      }
      
      // Reset drag state after a delay to allow click handler to check it
      setTimeout(() => {
        isDraggingRef.current = false;
        isPanningRef.current = false;
        dragStartRef.current = null;
        panStartTransformRef.current = null;
      }, 10);
    });
    
    overlay.on('mouseleave', function() {
      // If mouse leaves while dragging, finalize the pan only if we were actually panning
      if (dragStartRef.current && panStartTransformRef.current && isPanningRef.current) {
        // Get the current transform (which should already be updated from mousemove)
        const currentTransform = savedZoomTransformRef.current || d3.zoomIdentity;
        
        // Make sure the transform is saved and persisted in d3.zoom
        savedZoomTransformRef.current = currentTransform;
        overlay.call(zoomBehavior.transform as any, currentTransform);
        updateElementsWithTransform(currentTransform);
      }
      
      // Update cursor
      const currentTransform = savedZoomTransformRef.current || d3.zoomIdentity;
      if (currentTransform.k > 1) {
        overlay.style('cursor', 'grab');
      } else {
        overlay.style('cursor', 'crosshair');
      }
      
      // Reset drag state
      isDraggingRef.current = false;
      isPanningRef.current = false;
      dragStartRef.current = null;
      panStartTransformRef.current = null;
    });

    const vertexDistanceSet = new Set(originalVertices.map(v => v.point.distance));

    overlay.on('click', function (event: MouseEvent) {
      // Only handle click if we didn't drag (to avoid breaking click selection)
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        dragStartRef.current = null;
        return;
      }
      
      if (profileWithPlan.length === 0) return;
      const [mouseX] = d3.pointer(event, g.node() as SVGGElement);
      let closestPoint: typeof profileWithPlan[0] | null = null;
      let closestDistance = Infinity;
      for (const point of profileWithPlan) {
        if (Array.from(vertexDistanceSet).some(d => Math.abs(d - point.distance) < 1e-6)) {
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
      setCustomClimbRatio('');
      setCustomDescentRatio('');
      setIsClimbAmountOpen(true);
    });

    // Allow right-click to open the existing point context menu even with the overlay present
    overlay.on('contextmenu', function (event: MouseEvent) {
      // Check if we're clicking on a climb marker first - if so, show climb context menu
      // Use a larger threshold (15px) to ensure we catch clicks on climb markers even if slightly off
      const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
      
      let clickedClimb: { endDistance: number; climbAmount: number; climbRatio?: number; descentRatio?: number } | null = null;

      // Check for climb end markers with higher priority and larger threshold
      for (const climb of climbRequests) {
        const climbX = currentXScale(climb.endDistance);
        const climbY = currentYScale(getPlannedAltitudeAtDistance(climb.endDistance));
        const distToClimb = Math.sqrt(Math.pow(climbX - mouseX, 2) + Math.pow(climbY - mouseY, 2));

        // Use 15px threshold to ensure we catch clicks on climb markers
        if (distToClimb < 15) {
          clickedClimb = { endDistance: climb.endDistance, climbAmount: climb.climbAmount, climbRatio: climb.climbRatio, descentRatio: climb.descentRatio };
          break;
        }
      }

      // If clicking on a climb marker, show the climb context menu and prevent regular menu
      if (clickedClimb) {
        event.preventDefault();
        event.stopPropagation();
        const clickX = event.clientX || (event as MouseEvent).clientX;
        const clickY = event.clientY || (event as MouseEvent).clientY;
        // Close regular context menu if open
        setContextMenu(null);
        setClimbContextMenu({ x: clickX, y: clickY, endDistance: clickedClimb.endDistance, climbAmount: clickedClimb.climbAmount, climbRatio: clickedClimb.climbRatio, descentRatio: clickedClimb.descentRatio });
        return; // Don't show regular context menu
      }

      // Check if we're clicking on an input point
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
        // Close climb context menu if open
        setClimbContextMenu(null);
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
      // Replace the mousemove handler to include both panning and hover
      overlay.on('mousemove', function (event: MouseEvent) {
        // First, handle panning if mouse is down
        if (dragStartRef.current && panStartTransformRef.current) {
          const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
          
          // Calculate translation vector (delta from start position)
          const dx = mouseX - dragStartRef.current.x;
          const dy = mouseY - dragStartRef.current.y;
          
          // Check if we've moved beyond the drag threshold (5 pixels)
          const dragDistance = Math.sqrt(dx * dx + dy * dy);
          const dragThreshold = 5;
          
          if (dragDistance >= dragThreshold) {
            // Start panning only after threshold is crossed
            if (!isPanningRef.current) {
              isPanningRef.current = true;
              overlay.style('cursor', 'grabbing');
            }
            
            event.preventDefault();
            isDraggingRef.current = true;
            
            // Create new transform by adding translation to the start transform
            const newTransform = panStartTransformRef.current.translate(dx, dy);
            
            // Update the transform and render in real-time
            savedZoomTransformRef.current = newTransform;
            updateElementsWithTransform(newTransform);
            return; // Don't process hover when panning
          }
          // If below threshold, don't pan yet but also don't process hover
          return;
        }
        
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

    // Note: Zoom/pan state is managed via viewWindow state, no need to restore d3.zoom transform

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
    containerWidth, // Include container width to trigger re-render when it changes (for export)
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
    // minClimb applies to both increases and decreases
    if (absClimbAmount < climbConfig.minClimb) {
      setClimbAmountError(
        `ערך העלייה חייב להיות לפחות ${climbConfig.minClimb} מטרים (ערך נוכחי: ${absClimbAmount.toFixed(1)} מ').`
      );
      return;
    }
    // maxClimb only applies to increases (positive values), not decreases
    if (parsed > 0 && parsed > climbConfig.maxClimb) {
      setClimbAmountError(
        `ערך העלייה חייב להיות לכל היותר ${climbConfig.maxClimb} מטרים (ערך נוכחי: ${parsed.toFixed(1)} מ').`
      );
      return;
    }
    const baseAfterExisting = (() => {
      // Entry height (nominalFlightHeight) is ASL, so base altitude is nominalFlightHeight directly
      const constantAltitude = nominalFlightHeight;
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
        const activeRatio = c.climbAmount > 0
          ? (c.climbRatio ?? climbConfig.climbRatio)
          : (c.descentRatio ?? climbConfig.descentRatio);
        const requiredHorizontal = Math.abs(c.climbAmount) * activeRatio;
        const startDistance = Math.max(0, c.endDistance - requiredHorizontal);
        const res = computeClimbProfile(
          startDistance,
          c.climbAmount,
          c.climbRatio ?? climbConfig.climbRatio,
          c.descentRatio ?? climbConfig.descentRatio,
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

    const submitClimbRatio = parseFloat(customClimbRatio) > 0 ? parseFloat(customClimbRatio) : climbConfig.climbRatio;
    const submitDescentRatio = parseFloat(customDescentRatio) > 0 ? parseFloat(customDescentRatio) : climbConfig.descentRatio;
    const activeRatio = parsed > 0 ? submitClimbRatio : submitDescentRatio;
    const requiredHorizontal = Math.abs(parsed) * activeRatio;
    const startDistance = Math.max(0, pendingClimbEnd - requiredHorizontal);
    const preview = computeClimbProfile(
      startDistance,
      parsed,
      submitClimbRatio,
      submitDescentRatio,
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
      
      const existingRatio = existingClimb.climbAmount > 0
        ? (existingClimb.climbRatio ?? climbConfig.climbRatio)
        : (existingClimb.descentRatio ?? climbConfig.descentRatio);
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
          ? `עלייה חדשה (${newClimbStart.toFixed(1)} מ' - ${newClimbEnd.toFixed(1)} מ') חופפת עם עלייה קיימת ` +
          `(${existingStart.toFixed(1)} מ' - ${existingEnd.toFixed(1)} מ'). אין אפשרות להדבק בין עליות.`
          : `עלייה חדשה (${newClimbStart.toFixed(1)} מ' - ${newClimbEnd.toFixed(1)} מ') קרובה מדי לעלייה קיימת ` +
          `(${existingStart.toFixed(1)} מ' - ${existingEnd.toFixed(1)} מ'). ` +
          `מרחק מינימלי נדרש: ${climbConfig.vertexProximityMeters} מ' (נוכחי: ${minDist.toFixed(1)} מ').`;
        console.log('VALIDATION FAILED:', msg);
        setClimbAmountError(msg);
        return;
      }
    }

    const notReachable =
      Math.abs(preview.appliedClimb - parsed) > 1e-3 ||
      (!climbConfig.allowTurnsDuringClimb && (preview.warnings?.length ?? 0) > 0);

    if (notReachable) {
      console.log('Climb not reachable:', {
        appliedClimb: preview.appliedClimb,
        parsed,
        warnings: preview.warnings,
        notReachable
      });
      setClimbAmountError(
        preview.warnings?.length
          ? preview.warnings[0]
          : 'לא ניתן להגיע לעלייה המבוקשת. התאם את הכמות או הפעל פניות בעלייה.'
      );
      return;
    }

    // Find anchor points for this climb
    const anchors = findAnchorPointsForClimb(pendingClimbEnd, flightPath);
    console.log('[CLIMB_CREATE] Creating climb point:', {
      endDistance: pendingClimbEnd,
      climbAmount: parsed,
      anchors,
      flightPathLength: flightPath.length,
      flightPathIds: flightPath.map(p => ({ id: p.id, lng: p.lng, lat: p.lat }))
    });
    
    setClimbRequests((prev) => {
      // If editing, remove the specific climb being edited; otherwise remove any climb at the same endDistance
      const filtered = editingClimb
        ? prev.filter(
            (c) =>
              !(Math.abs(c.endDistance - editingClimb.endDistance) < 0.01 &&
                Math.abs(c.climbAmount - editingClimb.climbAmount) < 0.01)
          )
        : prev.filter((c) => Math.abs(c.endDistance - pendingClimbEnd) > 0.01);
      
      // Create new climb request with anchor IDs, segment ratio, and optional per-point ratio overrides
      const newClimb: ClimbRequest = {
        endDistance: pendingClimbEnd,
        climbAmount: parsed,
        ...(anchors && {
          anchorPointIdA: anchors.anchorPointIdA,
          anchorPointIdB: anchors.anchorPointIdB,
          segmentRatio: anchors.segmentRatio
        }),
        ...(parseFloat(customClimbRatio) > 0 && { climbRatio: parseFloat(customClimbRatio) }),
        ...(parseFloat(customDescentRatio) > 0 && { descentRatio: parseFloat(customDescentRatio) })
      };
      
      console.log('[CLIMB_CREATE] New climb created:', {
        ...newClimb,
        hasAnchors: !!(newClimb.anchorPointIdA && newClimb.anchorPointIdB),
        hasRatio: newClimb.segmentRatio !== undefined
      });
      
      return [...filtered, newClimb].sort((a, b) => a.endDistance - b.endDistance);
    });
    setIsClimbAmountOpen(false);
    setPendingClimbEnd(null);
    setClimbAmountError(null);
    setEditingClimb(null);
    setCustomClimbRatio('');
    setCustomDescentRatio('');
  }, [climbAmountInput, pendingClimbEnd, climbRequests, climbConfig, flightPath, elevationProfile, nominalFlightHeight, setClimbRequests, editingClimb, customClimbRatio, customDescentRatio]);

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

  // Handle Enter in climb amount modal
  useEffect(() => {
    if (!isClimbAmountOpen) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleConfirmClimb();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [isClimbAmountOpen, handleConfirmClimb]);

  // Handle Enter in climb validation popup
  useEffect(() => {
    if (!climbValidationPopup) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        setClimbValidationPopup(null);
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [climbValidationPopup]);

  // Handle Enter in delete-all confirmation
  useEffect(() => {
    if (!showDeleteAllConfirmation) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleConfirmDeleteAll();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [showDeleteAllConfirmation, handleConfirmDeleteAll]);

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
    if (!svgRef.current || !containerRef.current) return;

    // Calculate maximum width for export (window width - minimum map width - padding)
    // Minimum map width is 300px, add some padding for splitter and margins
    const minMapWidth = 300;
    const splitterWidth = 8;
    const padding = 20;
    const maxExportWidth = window.innerWidth - minMapWidth - splitterWidth - padding;
    // Use a reasonable minimum (at least 800px) and maximum (2000px) for export
    const exportWidth = Math.max(800, Math.min(2000, maxExportWidth));
    
    // Reset zoom to full extent for export, then restore after.
    // We must ALSO apply identity to the D3 overlay node so that
    // d3.zoomTransform(overlayNode) returns identity during the re-render
    // triggered by the container resize (otherwise the re-render reads the
    // old zoomed transform from D3's internal state and re-applies it).
    const savedTransform = savedZoomTransformRef.current;
    savedZoomTransformRef.current = d3.zoomIdentity;
    if (overlayRef.current && zoomBehaviorRef.current) {
      d3.select(overlayRef.current.node() as any).call(
        zoomBehaviorRef.current.transform as any,
        d3.zoomIdentity
      );
    }

    // Store original container width and style
    const originalStyleWidth = containerRef.current.style.width;
    const originalStyleMinWidth = containerRef.current.style.minWidth;
    
    // Temporarily set container to maximum width for export
    containerRef.current.style.width = `${exportWidth}px`;
    containerRef.current.style.minWidth = `${exportWidth}px`;
    
    // Force a reflow to ensure the container resizes
    containerRef.current.offsetHeight;
    
    // Calculate expected dimensions (left margin fits y-axis ticks + labels for PNG export)
    const margin = { top: 20, right: 80, bottom: 110, left: 80 };
    const legendWidth = 0;
    const expectedChartWidth = exportWidth - margin.left - margin.right - legendWidth;
    const expectedSvgWidth = expectedChartWidth + margin.left + margin.right + legendWidth;
    
    // Use ResizeObserver to detect when container actually resizes
    // Then wait for chart to re-render
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width >= exportWidth - 5) {
          // Container has resized, now wait for chart to re-render
          resizeObserver.disconnect();
          
          // Wait for the chart rendering useEffect to run
          // Use multiple requestAnimationFrame calls and a delay
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setTimeout(() => {
                // Verify the chart has actually re-rendered at the new width
                if (svgRef.current) {
                  const currentSvgWidth = parseFloat(svgRef.current.getAttribute('width') || '0');
                  if (Math.abs(currentSvgWidth - expectedSvgWidth) > 10) {
                    // Chart hasn't re-rendered yet, wait a bit more
                    setTimeout(() => {
                      performExport();
                    }, 300);
                    return;
                  }
                }
                
                performExport();
              }, 200);
            });
          });
          return;
        }
      }
    });
    
    resizeObserver.observe(containerRef.current);
    
    // Fallback: if ResizeObserver doesn't fire within 1 second, proceed anyway
    setTimeout(() => {
      resizeObserver.disconnect();
      performExport();
    }, 1000);
    
    function performExport() {
        // Calculate statistics based on flight altitude (planned altitude)
        // Entry height (nominalFlightHeight) is ASL, so use it directly as fallback
        let totalAscent = 0;
        let totalDescent = 0;
        for (let i = 1; i < elevationProfile.length; i++) {
          const prevAltitude = elevationProfile[i - 1].plannedAltitude ?? nominalFlightHeight;
          const currAltitude = elevationProfile[i].plannedAltitude ?? nominalFlightHeight;
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

        // For each point, calculate height from maximum and height from minimum
        // Use point.minElevation and point.maxElevation (per-point values) if available, otherwise use point.elevation
        // This matches the calculation in CoordinateTooltip
        // Entry height (nominalFlightHeight) is ASL, so use it directly as fallback
        const heightsFromMax = elevationProfile.map(p => {
          const plannedAlt = p.plannedAltitude ?? nominalFlightHeight;
          // Use point.maxElevation if available, otherwise use point.elevation (matches tooltip logic)
          const maxElev = p.maxElevation !== undefined ? p.maxElevation : p.elevation;
          return plannedAlt - maxElev;
        });
        const heightsFromMin = elevationProfile.map(p => {
          const plannedAlt = p.plannedAltitude ?? nominalFlightHeight;
          // Use point.minElevation if available, otherwise use point.elevation (matches tooltip logic)
          const minElev = p.minElevation !== undefined ? p.minElevation : p.elevation;
          return plannedAlt - minElev;
        });

        // Minimum flight height = minimum of all "height from maximum" values
        const minFlightHeight = Math.min(...heightsFromMax);

        // Maximum flight height = maximum of all "height from minimum" values
        const maxHeightFromMinPoint = Math.max(...heightsFromMin);

        // Change legend text-anchor to 'start' for PNG export
        const legendTexts = svgRef.current!.querySelectorAll('.legend-text');
        const originalTextAnchors: string[] = [];
        legendTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          originalTextAnchors[index] = svgText.style.textAnchor || 'end';
          svgText.style.textAnchor = 'start';
        });

        // Hide the vertical line for selected point (red dashed line) before export
        const selectedPointLines = svgRef.current!.querySelectorAll('line[stroke="#ff0000"]');
        const originalLineOpacities: string[] = [];
        selectedPointLines.forEach((line, index) => {
          const svgLine = line as SVGLineElement;
          originalLineOpacities[index] = svgLine.style.opacity || svgLine.getAttribute('opacity') || '1';
          svgLine.style.opacity = '0';
          svgLine.setAttribute('opacity', '0');
        });

        // Also hide hover line (purple dashed line) if present
        const hoverLines = svgRef.current!.querySelectorAll('line[stroke="#9B59B6"]');
        const originalHoverLineOpacities: string[] = [];
        hoverLines.forEach((line, index) => {
          const svgLine = line as SVGLineElement;
          originalHoverLineOpacities[index] = svgLine.style.opacity || svgLine.getAttribute('opacity') || '1';
          svgLine.style.opacity = '0';
          svgLine.setAttribute('opacity', '0');
        });

        // Hide hover point marker (purple circle) if present
        const hoverMarkers = svgRef.current!.querySelectorAll('circle[fill="#9B59B6"]');
        const originalHoverMarkerOpacities: string[] = [];
        hoverMarkers.forEach((marker, index) => {
          const svgCircle = marker as SVGCircleElement;
          originalHoverMarkerOpacities[index] = svgCircle.style.opacity || svgCircle.getAttribute('opacity') || '1';
          svgCircle.style.opacity = '0';
          svgCircle.setAttribute('opacity', '0');
        });

        // PNG only: x-axis tick labels RTL
        const xAxisTexts = svgRef.current!.querySelectorAll('.x-axis text');
        const originalXAxisDirection: string[] = [];
        const originalXAxisTextAnchor: string[] = [];
        xAxisTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          originalXAxisDirection[index] = svgText.style.direction ?? '';
          originalXAxisTextAnchor[index] = svgText.style.textAnchor ?? '';
          svgText.style.direction = 'rtl';
          svgText.style.textAnchor = 'start';
        });

        // PNG only: bring y-axis tick labels closer to the axis (reduce effective tickPadding)
        const yAxisTexts = svgRef.current!.querySelectorAll('.y-axis text');
        const originalYAxisX: string[] = [];
        const originalYAxisDx: string[] = [];
        const pngYAxisLabelOffset = 12; // distance from axis in PNG (on-screen uses tickPadding 52)
        yAxisTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          originalYAxisX[index] = svgText.getAttribute('x') ?? '';
          originalYAxisDx[index] = svgText.getAttribute('dx') ?? '';
          svgText.setAttribute('x', String(-pngYAxisLabelOffset));
          svgText.setAttribute('dx', '0');
        });

        const svgData = new XMLSerializer().serializeToString(svgRef.current!);

        // Restore y-axis label spacing for web display
        yAxisTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          if (originalYAxisX[index] !== '') {
            svgText.setAttribute('x', originalYAxisX[index]);
          } else {
            svgText.removeAttribute('x');
          }
          if (originalYAxisDx[index] !== '') {
            svgText.setAttribute('dx', originalYAxisDx[index]);
          } else {
            svgText.removeAttribute('dx');
          }
        });

        // Restore x-axis direction for web display
        xAxisTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          svgText.style.direction = originalXAxisDirection[index];
          svgText.style.textAnchor = originalXAxisTextAnchor[index];
        });

        // Restore original text-anchor for web display
        legendTexts.forEach((text, index) => {
          const svgText = text as SVGTextElement;
          svgText.style.textAnchor = originalTextAnchors[index];
        });

        // Restore original line opacity for web display
        selectedPointLines.forEach((line, index) => {
          const svgLine = line as SVGLineElement;
          svgLine.style.opacity = originalLineOpacities[index];
          if (originalLineOpacities[index] === '1') {
            svgLine.removeAttribute('opacity');
          } else {
            svgLine.setAttribute('opacity', originalLineOpacities[index]);
          }
        });

        // Restore hover line opacity for web display
        hoverLines.forEach((line, index) => {
          const svgLine = line as SVGLineElement;
          svgLine.style.opacity = originalHoverLineOpacities[index];
          if (originalHoverLineOpacities[index] === '1') {
            svgLine.removeAttribute('opacity');
          } else {
            svgLine.setAttribute('opacity', originalHoverLineOpacities[index]);
          }
        });

        // Restore hover marker opacity for web display
        hoverMarkers.forEach((marker, index) => {
          const svgCircle = marker as SVGCircleElement;
          svgCircle.style.opacity = originalHoverMarkerOpacities[index];
          if (originalHoverMarkerOpacities[index] === '1') {
            svgCircle.removeAttribute('opacity');
          } else {
            svgCircle.setAttribute('opacity', originalHoverMarkerOpacities[index]);
          }
        });
        
        // Restore original container width, style, and zoom state
        savedZoomTransformRef.current = savedTransform;
        if (overlayRef.current && zoomBehaviorRef.current && savedTransform) {
          d3.select(overlayRef.current.node() as any).call(
            zoomBehaviorRef.current.transform as any,
            savedTransform
          );
        }
        if (containerRef.current) {
          containerRef.current.style.width = originalStyleWidth;
          containerRef.current.style.minWidth = originalStyleMinWidth;
        }
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();

        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        img.onload = () => {
          // Add extra height for statistics and a top metadata strip.
          const topMetadataHeight = 44;
          const statsHeight = 140;
          canvas.width = img.width;
          canvas.height = topMetadataHeight + img.height + statsHeight;

          if (ctx) {
        // Fill canvas with white background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw top metadata background
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, canvas.width, topMetadataHeight);

        // Draw top metadata border
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, topMetadataHeight);
        ctx.lineTo(canvas.width, topMetadataHeight);
        ctx.stroke();

        const statPadding = 20;
        const topMetadata = [
          `שם מסלול: ${activeRouteName || '-'}`,
          `אחוז חפיפה: ${overlapPercentage.toFixed(1)}%`,
          `רדיוס בטיחות: ${safetyRadius.toFixed(1)} מ'`,
          `DTM פעיל: ${dtmName || '-'}`
        ];
        ctx.fillStyle = '#374151';
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'right';
        if ('direction' in ctx) {
          (ctx as any).direction = 'rtl';
        }
        ctx.fillText(topMetadata.join('   |   '), canvas.width - statPadding, 28);

        // Draw the SVG image
        ctx.drawImage(img, 0, topMetadataHeight);

        const statsTopY = topMetadataHeight + img.height;

        // Draw statistics background
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, statsTopY, canvas.width, statsHeight);

        // Draw statistics border
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, statsTopY);
        ctx.lineTo(canvas.width, statsTopY);
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
        const statSpacing = 120;
        const labelY = statsTopY + 30;
        const valueY = statsTopY + 55;

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
              // Generate default filename with route name if available
              const routeName = activeRouteName ? `${activeRouteName}-` : '';
              const defaultFilename = `${routeName}elevation-profile-${Date.now()}.png`;
              
              // Show save dialog
              setSaveFileDialog({
                isOpen: true,
                defaultFilename,
                fileContent: blob,
                mimeType: 'image/png'
              });
              
              // Clean up the SVG URL
              URL.revokeObjectURL(url);
            }
          });
        };

        img.src = url;
    }
  };

  const exportCSV = () => {
    if (elevationProfile.length === 0) return;

    const headers = [
      'Distance (מ\')',
      'Ground Elevation (מ\')',
      'Flight Altitude (מ\')',
      'AGL (מ\')',
      'Longitude',
      'Latitude',
      'UTM Easting',
      'UTM Northing',
      'UTM Zone'
    ];
    // Entry height (nominalFlightHeight) is ASL, so use it directly as fallback
    const rows = elevationProfile.map((point) => {
      const flightAltitude = point.plannedAltitude ?? nominalFlightHeight;
      const agl = flightAltitude - point.elevation;
      const utm = latLngToUTM(point.latitude, point.longitude);
      const utmZone = utm ? `${utm.zone}${utm.hemisphere}` : '';
      return [
        point.distance.toFixed(2),
        point.elevation.toFixed(2),
        flightAltitude.toFixed(2),
        agl.toFixed(2),
        point.longitude.toFixed(6),
        point.latitude.toFixed(6),
        utm ? utm.easting.toFixed(3) : '',
        utm ? utm.northing.toFixed(3) : '',
        utmZone
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    // Generate default filename with route name if available
    const routeName = activeRouteName ? `${activeRouteName}-` : '';
    const defaultFilename = `${routeName}elevation-profile-${Date.now()}.csv`;
    
    // Show save dialog
    setSaveFileDialog({
      isOpen: true,
      defaultFilename,
      fileContent: csvContent,
      mimeType: 'text/csv'
    });
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
        />
      )}
      <div className="elevation-header">
        <div className="elevation-controls">
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
            <div className="group-title">נקודות הגבהה </div>
            <div className="group-buttons">
              <Tooltip tooltip="הסר את כל נקודות ההגבהה">
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
              <Tooltip tooltip="ייצא את תרשים הגובה כ-PNG">
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
              <Tooltip tooltip="ייצא את נתוני הגובה כ-CSV">
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
        ) : elevationProfile.length === 0 && profileError ? (
          <div className="no-data profile-error" role="alert">
            <div className="profile-error__title">שגיאה ביצירת פרופיל הגובה</div>
            <div className="profile-error__details">{profileError}</div>
          </div>
        ) : elevationProfile.length === 0 ? (
          <div className="no-data">
            שרטט מסלול טיסה על המפה כדי לראות את פרופיל הגובה
          </div>
        ) : (
          <>
            {activeRouteName && (
              <div className="elevation-plot-title">
                מסלול: {activeRouteName}
              </div>
            )}
            <svg ref={svgRef} className="elevation-chart"></svg>
          </>
        )}
      </div>
      {isClimbAmountOpen && (
        <div className="climb-modal__backdrop" role="dialog" aria-modal="true">
          <div className="climb-modal__card">
            <div className="climb-modal__header">
              <div className="climb-modal__title">{parseFloat(climbAmountInput) < 0 ? 'החל ירידה' : 'החל עלייה'}</div>
              <button className="climb-modal__close" onClick={() => { setIsClimbAmountOpen(false); setClimbAmountError(null); setPendingClimbEnd(null); setEditingClimb(null); setCustomClimbRatio(''); setCustomDescentRatio(''); }}>×</button>
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
                min="-1000"
                max="1000"
                required
                inputMode="decimal"
                aria-required="true"
                value={climbAmountInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setClimbAmountInput(value);
                  
                  // Real-time validation
                  if (value === '' || value === '-') {
                    setClimbAmountError(null);
                    return;
                  }
                  
                  const numValue = parseFloat(value);
                  if (Number.isNaN(numValue)) {
                    setClimbAmountError('ערך חייב להיות מספר');
                  } else if (numValue < -1000 || numValue > 1000) {
                    setClimbAmountError('שינוי גובה חייב להיות בין -1000 ל-1000 מטרים');
                  } else {
                    setClimbAmountError(null);
                  }
                }}
                className={`climb-modal__input ${climbAmountError ? 'error' : ''}`}
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
              {/* Per-point ratio overrides */}
              <div className="climb-modal__ratios">
                <div className="climb-modal__ratio-row">
                  <label className="climb-modal__ratio-label" htmlFor="climb-ratio-override">יחס עלייה:</label>
                  <input
                    id="climb-ratio-override"
                    type="number"
                    step="0.5"
                    min="0.1"
                    className="climb-modal__ratio-input"
                    value={customClimbRatio}
                    placeholder={climbConfig.climbRatio.toString()}
                    onChange={(e) => setCustomClimbRatio(e.target.value)}
                  />
                </div>
                <div className="climb-modal__ratio-row">
                  <label className="climb-modal__ratio-label" htmlFor="descent-ratio-override">יחס ירידה:</label>
                  <input
                    id="descent-ratio-override"
                    type="number"
                    step="0.5"
                    min="0.1"
                    className="climb-modal__ratio-input"
                    value={customDescentRatio}
                    placeholder={climbConfig.descentRatio.toString()}
                    onChange={(e) => setCustomDescentRatio(e.target.value)}
                  />
                </div>
              </div>
              <div className="climb-modal__hint">
                יחס {parseFloat(climbAmountInput) > 0 ? modalClimbRatio : modalDescentRatio} : 1 (אופקי:אנכי).
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
              <button className="btn btn-tertiary" type="button" onClick={() => { setIsClimbAmountOpen(false); setEditingClimb(null); setCustomClimbRatio(''); setCustomDescentRatio(''); }}>ביטול</button>
              <button className="btn btn-primary" type="button" onClick={handleConfirmClimb}>{parseFloat(climbAmountInput) < 0 ? 'החל ירידה' : 'החל עלייה'}</button>
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
              setCustomClimbRatio(climbContextMenu.climbRatio !== undefined ? climbContextMenu.climbRatio.toString() : '');
              setCustomDescentRatio(climbContextMenu.descentRatio !== undefined ? climbContextMenu.descentRatio.toString() : '');
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
        // Entry height (nominalFlightHeight) is ASL, so use it directly as fallback
        let totalAscent = 0;
        let totalDescent = 0;
        for (let i = 1; i < elevationProfile.length; i++) {
          const prevAltitude = elevationProfile[i - 1].plannedAltitude ?? nominalFlightHeight;
          const currAltitude = elevationProfile[i].plannedAltitude ?? nominalFlightHeight;
          const altitudeDiff = currAltitude - prevAltitude;
          if (altitudeDiff > 0) {
            totalAscent += altitudeDiff;
          } else if (altitudeDiff < 0) {
            totalDescent += Math.abs(altitudeDiff);
          }
        }

        // For each point, calculate height from maximum and height from minimum
        // Use point.minElevation and point.maxElevation (per-point values) if available, otherwise use point.elevation
        // This matches the calculation in CoordinateTooltip
        // Entry height (nominalFlightHeight) is ASL, so use it directly as fallback
        const heightsFromMax = elevationProfile.map(p => {
          const plannedAlt = p.plannedAltitude ?? nominalFlightHeight;
          // Use point.maxElevation if available, otherwise use point.elevation (matches tooltip logic)
          const maxElev = p.maxElevation !== undefined ? p.maxElevation : p.elevation;
          return plannedAlt - maxElev;
        });
        const heightsFromMin = elevationProfile.map(p => {
          const plannedAlt = p.plannedAltitude ?? nominalFlightHeight;
          // Use point.minElevation if available, otherwise use point.elevation (matches tooltip logic)
          const minElev = p.minElevation !== undefined ? p.minElevation : p.elevation;
          return plannedAlt - minElev;
        });

        // Minimum flight height = minimum of all "height from maximum" values
        const minFlightHeight = Math.min(...heightsFromMax);

        // Maximum flight height = maximum of all "height from minimum" values
        const maxHeightFromMinPoint = Math.max(...heightsFromMin);

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
      {showMetadata && hoveredPoint && mousePos && (hoverSource === 'profile' || hoverSource === 'overlap') && !contextMenu && !climbContextMenu && (
        <div
          ref={tooltipRef}
          className="hover-metadata-tooltip"
          style={{
            left: tooltipPosition?.left ?? mousePos.x + 15,
            top: tooltipPosition?.top ?? mousePos.y + 15,
            visibility: tooltipPosition ? 'visible' : 'visible',
            opacity: tooltipPosition ? 1 : 0,
            pointerEvents: tooltipPosition ? 'auto' : 'none'
          }}
        >
          <CoordinateTooltip point={hoveredPoint} />
        </div>
      )}
      {saveFileDialog && (
        <SaveFileDialog
          isOpen={saveFileDialog.isOpen}
          defaultFilename={saveFileDialog.defaultFilename}
          fileExtension={saveFileDialog.mimeType === 'image/png' ? '.png' : '.csv'}
          title={saveFileDialog.mimeType === 'image/png' ? 'שמור תרשים גובה כ-PNG' : 'שמור נתוני גובה כ-CSV'}
          description={saveFileDialog.mimeType === 'image/png' 
            ? 'הזן שם קובץ לשמירת תרשים הגובה'
            : 'הזן שם קובץ לשמירת נתוני הגובה'}
          fileContent={saveFileDialog.fileContent}
          mimeType={saveFileDialog.mimeType}
          onClose={() => setSaveFileDialog(null)}
        />
      )}
    </div>
  );
};

export default ElevationProfile;


