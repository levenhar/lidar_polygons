import math
from skimage.draw import line
import matplotlib.pyplot as plt
import numpy as np 
import collections
import io
import re

def calculate_azimuth(x1, y1, x2, y2):
    calc_az = math.atan2(x2-x1, y2-y1)
    if calc_az > 2*np.pi:
        calc_az -= 2*np.pi
    if calc_az < 0:
        calc_az += 2*np.pi
    return calc_az

def calculate_azimuth_map(x1, y1, x2, y2):
    calc_az = math.atan2(x2-x1, -(y2-y1))
    if calc_az > 2*np.pi:
        calc_az -= 2*np.pi
    if calc_az < 0:
        calc_az += 2*np.pi
    return calc_az

def calculate_azimuth_arr(x1, y1, pnts):
    calc_az = np.arctan2(pnts[:,0]-x1, pnts[:,1]-y1)
    calc_az[calc_az > 2*np.pi] -= 2*np.pi
    calc_az[calc_az < 0] += 2*np.pi
    return calc_az

def calc_az_diff(az1, az2, diff, threshold):
    """
    az1 - angle
    az2 - array of angles
    """
    calc_diff = az2 - az1
    return np.abs(calc_diff - diff) <= threshold

def get_intersection_points(col, row, az, ncols, nrows):
    
    if az > 2*np.pi:
        az -= 2*np.pi
    if az < 0:
        az += 2*np.pi

    t1 = -col / (np.sin(az))
    c1 = 0
    r1 = row - t1 * (np.cos(az))

    t2 = (ncols - 1 - col) / (np.sin(az))
    c2 = ncols - 1
    r2 = row - t2 * (np.cos(az))

    t3 = row / (np.cos(az))
    r3 = 0
    c3 = col + t3 * (np.sin(az))

    t4 = -(nrows - 1 - row) / (np.cos(az))
    r4 = nrows - 1
    c4 = col + t4 * (np.sin(az))

    border_intersection = []

    if c1 >= 0 and c1 < ncols and r1 >= 0 and r1 < nrows:
        calc_az = calculate_azimuth_map(col, row, c1, r1)
        if abs(calc_az - az) < 0.000001:
            return([[c1, r1]])
    if c2 >= 0 and c2 < ncols and r2 >= 0 and r2 < nrows:
        calc_az = calculate_azimuth_map(col, row, c2, r2)
        if abs(calc_az - az) < 0.000001:
            return([[c2, r2]])
    if c3 >= 0 and c3 < ncols and r3 >= 0 and r3 < nrows:
        calc_az = calculate_azimuth_map(col, row, c3, r3)
        if abs(calc_az - az) < 0.000001:
            return([[c3, r3]])
    if c4 >= 0 and c4 < ncols and r4 >= 0 and r4 < nrows:
        calc_az = calculate_azimuth_map(col, row, c4, r4)
        if abs(calc_az - az) < 0.000001:
            return([[c4, r4]])

    return border_intersection

def ray_border_intersection(x0, y0, z0, az, dsm, transform):
    nrows, ncols = dsm.shape

    # find the flight point as pixels in dsm
    col, row = ~transform * (x0, y0)
    col = col
    row = row

    # check DSM borders
    flag = True
    if col < 0 or col >= ncols:
        print(col, "Doesnt fit to shape 0, ", ncols)
        flag = False
    if row < 0 or row > nrows:
        print(row, "Doesnt fit to shape 0, ", nrows)
        flag = False
    if flag == False:
        return

    border_intersection = []
    border_intersection += get_intersection_points(col, row, az + np.pi / 2, ncols, nrows)
    border_intersection += get_intersection_points(col, row, az - np.pi / 2, ncols, nrows)

    if len(border_intersection) == 2:
        return np.array(border_intersection)

    return None

def build_mask(border_intersection, dsm, nodatavals, x0, y0, z0, fov, transform, dist_threshold):
    num_points = int(np.sqrt((border_intersection[0, 1] - border_intersection[1, 1]) ** 2 + (border_intersection[0, 0] - border_intersection[1, 0]) ** 2)) + 1
    t = np.linspace(0, 1, num_points)
    points = border_intersection[0] + t[:, None] * (border_intersection[1] - border_intersection[0])
    rr = points[:, 1]
    cc = points[:, 0]

    values = dsm[rr.astype(int), cc.astype(int)]
    rr = rr[~np.isnan(values)]
    cc = cc[~np.isnan(values)]
    xx, yy = transform * (cc, rr)
    z = dsm[rr.astype(int), cc.astype(int)]
    fov_calc = np.arcsin(np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2) / np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2 + (z - z0) ** 2))
    dist = np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2 + (z - z0) ** 2)
    rr = rr[(fov_calc <= 0.5 * fov) & (dist <= dist_threshold)]
    cc = cc[(fov_calc <= 0.5 * fov) & (dist <= dist_threshold)]

    return rr, cc

def compute_visibility(x0, y0, z0, rr, cc, transform, dsm, viewshed, line_num):
    col, row = ~transform * (x0, y0)
    visible_list = []
    for i in range(len(rr)):
        r = rr[i]
        c = cc[i]
        all_r, all_c = line(int(r), int(c), int(row), int(col))
        xx, yy = transform * (all_c, all_r)
        zz = dsm[all_r, all_c]
        t = (xx - x0) / (xx[0] - x0)

        unique_vals, indices = np.unique(t, return_index=True)

        z_check = z0 + t[indices] * (zz[0] - z0)
        sign = np.zeros(xx[indices].shape)
        sign[z_check >= zz[indices]] = 1
        has_block = np.any(sign == 0)

        if has_block == False:
            viewshed[np.round(r, 0).astype(int), np.round(c, 0).astype(int)] = viewshed[np.round(r, 0).astype(int), np.round(c, 0).astype(int)] + str(line_num) + "."

    return viewshed

def calculate_viewshed_map(viewshed):
    viewshed_map = np.zeros(viewshed.shape, dtype="int32")

    for row in range(viewshed.shape[0]):
        for col in range(viewshed.shape[1]):
            a = list(set(viewshed[row, col].split(".")))
            a.remove('')
            viewshed_map[row, col] = len(a)
    return viewshed_map

def convert_trajectory_units(trajectory_lat_lng, transformer):
    # convert
    trajectory_xy = []
    for i in range(len(trajectory_lat_lng)):
        lat, lng = trajectory_lat_lng[i]["lat"], trajectory_lat_lng[i]["lng"]
        x, y = transformer.transform(lng, lat)
        trajectory_xy.append([x, y, trajectory_lat_lng[i]["height"]])
    trajectory_xy = np.array(trajectory_xy)

    # extract lines
    line_num = [0]
    az = []
    for i in range(1, len(trajectory_xy) - 1):
        prev_az = calculate_azimuth(trajectory_xy[i-1, 0], trajectory_xy[i-1, 1], trajectory_xy[i, 0], trajectory_xy[i, 1])
        next_az = calculate_azimuth(trajectory_xy[i, 0], trajectory_xy[i, 1], trajectory_xy[i+1, 0], trajectory_xy[i+1, 1])
        if abs(next_az - prev_az) < 0.0001:
            line_num.append(line_num[-1])
        else:
            line_num.append(line_num[-1] + 1)
        if i == 1:
            az.append(prev_az)
        az.append(next_az)
    az.append(next_az)
    line_num.append(line_num[-1])

    return trajectory_xy, az, line_num

def get_all_parallel_points(curr_point, curr_az, curr_line, all_points, az, line_num, thresh_az):
    # mask parallel by azimuth
    parallel_az1 = calc_az_diff(curr_az, az, np.deg2rad(0), thresh_az)
    parallel_az2 = calc_az_diff(curr_az, az, np.deg2rad(180), thresh_az)
    parallel_az3 = calc_az_diff(curr_az, az, np.deg2rad(-180), thresh_az)
    parallel_az = parallel_az1 | parallel_az2 | parallel_az3

    # remove the current line
    parallel_line = line_num != curr_line
    parallel_mask = parallel_az & parallel_line
    parallel_points = all_points[parallel_mask]
    parallel_line_relevant = line_num[parallel_mask]


    # mask perpendicular
    az_to_points = calculate_azimuth_arr(curr_point[0], curr_point[1], parallel_points)

    perpendicular_az_right = calc_az_diff(curr_az, az_to_points, np.deg2rad(90), thresh_az) | calc_az_diff(curr_az, az_to_points, np.deg2rad(-270), thresh_az)
    perpendicular_az_left = calc_az_diff(curr_az, az_to_points, np.deg2rad(270), thresh_az) | calc_az_diff(curr_az, az_to_points, np.deg2rad(-90), thresh_az)


    parallel_points_right = parallel_points[perpendicular_az_right]
    line_right_all = parallel_line_relevant[perpendicular_az_right]
    parallel_points_left = parallel_points[perpendicular_az_left]
    line_left_all = parallel_line_relevant[perpendicular_az_left]

    res = []

    if len(parallel_points_right) > 0:
        dist_right = (parallel_points_right[:, 0] - curr_point[0]) ** 2 + (parallel_points_right[:, 1] - curr_point[1]) ** 2
        min_right = np.argmin(dist_right)
        line_right = line_right_all[min_right]
        res.append([parallel_points_right[min_right][0], parallel_points_right[min_right][1], line_right])


    if len(parallel_points_left) > 0:
        dist_left = (parallel_points_left[:, 0] - curr_point[0]) ** 2 + (parallel_points_left[:, 1] - curr_point[1]) ** 2
        min_left = np.argmin(dist_left)
        line_left = line_left_all[min_left]
        res.append([parallel_points_left[min_left][0], parallel_points_left[min_left][1], line_left])

    return res

def distance(x1, y1, x2, y2):
    return np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

def calculate_overlap(trajectory_xy, az, line_num, thresh_az, data, transform, fovDegrees, outputHeight, nodata, viewshed_lines):
    # initialize
    overlap_data = []

    for i in range(len(trajectory_xy)):
        x0 = trajectory_xy[i, 0]
        y0 = trajectory_xy[i, 1]
        z0 = trajectory_xy[i, 2]

        r, c = ~transform*(x0, y0)
        neighbors = get_all_parallel_points([x0, y0, z0], az[i], line_num[i], trajectory_xy, np.array(az), np.array(line_num), thresh_az)

        border_intersection = ray_border_intersection(x0, y0, z0, az[i], data, transform)
        mask_rr_all, mask_cc_all = build_mask(border_intersection, data, nodata, x0, y0, z0, np.deg2rad(fovDegrees), transform, outputHeight / np.cos(np.deg2rad(fovDegrees) / 2))
        mask_rr_all = (np.round(np.array(mask_rr_all), 0)).astype(int)
        mask_cc_all = (np.round(np.array(mask_cc_all), 0)).astype(int)

        points_as_tuples = [tuple(point) for point in np.column_stack((mask_rr_all, mask_cc_all))]

        unique_points = list(dict.fromkeys(points_as_tuples))
        unique_points = np.array(unique_points)

        for n in neighbors:
            count = sum(1 for s in viewshed_lines[unique_points[:, 0], unique_points[:, 1]] if "." + str(n[2]) + "." in s)
            overlap = 100 * count / len(unique_points)
            overlap_data.append([i, line_num[i], n[2], overlap])

    groups_overlap = collections.defaultdict(list)
    groups_distances = collections.defaultdict(list)
    distances = calculate_distance_along_traj(trajectory_xy)
    for index, first, second, overlap in overlap_data:
        key = f"{first + 1}-{first + 2}:{second + 1}-{second + 2}"
        groups_overlap[key].append((index, overlap))
        groups_distances[key].append(distances[index])

    return groups_overlap, groups_distances


def calculate_distance_along_traj(trajectory_xy):
    distance= [0]
    for i in range(1, len(trajectory_xy)):
        distance.append(distance[-1] + np.sqrt((trajectory_xy[i, 0] - trajectory_xy[i-1, 0]) ** 2 + (trajectory_xy[i, 1] - trajectory_xy[i-1, 1]) ** 2))
    return distance


def calc_viewshed(trajectory_xy, viewshed_jobs, job_id, az, line_num, data, transform, fovDegrees, outputHeight, viewshed_no_data):
    viewshed_lines = np.empty(data.shape, dtype=object)
    viewshed_lines[:] = "."
    i = 0
    for p in trajectory_xy:
        viewshed_jobs[job_id]["progress"] = int(100 * i / (len(trajectory_xy) - 1))
        x0 = p[0]
        y0 = p[1]
        z0 = p[2]
        border_intersection = ray_border_intersection(x0, y0, z0, az[i], data, transform)
        mask_rr, mask_cc = build_mask(border_intersection, data, np.nan, x0, y0, z0, np.deg2rad(fovDegrees), transform, outputHeight / np.cos(np.deg2rad(fovDegrees) / 2))
        viewshed_lines = compute_visibility(x0, y0, z0, mask_rr, mask_cc, transform, data, viewshed_lines, line_num[i])
        i += 1

    viewshed = calculate_viewshed_map(viewshed_lines)
    
    viewshed[viewshed==0] = viewshed_no_data

    return viewshed, viewshed_lines