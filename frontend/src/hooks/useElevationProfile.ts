import { useState, useCallback, useRef } from 'react';
import { Coordinate } from '../App';
import { ElevationPoint } from '../App';
import axios, { CancelTokenSource } from 'axios';
import { computeClimbProfile, BaseAltitudeSample, ClimbConfig } from '../utils/climb';

export function useElevationProfile() {
  const [elevationProfile, setElevationProfile] = useState<ElevationPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  
  // Track the latest request to cancel previous ones
  const cancelTokenSourceRef = useRef<CancelTokenSource | null>(null);
  const requestIdRef = useRef(0);

  const calculateProfile = useCallback(async (
    flightPath: Coordinate[],
    dtmSource: string,
    nominalFlightHeight: number,
    safetyRadius: number = 50,
    resolutionRadius?: number,
    safetyHeight?: number,
    resolutionHeight?: number,
    activeClippedId?: string | null,
    onDefaultEntryHeightCalculated?: (height: number) => void
  ) => {
    if (flightPath.length < 2) {
      setElevationProfile([]);
      setProfileReady(false);
      setLoading(false);
      // Cancel any pending request
      if (cancelTokenSourceRef.current) {
        cancelTokenSourceRef.current.cancel('Flight path too short');
        cancelTokenSourceRef.current = null;
      }
      return;
    }

    // Cancel any previous request
    if (cancelTokenSourceRef.current) {
      cancelTokenSourceRef.current.cancel('New calculation started');
      cancelTokenSourceRef.current = null;
    }

    // Create a new cancel token for this request
    const cancelTokenSource = axios.CancelToken.source();
    cancelTokenSourceRef.current = cancelTokenSource;
    
    // Increment request ID to track the latest request
    const currentRequestId = ++requestIdRef.current;
    
    setLoading(true);
    setProfileReady(false); // Reset ready flag when starting new calculation
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
      
      const safetyRadiusToUse = safetyRadius ?? 50;
      const resolutionRadiusToUse = resolutionRadius ?? safetyRadiusToUse;
      console.log(`Calculating elevation profile with safety radius ${safetyRadiusToUse}m and resolution radius ${resolutionRadiusToUse}m`);
      
      // Check if dtmSource is a clipped DTM URL and extract clippedId
      // Use activeClippedId if provided, otherwise extract from dtmSource
      const clippedIdMatch = dtmSource.match(/\/api\/dtm\/clipped\/([^/]+)/);
      const clippedId = clippedIdMatch ? clippedIdMatch[1] : (activeClippedId || undefined);
      
      const response = await axios.post('/api/elevation-profile', {
        coordinates,
        dtmPath: dtmSource,
        safetyRadiusMeters: safetyRadiusToUse, // User-configurable radius for min (safety)
        resolutionRadiusMeters: resolutionRadiusToUse, // User-configurable radius for max (resolution)
        ...(clippedId && { clippedId }) // Pass clippedId if available for faster processing
      }, {
        cancelToken: cancelTokenSource.token
      });
      
      // Check if this request is still the latest one
      if (currentRequestId !== requestIdRef.current) {
        console.log('Ignoring response from outdated request');
        return;
      }

      // Check if server sent ready flag - only process if ready
      if (!response.data.ready) {
        console.warn('Server did not send ready flag, waiting...');
        setLoading(false);
        setProfileReady(false);
        return;
      }

      // Validate that we have complete profile data before processing
      if (!response.data.profile || !Array.isArray(response.data.profile) || response.data.profile.length === 0) {
        console.error('Server returned incomplete profile data:', {
          hasProfile: !!response.data.profile,
          isArray: !!(response.data.profile && Array.isArray(response.data.profile)),
          length: response.data.profile ? response.data.profile.length : 0
        });
        setLoading(false);
        setProfileReady(false);
        return;
      }

      // Check if server sent ready flag - only process if ready
      if (!response.data.ready) {
        console.warn('Server did not send ready flag, waiting...');
        setLoading(false);
        setProfileReady(false);
        return;
      }

      // Validate that we have complete profile data before processing
      if (!response.data.profile || !Array.isArray(response.data.profile) || response.data.profile.length === 0) {
        console.error('Server returned incomplete profile data:', {
          hasProfile: !!response.data.profile,
          isArray: !!(response.data.profile && Array.isArray(response.data.profile)),
          length: response.data.profile ? response.data.profile.length : 0
        });
        setLoading(false);
        setProfileReady(false);
        return;
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
      
      // Calculate default entrance height if nominalFlightHeight is still at default (250)
      // and we have the required parameters
      if (Math.abs(nominalFlightHeight - 250) < 0.1 &&
          safetyHeight !== undefined &&
          resolutionHeight !== undefined &&
          profile.length > 0 &&
          onDefaultEntryHeightCalculated) {
        const firstPoint = profile[0];
        const groundElevation = firstPoint.elevation;
        
        if (groundElevation !== null && !isNaN(groundElevation)) {
          // Calculate default: average of safety and resolution height + ground elevation
          const avgHeight = (safetyHeight + resolutionHeight) / 2;
          const calculatedHeight = avgHeight + groundElevation;
          // Round to 1 decimal place
          const defaultHeight = Math.round(calculatedHeight * 10) / 10;
          
          console.log(`Calculated default entrance height: ${defaultHeight} (ground: ${groundElevation}, avg: ${avgHeight})`);
          onDefaultEntryHeightCalculated(defaultHeight);
        }
      }
      
      // Only set profile when server confirms it's ready AND data is complete
      // Validate profile data is complete before setting ready flag
      if (profile.length === 0) {
        console.warn('Processed profile is empty, not setting ready flag');
        setLoading(false);
        setProfileReady(false);
        return;
      }

      // Check again if this request is still the latest one before updating state
      if (currentRequestId !== requestIdRef.current) {
        console.log('Ignoring response from outdated request');
        return;
      }

      // Clear the cancel token reference since request completed successfully
      if (cancelTokenSourceRef.current === cancelTokenSource) {
        cancelTokenSourceRef.current = null;
      }

      // Set profile data and ready flag together to ensure atomic update
      // This ensures the component only displays after all data is processed
      setElevationProfile(profile);
      setProfileReady(true);
      setLoading(false);
    } catch (error) {
      // Clear the cancel token reference
      if (cancelTokenSourceRef.current === cancelTokenSource) {
        cancelTokenSourceRef.current = null;
      }
      
      // Ignore cancellation errors
      if (axios.isCancel(error)) {
        console.log('Profile calculation cancelled:', error.message);
        return;
      }
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
      // Set profile data and ready flag together to ensure atomic update
      setElevationProfile(mockProfile);
      setProfileReady(true);
      setLoading(false);
    }
  }, []);

  const refreshFlightHeights = useCallback((
    flightPath: Coordinate[], 
    nominalFlightHeight: number,
    climbRequests?: { endDistance: number; climbAmount: number }[],
    climbConfig?: ClimbConfig
  ) => {
    if (flightPath.length < 1) {
      return;
    }

    setElevationProfile(prevProfile => {
      if (prevProfile.length === 0) {
        return prevProfile;
      }

      // If we have climb requests and config, recalculate planned altitude properly
      if (climbRequests && climbRequests.length > 0 && climbConfig) {
        // 1. Calculate base altitude profile (entry height is now ASL, not AGL)
        // Entry height (nominalFlightHeight) is absolute altitude above sea level
        const constantAltitude = nominalFlightHeight;
        const baseAltitudeProfile: BaseAltitudeSample[] = prevProfile.map((p) => ({
          distance: p.distance,
          baseAltitude: constantAltitude,
          ground: p.elevation
        }));

        // 2. Initial base plan
        const basePlanPoints = baseAltitudeProfile.map((p) => ({
          ...p,
          plannedAltitude: p.baseAltitude,
          climbDelta: 0,
          isClimbPhase: false
        }));

        // 3. Process climb requests sequentially
        const sortedClimbs = [...climbRequests].sort((a, b) => a.endDistance - b.endDistance);
        let currentBase = baseAltitudeProfile;
        let currentPlanned = basePlanPoints;

        sortedClimbs.forEach((climb) => {
          const activeRatio = climb.climbAmount > 0 ? climbConfig.climbRatio : climbConfig.descentRatio;
          const requiredHorizontal = Math.abs(climb.climbAmount) * activeRatio;
          const startDistanceOfClimb = Math.max(0, climb.endDistance - requiredHorizontal);

          const res = computeClimbProfile(
            startDistanceOfClimb,
            climb.climbAmount,
            climbConfig.climbRatio,
            climbConfig.descentRatio,
            climbConfig.allowTurnsDuringClimb,
            flightPath,
            currentBase,
            climbConfig.vertexProximityMeters,
            climb.endDistance
          );

          currentPlanned = res.points.map((p, i) => ({
            ...p,
            climbDelta: p.plannedAltitude - (basePlanPoints[i]?.baseAltitude ?? p.baseAltitude),
            isClimbPhase: p.plannedAltitude !== p.baseAltitude
          }));

          currentBase = res.points.map((p) => ({
            distance: p.distance,
            baseAltitude: p.plannedAltitude,
            ground: p.ground
          }));
        });

        // 4. Update profile with new planned and base altitudes
        // Entry height (nominalFlightHeight) is ASL, so base altitude is nominalFlightHeight directly
        return prevProfile.map((p, i) => ({
          ...p,
          plannedAltitude: currentPlanned[i]?.plannedAltitude ?? nominalFlightHeight,
          baseAltitude: currentPlanned[i]?.baseAltitude ?? nominalFlightHeight,
          climbDelta: currentPlanned[i]?.climbDelta ?? 0,
          flightHeight: (currentPlanned[i]?.plannedAltitude ?? nominalFlightHeight) - p.elevation
        }));
      } else {
        // No climb requests, just update based on nominal height
        // Entry height (nominalFlightHeight) is ASL, so planned/base altitude is nominalFlightHeight directly
        return prevProfile.map(point => ({
          ...point,
          plannedAltitude: nominalFlightHeight,
          baseAltitude: nominalFlightHeight,
          flightHeight: nominalFlightHeight - point.elevation
        }));
      }
    });
  }, []);

  const clearProfile = useCallback(() => {
    // Cancel any pending request
    if (cancelTokenSourceRef.current) {
      cancelTokenSourceRef.current.cancel('Profile cleared');
      cancelTokenSourceRef.current = null;
    }
    // Increment request ID to invalidate any in-flight requests
    requestIdRef.current++;
    setElevationProfile([]);
    setProfileReady(false);
    setLoading(false);
  }, []);

  return {
    elevationProfile,
    loading,
    profileReady,
    calculateProfile,
    refreshFlightHeights,
    clearProfile
  };
}

