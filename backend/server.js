import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join, basename, resolve } from 'path';
import { readFile, unlink } from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables - try multiple locations
const envResult = dotenv.config();
if (envResult.error) {
  console.warn('Warning: Could not load .env file:', envResult.error.message);
} else {
  console.log('Environment variables loaded from .env file');
}

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

// Get uploads directory from environment variable, with fallback to default
// UPLOADS_DIR can be absolute or relative to the backend directory
const UPLOADS_DIR_ENV = process.env.UPLOADS_DIR;
console.log(`UPLOADS_DIR from env: ${UPLOADS_DIR_ENV || '(not set)'}`);

let uploadsDir;
if (UPLOADS_DIR_ENV) {
  // Check if it's an absolute path (Unix: starts with /, Windows: matches drive letter pattern)
  const isAbsolute = UPLOADS_DIR_ENV.startsWith('/') || /^[A-Za-z]:[\\/]/.test(UPLOADS_DIR_ENV);
  if (isAbsolute) {
    uploadsDir = resolve(UPLOADS_DIR_ENV); // Normalize absolute path
  } else {
    // Relative path - resolve relative to backend directory
    uploadsDir = resolve(__dirname, UPLOADS_DIR_ENV);
  }
} else {
  // Default fallback
  uploadsDir = resolve(__dirname, 'uploads');
}

//Middleware
app.use((req, res, next) => {
  console.log(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  next();
})

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Log the resolved path (keep original path format for OS compatibility)
console.log(`Using UPLOADS_DIR: ${uploadsDir}`);
console.log(`Backend directory: ${__dirname}`);
console.log(`UPLOADS_DIR_ENV value: ${UPLOADS_DIR_ENV || '(not set, using default)'}`);

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
const clearUploadsDirectory = async () => {
  try {
    if (existsSync(uploadsDir)) {
      // Readdir and remove each file/directory instead of removing the directory itself
      // This preserves the directory inode which is important for Docker bind mounts
      const { readdir, rm, stat } = await import('fs/promises');
      const files = await readdir(uploadsDir);
      await Promise.all(
        files.map(async (file) => {
          const filePath = join(uploadsDir, file);
          try {
            const stats = await stat(filePath);
            if (stats.isDirectory()) {
              // Use rm with recursive for directories
              await rm(filePath, { recursive: true, force: true });
            } else {
              // Use unlink for files
              await unlink(filePath);
            }
          } catch (e) {
            console.error(`Failed to delete ${file}:`, e);
          }
        })
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
    const { path: dtmPath, filename, clippedId } = req.body || {};
    console.log(`Cleanup request - path: ${dtmPath}, filename: ${filename}, clippedId: ${clippedId}`);

    // If clippedId is provided, delete the clipped DTM from Python backend
    if (clippedId) {
      try {
        console.log(`Deleting clipped DTM via Python backend: ${clippedId}`);
        const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}`, {
          method: 'DELETE'
        });
        const data = await response.json();
        console.log(`Clipped DTM deletion result:`, data);
        return res.json(data);
      } catch (error) {
        console.error('Error deleting clipped DTM:', error);
        return res.status(500).json({ success: false, error: 'Failed to delete clipped DTM' });
      }
    }

    // Legacy: delete uploaded file
    const rawName = filename || (typeof dtmPath === 'string' ? dtmPath.split('/').pop() : null);

    if (!rawName) {
      return res.status(400).json({ success: false, error: 'No filename provided' });
    }

    const safeFilename = basename(rawName);
    const filePath = join(uploadsDir, safeFilename);
    
    console.log(`Attempting to delete legacy DTM file:`);
    console.log(`  - Filename: ${safeFilename}`);
    console.log(`  - Full path: ${filePath}`);
    console.log(`  - Uploads directory: ${uploadsDir}`);
    console.log(`  - File exists: ${existsSync(filePath)}`);

    if (!existsSync(filePath)) {
      console.warn(`File not found at: ${filePath}`);
      return res.json({ success: true, deleted: false, message: `File not found at ${filePath}`, uploadsDir });
    }

    await unlink(filePath);
    console.log(`Successfully deleted file: ${filePath}`);
    res.json({ success: true, deleted: true, filename: safeFilename, path: filePath });
  } catch (error) {
    console.error('Error deleting DTM file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete DTM file', details: error.message });
  }
});

// ============================================================================
// NEW DTM ENDPOINTS (proxy to Python backend)
// ============================================================================

// GET /api/dtm/options - List available DTM files
app.get('/api/dtm/options', async (req, res) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/options`, {
      headers: {
        'If-None-Match': req.headers['if-none-match'] || ''
      }
    });

    // Forward ETag and Cache-Control headers
    const etag = response.headers.get('ETag');
    const cacheControl = response.headers.get('Cache-Control');
    
    if (etag) res.setHeader('ETag', etag);
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (response.status === 304) {
      return res.status(304).end();
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching DTM options:', error);
    res.status(500).json({ error: 'Failed to fetch DTM options', details: error.message });
  }
});

// POST /api/dtm/clip - Clip DTM to AOI
app.post('/api/dtm/clip', async (req, res) => {
  try {
    console.log('Clipping DTM with params:', JSON.stringify(req.body));
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python clip error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error clipping DTM:', error);
    res.status(500).json({ error: 'Failed to clip DTM', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/metadata - Get clipped DTM metadata
app.get('/api/dtm/clipped/:clippedId/metadata', async (req, res) => {
  try {
    const { clippedId } = req.params;
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/metadata`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Metadata not found' });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching clipped metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/raster - Get clipped DTM raster data
app.get('/api/dtm/clipped/:clippedId/raster', async (req, res) => {
  try {
    const { clippedId } = req.params;
    console.log(`Fetching raster data for clipped DTM: ${clippedId}`);

    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/raster`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python raster error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching clipped raster:', error);
    res.status(500).json({ error: 'Failed to fetch raster', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/image.png - Get rendered PNG image
app.get('/api/dtm/clipped/:clippedId/image.png', async (req, res) => {
  try {
    const { clippedId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/image.png`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Image not found' });
    }

    res.setHeader('Content-Type', 'image/png');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching clipped image:', error);
    res.status(500).json({ error: 'Failed to fetch image', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/tiles/:z/:x/:y.png - Get map tiles
app.get('/api/dtm/clipped/:clippedId/tiles/:z/:x/:y.png', async (req, res) => {
  try {
    const { clippedId, z, x, y } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/tiles/${z}/${x}/${y}.png`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Tile not found' });
    }

    res.setHeader('Content-Type', 'image/png');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching tile:', error);
    res.status(500).json({ error: 'Failed to fetch tile', details: error.message });
  }
});

// DELETE /api/dtm/clipped/:clippedId - Delete clipped DTM
app.delete('/api/dtm/clipped/:clippedId', async (req, res) => {
  try {
    const { clippedId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error deleting clipped DTM:', error);
    res.status(500).json({ error: 'Failed to delete clipped DTM', details: error.message });
  }
});

// POST /api/dtm/clipped/:clippedId/upload - Upload clipped DTM directly from Python backend cache
// Streams the file from Python backend cache directly to Python backend upload endpoint without copying
app.post('/api/dtm/clipped/:clippedId/upload', async (req, res) => {
  try {
    const { clippedId } = req.params;
    console.log(`Uploading clipped DTM ${clippedId} directly from Python backend cache...`);

    // Try multiple possible endpoints for getting the file from cache
    const possibleEndpoints = [
      `/api/dtm/clipped/${clippedId}/file`,
      `/api/dtm/clipped/${clippedId}/download`,
      `/api/dtm/clipped/${clippedId}/geotiff`,
      `/api/dtm/clipped/${clippedId}/tif`
    ];

    let fileResponse = null;
    let lastError = null;

    // Try each endpoint until one works
    for (const endpoint of possibleEndpoints) {
      try {
        const url = `${PYTHON_BACKEND_URL}${endpoint}`;
        console.log(`Trying to get file from: ${url}`);
        const response = await fetch(url);
        
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('tiff') || 
              contentType.includes('octet-stream') ||
              contentType.includes('application/octet-stream') ||
              contentType.includes('image/tiff')) {
            fileResponse = response;
            console.log(`Successfully got file from: ${endpoint}`);
            break;
          } else {
            console.log(`Endpoint ${endpoint} returned OK but wrong content type: ${contentType}`);
            continue;
          }
        }
      } catch (error) {
        console.log(`Endpoint ${endpoint} failed:`, error.message);
        lastError = error;
        continue;
      }
    }

    if (!fileResponse) {
      const errorText = lastError?.message || 'Failed to get clipped DTM file from any endpoint';
      console.error('All file endpoints failed. Last error:', errorText);
      return res.status(404).json({ 
        error: 'Failed to get clipped DTM file from cache',
        details: errorText,
        triedEndpoints: possibleEndpoints
      });
    }

    // Read file into buffer
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    const filename = `clipped-${clippedId}.tif`;
    
    // Create multipart form data manually
    const boundary = `----WebKitFormBoundary${Date.now()}`;
    const formDataBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, 'utf-8'),
      Buffer.from(`Content-Disposition: form-data; name="dtm"; filename="${filename}"\r\n`, 'utf-8'),
      Buffer.from(`Content-Type: image/tiff\r\n\r\n`, 'utf-8'),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
    ]);

    // Upload to Python backend
    const uploadResponse = await fetch(`${PYTHON_BACKEND_URL}/upload-dtm`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: formDataBuffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Python upload error:', errorText);
      return res.status(uploadResponse.status).json({ error: errorText || 'Failed to upload clipped DTM' });
    }

    const data = await uploadResponse.json();
    console.log(`Successfully uploaded clipped DTM ${clippedId} directly from cache (no copy made)`);
    res.json(data);
  } catch (error) {
    console.error('Error uploading clipped DTM:', error);
    res.status(500).json({ error: 'Failed to upload clipped DTM', details: error.message });
  }
});

// ============================================================================
// NEW DTM ENDPOINTS (proxy to Python backend)
// ============================================================================

// GET /api/dtm/options - List available DTM files
app.get('/api/dtm/options', async (req, res) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/options`, {
      headers: {
        'If-None-Match': req.headers['if-none-match'] || ''
      }
    });

    // Forward ETag and Cache-Control headers
    const etag = response.headers.get('ETag');
    const cacheControl = response.headers.get('Cache-Control');
    
    if (etag) res.setHeader('ETag', etag);
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (response.status === 304) {
      return res.status(304).end();
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching DTM options:', error);
    res.status(500).json({ error: 'Failed to fetch DTM options', details: error.message });
  }
});

// POST /api/dtm/clip - Clip DTM to AOI
app.post('/api/dtm/clip', async (req, res) => {
  try {
    console.log('Clipping DTM with params:', JSON.stringify(req.body));
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python clip error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error clipping DTM:', error);
    res.status(500).json({ error: 'Failed to clip DTM', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/metadata - Get clipped DTM metadata
app.get('/api/dtm/clipped/:clippedId/metadata', async (req, res) => {
  try {
    const { clippedId } = req.params;
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/metadata`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Metadata not found' });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching clipped metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/raster - Get clipped DTM raster data
app.get('/api/dtm/clipped/:clippedId/raster', async (req, res) => {
  try {
    const { clippedId } = req.params;
    console.log(`Fetching raster data for clipped DTM: ${clippedId}`);

    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/raster`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python raster error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching clipped raster:', error);
    res.status(500).json({ error: 'Failed to fetch raster', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/image.png - Get rendered PNG image
app.get('/api/dtm/clipped/:clippedId/image.png', async (req, res) => {
  try {
    const { clippedId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/image.png`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Image not found' });
    }

    res.setHeader('Content-Type', 'image/png');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching clipped image:', error);
    res.status(500).json({ error: 'Failed to fetch image', details: error.message });
  }
});

// GET /api/dtm/clipped/:clippedId/tiles/:z/:x/:y.png - Get map tiles
app.get('/api/dtm/clipped/:clippedId/tiles/:z/:x/:y.png', async (req, res) => {
  try {
    const { clippedId, z, x, y } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/tiles/${z}/${x}/${y}.png`);

    const cacheControl = response.headers.get('Cache-Control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Tile not found' });
    }

    res.setHeader('Content-Type', 'image/png');

    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error fetching tile:', error);
    res.status(500).json({ error: 'Failed to fetch tile', details: error.message });
  }
});

// DELETE /api/dtm/clipped/:clippedId - Delete clipped DTM
app.delete('/api/dtm/clipped/:clippedId', async (req, res) => {
  try {
    const { clippedId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error deleting clipped DTM:', error);
    res.status(500).json({ error: 'Failed to delete clipped DTM', details: error.message });
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

    const response = await fetch(`${PYTHON_BACKEND_URL}/dtm/${filename}/raster`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python raster error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    // Forward the content type and stream the body
    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json');

    // In Node 18+ fetch (and node-fetch v3), response.body is a ReadableStream
    // We use a helper to pipe it to the response
    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (error) {
    console.error('Error proxying raster data:', error);
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
    const { coordinates, dtmPath, safetyRadiusMeters, resolutionRadiusMeters, clippedId } = req.body;

    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Invalid coordinates array' });
    }

    if (!dtmPath) {
      return res.status(400).json({ error: 'DTM path is required' });
    }

    console.log(`Proxying elevation profile request for ${dtmPath} to Python backend...${clippedId ? ` (clippedId: ${clippedId})` : ''}`);

    const result = await proxyToPython('/elevation-profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        coordinates,
        dtmPath,
        safetyRadiusMeters: safetyRadiusMeters ?? 50,
        resolutionRadiusMeters: resolutionRadiusMeters ?? 50,
        ...(clippedId && { clippedId })
      })
    });

    // Validate that the result contains the expected profile data
    // Only set ready flag if the data is complete and valid
    const isDataComplete = result && 
                           result.profile && 
                           Array.isArray(result.profile) && 
                           result.profile.length > 0;

    if (!isDataComplete) {
      console.warn('Profile data incomplete or invalid:', {
        hasResult: !!result,
        hasProfile: !!(result && result.profile),
        isArray: !!(result && result.profile && Array.isArray(result.profile)),
        length: result && result.profile ? result.profile.length : 0
      });
      return res.status(500).json({
        error: 'Profile calculation did not return complete data',
        details: 'Server did not receive complete profile data from Python backend'
      });
    }

    // Add completion flag to signal that profile calculation is finished
    // Only set ready: true when we have confirmed complete data
    res.json({
      ...result,
      ready: true
    });
  } catch (error) {
    console.error('Error proxying elevation profile request:', error);
    res.status(500).json({
      error: 'Could not calculate elevation profile',
      details: error.message
    });
  }
});

// Get elevation at a specific point
app.post('/api/elevation-at-point', async (req, res) => {
  try {
    const { longitude, latitude, dtmPath, clippedId } = req.body;

    if (longitude === undefined || latitude === undefined) {
      return res.status(400).json({ error: 'Longitude and latitude are required' });
    }

    if (!dtmPath) {
      return res.status(400).json({ error: 'DTM path is required' });
    }

    const result = await proxyToPython('/elevation-at-point', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        longitude,
        latitude,
        dtmPath,
        ...(clippedId && { clippedId })
      })
    });

    // Add completion flag to signal that profile calculation is finished
    res.json({
      ...result,
      ready: true
    });
  } catch (error) {
    console.error('Error proxying elevation-at-point to Python:', error);
    res.status(500).json({
      error: 'Could not get elevation at point',
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

