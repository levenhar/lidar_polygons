import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

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

// Upload DTM file endpoint
app.post('/api/upload-dtm', upload.single('dtm'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    // Parse GeoTIFF to get metadata immediately
    const filePath = join(uploadsDir, req.file.filename);
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox();
    const [minX, minY, maxX, maxY] = bbox;
    
    res.json({
      success: true,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      size: req.file.size,
      bounds: {
        minX,
        minY,
        maxX,
        maxY
      },
      resolution: {
        width: image.getWidth(),
        height: image.getHeight()
      }
    });
  } catch (error) {
    console.error('Error parsing uploaded GeoTIFF:', error);
    // Still return success but without metadata
    res.json({
      success: true,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      size: req.file.size,
      error: 'Could not parse GeoTIFF metadata'
    });
  }
});

// Get DTM metadata endpoint
app.get('/api/dtm/:filename/metadata', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = join(uploadsDir, filename);
    
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Parse GeoTIFF to get metadata
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox();
    const [minX, minY, maxX, maxY] = bbox;
    
    res.json({
      filename,
      bounds: {
        minX,
        minY,
        maxX,
        maxY
      },
      resolution: {
        width: image.getWidth(),
        height: image.getHeight()
      },
      noDataValue: image.getGDALNoData()
    });
  } catch (error) {
    console.error('Error parsing GeoTIFF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get DTM raster data for rendering
app.get('/api/dtm/:filename/raster', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = join(uploadsDir, filename);
    
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    console.log(`Processing GeoTIFF: ${filename}`);
    
    // Parse GeoTIFF
    const tiff = await fromFile(filePath);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    
    console.log(`GeoTIFF dimensions: ${width}x${height} (${width * height} pixels)`);
    
    // Read full resolution raster data - no downsampling
    let rasters;
    let data;
    
    try {
      console.log('Reading full resolution raster data...');
      rasters = await image.readRasters();
      let rawData = rasters[0];
      console.log(`Raw data type: ${rawData.constructor.name}, length: ${rawData.length}`);
      
      // Convert to array (keep full resolution)
      // Use a more efficient method that doesn't cause stack overflow
      if (ArrayBuffer.isView(rawData) && !Array.isArray(rawData)) {
        console.log('Converting TypedArray to regular array (full resolution)...');
        const totalLength = rawData.length;
        const chunkSize = 100000; // Smaller chunks to avoid stack overflow
        const result = new Array(totalLength);
        
        // Copy in chunks without using spread operator
        for (let i = 0; i < totalLength; i += chunkSize) {
          const end = Math.min(i + chunkSize, totalLength);
          for (let j = i; j < end; j++) {
            result[j] = rawData[j];
          }
          if (i % (chunkSize * 10) === 0) {
            console.log(`Converted ${((i / totalLength) * 100).toFixed(1)}%...`);
          }
        }
        data = result;
        console.log(`Conversion complete: ${data.length} values`);
      } else {
        data = rawData;
        console.log(`Data already in array format: ${data.length} values`);
      }
      
      console.log(`Final data length: ${data.length}`);
    } catch (readError) {
      console.error('Error reading rasters:', readError);
      console.error('Stack:', readError.stack);
      throw new Error(`Failed to read GeoTIFF raster data: ${readError.message}`);
    }
    
    // Calculate statistics (handle no-data values) - use efficient methods for large arrays
    const noDataValue = image.getGDALNoData();
    
    // Calculate min/max without creating intermediate arrays
    let min = Infinity;
    let max = -Infinity;
    let hasValidData = false;
    
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (noDataValue !== null && noDataValue !== undefined && value === noDataValue) {
        continue; // Skip no-data values
      }
      if (isNaN(value) || !isFinite(value)) {
        continue; // Skip invalid values
      }
      hasValidData = true;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    
    if (!hasValidData) {
      min = 0;
      max = 0;
    }
    
    console.log(`Elevation range: ${min} to ${max}`);
    
    // Get bounds - check if we need coordinate transformation
    const bbox = image.getBoundingBox();
    const [minX, minY, maxX, maxY] = bbox;
    
    // Check if bounds are in projected coordinates (large numbers) vs geographic (lat/lon)
    // Geographic coordinates: lon typically -180 to 180, lat -90 to 90
    // Projected coordinates: typically much larger numbers
    const isProjected = Math.abs(minX) > 180 || Math.abs(minY) > 90 || 
                        Math.abs(maxX) > 180 || Math.abs(maxY) > 90;
    
    console.log(`Bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]`);
    console.log(`Coordinate system: ${isProjected ? 'Projected (needs transformation)' : 'Geographic (WGS84)'}`);
    
    // Prepare response - use full resolution
    const responseData = {
      width: width,
      height: height,
      originalWidth: width,
      originalHeight: height,
      min,
      max,
      bounds: bbox,
      noDataValue: noDataValue,
      isProjected: isProjected
    };
    
    // Try to get coordinate system info for transformation
    try {
      const geoKeys = image.getGeoKeys();
      const fileDirectory = image.getFileDirectory();
      
      // Get CRS information
      responseData.crs = {
        geographicType: geoKeys?.GeographicTypeGeoKey || null,
        projectedCSType: geoKeys?.ProjectedCSTypeGeoKey || null,
        geogCitation: geoKeys?.GeogCitationGeoKey || null,
        projCitation: geoKeys?.PCSCitationGeoKey || null
      };
      
      // Get projection parameters if available
      responseData.projParams = {
        projString: fileDirectory.GeoAsciiParamsTag || null,
        modelTiepoint: fileDirectory.ModelTiepointTag || null,
        modelPixelScale: fileDirectory.ModelPixelScaleTag || null,
        modelTransformation: fileDirectory.ModelTransformationTag || null
      };
      
      // Try to determine EPSG code
      if (geoKeys?.ProjectedCSTypeGeoKey) {
        responseData.epsg = geoKeys.ProjectedCSTypeGeoKey;
      } else if (geoKeys?.GeographicTypeGeoKey) {
        responseData.epsg = geoKeys.GeographicTypeGeoKey;
      }
      
      console.log('CRS Info:', JSON.stringify(responseData.crs, null, 2));
      console.log('EPSG Code:', responseData.epsg);
    } catch (e) {
      console.error('Error getting CRS info:', e);
      // Ignore if we can't get CRS info
    }
    
    console.log('Preparing to send response...');
    console.log(`Data array length: ${data.length}`);
    
    // Add data to response
    try {
      responseData.data = data;
      console.log('Serializing JSON response...');
      const jsonString = JSON.stringify(responseData);
      console.log(`JSON size: ${(jsonString.length / 1024 / 1024).toFixed(2)} MB`);
      
      res.json(responseData);
      console.log('Response sent successfully');
    } catch (jsonError) {
      console.error('Error serializing JSON:', jsonError);
      throw new Error(`Failed to serialize response: ${jsonError.message}. Data may be too large.`);
    }
  } catch (error) {
    console.error('Error processing GeoTIFF:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ 
      error: error.message,
      details: error.stack,
      filename: req.params.filename
    });
  }
});

// Get elevation data along a path
// This endpoint samples the DTM at points along the path
app.post('/api/elevation-profile', async (req, res) => {
  try {
    const { coordinates, dtmPath } = req.body;
    
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Invalid coordinates array' });
    }
    
    if (!dtmPath) {
      return res.status(400).json({ error: 'DTM path is required' });
    }
    
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
    console.log(`Number of coordinates: ${coordinates.length}`);
    
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
    
    // Sample elevation at each coordinate
    const profile = [];
    for (let i = 0; i < coordinates.length; i++) {
      const [lon, lat] = coordinates[i];
      
      // Convert to pixel coordinates
      const pixel = geoToPixel(lon, lat);
      if (!pixel) {
        console.warn(`Could not convert coordinates [${lon}, ${lat}] to pixel coordinates`);
        profile.push({
          distance: 0,
          elevation: 0,
          longitude: lon,
          latitude: lat
        });
        continue;
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
      
      profile.push({
        distance: 0, // Distance will be calculated on frontend
        elevation: elevation !== null ? elevation : 0,
        longitude: lon,
        latitude: lat
      });
    }
    
    console.log(`Successfully sampled ${profile.length} elevation points`);
    console.log(`Elevation range: ${Math.min(...profile.map(p => p.elevation))} to ${Math.max(...profile.map(p => p.elevation))}`);
    
    res.json({ profile });
  } catch (error) {
    console.error('Error calculating elevation profile:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

