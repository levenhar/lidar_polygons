# Example Datasets

This directory contains example datasets for testing the LiDAR Mission Planner application.

## Flight Path Example

**File:** `flight-path-example.geojson`

A sample GeoJSON file containing a LineString feature representing a flight path over San Francisco. This can be imported into the application to see an example flight path.

### Usage

1. Open the LiDAR Mission Planner application
2. Click "Import GeoJSON" in the header
3. Select `flight-path-example.geojson`
4. The flight path will be loaded and displayed on the map

### Format

The GeoJSON follows the standard GeoJSON specification:
- Type: FeatureCollection
- Feature geometry: LineString
- Coordinates: [longitude, latitude] pairs

## DTM (Digital Terrain Model) Files

For testing with actual DTM data, you can use any GeoTIFF file (.tif, .tiff, .geotiff). 

### Where to Get DTM Data

- **USGS EarthExplorer:** https://earthexplorer.usgs.gov/
- **OpenTopography:** https://opentopography.org/
- **NASA SRTM:** https://www2.jpl.nasa.gov/srtm/

### Recommended Test Areas

- San Francisco Bay Area (coordinates in example match this region)
- Any area with varied terrain for interesting elevation profiles

### Note

Currently, the application accepts DTM uploads but uses mock elevation data. To use real elevation data, implement GeoTIFF parsing in the backend (see main README for details).


