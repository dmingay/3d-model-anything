#!/usr/bin/env python3
"""Convert an outdoor house-capture bundle into a garden demo for the viewer.

usage: .venv/bin/python tools/garden/garden_bundle.py <bundle-dir-with-manifest.json> <garden-id>
         [--faces 240000] [--photo-edge 1280] [--no-photos]

Outdoor bundles have no RoomPlan walls, so bundle_to_room/bundle_plan do not apply. This reads
the LiDAR mesh (mesh/room-N.ply, already coloured on the phone), cleans it, fits the ground
plane and re-expresses everything in a *garden frame*:

  metres, +Y up (gravity), ground plane at y = 0 under the scan centre, origin at the scan
  centre, −Z = true north, +X = east (rotated by manifest.site.worldMinusZBearing).

Outputs
  data/web-assets/gardens/<id>/scan.glb        the cleaned mesh in the garden frame (served by Vite)
  data/web-assets/gardens/<id>/photos/NNNN.jpg  upright, downsized posed photos (for plant ID / UI)
  data/demos/<id>/garden.json                   site (lat/lon rounded to 2 dp ≈ 1 km, enough for
                                                sun geometry), ground plane, bounds, photo poses
                                                in the garden frame, camera suggestions

Precise coordinates and the raw bundle stay in data/captures-in (git-ignored).
"""
import argparse, json, math, os, sys
import numpy as np
import open3d as o3d
from PIL import Image, ImageOps


def mat(cm):
    """ARKit column-major 16-list → 4x4 row-major numpy."""
    return np.array(cm, dtype=np.float64).reshape(4, 4).T


def rot_y(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]])


def fit_ground(V, N):
    """RANSAC plane through the lowest up-facing vertices. Returns (normal, d) with n·p + d = 0."""
    up = (N[:, 1] > 0.8)
    cand = V[up]
    if len(cand) < 500:
        cand = V
    low = cand[cand[:, 1] <= np.percentile(cand[:, 1], 35)]
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(low))
    (a, b, c, d), inl = pc.segment_plane(distance_threshold=0.06, ransac_n=3, num_iterations=800)
    n = np.array([a, b, c])
    if n[1] < 0:
        n, d = -n, -d
    tilt = math.degrees(math.acos(min(1.0, n[1])))
    return n, d, len(inl), len(low), tilt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('bundle')
    ap.add_argument('garden_id')
    ap.add_argument('--faces', type=int, default=240000, help='target triangle count for the web mesh (0 = keep all)')
    ap.add_argument('--photo-edge', type=int, default=1280)
    ap.add_argument('--no-photos', action='store_true')
    ap.add_argument('--min-cluster', type=int, default=40, help='drop connected shells smaller than this many triangles')
    ap.add_argument('--site', help='site_lookup.py --json output; only coarse facts (hardiness, soil, frost, rain) are copied in')
    a = ap.parse_args()

    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bundle = os.path.abspath(a.bundle)
    manifest = json.load(open(os.path.join(bundle, 'manifest.json')))
    if manifest.get('capture') != 'outdoor':
        print(f"warning: manifest.capture = {manifest.get('capture')!r}; this converter is for outdoor bundles", file=sys.stderr)
    site = manifest.get('site') or {}
    bearing = float(site.get('worldMinusZBearing') or 0.0)
    rooms = manifest.get('rooms') or []
    name = rooms[0].get('name') if rooms else a.garden_id

    mesh_rel = manifest['mesh']['file'] if isinstance(manifest.get('mesh'), dict) else 'mesh/room-0.ply'
    mesh = o3d.io.read_triangle_mesh(os.path.join(bundle, mesh_rel))
    print(f'mesh: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} triangles, colours={mesh.has_vertex_colors()}')

    # --- clean -------------------------------------------------------------------------
    cl, cnt, _ = mesh.cluster_connected_triangles()
    cl, cnt = np.asarray(cl), np.asarray(cnt)
    mesh.remove_triangles_by_mask(cnt[cl] < a.min_cluster)
    mesh.remove_unreferenced_vertices()
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_unreferenced_vertices()
    print(f'cleaned: {len(mesh.triangles):,} triangles after dropping shells < {a.min_cluster} tris')
    if a.faces and len(mesh.triangles) > a.faces:
        mesh = mesh.simplify_quadric_decimation(a.faces)
        mesh.remove_degenerate_triangles()
        mesh.remove_unreferenced_vertices()
        print(f'simplified: {len(mesh.triangles):,} triangles, {len(mesh.vertices):,} vertices')
    mesh.compute_vertex_normals()

    # --- ground plane + garden frame -----------------------------------------------------
    V = np.asarray(mesh.vertices)
    N = np.asarray(mesh.vertex_normals)
    n, d, inliers, cands, tilt = fit_ground(V, N)
    lo, hi = np.percentile(V, 1, axis=0), np.percentile(V, 99, axis=0)
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    # height of the fitted plane under the scan centre: n·(cx, y, cz) + d = 0
    gy = -(n[0] * cx + n[2] * cz + d) / n[1]
    print(f'ground: plane normal {np.round(n, 3)}, tilt {tilt:.1f}°, {inliers}/{cands} inliers; y = {gy:.3f} under centre ({cx:.2f}, {cz:.2f})')

    theta = math.radians(bearing)           # rotate so the −Z axis swings from bearing b onto true north
    T = rot_y(theta) @ np.array([[1, 0, 0, -cx], [0, 1, 0, -gy], [0, 0, 1, -cz], [0, 0, 0, 1]], dtype=np.float64)
    mesh.transform(T)
    V = np.asarray(mesh.vertices)
    lo, hi = V.min(0), V.max(0)
    p1, p99 = np.percentile(V, 1, axis=0), np.percentile(V, 99, axis=0)
    n_g = (T[:3, :3] @ n)
    print(f'garden frame: bounds x {lo[0]:.2f}..{hi[0]:.2f}  y {lo[1]:.2f}..{hi[1]:.2f}  z {lo[2]:.2f}..{hi[2]:.2f}; rotated {bearing:.2f}° so −Z = north')

    # --- write mesh ----------------------------------------------------------------------
    web = os.path.join(repo, 'data', 'web-assets', 'gardens', a.garden_id)
    os.makedirs(web, exist_ok=True)
    glb = os.path.join(web, 'scan.glb')
    ok = o3d.io.write_triangle_mesh(glb, mesh, write_vertex_normals=True, write_vertex_colors=True, write_triangle_uvs=False)
    if not ok or not os.path.exists(glb):
        ply = os.path.join(web, 'scan.ply')
        o3d.io.write_triangle_mesh(ply, mesh, write_ascii=False)
        print('glTF export failed; wrote PLY instead:', ply)
        mesh_file = 'scan.ply'
    else:
        mesh_file = 'scan.glb'
    print(f'wrote {mesh_file}: {os.path.getsize(os.path.join(web, mesh_file)) / 1e6:.1f} MB')
    # tooling copy: Open3D's ASSIMP reader rejects its own GLB, so Python tools read this PLY
    o3d.io.write_triangle_mesh(os.path.join(web, 'scan.ply'), mesh, write_ascii=False)

    # --- photos --------------------------------------------------------------------------
    photos = json.load(open(os.path.join(bundle, manifest.get('photos', 'photos/photos.json'))))
    out_photos = []
    pdir = os.path.join(web, 'photos')
    if not a.no_photos:
        os.makedirs(pdir, exist_ok=True)
    for i, p in enumerate(photos):
        cam = T @ mat(p['transform'])                       # camera→garden
        pos = cam[:3, 3]
        fwd = -cam[:3, 2]                                   # ARKit camera looks down −Z
        upv = cam[:3, 1]
        # upright rotation: pick the 90° step that brings the sensor's up closest to +Y (ARKit camera is landscape-left native)
        right = cam[:3, 0]
        k = int(np.argmax([upv[1], -right[1], -upv[1], right[1]]))  # 0,90,180,270 CW
        rec = {
            'file': f'photos/{i:04d}.jpg', 'source': p['file'], 'index': i,
            'position': [round(float(x), 3) for x in pos], 'forward': [round(float(x), 3) for x in fwd],
            'heading': round((math.degrees(math.atan2(fwd[0], -fwd[2])) + 360) % 360, 1),
            'pitch': round(math.degrees(math.asin(max(-1, min(1, fwd[1])))), 1),
            'rotateCW': 90 * k, 'blurPixels': p.get('blurPixels'), 'timestamp': p.get('timestamp'),
            'manual': bool(p.get('manual')), 'pass': p.get('pass') or 'scan',
        }
        out_photos.append(rec)
        if not a.no_photos:
            with Image.open(os.path.join(bundle, p['file'])) as im:
                # the app tags each JPEG with an EXIF orientation; trust it, and fall back to the
                # pose-derived rotation only for untagged photos
                if im.getexif().get(274):
                    im = ImageOps.exif_transpose(im)
                elif k:
                    im = im.rotate(-90 * k, expand=True)
                im.thumbnail((a.photo_edge, a.photo_edge))
                im.save(os.path.join(pdir, f'{i:04d}.jpg'), quality=86, optimize=True)
    print(f'photos: {len(out_photos)}' + ('' if a.no_photos else f' → {pdir}'))

    # --- garden.json ---------------------------------------------------------------------
    lat, lon = site.get('latitude'), site.get('longitude')
    garden = {
        'id': a.garden_id, 'name': name, 'format': 'garden/1',
        'source': {'format': manifest.get('format'), 'device': manifest.get('device'), 'createdAt': manifest.get('createdAt'),
                   'capturedAt': rooms[0].get('capturedAt') if rooms else None, 'photoCoverage': rooms[0].get('photoCoverage') if rooms else None},
        'frame': 'garden: metres, +Y up, ground y=0 under scan centre, origin at scan centre, −Z true north, +X east',
        'site': {
            'latitude': round(lat, 2) if lat is not None else None, 'longitude': round(lon, 2) if lon is not None else None,
            'coordinatePrecision': '2 dp (~1 km) — precise fix kept out of the repo',
            'altitude': round(site['altitude']) if site.get('altitude') is not None else None,
            'northBearing': 0, 'sessionMinusZBearing': round(bearing, 2),
            'headingSpread': site.get('headingSpread'), 'headingSampleCount': site.get('headingSampleCount'),
            'horizontalAccuracy': site.get('horizontalAccuracy'), 'worldAlignment': site.get('worldAlignment'),
        },
        'ground': {'normal': [round(float(x), 4) for x in n_g], 'tiltDegrees': round(tilt, 2), 'inliers': inliers},
        'bounds': {'min': [round(float(x), 2) for x in lo], 'max': [round(float(x), 2) for x in hi],
                   'p1': [round(float(x), 2) for x in p1], 'p99': [round(float(x), 2) for x in p99]},
        'mesh': {'file': f'gardens/{a.garden_id}/{mesh_file}', 'toolFile': f'gardens/{a.garden_id}/scan.ply', 'vertices': len(mesh.vertices), 'triangles': len(mesh.triangles)},
        'photos': out_photos,
        'transform': {'sessionToGarden': [round(float(x), 6) for x in T.T.ravel()], 'columnMajor': True},
    }
    if a.site:
        L = json.load(open(a.site)).get('layers', {})
        soil, clim = L.get('soil', {}), L.get('climate', {})
        garden['siteFacts'] = {
            'hardinessZone': (clim.get('rhs_hardiness_zone') or '').split(' ')[0] or None,
            'typicalWinterMinC': clim.get('typical_winter_minimum_c'), 'absoluteMinC': clim.get('absolute_minimum_c'),
            'lastSpringFrost': (clim.get('last_spring_frost') or {}).get('median'), 'firstAutumnFrost': (clim.get('first_autumn_frost') or {}).get('median'),
            'annualRainMm': clim.get('annual_rain_mm'),
            'soilTexture': soil.get('texture'), 'soilGroup': soil.get('group'), 'soilDepth': soil.get('depth'),
            'calcareous': soil.get('calcareous'), 'parentMaterial': soil.get('parentMaterial'),
            'elevationM': (L.get('elevation') or {}).get('metres'),
            'sources': [soil.get('source'), clim.get('source')],
        }
    ddir = os.path.join(repo, 'data', 'demos', a.garden_id)
    os.makedirs(ddir, exist_ok=True)
    with open(os.path.join(ddir, 'garden.json'), 'w') as f:
        json.dump(garden, f, indent=1)
    print('wrote', os.path.join(ddir, 'garden.json'))


if __name__ == '__main__':
    main()
