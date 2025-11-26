import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { ElevationPoint, Coordinate } from '../App';
import './ElevationProfile.css';

interface ElevationProfileProps {
  elevationProfile: ElevationPoint[];
  loading: boolean;
  nominalFlightHeight: number;
  selectedPoint: Coordinate | null;
  flightPath: Coordinate[];
}

const ElevationProfile: React.FC<ElevationProfileProps> = ({
  elevationProfile,
  loading,
  nominalFlightHeight,
  selectedPoint,
  flightPath
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || elevationProfile.length === 0) {
      return;
    }

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove(); // Clear previous render

    const margin = { top: 20, right: 30, bottom: 60, left: 80 };
    const width = containerRef.current.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    // Set SVG dimensions
    svg.attr('width', width + margin.left + margin.right)
       .attr('height', height + margin.top + margin.bottom);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create scales
    const xScale = d3.scaleLinear()
      .domain(d3.extent(elevationProfile, d => d.distance) as [number, number])
      .range([0, width]);

    const maxElevation = Math.max(
      ...elevationProfile.map(d => d.elevation),
      ...elevationProfile.map(d => d.elevation + nominalFlightHeight)
    );
    const minElevation = Math.min(...elevationProfile.map(d => d.elevation));

    const yScale = d3.scaleLinear()
      .domain([minElevation - 20, maxElevation + 20])
      .range([height, 0]);

    // Create line generators
    const groundLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => yScale(d.elevation))
      .curve(d3.curveMonotoneX);

    const flightLine = d3.line<ElevationPoint>()
      .x(d => xScale(d.distance))
      .y(d => yScale(d.elevation + nominalFlightHeight))
      .curve(d3.curveMonotoneX);

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
        .y1(d => yScale(d.elevation + nominalFlightHeight))
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
    g.selectAll('.ground-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'ground-point')
      .attr('cx', d => xScale(d.point.distance))
      .attr('cy', d => yScale(d.point.elevation))
      .attr('r', 3)
      .attr('fill', '#8B4513');

    g.selectAll('.flight-point')
      .data(originalVertices)
      .enter()
      .append('circle')
      .attr('class', 'flight-point')
      .attr('cx', d => xScale(d.point.distance))
      .attr('cy', d => yScale(d.point.elevation + nominalFlightHeight))
      .attr('r', 3)
      .attr('fill', '#1E90FF');

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
      .style('font-size', '10px')
      .style('font-weight', '500')
      .text(d => d.index + 1);

    // Add axes
    const xAxis = d3.axisBottom(xScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    const yAxis = d3.axisLeft(yScale)
      .ticks(10)
      .tickFormat(d => `${d}m`);

    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxis)
      .append('text')
      .attr('x', width / 2)
      .attr('y', 50)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .text('Distance (meters)');

    g.append('g')
      .call(yAxis)
      .append('text')
      .attr('transform', 'rotate(-90)')
      .attr('y', -60)
      .attr('x', -height / 2)
      .attr('fill', 'black')
      .style('text-anchor', 'middle')
      .text('Elevation (meters)');

    // Highlight selected point
    if (selectedPoint && flightPath.length > 0) {
      // Find closest point in elevation profile
      const closestIndex = flightPath.findIndex(
        p => Math.abs(p.lng - selectedPoint.lng) < 0.0001 &&
             Math.abs(p.lat - selectedPoint.lat) < 0.0001
      );

      if (closestIndex >= 0 && closestIndex < elevationProfile.length) {
        const point = elevationProfile[closestIndex];
        
        // Draw vertical line at selected point
        g.append('line')
          .attr('x1', xScale(point.distance))
          .attr('x2', xScale(point.distance))
          .attr('y1', 0)
          .attr('y2', height)
          .attr('stroke', '#ff0000')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '5,5');
      }
    }

    // Add legend
    const legend = g.append('g')
      .attr('transform', `translate(${width - 150}, 20)`);

    const legendData = [
      { label: 'Ground Elevation', color: '#8B4513', style: 'solid' },
      { label: 'Flight Altitude', color: '#1E90FF', style: 'dashed' }
    ];

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
        .style('font-size', '12px')
        .text(item.label);
    });

  }, [elevationProfile, nominalFlightHeight, selectedPoint, flightPath]);

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
      ctx?.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `elevation-profile-${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      });
    };

    img.src = url;
  };

  const exportCSV = () => {
    if (elevationProfile.length === 0) return;

    const headers = ['Distance (m)', 'Ground Elevation (m)', 'Flight Altitude (m)', 'AGL (m)', 'Longitude', 'Latitude'];
    const rows = elevationProfile.map(point => [
      point.distance.toFixed(2),
      point.elevation.toFixed(2),
      (point.elevation + nominalFlightHeight).toFixed(2),
      nominalFlightHeight.toFixed(2),
      point.longitude.toFixed(6),
      point.latitude.toFixed(6)
    ]);

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

  return (
    <div className="elevation-panel">
      <div className="elevation-header">
        <h2>Elevation Profile</h2>
        <div className="elevation-controls">
          <button onClick={exportPNG} disabled={elevationProfile.length === 0}>
            Export PNG
          </button>
          <button onClick={exportCSV} disabled={elevationProfile.length === 0}>
            Export CSV
          </button>
        </div>
      </div>
      <div ref={containerRef} className="elevation-chart-container">
        {loading ? (
          <div className="loading">Calculating elevation profile...</div>
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


