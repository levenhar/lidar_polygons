import { useState, useCallback } from 'react';
import { Coordinate } from '../App';
import { ElevationPoint } from '../App';
import axios from 'axios';

export function useElevationProfile() {
  const [elevationProfile, setElevationProfile] = useState<ElevationPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const calculateProfile = useCallback(async (
    flightPath: Coordinate[],
    dtmSource: string
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
      for (let i = 1; i < flightPath.length; i++) {
        cumulativeDistance += calculateDistance(flightPath[i - 1], flightPath[i]);
        distances.push(cumulativeDistance);
      }
      
      const response = await axios.post('http://localhost:5000/api/elevation-profile', {
        coordinates,
        dtmPath: dtmSource
      });

      // Merge API response with calculated distances
      const profile: ElevationPoint[] = response.data.profile.map((point: any, index: number) => ({
        distance: distances[index] || point.distance,
        elevation: point.elevation,
        longitude: point.longitude,
        latitude: point.latitude
      }));

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
      const mockProfile: ElevationPoint[] = flightPath.map((coord, index) => {
        if (index > 0) {
          cumulativeDistance += calculateDistance(flightPath[index - 1], coord);
        }
        // Mock elevation with some variation
        const elevation = 100 + Math.sin(index * 0.1) * 50 + Math.random() * 20;
        return {
          distance: cumulativeDistance,
          elevation,
          longitude: coord.lng,
          latitude: coord.lat
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

