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
const proxyToPython = async (endpoint, options = {}) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}${endpoint}`, options);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Python backend error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Python proxy error for ${endpoint}:`, error);
    throw error;
  }
};

// Upload DTM file endpoint
// Proxy the raw multipart request to Python
app.post('/api/upload-dtm', async (req, res) => {
  try {
    console.log('Proxying DTM upload to Python backend...');

    // We forward the request as a stream to the Python backend
    // Note: Node-fetch in Node 18+ can handle the request stream directly
    const response = await fetch(`${PYTHON_BACKEND_URL}/upload-dtm`, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type']
      },
      body: req,
      // @ts-ignore
      duplex: 'half'
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python upload error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error proxying uploaded GeoTIFF to Python:', error);
    res.status(500).json({
      error: 'Could not upload DTM to Python backend',
      details: error.message
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
    const { coordinates, dtmPath, safetyRadiusMeters, resolutionRadiusMeters } = req.body;

    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Invalid coordinates array' });
    }

    if (!dtmPath) {
      return res.status(400).json({ error: 'DTM path is required' });
    }

    console.log(`Proxying elevation profile request for ${dtmPath} to Python backend...`);

    const result = await proxyToPython('/elevation-profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        coordinates,
        dtmPath,
        safetyRadiusMeters: safetyRadiusMeters ?? 50,
        resolutionRadiusMeters: resolutionRadiusMeters ?? 50
      })
    });

    res.json(result);
  } catch (error) {
    console.error('Error proxying elevation profile request:', error);
    res.status(500).json({
      error: 'Could not calculate elevation profile',
      details: error.message
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

