import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { readFile, unlink } from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.BACKEND_PORT;
const MAPS_TOKEN = process.env.MAPS_TOKEN;
const MAPS_URL = process.env.MAPS_URL;
const MAPS_URL_ALT = process.env.MAPS_URL_ALT;
const MAPS_CRS = process.env.MAPS_CRS;
const MAPS_PREVIEW_ZOOM_DEFAULT = process.env.MAPS_PREVIEW_ZOOM_DEFAULT;
const MAPS_PREVIEW_X_DEFAULT = process.env.MAPS_PREVIEW_X_DEFAULT;
const MAPS_PREVIEW_Y_DEFAULT = process.env.MAPS_PREVIEW_Y_DEFAULT;
const MAPS_PREVIEW_ZOOM_PRIMARY = process.env.MAPS_PREVIEW_ZOOM_PRIMARY;
const MAPS_PREVIEW_X_PRIMARY = process.env.MAPS_PREVIEW_X_PRIMARY;
const MAPS_PREVIEW_Y_PRIMARY = process.env.MAPS_PREVIEW_Y_PRIMARY;
const MAPS_PREVIEW_ZOOM_ALTERNATE = process.env.MAPS_PREVIEW_ZOOM_ALTERNATE;
const MAPS_PREVIEW_X_ALTERNATE = process.env.MAPS_PREVIEW_X_ALTERNATE;
const MAPS_PREVIEW_Y_ALTERNATE = process.env.MAPS_PREVIEW_Y_ALTERNATE;

//Middleware
app.use((req, res, next) => {
  console.log(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  next();
})

// Middleware
app.use(cors());
app.use(express.json());

const uploadsDir = join(__dirname, 'uploads');

// Helpers for preview values
const clampZoom = (value) => Math.min(22, Math.max(0, value));
const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getPreviewConfig = () => {
  const defaults = {
    zoom: clampZoom(parseNumber(MAPS_PREVIEW_ZOOM_DEFAULT, 0)),
    x: parseNumber(MAPS_PREVIEW_X_DEFAULT, 0),
    y: parseNumber(MAPS_PREVIEW_Y_DEFAULT, 0)
  };

  const overrides = {};

  const assignIfDefined = (id, key, envValue, clampFn = (v) => v) => {
    if (envValue !== undefined) {
      if (!overrides[id]) overrides[id] = {};
      overrides[id][key] = clampFn(parseNumber(envValue, defaults[key]));
    }
  };

  assignIfDefined('primary', 'zoom', MAPS_PREVIEW_ZOOM_PRIMARY, clampZoom);
  assignIfDefined('primary', 'x', MAPS_PREVIEW_X_PRIMARY);
  assignIfDefined('primary', 'y', MAPS_PREVIEW_Y_PRIMARY);

  assignIfDefined('alternate', 'zoom', MAPS_PREVIEW_ZOOM_ALTERNATE, clampZoom);
  assignIfDefined('alternate', 'x', MAPS_PREVIEW_X_ALTERNATE);
  assignIfDefined('alternate', 'y', MAPS_PREVIEW_Y_ALTERNATE);

  return { defaults, overrides };
};

// Clear cached uploads on restart to avoid serving stale files
// Clear cached uploads on restart to avoid serving stale files
const clearUploadsDirectory = async () => {
  try {
    if (existsSync(uploadsDir)) {
      // Readdir and unlink each file instead of removing the directory itself
      // This preserves the directory inode which is important for Docker bind mounts
      const { readdir } = await import('fs/promises');
      const files = await readdir(uploadsDir);
      await Promise.all(
        files.map(file => unlink(join(uploadsDir, file)).catch(e => console.error(`Failed to delete ${file}:`, e)))
      );
    } else {
      mkdirSync(uploadsDir, { recursive: true });
    }
    console.log('Uploads cache cleared on startup');
  } catch (error) {
    console.error('Failed to clear uploads cache on startup:', error);
  }
};

clearUploadsDirectory();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Accept GeoTIFF files
    if (file.mimetype === 'image/tiff' ||
      file.mimetype === 'image/geotiff' ||
      file.originalname.toLowerCase().endsWith('.tif') ||
      file.originalname.toLowerCase().endsWith('.tiff') ||
      file.originalname.toLowerCase().endsWith('.geotiff')) {
      cb(null, true);
    } else {
      cb(new Error('Only GeoTIFF files are allowed'));
    }
  }
});

// Serve static files from uploads directory
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// token endpoint
app.get('/api/token', (req, res) => {
  res.json({ token: MAPS_TOKEN })
})

// url endpoint
app.get('/api/url', (req, res) => {
  res.json({
    url: MAPS_URL,
    altUrl: MAPS_URL_ALT || null
  })
})

// map preview config endpoint
app.get('/api/map-preview', (req, res) => {
  res.json(getPreviewConfig());
})

// crs endpoint
app.get('/api/crs', (req, res) => {
  res.json({ crs: MAPS_CRS })
})


// Test GeoTIFF reading endpoint
app.get('/api/dtm/:filename/test', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = join(uploadsDir, filename);

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    console.log(`Testing GeoTIFF: ${filename}`);

    // Try to parse GeoTIFF
    const tiff = await fromFile(filePath);
    console.log('GeoTIFF opened successfully');

    const image = await tiff.getImage();
    console.log('Image retrieved');

    const width = image.getWidth();
    const height = image.getHeight();
    console.log(`Dimensions: ${width}x${height}`);

    const bbox = image.getBoundingBox();
    console.log(`Bounds: ${bbox}`);

    // Try reading a small sample
    const rasters = await image.readRasters({
      window: [0, 0, Math.min(10, width), Math.min(10, height)]
    });
    console.log(`Sample read: ${rasters[0].length} values`);

    res.json({
      success: true,
      width,
      height,
      bounds: bbox,
      sampleSize: rasters[0].length,
      sampleData: Array.from(rasters[0].slice(0, 10))
    });
  } catch (error) {
    console.error('Test error:', error);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// Python backend URL
const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || 'http://localhost:8000';

// Proxy helper
const proxyToPython = async (endpoint) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}${endpoint}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Python backend error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Python proxy error:', error);
    throw error;
  }
};

// Upload DTM file endpoint
app.post('/api/upload-dtm', upload.single('dtm'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    // Call Python backend for metadata
    const metadata = await proxyToPython(`/dtm/${req.file.filename}/metadata`);

    res.json({
      success: true,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      size: req.file.size,
      bounds: metadata.bounds,
      resolution: metadata.resolution
    });
  } catch (error) {
    console.error('Error parsing uploaded GeoTIFF via Python:', error);
    // Return partial success if python fails, or error?
    // Let's return minimal info if python fails, assuming file upload worked
    res.json({
      success: true,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      size: req.file.size,
      error: 'Could not retrieve metadata from Python backend'
    });
  }
});

// Delete a cached DTM file (used when clients unload/close)
app.post('/api/dtm/cleanup', async (req, res) => {
  try {
    const { path: dtmPath, filename } = req.body || {};
    const rawName = filename || (typeof dtmPath === 'string' ? dtmPath.split('/').pop() : null);

    if (!rawName) {
      return res.status(400).json({ success: false, error: 'No filename provided' });
    }

    const safeFilename = basename(rawName);
    const filePath = join(uploadsDir, safeFilename);

    if (!existsSync(filePath)) {
      return res.json({ success: true, deleted: false, message: 'File not found' });
    }

    await unlink(filePath);
    res.json({ success: true, deleted: true, filename: safeFilename });
  } catch (error) {
    console.error('Error deleting DTM file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete DTM file' });
  }
});

// Get DTM metadata endpoint
app.get('/api/dtm/:filename/metadata', async (req, res) => {
  try {
    const filename = req.params.filename;
    const metadata = await proxyToPython(`/dtm/${filename}/metadata`);
    res.json(metadata);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get DTM raster data for rendering
app.get('/api/dtm/:filename/raster', async (req, res) => {
  try {
    const filename = req.params.filename;
    console.log(`Proxying raster request for ${filename} to Python backend...`);

    // For large raster data, we might want to pipe the response directly
    // But existing frontend expects specific JSON structure which the Python backend provides
    const rasterData = await proxyToPython(`/dtm/${filename}/raster`);

    console.log('Received raster data from Python, sending to client...');
    res.json(rasterData);
  } catch (error) {
    console.error('Error getting raster data:', error);
    res.status(500).json({
      error: error.message,
      filename: req.params.filename
    });
  }
});

// Get elevation data along a path
// This endpoint samples the DTM at points along the path, including interpolated points along line segments
app.post('/api/elevation-profile', async (req, res) => {
  try {
    const { coordinates, dtmPath, radiusMeters, resolutionRadiusMeters, safetyRadiusMeters } = req.body;

    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Invalid coordinates array' });
    }

    if (!dtmPath) {
      return res.status(400).json({ error: 'DTM path is required' });
    }

    // Default radii are 50 meters if not specified
    const resolutionRadius = resolutionRadiusMeters ?? radiusMeters ?? 50; // max (resolution / highest point)
    const safetyRadius = safetyRadiusMeters ?? radiusMeters ?? 50; // min (safety / lowest point)

    // Extract filename from path
    const filename = dtmPath.split('/').pop();
    if (!filename) {
      return res.status(400).json({ error: 'Invalid DTM path' });
    }

    const filePath = join(uploadsDir, filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'DTM file not found' });
    }

    console.log(`Sampling elevation profile from DTM: ${filename}`);
    console.log(`Number of input coordinates: ${coordinates.length}`);
    console.log(`Radii -> safety(min): ${safetyRadius}m, resolution(max): ${resolutionRadius}m`);

    // Load the GeoTIFF
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox();
    const [minX, minY, maxX, maxY] = bbox;

    // Check if DTM uses projected coordinates
    const isProjected = Math.abs(minX) > 180 || Math.abs(minY) > 90 ||
      Math.abs(maxX) > 180 || Math.abs(maxY) > 90;

    // Get coordinate system info for transformation
    let sourceProj = null;
    try {
      const geoKeys = image.getGeoKeys();
      if (geoKeys?.ProjectedCSTypeGeoKey) {
        sourceProj = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
      } else if (geoKeys?.GeographicTypeGeoKey) {
        sourceProj = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
      }
    } catch (e) {
      console.warn('Could not determine EPSG code, will attempt coordinate conversion');
    }

    // If projected and no EPSG found, try to infer from bounds
    if (isProjected && !sourceProj) {
      // Default to UTM Zone 36N if we can't determine
      sourceProj = 'EPSG:32636';
      console.warn('Using default projection EPSG:32636');
    }

    // Read the raster data
    const rasters = await image.readRasters();
    const elevationData = rasters[0];
    const noDataValue = image.getGDALNoData();

    // Get pixel scale and tie points for coordinate conversion
    const fileDirectory = image.getFileDirectory();
    const modelPixelScale = fileDirectory.ModelPixelScaleTag;
    const modelTiepoint = fileDirectory.ModelTiepointTag;

    // Helper function to convert geographic coordinates to pixel coordinates
    const geoToPixel = (lon, lat) => {
      let x = lon;
      let y = lat;

      // Transform from WGS84 to DTM coordinate system if needed
      if (isProjected && sourceProj) {
        try {
          [x, y] = proj4('EPSG:4326', sourceProj, [lon, lat]);
        } catch (transformError) {
          console.error('Coordinate transformation error:', transformError);
          return null;
        }
      }

      // Calculate pixel coordinates using model transformation
      if (modelPixelScale && modelTiepoint) {
        // ModelTiepoint: [I, J, K, X, Y, Z] where (I,J) is pixel location and (X,Y,Z) is geo location
        // ModelPixelScale: [ScaleX, ScaleY, ScaleZ]
        const [tieI, tieJ, tieK, geoX, geoY, geoZ] = modelTiepoint;
        const [scaleX, scaleY, scaleZ] = modelPixelScale;

        // Invert the transformation: pixel = (geo - geoOrigin) / scale + tiePoint
        const pixelX = Math.round((x - geoX) / scaleX + tieI);
        const pixelY = Math.round((geoY - y) / scaleY + tieJ); // Note: Y is typically inverted

        return { pixelX, pixelY };
      } else {
        // Fallback: use bounding box (assumes north-up, west-left orientation)
        const pixelX = Math.round(((x - minX) / (maxX - minX)) * width);
        const pixelY = Math.round(((maxY - y) / (maxY - minY)) * height);

        return { pixelX, pixelY };
      }
    };

    // Helper function to calculate distance between two coordinates (Haversine formula)
    const calculateDistance = (coord1, coord2) => {
      const R = 6371000; // Earth radius in meters
      const [lon1, lat1] = coord1;
      const [lon2, lat2] = coord2;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    // Helper function to interpolate points along a line segment
    // Returns an array of coordinates along the segment at regular intervals
    const interpolateSegment = (start, end, intervalMeters) => {
      const distance = calculateDistance(start, end);
      const numPoints = Math.max(2, Math.ceil(distance / intervalMeters));
      const points = [];

      for (let i = 0; i < numPoints; i++) {
        const t = i / (numPoints - 1);
        const lon = start[0] + (end[0] - start[0]) * t;
        const lat = start[1] + (end[1] - start[1]) * t;
        points.push([lon, lat]);
      }

      return points;
    };

    // Sample elevation at a coordinate
    const sampleElevation = (lon, lat) => {
      const pixel = geoToPixel(lon, lat);
      if (!pixel) {
        return null;
      }

      const { pixelX, pixelY } = pixel;

      // Clamp pixel coordinates to valid range
      const clampedX = Math.max(0, Math.min(width - 1, pixelX));
      const clampedY = Math.max(0, Math.min(height - 1, pixelY));

      // Calculate array index (raster data is stored row by row, top to bottom)
      const index = clampedY * width + clampedX;

      // Get elevation value from raster data
      let elevation = elevationData[index];

      // Handle no-data values
      if (noDataValue !== null && noDataValue !== undefined && elevation === noDataValue) {
        elevation = null;
      } else if (isNaN(elevation) || !isFinite(elevation)) {
        elevation = null;
      }

      return elevation !== null ? elevation : null;
    };

    // Calculate min and max elevation within a given radius (in meters)
    const getMinMaxElevationInRadius = (centerLon, centerLat, radiusMeters) => {
      // Convert radius from meters to degrees (approximate)
      // At equator: 1 degree ≈ 111,320 meters
      // Adjust for latitude: degrees_lon = meters / (111,320 * cos(lat))
      // degrees_lat = meters / 111,320
      const metersPerDegreeLat = 111320;
      const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180);

      const radiusDegLat = radiusMeters / metersPerDegreeLat;
      const radiusDegLon = radiusMeters / metersPerDegreeLon;

      // Calculate bounding box for the circular area
      const minLon = centerLon - radiusDegLon;
      const maxLon = centerLon + radiusDegLon;
      const minLat = centerLat - radiusDegLat;
      const maxLat = centerLat + radiusDegLat;

      // Convert bounding box corners to pixels
      const minPixel = geoToPixel(minLon, minLat);
      const maxPixel = geoToPixel(maxLon, maxLat);

      if (!minPixel || !maxPixel) {
        return { min: null, max: null };
      }

      // Get pixel bounds to sample
      const minPixelX = Math.max(0, Math.min(width - 1, minPixel.pixelX));
      const maxPixelX = Math.max(0, Math.min(width - 1, maxPixel.pixelX));
      const minPixelY = Math.max(0, Math.min(height - 1, minPixel.pixelY));
      const maxPixelY = Math.max(0, Math.min(height - 1, maxPixel.pixelY));

      // Sample pixels within the bounding box and check if they're within radius
      let minElevation = Infinity;
      let maxElevation = -Infinity;
      let hasValidData = false;

      // Calculate center pixel for distance checking
      const centerPixel = geoToPixel(centerLon, centerLat);
      if (!centerPixel) {
        return { min: null, max: null };
      }

      // Estimate pixel resolution for efficient sampling
      // Calculate approximate meters per pixel
      let metersPerPixelX, metersPerPixelY;
      if (modelPixelScale) {
        const [scaleX, scaleY] = modelPixelScale;
        // Scale is in units per pixel - convert to meters if needed
        // For geographic coordinates, we need to account for latitude
        if (isProjected) {
          metersPerPixelX = scaleX;
          metersPerPixelY = scaleY;
        } else {
          // Approximate conversion for geographic coordinates
          metersPerPixelX = scaleX * 111320 * Math.cos(centerLat * Math.PI / 180);
          metersPerPixelY = scaleY * 111320;
        }
      } else {
        // Fallback: estimate from bounding box
        const pixelWidth = maxX - minX;
        const pixelHeight = maxY - minY;
        if (isProjected) {
          metersPerPixelX = pixelWidth / width;
          metersPerPixelY = pixelHeight / height;
        } else {
          metersPerPixelX = (pixelWidth / width) * 111320 * Math.cos(centerLat * Math.PI / 180);
          metersPerPixelY = (pixelHeight / height) * 111320;
        }
      }

      // Calculate step size to sample approximately 100-200 points within radius
      const estimatedPixelsInRadius = Math.max(10, Math.min(200, (radiusMeters / Math.min(metersPerPixelX, metersPerPixelY))));
      const stepSize = Math.max(1, Math.floor(Math.sqrt((maxPixelX - minPixelX) * (maxPixelY - minPixelY) / estimatedPixelsInRadius)));

      // Sample pixels with step size
      for (let py = minPixelY; py <= maxPixelY; py += stepSize) {
        for (let px = minPixelX; px <= maxPixelX; px += stepSize) {
          // Convert pixel back to geographic coordinates to check distance
          let sampleLon, sampleLat;

          if (modelPixelScale && modelTiepoint) {
            const [tieI, tieJ, tieK, geoX, geoY, geoZ] = modelTiepoint;
            const [scaleX, scaleY, scaleZ] = modelPixelScale;

            // Convert pixel to geo coordinates
            const geoX_coord = (px - tieI) * scaleX + geoX;
            const geoY_coord = geoY - (py - tieJ) * scaleY;

            // Transform back to WGS84 if needed
            if (isProjected && sourceProj) {
              try {
                [sampleLon, sampleLat] = proj4(sourceProj, 'EPSG:4326', [geoX_coord, geoY_coord]);
              } catch (e) {
                continue;
              }
            } else {
              sampleLon = geoX_coord;
              sampleLat = geoY_coord;
            }
          } else {
            // Fallback: use bounding box interpolation
            sampleLon = minX + ((px / width) * (maxX - minX));
            sampleLat = maxY - ((py / height) * (maxY - minY));
          }

          // Check if this pixel is within the circular radius
          const distance = calculateDistance([centerLon, centerLat], [sampleLon, sampleLat]);
          if (distance > radiusMeters) {
            continue; // Skip pixels outside the radius
          }

          // Get elevation at this pixel
          const index = py * width + px;
          if (index < 0 || index >= elevationData.length) continue;

          let elevation = elevationData[index];

          // Handle no-data values
          if (noDataValue !== null && noDataValue !== undefined && elevation === noDataValue) {
            continue;
          }
          if (isNaN(elevation) || !isFinite(elevation)) {
            continue;
          }

          // Update min/max
          if (elevation < minElevation) minElevation = elevation;
          if (elevation > maxElevation) maxElevation = elevation;
          hasValidData = true;
        }
      }

      // Also check immediate neighbors of center pixel for accuracy
      const centerX = Math.round(centerPixel.pixelX);
      const centerY = Math.round(centerPixel.pixelY);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = centerX + dx;
          const py = centerY + dy;
          if (px < 0 || px >= width || py < 0 || py >= height) continue;

          const index = py * width + px;
          if (index < 0 || index >= elevationData.length) continue;

          let elevation = elevationData[index];
          if (noDataValue !== null && noDataValue !== undefined && elevation === noDataValue) continue;
          if (isNaN(elevation) || !isFinite(elevation)) continue;

          if (elevation < minElevation) minElevation = elevation;
          if (elevation > maxElevation) maxElevation = elevation;
          hasValidData = true;
        }
      }

      if (!hasValidData) {
        return { min: null, max: null };
      }

      return { min: minElevation, max: maxElevation };
    };

    // Generate sampling points along the entire path
    // Use a sampling interval of 5 meters to get dense coverage
    const samplingInterval = 5; // meters
    const allPoints = [];

    // Always include the first point
    allPoints.push(coordinates[0]);

    // For each segment, interpolate points along it
    for (let i = 0; i < coordinates.length - 1; i++) {
      const start = coordinates[i];
      const end = coordinates[i + 1];

      // Get interpolated points along this segment (excluding the start point to avoid duplicates)
      const segmentPoints = interpolateSegment(start, end, samplingInterval);

      // Add all points except the first (which is the same as the previous segment's end)
      for (let j = 1; j < segmentPoints.length; j++) {
        allPoints.push(segmentPoints[j]);
      }
    }

    console.log(`Generated ${allPoints.length} sampling points along the path`);

    // Sample elevation at all points
    const profile = [];
    let cumulativeDistance = 0;

    for (let i = 0; i < allPoints.length; i++) {
      const [lon, lat] = allPoints[i];

      // Calculate cumulative distance
      if (i > 0) {
        cumulativeDistance += calculateDistance(allPoints[i - 1], allPoints[i]);
      }

      // Sample elevation at the point
      const elevation = sampleElevation(lon, lat);

      // Calculate min/max elevation within radius
      let minElevation = undefined;
      let maxElevation = undefined;

      try {
        const minResult = getMinMaxElevationInRadius(lon, lat, safetyRadius);
        const maxResult = resolutionRadius === safetyRadius
          ? minResult
          : getMinMaxElevationInRadius(lon, lat, resolutionRadius);

        if (minResult && minResult.min !== null) {
          minElevation = minResult.min;
        }
        if (maxResult && maxResult.max !== null) {
          maxElevation = maxResult.max;
        }
      } catch (error) {
        console.error(`Error calculating min/max at point ${i}:`, error);
        // Continue without min/max for this point
      }

      profile.push({
        distance: cumulativeDistance,
        elevation: elevation !== null ? elevation : 0,
        longitude: lon,
        latitude: lat,
        minElevation: minElevation,
        maxElevation: maxElevation
      });
    }

    console.log(`Successfully sampled ${profile.length} elevation points`);
    const validElevations = profile.filter(p => p.elevation > 0 || p.elevation < 0).map(p => p.elevation);
    if (validElevations.length > 0) {
      console.log(`Elevation range: ${Math.min(...validElevations).toFixed(2)} to ${Math.max(...validElevations).toFixed(2)}`);
    }

    // Log min/max statistics
    const pointsWithMinMax = profile.filter(p => p.minElevation !== undefined && p.maxElevation !== undefined);
    console.log(`Points with min/max elevation: ${pointsWithMinMax.length} out of ${profile.length}`);
    if (pointsWithMinMax.length > 0) {
      const minValues = pointsWithMinMax.map(p => p.minElevation).filter(v => v !== undefined);
      const maxValues = pointsWithMinMax.map(p => p.maxElevation).filter(v => v !== undefined);
      console.log(`Min elevation range: ${Math.min(...minValues).toFixed(2)} to ${Math.max(...minValues).toFixed(2)}`);
      console.log(`Max elevation range: ${Math.min(...maxValues).toFixed(2)} to ${Math.max(...maxValues).toFixed(2)}`);
    }

    res.json({ profile });
  } catch (error) {
    console.error('Error calculating elevation profile:', error);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

// 1) Path to Vite build 
const distPath = join(__dirname, '../frontend/dist');
console.log("distPath");
console.log(distPath)
// 2) Serve static file (JS, CSS, image, etc.)
app.use(express.static(distPath));
// 3) SPA fallback: for any unknown route, send index.html
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});


// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

