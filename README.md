# LiDAR Mission Planner

A production-ready web application for planning LiDAR scanning missions with synchronized overhead map view and real-time elevation profile visualization.

## Features

🔶 **Left Panel - Overhead Map View**
- Display DTM (Digital Terrain Model) raster as base layer
- Load DTM from GeoTIFF file or server endpoint
- Interactive flight path polyline with drawing/editing capabilities
- Drag markers to modify flight path points
- Right-click markers to delete points
- Hover over points to highlight in elevation profile
- Import/export flight paths as GeoJSON

🔶 **Right Panel - Elevation Profile**
- Dynamic elevation cross-section based on DTM
- Real-time updates when flight path changes
- Visualizes:
  - Ground elevation (brown line)
  - Flight altitude AGL (blue dashed line)
  - Nominal flight height (configurable)
- Export elevation profile as PNG or CSV
- Statistics panel showing min/max elevation and distance

## Technology Stack

### Frontend
- **React 18** with TypeScript
- **MapLibre GL JS** for map visualization
- **D3.js** for elevation profile charts
- **Vite** for fast development and building

### Backend
- **Node.js** with Express
- **Multer** for file uploads
- **GeoTIFF.js** for DTM processing (ready for implementation)

## Project Structure

```
polygon_plane/
├── frontend/                 # React frontend application
│   ├── src/
│   │   ├── components/       # React components
│   │   │   ├── MapPanel.tsx  # Map view with flight path
│   │   │   └── ElevationProfile.tsx  # Elevation chart
│   │   ├── hooks/            # Custom React hooks
│   │   │   ├── useFlightPath.ts
│   │   │   └── useElevationProfile.ts
│   │   ├── App.tsx           # Main application component
│   │   └── main.tsx          # Entry point
│   ├── package.json
│   └── vite.config.ts
├── backend/                  # Express backend server
│   ├── server.js             # Main server file
│   ├── uploads/              # Uploaded DTM files (created at runtime)
│   └── package.json
├── examples/                 # Example datasets
│   └── flight-path-example.geojson
└── README.md
```

## Installation

### Prerequisites
- Node.js 18+ and npm
- A modern web browser (Chrome, Firefox, Edge, Safari)

### Setup Steps

1. **Install all dependencies:**
   ```bash
   npm run install:all
   ```
   
   Or install separately:
   ```bash
   # Install root dependencies
   npm install
   
   # Install frontend dependencies
   cd frontend
   npm install
   
   # Install backend dependencies
   cd ../backend
   npm install
   ```

2. **Start the development servers:**
   
   From the root directory:
   ```bash
   npm run dev
   ```
   
   This starts both frontend (port 3000) and backend (port 5000) concurrently.
   
   Or start them separately:
   ```bash
   # Terminal 1 - Backend
   cd backend
   npm run dev
   
   # Terminal 2 - Frontend
   cd frontend
   npm run dev
   ```

3. **Open the application:**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:5000

## Usage Guide

### Loading a DTM (Digital Terrain Model)

1. Click the **"Load DTM"** button in the map panel
2. Select a GeoTIFF file (.tif, .tiff, .geotiff)
3. The DTM will be uploaded to the server and displayed on the map

**Note:** Currently, the backend accepts DTM files but uses mock elevation data. For production use, implement GeoTIFF parsing in `backend/server.js` to extract actual elevation values.

### Drawing a Flight Path

1. Click the **"Draw Path"** button in the map panel
2. Click on the map to add points to your flight path
3. The path will appear as a red line connecting the points
4. Click **"Stop Drawing"** when finished

### Editing the Flight Path

- **Move a point:** Drag any numbered marker on the map
- **Delete a point:** Right-click on a marker
- **Hover over a point:** Move your mouse over a marker to see it highlighted in the elevation profile

### Configuring Flight Parameters

- Adjust the **Nominal Flight Height** in the header to set the AGL (Above Ground Level) altitude
- The elevation profile will update automatically

### Importing/Exporting

- **Export GeoJSON:** Click "Export GeoJSON" in the header to download the current flight path
- **Import GeoJSON:** Click "Import GeoJSON" and select a GeoJSON file with a LineString feature
- **Export Elevation Profile:**
  - **PNG:** Click "Export PNG" in the elevation panel to save the chart as an image
  - **CSV:** Click "Export CSV" to download elevation data as a spreadsheet

### Example Dataset

An example flight path is provided in `examples/flight-path-example.geojson`. You can import this to see a sample flight path over San Francisco.

## API Endpoints

### Backend API

- `GET /api/health` - Health check
- `POST /api/upload-dtm` - Upload a GeoTIFF file
  - Body: `multipart/form-data` with `dtm` field
  - Returns: `{ success: true, filename: string, path: string }`
- `GET /api/dtm/:filename/metadata` - Get DTM metadata
- `POST /api/elevation-profile` - Calculate elevation profile
  - Body: `{ coordinates: number[][], dtmPath: string }`
  - Returns: `{ profile: ElevationPoint[] }`

## Development

### Building for Production

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`.

### Code Structure

The application follows a modular architecture:

- **Components:** Reusable UI components (`MapPanel`, `ElevationProfile`)
- **Hooks:** Custom React hooks for state management (`useFlightPath`, `useElevationProfile`)
- **Backend:** RESTful API for file handling and data processing

### Extending the Application

#### Adding Real GeoTIFF Processing

To process actual GeoTIFF files, enhance `backend/server.js`:

```javascript
import { fromFile } from 'geotiff';

// In the elevation-profile endpoint:
const tiff = await fromFile(filePath);
const image = await tiff.getImage();
const rasters = await image.readRasters();
// Sample elevation at coordinates
```

#### Adding DTM Raster Layer to Map

To display the DTM as a raster layer on the map:

1. Create tile endpoints in the backend
2. Add a raster source to MapLibre
3. Configure the layer styling

## Troubleshooting

### Port Already in Use
If port 3000 or 5000 is already in use:
- Frontend: Edit `frontend/vite.config.ts` and change the port
- Backend: Edit `backend/server.js` and change `PORT`

### CORS Errors
The backend includes CORS middleware. If you encounter CORS issues, check that the frontend proxy is configured correctly in `vite.config.ts`.

### DTM Not Displaying
Currently, DTM files are uploaded but not rendered as map layers. This requires additional GeoTIFF tile generation. The elevation profile uses mock data until real GeoTIFF processing is implemented.

## Future Enhancements

- [ ] Real GeoTIFF parsing and elevation extraction
- [ ] DTM raster tile generation and display
- [ ] Multiple flight path support
- [ ] Waypoint altitude constraints
- [ ] 3D visualization
- [ ] Mission planning templates
- [ ] Cloud storage integration
- [ ] Real-time weather overlay

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.


