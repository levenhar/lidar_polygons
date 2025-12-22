import { useState, useCallback } from 'react';
import { Coordinate } from '../App';
import { ElevationPoint } from '../App';
import axios from 'axios';

export function useElevationProfile() {
  const [elevationProfile, setElevationProfile] = useState<ElevationPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const calculateProfile = useCallback(async (
    flightPath: Coordinate[],
    dtmSource: string,
    nominalFlightHeight: number,
    searchRadius: number = 50
  ) => {
    if (flightPath.length < 2) {
      setElevationProfile([]);
      return;
    }

    setLoading(true);
    try {
      // Convert coordinates to [lng, lat] format for API
      const coordinates = flightPath.map(p => [p.lng, p.lat]);
      
      // Calculate cumulative distance along the path
      const calculateDistance = (coord1: Coordinate, coord2: Coordinate): number => {
        const R = 6371000; // Earth radius in meters
        const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
        const dLon = (coord2.lng - coord1.lng) * Math.PI / 180;
        const a = 
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };

      let cumulativeDistance = 0;
      const distances = [0];
      const segmentDistances: number[] = [0]; // Distance from start of each segment
      for (let i = 1; i < flightPath.length; i++) {
        const segmentDist = calculateDistance(flightPath[i - 1], flightPath[i]);
        cumulativeDistance += segmentDist;
        distances.push(cumulativeDistance);
        segmentDistances.push(segmentDist);
      }
      
      console.log(`Calculating elevation profile with search radius: ${searchRadius}m`);
      
      const response = await axios.post('/api/elevation-profile', {
        coordinates,
        dtmPath: dtmSource,
        radiusMeters: searchRadius // User-configurable radius for min/max calculation
      });

      // Helper function to interpolate flight height for any point along the path
      const interpolateFlightHeight = (distance: number): number => {
        // Find which segment this point belongs to
        if (distance <= 0) {
          return flightPath[0].height ?? nominalFlightHeight;
        }
        
        if (distance >= distances[distances.length - 1]) {
          return flightPath[flightPath.length - 1].height ?? nominalFlightHeight;
        }
        
        // Find the segment containing this distance
        for (let i = 0; i < distances.length - 1; i++) {
          if (distance >= distances[i] && distance <= distances[i + 1]) {
            const startHeight = flightPath[i].height ?? nominalFlightHeight;
            const endHeight = flightPath[i + 1].height ?? nominalFlightHeight;
            
            // If heights are the same, no interpolation needed
            if (startHeight === endHeight) {
              return startHeight;
            }
            
            // Linear interpolation
            const segmentStartDist = distances[i];
            const segmentLength = distances[i + 1] - segmentStartDist;
            const distanceInSegment = distance - segmentStartDist;
            const t = segmentLength > 0 ? distanceInSegment / segmentLength : 0;
            return startHeight + (endHeight - startHeight) * t;
          }
        }
        
        // Fallback to nominal height
        return nominalFlightHeight;
      };

      // Merge API response with calculated distances and interpolated flight heights
      // Use the API's distance for interpolation, but ensure vertex distances match
      const profile: ElevationPoint[] = response.data.profile.map((point: any, index: number) => {
        // Use API distance if available, otherwise calculate from vertex distances
        const distance = point.distance !== undefined ? point.distance : (distances[index] || 0);
        return {
          distance,
          elevation: point.elevation,
          longitude: point.longitude,
          latitude: point.latitude,
          flightHeight: interpolateFlightHeight(distance),
          minElevation: point.minElevation,
          maxElevation: point.maxElevation
        };
      });

      // Log min/max statistics
      const pointsWithMinMax = profile.filter(p => p.minElevation !== undefined && p.maxElevation !== undefined);
      console.log(`Elevation profile loaded: ${profile.length} points, ${pointsWithMinMax.length} with min/max values`);
      if (pointsWithMinMax.length > 0) {
        console.log(`Sample min/max values:`, pointsWithMinMax.slice(0, 3).map(p => ({
          distance: p.distance.toFixed(1),
          min: p.minElevation?.toFixed(1),
          max: p.maxElevation?.toFixed(1),
          elevation: p.elevation.toFixed(1)
        })));
      }
      
      setElevationProfile(profile);
    } catch (error) {
      console.error('Error calculating elevation profile:', error);
      // Fallback to mock data if API fails
      const calculateDistance = (coord1: Coordinate, coord2: Coordinate): number => {
        const R = 6371000; // Earth radius in meters
        const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
        const dLon = (coord2.lng - coord1.lng) * Math.PI / 180;
        const a = 
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };

      let cumulativeDistance = 0;
      const distances = [0];
      const segmentDistances: number[] = [0];
      for (let i = 1; i < flightPath.length; i++) {
        const segmentDist = calculateDistance(flightPath[i - 1], flightPath[i]);
        cumulativeDistance += segmentDist;
        distances.push(cumulativeDistance);
        segmentDistances.push(segmentDist);
      }

      // Helper function to interpolate flight height for any point along the path
      const interpolateFlightHeight = (distance: number): number => {
        // Find which segment this point belongs to
        if (distance <= 0) {
          return flightPath[0].height ?? nominalFlightHeight;
        }
        
        if (distance >= distances[distances.length - 1]) {
          return flightPath[flightPath.length - 1].height ?? nominalFlightHeight;
        }
        
        // Find the segment containing this distance
        for (let i = 0; i < distances.length - 1; i++) {
          if (distance >= distances[i] && distance <= distances[i + 1]) {
            const startHeight = flightPath[i].height ?? nominalFlightHeight;
            const endHeight = flightPath[i + 1].height ?? nominalFlightHeight;
            
            // If heights are the same, no interpolation needed
            if (startHeight === endHeight) {
              return startHeight;
            }
            
            // Linear interpolation
            const segmentStartDist = distances[i];
            const segmentLength = distances[i + 1] - segmentStartDist;
            const distanceInSegment = distance - segmentStartDist;
            const t = segmentLength > 0 ? distanceInSegment / segmentLength : 0;
            return startHeight + (endHeight - startHeight) * t;
          }
        }
        
        // Fallback to nominal height
        return nominalFlightHeight;
      };

      const mockProfile: ElevationPoint[] = flightPath.map((coord, index) => {
        const distance = distances[index] || 0;
        // Mock elevation with some variation
        const elevation = 100 + Math.sin(index * 0.1) * 50 + Math.random() * 20;
        return {
          distance,
          elevation,
          longitude: coord.lng,
          latitude: coord.lat,
          flightHeight: interpolateFlightHeight(distance)
        };
      });
      setElevationProfile(mockProfile);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    elevationProfile,
    loading,
    calculateProfile
  };
}

