import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import ContextMenu from './ContextMenu';
import './ElevationProfile.css';

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

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create scales
    const xScale = d3.scaleLinear()
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

    const yScale = d3.scaleLinear()
      .domain([minElevation - 20, maxElevation + 20])
      .range([height, 0]);

    // Draw ground elevation line
    const groundLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => yScale(d.elevation))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#8B4513')
      .attr('stroke-width', 2)
      .attr('d', groundLine);

    // Draw flight altitude line
    const flightLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => yScale(d.elevation + (d.flightHeight ?? nominalFlightHeight)))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#1E90FF')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,5')
      .attr('d', flightLine);

    // Draw safety line (yellow) - safetyHeight meters above max elevation
    // Use maxElevation if available, otherwise use regular elevation
    const safetyLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => {
        const maxElev = d.maxElevation !== undefined ? d.maxElevation : d.elevation;
        return yScale(maxElev + safetyHeight);
      })
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#FFD700')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '8,4')
      .attr('d', safetyLine);

    // Draw resolution line (green) - resolutionHeight meters above min elevation
    // Use minElevation if available, otherwise use regular elevation
    const resolutionLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => {
        const minElev = d.minElevation !== undefined ? d.minElevation : d.elevation;
        return yScale(minElev + resolutionHeight);
      })
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(elevationProfile)
      .attr('fill', 'none')
      .attr('stroke', '#32CD32')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '8,4')
      .attr('d', resolutionLine);

    // Add grid lines
    const xAxisGrid = d3.axisBottom(xScale)
      .ticks(10)
      .tickSize(-height)
      .tickFormat(() => '');

    const yAxisGrid = d3.axisLeft(yScale)
      .ticks(10)
      .tickSize(-width)
      .tickFormat(() => '');

    g.append('g')
      .attr('class', 'grid')
      .attr('stroke', '#ddd')
      .attr('stroke-width', 0.5)
      .attr('stroke-dasharray', '3,3')
      .call(xAxisGrid);

    g.append('g')
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
      g.selectAll('.elevation-range-bar')
        .data(pointsWithMinMax)
        .enter()
        .append('line')
        .attr('class', 'elevation-range-bar')
        .attr('x1', d => xScale(d.distance))
        .attr('x2', d => xScale(d.distance))
        .attr('y1', d => yScale(d.minElevation!))
        .attr('y2', d => yScale(d.maxElevation!))
        .attr('stroke', '#FF6B6B')
        .attr('stroke-width', 2)
        .attr('opacity', 0.6);

      // Draw min elevation markers
      g.selectAll('.min-elevation-marker')
        .data(pointsWithMinMax)
        .enter()
        .append('circle')
        .attr('class', 'min-elevation-marker')
        .attr('cx', d => xScale(d.distance))
        .attr('cy', d => yScale(d.minElevation!))
        .attr('r', 2.5)
        .attr('fill', '#FF6B6B')
        .attr('opacity', 0.8);

      // Draw max elevation markers
      g.selectAll('.max-elevation-marker')
        .data(pointsWithMinMax)
        .enter()
        .append('circle')
        .attr('class', 'max-elevation-marker')
        .attr('cx', d => xScale(d.distance))
        .attr('cy', d => yScale(d.maxElevation!))
        .attr('r', 2.5)
        .attr('fill', '#FF6B6B')
        .attr('opacity', 0.8);
    } else {
      // Remove any existing min/max elements if there are no points
      g.selectAll('.elevation-range-bar').remove();
      g.selectAll('.min-elevation-marker').remove();
      g.selectAll('.max-elevation-marker').remove();
    }

    // Fill area under ground
    g.append('path')
      .datum(elevationProfile)
      .attr('fill', '#8B4513')
      .attr('fill-opacity', 0.3)
      .attr('d', d3.area<ElevationPoint>()
        .x(d => xScale(d.distance))
        .y0(height)
        .y1(d => yScale(d.elevation))
        .curve(d3.curveMonotoneX)
      );

    // Fill area between ground and flight altitude
    g.append('path')
      .datum(elevationProfile)
      .attr('fill', '#87CEEB')
      .attr('fill-opacity', 0.3)
      .attr('d', d3.area<ElevationPoint>()
        .x(d => xScale(d.distance))
        .y0(d => yScale(d.elevation))
        .y1(d => yScale(d.elevation + (d.flightHeight ?? nominalFlightHeight)))
        .curve(d3.curveMonotoneX)
      );

    // Find original flight path vertices in the elevation profile
    // Match by coordinates (with small tolerance for floating point precision)
    const originalVertices = flightPath.map((vertex, vertexIndex) => {
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
    const groundPoints = g.selectAll('.ground-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'ground-point')
      .attr('cx', d => xScale(d.point.distance))
      .attr('cy', d => yScale(d.point.elevation))
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

    const flightPoints = g.selectAll('.flight-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'flight-point')
      .attr('cx', d => xScale(d.point.distance))
      .attr('cy', d => yScale(d.point.elevation + (d.point.flightHeight ?? nominalFlightHeight)))
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
    g.selectAll('.point-label')
      .data(originalVertices)
      .enter()
      .append('text')
      .attr('class', 'point-label')
      .attr('x', d => xScale(d.point.distance))
      .attr('y', d => yScale(d.point.elevation) - 8)
      .attr('text-anchor', 'middle')
      .attr('fill', '#666')
      .style('font-size', '12px')
      .style('font-weight', '500')
      .text(d => d.index + 1);

    // Add axes
    const xAxis = d3.axisBottom(xScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    const yAxis = d3.axisLeft(yScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    const xAxisGroup = g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis);
    
    xAxisGroup.selectAll('text')
      .style('font-size', '12px');
    
    xAxisGroup.append('text')
      .attr('x', width / 2)
      .attr('y', 50)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .style('font-size', '14px')
      .text('Distance (meters)');

    const yAxisGroup = g.append('g')
      .call(yAxis);
    
    yAxisGroup.selectAll('text')
      .style('font-size', '12px');
    
    yAxisGroup.append('text')
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
        g.append('line')
          .attr('x1', xScale(selectedVertex.point.distance))
          .attr('x2', xScale(selectedVertex.point.distance))
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

    // Add invisible overlay for hover detection on all elevation points (on top of everything)
    // This allows hover detection regardless of which curve the user is over
    // Note: We need to allow right-click events to pass through to input points
    if (onElevationPointHover) {
      const overlay = g.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', width)
        .attr('height', height)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .style('pointer-events', 'all'); // Ensure it captures mouse events

      overlay.on('mousemove', function(event: MouseEvent) {
        const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
        
        // Check if we're near any input point (ground or flight points)
        // If so, don't interfere with their right-click events
        let isNearInputPoint = false;
        if (originalVertices.length > 0) {
          for (const vertex of originalVertices) {
            const pointX = xScale(vertex.point.distance);
            const groundY = yScale(vertex.point.elevation);
            const flightY = yScale(vertex.point.elevation + (vertex.point.flightHeight ?? nominalFlightHeight));
            
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
            const pointX = xScale(point.distance);
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

      // Allow right-click events to pass through to input points
      overlay.on('contextmenu', function(event: MouseEvent) {
        // Check if we're clicking on an input point
        const [mouseX, mouseY] = d3.pointer(event, g.node() as SVGGElement);
        let clickedInputPoint: { point: ElevationPoint; index: number; isFlight: boolean } | null = null;
        
        if (originalVertices.length > 0) {
          for (const vertex of originalVertices) {
            const pointX = xScale(vertex.point.distance);
            const groundY = yScale(vertex.point.elevation);
            const flightY = yScale(vertex.point.elevation + (vertex.point.flightHeight ?? nominalFlightHeight));
            
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
              <button 
                onClick={exportPNG} 
                disabled={elevationProfile.length === 0}
                className="btn btn-secondary"
              >
                Export PNG
              </button>
              <button 
                onClick={exportCSV} 
                disabled={elevationProfile.length === 0}
                className="btn btn-secondary"
              >
                Export CSV
              </button>
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


