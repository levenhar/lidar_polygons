import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import rasterio
import rasterio.features
import rasterio.warp
import numpy as np
from typing import Optional, List
import json

app = FastAPI()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Uploads directory - needs to be mounted or same path
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", "../backend/uploads")

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "backend_python"}

@app.get("/dtm/{filename}/metadata")
async def get_dtm_metadata(filename: str):
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        with rasterio.open(file_path) as src:
            bounds = src.bounds
            return {
                "filename": filename,
                "bounds": {
                    "minX": bounds.left,
                    "minY": bounds.bottom,
                    "maxX": bounds.right,
                    "maxY": bounds.top
                },
                "resolution": {
                    "width": src.width,
                    "height": src.height
                },
                "noDataValue": src.nodata,
                "crs": src.crs.to_string() if src.crs else None
            }
    except Exception as e:
        print(f"Error reading metadata: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/dtm/{filename}/raster")
async def get_dtm_raster(filename: str):
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        with rasterio.open(file_path) as src:
            # Read first band
            data = src.read(1)
            
            # Get stats
            nodata = src.nodata
            
            valid_mask = data != nodata if nodata is not None else np.ones_like(data, dtype=bool)
            # Handle NaN if present in float data
            if np.issubdtype(data.dtype, np.floating):
                valid_mask &= ~np.isnan(data)
                
            if valid_mask.any():
                min_val = float(np.min(data[valid_mask]))
                max_val = float(np.max(data[valid_mask]))
            else:
                min_val = 0.0
                max_val = 0.0
            
            bounds = src.bounds
            
            # Check projection
            is_projected = False
            if src.crs:
                is_projected = src.crs.is_projected
            else:
                # Heuristic fallback
                is_projected = abs(bounds.left) > 180 or abs(bounds.bottom) > 90
            
            # Convert to list for JSON response
            # Flatten array
            flat_data = data.flatten()
            
            # Handle serialization of special values (NaN, Infinity)
            # Replace NaNs/Infinity with null or custom handling if needed, 
            # but standard JSON doesn't support NaN.
            # Node.js backend seemed to simple pass it, but JSON.stringify usually turns NaN to null.
            # Rasterio reads into numpy array.
            
            return {
                "width": src.width,
                "height": src.height,
                "originalWidth": src.width,
                "originalHeight": src.height,
                "min": min_val,
                "max": max_val,
                "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
                "noDataValue": nodata,
                "isProjected": is_projected,
                "data": flat_data.tolist(),
                "crs": src.crs.to_string() if src.crs else None
            }
            
    except Exception as e:
        print(f"Error reading raster: {e}")
        raise HTTPException(status_code=500, detail=str(e))
