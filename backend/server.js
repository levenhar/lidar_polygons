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
import { Agent } from 'undici';

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

// ============================================================================
// DTM LEASE PROTECTION HELPERS
// ============================================================================

/**
 * Check if a DTM is protected by active leases.
 * @param {string} dtmId - The DTM identifier
 * @returns {Promise<{isProtected: boolean, activeLeaseCount: number}>}
 */
const checkDtmProtection = async (dtmId) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/${dtmId}/protection`, {
      dispatcher: pythonDispatcher
    });
    if (response.ok) {
      const data = await response.json();
      return {
        isProtected: data.isProtected || false,
        activeLeaseCount: data.activeLeaseCount || 0
      };
    }
  } catch (error) {
    console.warn(`Failed to check DTM protection for ${dtmId}:`, error.message);
  }
  // If we can't check, assume not protected (fail open for cleanup)
  return { isProtected: false, activeLeaseCount: 0 };
};

/**
 * Get list of all protected DTM IDs from the lease manager.
 * @returns {Promise<Set<string>>}
 */
const getProtectedDtmIds = async () => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/leases/metrics`, {
      dispatcher: pythonDispatcher
    });
    if (response.ok) {
      const data = await response.json();
      // Get all DTMs with active leases
      const auditResponse = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/leases/audit?limit=1000&since_hours=24`, {
        dispatcher: pythonDispatcher
      });
      if (auditResponse.ok) {
        const auditData = await auditResponse.json();
        // Extract DTM IDs from lease_acquired entries that haven't been released/deleted
        const activeDtmIds = new Set();
        for (const entry of auditData.entries || []) {
          if (entry.action === 'lease_acquired' || entry.action === 'lease_renewed') {
            activeDtmIds.add(entry.dtmId);
          }
          if (entry.action === 'deleted') {
            activeDtmIds.delete(entry.dtmId);
          }
        }
        return activeDtmIds;
      }
    }
  } catch (error) {
    console.warn('Failed to get protected DTM IDs:', error.message);
  }
  return new Set();
};

// Clear cached uploads on restart to avoid serving stale files
// MODIFIED: Now respects DTM protection status and is DISABLED BY DEFAULT
// 
// CRITICAL: This should NOT clear DTM cache directories. The startup cleanup
// is only meant for temporary upload files, not for cached DTMs that clients
// may need after a server restart.
const clearUploadsDirectory = async () => {
  try {
    if (existsSync(uploadsDir)) {
      // SAFETY CHECK: If uploadsDir contains "Cache" or "DTM", this is likely
      // a DTM cache directory that should NOT be cleared on startup
      const uploadsPath = uploadsDir.toLowerCase();
      if (uploadsPath.includes('cache') || uploadsPath.includes('dtm')) {
        console.log(`[startup] WARNING: UPLOADS_DIR appears to be a DTM cache directory: ${uploadsDir}`);
        console.log(`[startup] Skipping startup cleanup to protect DTM files.`);
        console.log(`[startup] To force cleanup, set CLEAR_UPLOADS_ON_STARTUP=true and FORCE_CLEAR_DTM_CACHE=true`);
        
        // Only proceed if explicitly forced
        if (process.env.FORCE_CLEAR_DTM_CACHE !== 'true') {
          return;
        }
        console.log(`[startup] FORCE_CLEAR_DTM_CACHE is true - proceeding with cleanup`);
      }
      
      // Try to read the lease database directly to check for registered DTMs
      // This is more reliable than calling Python backend which may not be ready
      let registeredDtmIds = new Set();
      try {
        const dbPath = resolve(uploadsDir, '..', 'dtm_leases.db');
        if (existsSync(dbPath)) {
          // We can't easily read SQLite from Node.js without a dependency,
          // so we'll use a conservative approach: if the lease DB exists,
          // there may be protected DTMs - don't delete anything
          console.log(`[startup] Found lease database at ${dbPath}`);
          console.log(`[startup] Skipping cleanup to protect potentially leased DTMs`);
          console.log(`[startup] Set FORCE_CLEAR_DTM_CACHE=true to override`);
          return;
        }
      } catch (e) {
        // Ignore errors reading lease DB
      }
      
      // Also try to get protected DTM IDs from the Python backend
      let protectedIds = new Set();
      try {
        protectedIds = await getProtectedDtmIds();
        if (protectedIds.size > 0) {
          console.log(`[startup] Found ${protectedIds.size} protected DTM(s) from Python backend - will skip deletion`);
        }
      } catch (e) {
        console.log(`[startup] Could not fetch protected DTM list (Python backend may not be running yet)`);
        // FAIL CLOSED: If we can't verify protection, don't delete anything
        console.log(`[startup] Skipping cleanup to be safe. Set FORCE_CLEAR_DTM_CACHE=true to override`);
        return;
      }
      
      // Readdir and remove each file/directory instead of removing the directory itself
      // This preserves the directory inode which is important for Docker bind mounts
      const { readdir, rm, stat } = await import('fs/promises');
      const files = await readdir(uploadsDir);
      let deletedCount = 0;
      let skippedCount = 0;
      
      await Promise.all(
        files.map(async (file) => {
          const filePath = join(uploadsDir, file);
          const fileLower = file.toLowerCase();
          
          // Skip any file that looks like a DTM (has .tif extension)
          if (fileLower.endsWith('.tif') || fileLower.endsWith('.tiff') || fileLower.endsWith('.geotiff')) {
            console.log(`[startup] Skipping DTM file: ${file}`);
            skippedCount++;
            return;
          }
          
          // Check if this file is protected
          const isProtected = protectedIds.has(file) || 
            [...protectedIds].some(id => file.includes(id));
          
          if (isProtected) {
            console.log(`[startup] Skipping protected DTM: ${file}`);
            skippedCount++;
            return;
          }
          
          try {
            const stats = await stat(filePath);
            if (stats.isDirectory()) {
              // Don't delete subdirectories that might contain DTMs
              if (file.toLowerCase().includes('cache') || file.toLowerCase().includes('viewshed')) {
                console.log(`[startup] Skipping subdirectory: ${file}`);
                skippedCount++;
                return;
              }
              // Use rm with recursive for directories
              await rm(filePath, { recursive: true, force: true });
            } else {
              // Use unlink for files
              await unlink(filePath);
            }
            deletedCount++;
          } catch (e) {
            console.error(`[startup] Failed to delete ${file}:`, e);
          }
        })
      );
      
      console.log(`[startup] Uploads cache cleared: ${deletedCount} deleted, ${skippedCount} protected (skipped)`);
    } else {
      mkdirSync(uploadsDir, { recursive: true });
      console.log('[startup] Uploads directory created');
    }
  } catch (error) {
    console.error('[startup] Failed to clear uploads cache:', error);
  }
};

// IMPORTANT: Startup cleanup is now DISABLED BY DEFAULT to protect DTM files.
// This change was made because:
// 1. uploadsDir often points to DTM_CACHE_DIR (same directory)
// 2. Clearing on startup deletes DTMs that clients may still need
// 3. Clients need time to reconnect and re-acquire leases after server restart
//
// To enable startup cleanup, set CLEAR_UPLOADS_ON_STARTUP=true
// To also clear DTM files, set FORCE_CLEAR_DTM_CACHE=true (dangerous!)
const parseEnvBool = (value) => {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
};

const clearUploadsOverride = parseEnvBool(process.env.CLEAR_UPLOADS_ON_STARTUP);
// Default to FALSE (don't clear) to protect DTM files
const shouldClearUploadsOnStartup = clearUploadsOverride === true;

if (shouldClearUploadsOnStartup) {
  console.log('[startup] CLEAR_UPLOADS_ON_STARTUP is enabled');
  clearUploadsDirectory();
} else {
  console.log('[startup] Skipping uploads cache clear (set CLEAR_UPLOADS_ON_STARTUP=true to enable)');
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

// File size limits
const MAX_DTM_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_KML_SIZE = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_DTM_SIZE
  },
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
// Long-running Python tasks (e.g., viewshed) can exceed default Undici timeouts.
const pythonDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// Proxy helper
const proxyToPython = async (endpoint, options = {}) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}${endpoint}`, {
      ...options,
      dispatcher: pythonDispatcher
    });
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
    // Check Content-Length header for file size validation
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const fileSize = parseInt(contentLength, 10);
      if (fileSize > MAX_DTM_SIZE) {
        return res.status(400).json({
          error: `File size exceeds maximum allowed size of ${MAX_DTM_SIZE / (1024 * 1024 * 1024)}GB`,
          maxSize: MAX_DTM_SIZE,
          receivedSize: fileSize
        });
      }
    }

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
// IMPORTANT: All cleanup requests are now forwarded to Python backend for protection validation
app.post('/api/dtm/cleanup', async (req, res) => {
  try {
    const { path: dtmPath, filename, clippedId, force } = req.body || {};
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    console.log(`[${traceId}] Cleanup request - path: ${dtmPath}, filename: ${filename}, clippedId: ${clippedId}, force: ${force}`);

    // If clippedId is provided, delete the clipped DTM from Python backend
    if (clippedId) {
      try {
        console.log(`[${traceId}] Deleting clipped DTM via Python backend: ${clippedId}`);
        const response = await fetch(
          `${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}?force=${force || false}`, 
          {
            method: 'DELETE',
            headers: {
              'X-Trace-ID': traceId
            }
          }
        );
        const data = await response.json();
        console.log(`[${traceId}] Clipped DTM deletion result:`, data);
        return res.status(response.status).json(data);
      } catch (error) {
        console.error(`[${traceId}] Error deleting clipped DTM:`, error);
        return res.status(500).json({ success: false, error: 'Failed to delete clipped DTM' });
      }
    }

    // For all other cleanup requests, forward to Python backend for protection validation
    // This ensures DTM lease protection is enforced consistently
    try {
      console.log(`[${traceId}] Forwarding cleanup request to Python backend for protection validation`);
      const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/cleanup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-ID': traceId
        },
        body: JSON.stringify({ path: dtmPath, filename, force: force || false })
      });
      
      const data = await response.json();
      console.log(`[${traceId}] Python cleanup result:`, data);
      return res.status(response.status).json(data);
    } catch (error) {
      console.error(`[${traceId}] Error forwarding cleanup to Python:`, error);
      // If Python backend is unavailable, fail safely - don't delete anything
      return res.status(503).json({ 
        success: false, 
        error: 'Python backend unavailable - cannot validate DTM protection', 
        details: error.message 
      });
    }
  } catch (error) {
    console.error('Error in cleanup endpoint:', error);
    res.status(500).json({ success: false, error: 'Failed to process cleanup request', details: error.message });
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

// POST /api/dtm/available - Get TIF files overlapping with AOI
app.post('/api/dtm/available', async (req, res) => {
  try {
    console.log('Getting available TIFs with params:', JSON.stringify(req.body));
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/available`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Python available TIFs error:', errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching available TIFs:', error);
    res.status(500).json({ error: 'Failed to fetch available TIFs', details: error.message });
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

// GET /api/dtm/clipped/:clippedId/ready - Check if clipped DTM is ready
app.get('/api/dtm/clipped/:clippedId/ready', async (req, res) => {
  try {
    const { clippedId } = req.params;
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    console.log(`[${traceId}] Checking readiness for clipped DTM: ${clippedId}`);
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}/ready`, {
      dispatcher: pythonDispatcher,
      headers: {
        'X-Trace-ID': traceId
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${traceId}] Python ready check error: ${errorText}`);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    console.log(`[${traceId}] Clipped DTM ${clippedId} ready status:`, data);
    res.json(data);
  } catch (error) {
    console.error('Error checking clipped DTM readiness:', error);
    res.status(500).json({ error: 'Failed to check readiness', details: error.message });
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
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    const force = req.query.force === 'true';
    
    console.log(`[${traceId}] Delete request for clipped DTM: ${clippedId}, force=${force}`);
    
    const response = await fetch(
      `${PYTHON_BACKEND_URL}/api/dtm/clipped/${clippedId}?force=${force}`, 
      {
        method: 'DELETE',
        headers: {
          'X-Trace-ID': traceId
        }
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error deleting clipped DTM:', error);
    res.status(500).json({ error: 'Failed to delete clipped DTM', details: error.message });
  }
});

// ============================================================================
// DTM LEASE API ENDPOINTS (proxy to Python backend)
// ============================================================================

// POST /api/dtm/lease/acquire - Acquire a lease for a DTM
app.post('/api/dtm/lease/acquire', async (req, res) => {
  try {
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    console.log(`[${traceId}] Lease acquire request:`, req.body);
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/lease/acquire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-ID': traceId
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error acquiring lease:', error);
    res.status(500).json({ error: 'Failed to acquire lease', details: error.message });
  }
});

// POST /api/dtm/lease/renew - Renew an existing lease
app.post('/api/dtm/lease/renew', async (req, res) => {
  try {
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/lease/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-ID': traceId
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error renewing lease:', error);
    res.status(500).json({ error: 'Failed to renew lease', details: error.message });
  }
});

// POST /api/dtm/lease/release - Release a lease
app.post('/api/dtm/lease/release', async (req, res) => {
  try {
    const traceId = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/lease/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-ID': traceId
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error releasing lease:', error);
    res.status(500).json({ error: 'Failed to release lease', details: error.message });
  }
});

// GET /api/dtm/lease/:leaseId - Get lease details
app.get('/api/dtm/lease/:leaseId', async (req, res) => {
  try {
    const { leaseId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/lease/${leaseId}`);

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error getting lease:', error);
    res.status(500).json({ error: 'Failed to get lease', details: error.message });
  }
});

// GET /api/dtm/:dtmId/leases - Get all active leases for a DTM
app.get('/api/dtm/:dtmId/leases', async (req, res) => {
  try {
    const { dtmId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/${dtmId}/leases`);

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error getting DTM leases:', error);
    res.status(500).json({ error: 'Failed to get DTM leases', details: error.message });
  }
});

// GET /api/dtm/:dtmId/protection - Check if DTM is protected
app.get('/api/dtm/:dtmId/protection', async (req, res) => {
  try {
    const { dtmId } = req.params;
    
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/${dtmId}/protection`);

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error checking DTM protection:', error);
    res.status(500).json({ error: 'Failed to check DTM protection', details: error.message });
  }
});

// GET /api/dtm/leases/metrics - Get lease system metrics
app.get('/api/dtm/leases/metrics', async (req, res) => {
  try {
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/dtm/leases/metrics`);

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error getting lease metrics:', error);
    res.status(500).json({ error: 'Failed to get lease metrics', details: error.message });
  }
});

// GET /api/dtm/leases/audit - Get audit log
app.get('/api/dtm/leases/audit', async (req, res) => {
  try {
    const queryParams = new URLSearchParams();
    if (req.query.dtm_id) queryParams.set('dtm_id', req.query.dtm_id);
    if (req.query.limit) queryParams.set('limit', req.query.limit);
    if (req.query.since_hours) queryParams.set('since_hours', req.query.since_hours);
    
    const response = await fetch(
      `${PYTHON_BACKEND_URL}/api/dtm/leases/audit?${queryParams.toString()}`
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error getting audit log:', error);
    res.status(500).json({ error: 'Failed to get audit log', details: error.message });
  }
});

// POST /api/dtm/clipped/:clippedId/upload - Upload clipped DTM directly from Python backend cache
// NOTE: This endpoint used to re-upload the clipped GeoTIFF into the upload pipeline, which created
// extra copies (uploads + cache + subsample). We now keep only two artifacts per clip:
// 1) full-resolution clipped raster in Python `DTM_CACHE_DIR`
// 2) subsampled raster in Python `DTM_SUBSAMPLED_CACHE_DIR` (display only)
// The clipped DTM remains accessible via `/api/dtm/clipped/:clippedId/*` proxy routes, so this
// upload step is no longer required. Kept as a backward-compatible no-op.
app.post('/api/dtm/clipped/:clippedId/upload', async (req, res) => {
  try {
    const { clippedId } = req.params;
    console.log(`Skipping clipped DTM upload for ${clippedId} (no-op; clip already produces full-res + subsample).`);
    res.json({
      success: true,
      skipped: true,
      clippedId,
      message: 'Clipped DTM upload step is deprecated; using Python cache artifacts (full-res + subsampled) only.'
    });
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
    // Forward Python backend error detail when present (e.g. "Python backend error: 500 - {\"detail\":\"...\"}")
    let details = error.message;
    const match = error.message && error.message.match(/Python backend error: \d+ [^-]* - (.+)/s);
    if (match && match[1]) {
      try {
        const body = JSON.parse(match[1].trim());
        if (body.detail) details = body.detail;
      } catch (_) { /* use full message */ }
    }
    const status = error.message && error.message.includes('Python backend error: 400') ? 400 : 500;
    res.status(status).json({
      error: 'Could not calculate elevation profile',
      details
    });
  }
});

// Viewshed job endpoints (proxy to Python backend)
app.post('/api/viewshed/start', async (req, res) => {
  try {
    console.log('Proxying viewshed start to Python backend...');
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/viewshed/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      dispatcher: pythonDispatcher
    });
    if (response.status === 404) {
      console.warn('Python /api/viewshed/start not found; falling back to legacy /api/viewshed');
      const legacyResponse = await fetch(`${PYTHON_BACKEND_URL}/api/viewshed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        dispatcher: pythonDispatcher
      });
      if (!legacyResponse.ok) {
        const errorText = await legacyResponse.text();
        return res.status(legacyResponse.status).send(errorText);
      }
      const contentType = legacyResponse.headers.get('content-type') || 'image/tiff';
      res.setHeader('Content-Type', contentType);
      const arrayBuffer = await legacyResponse.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Error proxying viewshed start to Python:', error);
    res.status(500).json({ error: 'Could not start viewshed' });
  }
});

app.get('/api/viewshed/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/viewshed/status/${jobId}`, {
      dispatcher: pythonDispatcher
    });
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Error proxying viewshed status to Python:', error);
    res.status(500).json({ error: 'Could not fetch viewshed status' });
  }
});

app.post('/api/viewshed/cancel/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/viewshed/cancel/${jobId}`, {
      method: 'POST',
      dispatcher: pythonDispatcher
    });
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Error proxying viewshed cancel to Python:', error);
    res.status(500).json({ error: 'Could not cancel viewshed' });
  }
});

app.get('/api/viewshed/result/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const response = await fetch(`${PYTHON_BACKEND_URL}/api/viewshed/result/${jobId}`, {
      dispatcher: pythonDispatcher
    });
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).send(errorText);
    }
    const contentType = response.headers.get('content-type') || 'image/tiff';
    res.setHeader('Content-Type', contentType);
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Error proxying viewshed result to Python:', error);
    res.status(500).json({ error: 'Could not fetch viewshed result' });
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
    console.error('Error proxying elevation-at-point to Python:', error);
    res.status(500).json({
      error: 'Could not get elevation at point',
      details: error.message
    });
  }
});

// 1) Path to Vite build - use resolve to get absolute path
const distPath = resolve(__dirname, '../frontend/dist');
const indexHtmlPath = resolve(distPath, 'index.html');

console.log("distPath:", distPath);
console.log("index.html path:", indexHtmlPath);

// Check if dist directory exists
if (!existsSync(distPath)) {
  console.error(`ERROR: Frontend dist directory not found at: ${distPath}`);
  console.error('Please build the frontend first by running: cd frontend && npm run build');
}

// Check if index.html exists
if (!existsSync(indexHtmlPath)) {
  console.error(`ERROR: index.html not found at: ${indexHtmlPath}`);
  console.error('Please build the frontend first by running: cd frontend && npm run build');
}

// 2) Serve static file (JS, CSS, image, etc.)
if (existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  console.warn('WARNING: Cannot serve static files - dist directory does not exist');
}

// 3) SPA fallback: for any unknown route, send index.html
app.get('*', (req, res) => {
  if (!existsSync(indexHtmlPath)) {
    return res.status(503).json({
      error: 'Frontend not built',
      message: 'Please build the frontend first by running: cd frontend && npm run build',
      path: indexHtmlPath
    });
  }
  res.sendFile(indexHtmlPath);
});


// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

