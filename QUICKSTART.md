# Quick Start Guide

Get the LiDAR Mission Planner up and running in 5 minutes!

## Step 1: Install Dependencies

```bash
npm run install:all
```

This installs dependencies for the root project, frontend, and backend.

## Step 2: Start the Application

```bash
npm run dev
```

This starts both the backend server (port 5000) and frontend development server (port 3000).

## Step 3: Open in Browser

Navigate to: **http://localhost:3000**

## Step 4: Try It Out

1. **Draw a flight path:**
   - Click "Draw Path" button
   - Click on the map to add points
   - Click "Stop Drawing" when done

2. **See the elevation profile:**
   - The right panel automatically shows the elevation profile
   - Adjust "Nominal Flight Height" to see how it affects the flight altitude

3. **Import example data:**
   - Click "Import GeoJSON"
   - Select `examples/flight-path-example.geojson`

4. **Export your work:**
   - Click "Export GeoJSON" to save your flight path
   - Click "Export PNG" or "Export CSV" in the elevation panel

## Troubleshooting

**Port already in use?**
- Kill the process using port 3000 or 5000, or change ports in the config files

**Dependencies won't install?**
- Make sure you have Node.js 18+ installed
- Try deleting `node_modules` folders and running `npm install` again

**Backend not connecting?**
- Make sure the backend is running on port 5000
- Check the browser console for CORS errors

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Check out [examples/README.md](examples/README.md) for sample datasets
- Customize the application for your specific needs

Happy mission planning! 🚁


