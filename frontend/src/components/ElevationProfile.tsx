import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import Tooltip from './Tooltip';
import './ElevationProfile.css';

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
      ...elevationProfile.map(d => d.elevation + (d.flightHeight ?? nominalFlightHeight)),
      ...(allMaxElevations.length > 0 ? allMaxElevations : [0]),
      maxWithSafety,
      maxWithResolution
    );
    const minElevation = Math.min(
      ...elevationProfile.map(d => d.elevation),
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

    // Draw flight altitude line
    const flightLine = d3.line<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y(d => currentYScale(d.elevation + (d.flightHeight ?? nominalFlightHeight)))
      .curve(d3.curveMonotoneX);

    const flightPathLine = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#1E90FF')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,5')
      .attr('d', flightLine);

    // Draw safety line (yellow) - safetyHeight meters above max elevation
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
      .attr('stroke', '#FFD700')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '8,4')
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
      .attr('stroke', '#32CD32')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '8,4')
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
        .attr('stroke', '#FF6B6B')
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
        .attr('fill', '#FF6B6B')
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
        .attr('fill', '#FF6B6B')
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

    // Fill area between ground and flight altitude
    const flightAreaGenerator = d3.area<ElevationPoint>()
      .x(d => currentXScale(d.distance))
      .y0(d => currentYScale(d.elevation))
      .y1(d => currentYScale(d.elevation + (d.flightHeight ?? nominalFlightHeight)))
      .curve(d3.curveMonotoneX);

    const flightArea = chartArea.append('path')
      .datum(elevationProfile)
      .attr('fill', '#87CEEB')
      .attr('fill-opacity', 0.3)
      .attr('d', flightAreaGenerator);

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
      .attr('cy', d => currentYScale(d.point.elevation + (d.point.flightHeight ?? nominalFlightHeight)))
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

    // Add legend outside the graph area
    const legend = svg.append('g')
      .attr('transform', `translate(${width + margin.left + 10}, ${margin.top + 20})`);

    const legendData = [
      { label: 'Ground Elevation', color: '#8B4513', style: 'solid' },
      { label: 'Flight Altitude', color: '#1E90FF', style: 'dashed' },
      ...(pointsWithMinMax.length > 0 ? [{ label: 'Min/Max Elevation', color: '#FF6B6B', style: 'solid' }] : []),
      { label: `Safety (+${safetyHeight}m)`, color: '#FFD700', style: 'dashed' },
      { label: `Resolution (+${resolutionHeight}m)`, color: '#32CD32', style: 'dashed' }
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
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', item.style === 'dashed' ? '5,5' : '0');

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
        flightPathLine.attr('d', flightLine);
        safetyPath.attr('d', safetyLine);
        resolutionPath.attr('d', resolutionLine);
        groundArea.attr('d', groundAreaGenerator);
        flightArea.attr('d', flightAreaGenerator);

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
          .attr('cy', d => currentYScale(d.point.elevation + (d.point.flightHeight ?? nominalFlightHeight)));

        pointLabels
          .attr('x', d => currentXScale(d.point.distance))
          .attr('y', d => currentYScale(d.point.elevation) - 8);

        if (selectedDistanceLine && selectedDistance !== null) {
          selectedDistanceLine
            .attr('x1', currentXScale(selectedDistance))
            .attr('x2', currentXScale(selectedDistance));
        }
      });

    overlay.call(zoomBehavior as any);

    // Allow right-click to open the existing point context menu even with the overlay present
    overlay.on('contextmenu', function(event: MouseEvent) {
      // Check if we're clicking on an input point
      const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
      let clickedInputPoint: { point: ElevationPoint; index: number; isFlight: boolean } | null = null;
      
      if (originalVertices.length > 0) {
        for (const vertex of originalVertices) {
          const pointX = currentXScale(vertex.point.distance);
          const groundY = currentYScale(vertex.point.elevation);
          const flightY = currentYScale(vertex.point.elevation + (vertex.point.flightHeight ?? nominalFlightHeight));
          
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
            const flightY = currentYScale(vertex.point.elevation + (vertex.point.flightHeight ?? nominalFlightHeight));
            
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

  }, [elevationProfile, nominalFlightHeight, safetyHeight, resolutionHeight, selectedPoint, flightPath, onDeletePoint, onUpdatePoint, onSetFlightHeight, onEditPointRequest, onElevationPointHover]);

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
    const rows = elevationProfile.map(point => {
      const flightHeight = point.flightHeight ?? nominalFlightHeight;
      return [
        point.distance.toFixed(2),
        point.elevation.toFixed(2),
        (point.elevation + flightHeight).toFixed(2),
        flightHeight.toFixed(2),
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


