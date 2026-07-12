import rasterio
import numpy as np
from shapely.geometry import Point, box
import warnings
import pandas as pd
from math import atan2, degrees
import matplotlib.pyplot as plt
from skimage.draw import line
from rasterio.windows import from_bounds
from rasterio.windows import transform as window_transform
from rasterio.features import geometry_mask
import time
from rasterio.transform import rowcol
from pyproj import Transformer
import logging

logger = logging.getLogger(__name__)


def max_value_in_buffer(dsm, transform, points_df, radius, nodata=np.nan):
    """
    Efficiently compute max value in circular buffer around points using a window.

    Parameters
    ----------
    dsm : np.ndarray
        2D DSM array
    transform : affine.Affine
        Raster transform of the DSM
    points_df : pd.DataFrame
        Columns ["X", "Y"]
    radius : float
        Buffer radius in map units (same as raster CRS)
    nodata : float
        DSM nodata value

    Returns
    -------
    np.ndarray
        Max values for each point
    """
    results = np.zeros(len(points_df), dtype=float)
    nrows, ncols = dsm.shape

    # Convert point coordinates to raster row/col
    rows, cols = rowcol(transform, points_df["X"].to_numpy(), points_df["Y"].to_numpy())

    # Pixel size (assumes square pixels)
    px_size_x = transform.a
    px_size_y = abs(transform.e)

    # Precompute squared radius in pixel units
    radius_px_x = int(np.ceil(radius / px_size_x))
    radius_px_y = int(np.ceil(radius / px_size_y))

    for i, (r, c) in enumerate(zip(rows, cols)):
        # Check if point is outside raster bounds
        if r < 0 or r >= nrows or c < 0 or c >= ncols:
            results[i] = np.nan
            continue
            
        # define window boundaries
        row_min = max(r - radius_px_y, 0)
        row_max = min(r + radius_px_y + 1, nrows)
        col_min = max(c - radius_px_x, 0)
        col_max = min(c + radius_px_x + 1, ncols)

        # Check if window is valid
        if row_min >= row_max or col_min >= col_max:
            results[i] = np.nan
            continue

        window = dsm[row_min:row_max, col_min:col_max]

        # compute pixel coordinates in map units
        ys, xs = np.meshgrid(
            np.arange(row_min, row_max),
            np.arange(col_min, col_max),
            indexing='ij'
        )
        xs_map = transform.c + xs * transform.a + ys * transform.b
        ys_map = transform.f + xs * transform.d + ys * transform.e

        # mask pixels outside radius
        dist2 = (xs_map - points_df["X"].iloc[i]) ** 2 + (ys_map - points_df["Y"].iloc[i]) ** 2
        mask = dist2 <= (radius+(np.sqrt(px_size_x**2+px_size_y**2)/2)) ** 2

        # Handle nodata safely - could be None, np.nan, or a numeric value
        if nodata is None:
            fill_value = np.nan
        elif isinstance(nodata, (int, float, np.number)) and np.isnan(nodata):
            fill_value = np.nan
        else:
            fill_value = nodata
        masked_window = np.where(mask, window, fill_value)

        # Handle case where masked_window might be empty
        if np.all(np.isnan(masked_window)):
            results[i] = np.nan
        else:
            results[i] = np.nanmax(masked_window)

    return results


def create_points_dataframe(vertices, dsm, transform, line_res):
    """
    Create a DataFrame of points along lines with values from a DSM array.

    Parameters
    ----------
    vertices : list of (x,y) tuples
        Vertices of lines
    dsm : np.ndarray
        2D DSM array
    transform : affine.Affine
        Raster transform of the DSM
    line_res : float
        Distance between points along the line in map units

    Returns
    -------
    pd.DataFrame
        Columns: X, Y, elevation, azimuth, line_num, minElevation, maxElevation, parallel_points
    """
    all_x, all_y, all_z, all_az, all_line_num = [], [], [], [], []

    n_rows, n_cols = dsm.shape

    for i in range(len(vertices) - 1):
        x1, y1 = vertices[i]
        x2, y2 = vertices[i + 1]

        dx = x2 - x1
        dy = y2 - y1
        line_length = np.hypot(dx, dy)
        
        # Handle identical or very close points
        if line_length < 1e-10:  # Essentially zero length
            # For identical points, create a single point with default azimuth
            xs = np.array([x1])
            ys = np.array([y1])
            azimuth = 0.0  # Default azimuth for identical points
            distances = np.array([0.0])
        else:
            azimuth = (degrees(atan2(dx, dy)) + 360) % 360

            distances = np.arange(0, line_length, line_res)
            if len(distances) > 0 and line_length-distances[-1]>1e-6:
                distances = np.append(distances, line_length)
            elif len(distances) == 0:
                distances = np.array([0, line_length])
            t = distances/line_length

            xs = x1 + t * dx
            ys = y1 + t * dy

        # Convert coordinates to raster row/col in bulk
        rows, cols = rasterio.transform.rowcol(transform, xs, ys)

        # Clip indices to array bounds
        rows = np.clip(rows, 0, n_rows - 1)
        cols = np.clip(cols, 0, n_cols - 1)

        zs = dsm[rows, cols]

        all_x.extend(xs)
        all_y.extend(ys)
        all_z.extend(zs)
        all_az.extend([azimuth] * len(distances))
        all_line_num.extend([i] * len(distances))


    df = pd.DataFrame({
        "X": all_x,
        "Y": all_y,
        "elevation": all_z,
        "minElevation": None,
        "maxElevation": None,
        "azimuth": all_az,
        "line_num": all_line_num,
        "parallel_points": pd.Series([None] * len(all_x), dtype="object")
    })

    return df


def draw_path_and_points(df, vertices, idx):
    plt.figure(figsize=(8,8))

    # draw original polyline vertices
    plt.scatter(vertices[:,0], vertices[:,1],
                color="red", label="Original Vertices", zorder=2)
    for p in vertices:
        indices = df.index[(df["X"] == p[0]) & (df["Y"] == p[1])].tolist()
        if indices:
            plt.text(p[0], p[1], str(indices[0]))
    # draw sampled points
    plt.scatter(df["X"], df["Y"],
                s=10, color="blue", label="Generated Points")
    # highlight selected point
    plt.scatter(df.loc[idx, "X"], df.loc[idx, "Y"],
                color="yellow", s=80, label="Selected Point")
    # highlight parallel points
    for p_idx in df.loc[idx, "parallel_points"]:
        if p_idx is not None:
            plt.scatter(df.loc[p_idx, "X"], df.loc[p_idx, "Y"],
                        color="green", s=60)
    plt.xlabel("X")
    plt.ylabel("Y")
    plt.legend()
    plt.axis("equal")
    plt.title("Polyline and Generated Points")
    plt.savefig("/app/data/Cache/output"+str(idx)+".png")

def find_parallel_points(df, parallel_threshold, distance_threshold):
    """
    Vectorized version to find closest parallel points to the left and right.

    Parameters
    ----------
    df : pandas.DataFrame
        Must contain columns ["X", "Y", "azimuth", "line_num"]
    parallel_threshold : float
        Maximum angular difference (degrees) to consider lines parallel/perpendicular
    distance_threshold : float
        Maximum distance (map units) to consider points related

    Returns
    -------
    df : pandas.DataFrame
        Adds column "parallel_points" with list of closest right/left indices
    """

    xy = df[["X", "Y"]].to_numpy()  # (N,2)
    az = df["azimuth"].to_numpy()  # (N,)
    lines = df["line_num"].to_numpy()  # (N,)
    N = len(df)

    # If we have only one line segment (all points have same line_num), 
    # no parallel points can be found
    if len(np.unique(lines)) <= 1:
        df = df.copy()
        df["parallel_points"] = [[] for _ in range(N)]
        return df

    # pairwise vectors and distances
    vecs = xy[:, np.newaxis, :] - xy[np.newaxis, :, :]  # (N,N,2)
    distances = np.linalg.norm(vecs, axis=2)  # (N,N)

    distance_mask = distances <= distance_threshold

    # remove zero distance and same line
    nonzero_mask = distances > 0
    line_mask = lines[:, np.newaxis] != lines[np.newaxis, :]

    # parallel check
    az_i = az[:, np.newaxis]
    az_j = az[np.newaxis, :]
    az_diff = np.abs(az_i - az_j) % 180
    az_diff = np.minimum(az_diff, 180 - az_diff)
    parallel_mask = az_diff <= parallel_threshold

    # perpendicular condition
    vec_angles = (np.degrees(np.arctan2(vecs[..., 0], vecs[..., 1])) + 360) % 360
    diff = np.abs(vec_angles - az_i) % 360
    diff = np.minimum(diff, 360 - diff)
    perp_mask = np.abs(diff - 90) <= parallel_threshold

    # combined valid mask
    valid_mask = nonzero_mask & line_mask & parallel_mask & perp_mask & distance_mask

    # normal vectors for each point
    az_rad = np.radians(az)
    n_vecs = np.stack([-np.sin(az_rad), np.cos(az_rad)], axis=1)  # (N,2)

    # project vectors onto normal
    proj = np.einsum("ik,ijk->ij", n_vecs, vecs)  # (N,N)

    left_mask = (proj < 0) & valid_mask
    right_mask = (proj > 0) & valid_mask

    # distances masked with inf where invalid
    masked_left = np.where(left_mask, distances, np.inf)
    masked_right = np.where(right_mask, distances, np.inf)

    # closest indices
    closest_left_idx = np.argmin(masked_left, axis=1)
    closest_right_idx = np.argmin(masked_right, axis=1)

    closest_left_dist = masked_left[np.arange(N), closest_left_idx]
    closest_right_dist = masked_right[np.arange(N), closest_right_idx]

    # set -1 where no valid neighbor
    closest_left_idx[closest_left_dist == np.inf] = -1
    closest_right_idx[closest_right_dist == np.inf] = -1

    # combine into parallel_points column
    parallel_points = []
    for left, right in zip(closest_left_idx, closest_right_idx):
        lst = []
        if right != -1:
            lst.append(right)
        if left != -1:
            lst.append(left)
        parallel_points.append(lst)

    df = df.copy()
    df["parallel_points"] = parallel_points

    return df


def min_height_between_points(p1, p2, transform, dsm):
    """
    Get the minimum DSM value along a line between two points.
    p1, p2 : (x, y) coordinates
    """
    # Convert coordinates to row/col
    r0, c0 = rowcol(transform, p1[0], p1[1])
    r1, c1 = rowcol(transform, p2[0], p2[1])

    # Clip to array bounds
    r0 = np.clip(r0, 0, dsm.shape[0] - 1)
    r1 = np.clip(r1, 0, dsm.shape[0] - 1)
    c0 = np.clip(c0, 0, dsm.shape[1] - 1)
    c1 = np.clip(c1, 0, dsm.shape[1] - 1)

    rr, cc = line(r0, c0, r1, c1)
    rr = np.clip(rr, 0, dsm.shape[0] - 1)
    cc = np.clip(cc, 0, dsm.shape[1] - 1)

    return dsm[rr, cc].min()


def min_value_in_buffer(df, dsm, transform):
    """
    Compute minimum height along lines connecting parallel points for all points in df.
    """
    n = len(df)
    results = df["elevation"].to_numpy(dtype=float)

    # Precompute all coordinates
    coords = df[["X", "Y"]].to_numpy()

    for i in range(n):
        parallel = df.at[i, "parallel_points"]
        if not parallel:
            continue  # results[i] stays nan
        p1 = coords[i]
        min_height = np.inf
        for j in parallel:
            p2 = coords[j]
            min_height = min(min_height, min_height_between_points(p1, p2, transform, dsm))
        results[i] = min_height

    return results


def latlon_array_to_utm(lats, lons):
    lats = np.asarray(lats)
    lons = np.asarray(lons)

    # 1. Detect zone from (any) longitude — here we use the mean
    mean_lon = np.mean(lons)
    zone = int((mean_lon + 180) // 6) + 1

    # 2. Determine hemisphere
    if np.mean(lats) >= 0:
        epsg = 32600 + zone  # Northern hemisphere
    else:
        epsg = 32700 + zone  # Southern hemisphere

    # 3. Create transformer once
    transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)

    # 4. Transform entire arrays at once
    eastings, northings = transformer.transform(lons, lats)

    return np.column_stack((eastings, northings)), epsg

def utm_to_latlon(eastings, northings, epsg):
    eastings = np.asarray(eastings)
    northings = np.asarray(northings)

    transformer = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

    lons, lats = transformer.transform(eastings, northings)

    return lats, lons

def add_cumulative_distance(df):
    coords = df[["X", "Y"]].to_numpy()

    # differences between consecutive points
    diffs = coords[1:] - coords[:-1]

    # Euclidean distance in 3D
    seg_lengths = np.linalg.norm(diffs, axis=1)

    # cumulative sum (start from 0)
    cumulative = np.concatenate([[0], np.cumsum(seg_lengths)])

    df = df.copy()
    df["distance"] = cumulative

    return df

def run(dsm, transform, points, line_res, radius, parallel_threshold, nodata, distance_threshold, skip_coordinate_transform=False):
    """
    Calculate elevation profile along a path.

    Parameters
    ----------
    dsm : np.ndarray
        2D DSM array
    transform : affine.Affine
        Raster transform of the DSM
    points : np.ndarray
        Array of [lon, lat] coordinates (WGS84) or [x, y] in DTM's CRS if skip_coordinate_transform=True
    line_res : float
        Distance between points along the line in map units
    radius : float
        Buffer radius for min/max elevation calculation
    parallel_threshold : float
        Maximum angular difference (degrees) to consider lines parallel/perpendicular
    nodata : float
        DSM nodata value
    distance_threshold : float
        Maximum distance (map units) to consider points related
    skip_coordinate_transform : bool
        If True, assume points are already in DTM's CRS and skip WGS84->UTM transformation.
        If False (default), transform WGS84 coordinates to UTM based on their location.

    Returns
    -------
    pd.DataFrame
        Columns: X, Y, elevation, longitude, latitude, distance, minElevation, maxElevation, etc.
    """
    # Validate input
    if points is None or len(points) < 2:
        raise ValueError("At least two points required for elevation profile calculation")

    if skip_coordinate_transform:
        # Points are already in DTM's CRS, no transformation needed
        # epsg is used only for converting back to lat/lon at the end
        # We need to determine epsg from the transform CRS or use a default
        # Since we don't have the CRS info here, we'll use the points as-is
        # and set epsg to None to indicate no conversion needed at the end
        epsg = None
    else:
        points, epsg = latlon_array_to_utm(points[:,1], points[:,0])

    points_df = create_points_dataframe(points, dsm, transform, line_res)
    
    # Check if we got valid points
    if len(points_df) == 0:
        # Fallback: create minimal DataFrame with the original points
        logger.warning("No points generated from sampling, creating minimal profile with original points")
        points_df = pd.DataFrame({
            "X": points[:, 0],
            "Y": points[:, 1],
            "elevation": 0.0,  # Will be filled later
            "minElevation": None,
            "maxElevation": None,
            "azimuth": 0.0,
            "line_num": 0,
            "parallel_points": [[] for _ in range(len(points))]
        })
        
        # Try to get actual elevation values for the points
        try:
            rows, cols = rasterio.transform.rowcol(transform, points_df["X"], points_df["Y"])
            rows = np.clip(rows, 0, dsm.shape[0] - 1)
            cols = np.clip(cols, 0, dsm.shape[1] - 1)
            points_df["elevation"] = dsm[rows, cols]
        except Exception as e:
            logger.warning(f"Could not sample elevation values: {e}")
            points_df["elevation"] = 0.0

    ## FIND HEIGHEST
    max_values = max_value_in_buffer(dsm, transform, points_df, radius, nodata)
    points_df["maxElevation"] = max_values

    ## FIND PARALLELS
    points_df=find_parallel_points(points_df, parallel_threshold, distance_threshold)

    ## FIND LOWEST
    min_values = min_value_in_buffer(points_df, dsm, transform)
    points_df["minElevation"] = min_values

    if epsg is not None:
        # Convert back to WGS84 lat/lon for output
        lats, lons = utm_to_latlon(points_df["X"], points_df["Y"], epsg)
        points_df["latitude"] = lats
        points_df["longitude"] = lons
    else:
        # When skip_coordinate_transform=True, X/Y are in DTM's CRS
        # The caller is responsible for converting back to WGS84 if needed
        # For now, just copy X/Y to latitude/longitude columns (will be overwritten by caller)
        points_df["latitude"] = points_df["Y"]
        points_df["longitude"] = points_df["X"]

    points_df = add_cumulative_distance(points_df)

    return points_df
