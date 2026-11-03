"""ZG3D 2022 LoD2.2 faces → a stepped skyline per building (the Zagreb port's drawn geometry).

The ZG3D GeoJSON gives each building part a 2D footprint and Z_Min/Z_Max only, so a part drawn as a box reaches its
HIGHEST point: the cathedral's 2,669 m² main part became a 103.5 m block (the spire tips) and every pitched roof
stood at ridge height. The same data published per gradska četvrt as SHP (FGDB for Podsused - Vrapče) carries the
real LoD2.2 surfaces: each feature is a MultiPolygon Z (EWKB 0x80000006; a few are TIN Z 1016 or GeometryCollection
Z, read by `_faces_wkb`) whose polygons are its walls, roof faces and floor with true vertex heights (m a.s.l.).

`roof_faces` keeps the faces that face up (outward normal z > NZ_MIN; walls are vertical, floors and eave
undersides face down). `skyline` turns one building's roof faces into nested height bands:
  1. Levels L_k = ground + k * step from the building's ground (step = STEP_M, coarser for small buildings and when a
     building would need more than MAX_BANDS bands: spires get 5 m steps).
  2. Each face's slice in band k (where its plane lies in [L_k, L_k+1)) has the mean height of its z-range there, so a
     band's height is the area-weighted mean of its slices. That is volume-preserving for planar faces: a gable roof
     is drawn as steps around eave-to-ridge, not as a box at the ridge, and a spire as a tapering stack.
  3. Consecutive bands closer than MERGE_M are merged (area-weighted), so flat roofs straddling a level, or gentle
     slopes, stay one part.
  4. Each band is drawn as U_k, the union of every face portion at or above L_k (computed top-down, U_k = U_k+1 ∪ the
     slices of band k), so the parts are nested solids drawn from the building's ground: no cracks between steps.
     Bands whose own slices cover under MIN_AREA_M2, or whose U_k does, are dropped; outlines are simplified at
     SIMPLIFY_M.
The lowest band is the building's base (its footprint drawn at that height); every higher band is a further part.
"""
import struct

import numpy as np
import shapely

NZ_MIN = 0.05          # unit normal z above this: a roof face (walls ~0; floors and soffits face down)
STEP_M = 2.0           # band height for most buildings
STEP_SMALL_M = 3.0     # band height for buildings under SMALL_AREA_M2 (houses: one step between eave and ridge)
SMALL_AREA_M2 = 300.0
MAX_BANDS = 14         # per building; a taller roof range gets a coarser step
MERGE_M = 1.2          # neighbouring bands closer than this become one
MIN_AREA_M2 = 1.0      # slivers under this are dropped
SIMPLIFY_M = 0.3


# ------------------------------------------------------------------ WKB (the geometries GEOS refuses)
def _faces_wkb(w: bytes) -> list[np.ndarray]:
    """Exterior rings (n x 3) of every polygon/triangle in a (E/ISO)WKB MultiPolygon Z, TIN Z, PolyhedralSurface Z or
    GeometryCollection Z. Only the outer rings: the few faces with holes come through GEOS."""
    out = []

    def geom(off):
        bo = "<" if w[off] == 1 else ">"
        t = struct.unpack_from(bo + "I", w, off + 1)[0]
        off += 5
        has_z = bool(t & 0x80000000) or (t & 0xFFFF) // 1000 in (1, 3)
        has_m = bool(t & 0x40000000) or (t & 0xFFFF) // 1000 in (2, 3)
        if t & 0x20000000:
            off += 4                                     # EWKB SRID
        base = (t & 0x0FFFFFFF) % 1000
        dim = 2 + has_z + has_m
        if base in (3, 17):                              # Polygon, Triangle
            nr = struct.unpack_from(bo + "I", w, off)[0]
            off += 4
            for r in range(nr):
                n = struct.unpack_from(bo + "I", w, off)[0]
                off += 4
                a = np.frombuffer(w, dtype=bo + "f8", count=n * dim, offset=off).reshape(n, dim)
                off += 8 * n * dim
                if r == 0 and n >= 4:
                    out.append(a[:, :3].copy() if has_z else np.c_[a[:, :2], np.zeros(n)])
            return off
        if base in (6, 7, 15, 16):                       # Multi*, collection, polyhedral surface, TIN
            k = struct.unpack_from(bo + "I", w, off)[0]
            off += 4
            for _ in range(k):
                off = geom(off)
            return off
        if base == 1:
            return off + 8 * dim
        if base == 2:
            n = struct.unpack_from(bo + "I", w, off)[0]
            return off + 4 + 8 * n * dim
        raise ValueError(f"WKB type {t:#x}")

    geom(0)
    return out


def read_faces(path, layer=None, to_crs=3765):
    """(attrs dict of arrays, faces (shapely Polygon Z array, projected), feature index per face)."""
    import pyogrio
    import pyogrio.raw as raw
    from pyproj import Transformer
    layer = layer or pyogrio.list_layers(path)[0][0]
    meta, _, wkb, fields = raw.read(path, layer=layer)
    attrs = {k: np.asarray(v) for k, v in zip(meta["fields"], fields)}
    g = shapely.from_wkb(wkb, on_invalid="ignore")
    miss = np.flatnonzero(shapely.is_missing(g) & np.array([w is not None for w in wkb]))
    for i in miss:
        rings = _faces_wkb(wkb[i])
        g[i] = shapely.MultiPolygon([shapely.Polygon(r) for r in rings]) if rings else None
    faces, fidx = shapely.get_parts(g, return_index=True)
    keep = shapely.get_type_id(faces) == 3
    faces, fidx = faces[keep], fidx[keep]
    epsg = pyogrio.read_info(path, layer=layer)["crs"]
    if epsg and epsg.upper() != f"EPSG:{to_crs}":
        tr = Transformer.from_crs(epsg, to_crs, always_xy=True)

        def fn(c):
            x, y = tr.transform(c[:, 0], c[:, 1])
            return np.c_[x, y, c[:, 2]]
        faces = shapely.transform(faces, fn, include_z=True)
    return attrs, faces, fidx


def face_planes(faces):
    """Per face: unit normal (n x 3), projected area, z min/max, centroid (x, y, z) of the exterior ring (Newell)."""
    ring = shapely.get_exterior_ring(faces)
    c, ri = shapely.get_coordinates(ring, include_z=True, return_index=True)
    n = len(faces)
    nxt = np.r_[c[1:], c[:1]]
    same = np.r_[ri[1:] == ri[:-1], False]               # the pair (i, i+1) lies on one ring
    d = np.where(same[:, None], 1.0, 0.0)
    x, y, z = c[:, 0], c[:, 1], c[:, 2]
    x1, y1, z1 = nxt[:, 0], nxt[:, 1], nxt[:, 2]
    # Newell on coordinates shifted to each ring's first vertex (projected coordinates are ~5e6)
    first = np.r_[0, np.flatnonzero(np.diff(ri)) + 1]
    start = np.repeat(first, np.diff(np.r_[first, len(ri)]))
    ox, oy = x[start], y[start]
    xs, ys, x1s, y1s = x - ox, y - oy, x1 - ox, y1 - oy
    N = np.zeros((n, 3))
    np.add.at(N[:, 0], ri, d[:, 0] * (ys - y1s) * (z + z1))
    np.add.at(N[:, 1], ri, d[:, 0] * (z - z1) * (xs + x1s))
    np.add.at(N[:, 2], ri, d[:, 0] * (xs - x1s) * (ys + y1s))
    norm = np.linalg.norm(N, axis=1)
    unit = N / np.where(norm > 0, norm, 1.0)[:, None]
    area2d = np.abs(N[:, 2]) / 2.0
    zmin = np.full(n, np.inf)
    zmax = np.full(n, -np.inf)
    np.minimum.at(zmin, ri, z)
    np.maximum.at(zmax, ri, z)
    cnt = np.bincount(ri, minlength=n).astype(float)
    cz = np.bincount(ri, weights=z, minlength=n) / np.maximum(cnt, 1)
    cx = np.bincount(ri, weights=x, minlength=n) / np.maximum(cnt, 1)
    cy = np.bincount(ri, weights=y, minlength=n) / np.maximum(cnt, 1)
    return unit, area2d, zmin, zmax, np.c_[cx, cy, cz]


def orient(fidx, unit, area2d, cent, zmin_feature, n_features):
    """+1/-1 per feature so that its normals point outward. ZG3D's solids are consistently oriented within a feature but
    most (98.7% in Gornji grad) point inward; the divergence theorem gives the sign: V = sum(z * n_z * A) > 0 outward."""
    vol = np.bincount(fidx, weights=(cent[:, 2] - zmin_feature[fidx]) * unit[:, 2] * area2d, minlength=n_features)
    return np.where(vol < 0, -1.0, 1.0)


def roof_mask(nz_out, area2d):
    """Faces that face up once oriented outward (walls ~0; floors and eave soffits face down)."""
    return (nz_out > NZ_MIN) & (area2d > 0.01)


def district_roofs(path):
    """One district file → its roof faces: dict of arrays (wkb of the 2D face, unit normal (outward), zmin, zmax,
    centroid, projected area, feature index) and the features' Z_Min/Z_Max/count."""
    attrs, faces, fidx = read_faces(path)
    unit, a2, zmin, zmax, cent = face_planes(faces)
    zmin_f = np.asarray(attrs["Z_Min"], float)
    n = len(zmin_f)
    s = orient(fidx, unit, a2, cent, zmin_f, n)
    unit = unit * s[fidx][:, None]
    roof = roof_mask(unit[:, 2], a2)
    f2 = shapely.force_2d(faces[roof])
    bad = ~shapely.is_valid(f2)
    if bad.any():
        f2[bad] = [_polys_only(g) for g in shapely.make_valid(f2[bad])]
    return dict(wkb=shapely.to_wkb(f2), unit=unit[roof], zmin=zmin[roof], zmax=zmax[roof], cent=cent[roof],
                area=a2[roof], fidx=fidx[roof], n_features=n, z_min=zmin_f, z_max=np.asarray(attrs["Z_Max"], float),
                n_faces=len(faces))


def _polys_only(g):
    ps = [p for p in getattr(g, "geoms", [g]) if isinstance(p, (shapely.Polygon, shapely.MultiPolygon))]
    return shapely.union_all(ps) if len(ps) > 1 else (ps[0] if ps else shapely.Polygon())


def _halfplane(cx, cy, cz, ux, uy, uz, level, reach):
    """Polygons of the half-planes where each face plane (point c, unit normal u) lies at or above `level`."""
    gx, gy = -ux / uz, -uy / uz                          # z gradient of the plane
    gg = np.hypot(gx, gy)
    ex, ey = gx / gg, gy / gg                            # uphill unit
    t = (level - cz) / gg                                # distance uphill from c to the contour
    qx, qy = cx + ex * t, cy + ey * t
    px, py = -ey, ex
    R = reach
    pts = np.stack([np.c_[qx + px * R, qy + py * R], np.c_[qx + px * R + ex * R, qy + py * R + ey * R],
                    np.c_[qx - px * R + ex * R, qy - py * R + ey * R], np.c_[qx - px * R, qy - py * R]], axis=1)
    return shapely.polygons(pts)


def band_slices(face2d, unit, zmin, zmax, cent, ground, step):
    """For the roof faces of buildings (ground, step per face): rows (face, k, area of the face at or above L_k,
    geometry of that portion). k runs over every band the face touches; the first is the whole face."""
    k0 = np.floor((zmin - ground) / step).astype(np.int64)
    k1 = np.floor((zmax - ground) / step - 1e-9).astype(np.int64)
    k1 = np.maximum(k1, k0)
    nk = k1 - k0 + 1
    fi = np.repeat(np.arange(len(face2d)), nk)
    kk = k0[fi] + (np.arange(len(fi)) - np.repeat(np.cumsum(nk) - nk, nk))
    whole = kk == k0[fi]
    geom = np.empty(len(fi), dtype=object)
    geom[whole] = face2d[fi[whole]]
    cut = np.flatnonzero(~whole)
    if len(cut):
        f = fi[cut]
        level = ground[f] + kk[cut] * step[f]
        b = shapely.bounds(face2d[f])
        reach = np.hypot(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]) * 2 + 10.0
        hp = _halfplane(cent[f, 0], cent[f, 1], cent[f, 2], unit[f, 0], unit[f, 1], unit[f, 2], level, reach)
        geom[cut] = shapely.intersection(face2d[f], hp)
    return fi, kk, geom


def steps_for(r0, r1, area):
    """Band height per building: STEP_M (STEP_SMALL_M under SMALL_AREA_M2), coarser when the roof range would need
    more than MAX_BANDS bands."""
    step = np.where(area < SMALL_AREA_M2, STEP_SMALL_M, STEP_M)
    return np.maximum(step, (r1 - r0) / MAX_BANDS)


def bands(gid, face2d, unit, zmin, zmax, cent, r0, step):
    """Per roof face (its building gid; r0/step per face): the band rows. Returns a DataFrame (gid, face, k, whole,
    cum_area, slice_area, h) and the row geometries (the face portion at or above L_k)."""
    import pandas as pd
    fi, kk, geom = band_slices(face2d, unit, zmin, zmax, cent, r0, step)
    cum = shapely.area(geom)
    k0 = np.floor((zmin - r0) / step).astype(np.int64)
    nxt_same = np.r_[fi[1:] == fi[:-1], False]
    nxt_cum = np.r_[cum[1:], 0.0]
    sl = np.maximum(cum - np.where(nxt_same, nxt_cum, 0.0), 0.0)
    L = r0[fi] + kk * step[fi]
    lo = np.maximum(L, zmin[fi])
    hi = np.minimum(L + step[fi], zmax[fi])
    h = (lo + np.maximum(hi, lo)) / 2.0
    df = pd.DataFrame({"gid": gid[fi], "face": fi, "k": kk, "whole": kk == k0[fi], "cum": cum, "slice": sl, "h": h})
    return df, geom


def groups_of(bt):
    """bt: one building's bands (k ascending, slice, h). Consecutive bands closer than MERGE_M (to the group's running
    mean) or thinner than MIN_AREA_M2 join the group below. Returns [(k_first, h, slice_area)]."""
    out = []
    for k, a, h in bt:
        if out and (a < MIN_AREA_M2 or abs(h - out[-1][1]) < MERGE_M):
            k0, h0, a0 = out[-1]
            w = a0 + a
            out[-1] = (k0, (h0 * a0 + h * a) / w if w > 0 else h0, w)
        else:
            out.append((int(k), float(h), float(a)))
    return out


def region(k, rows_k, geoms, foot):
    """U_k: every face portion at or above L_k (the rows with k == band, plus the whole faces that start higher), cut
    to the building's footprint, simplified, slivers dropped."""
    sel = rows_k
    try:
        u = shapely.union_all(geoms[sel], grid_size=0.01) if len(sel) > 1 else geoms[sel[0]]
        u = shapely.intersection(u, foot, grid_size=0.01)
    except shapely.errors.GEOSException:         # a near-degenerate slice: repair the inputs and try once more
        try:
            u = shapely.union_all(shapely.make_valid(geoms[sel]).tolist() + [], grid_size=0.01)
            u = shapely.intersection(shapely.make_valid(u), shapely.make_valid(foot).buffer(0), grid_size=0.01)
        except shapely.errors.GEOSException:
            u = shapely.intersection(shapely.union_all(shapely.make_valid(geoms[sel]).tolist()).buffer(0),
                                     shapely.make_valid(foot).buffer(0))
    u = shapely.simplify(_polys_only(u), SIMPLIFY_M, preserve_topology=True)
    ps = [p for p in getattr(u, "geoms", [u]) if isinstance(p, shapely.Polygon) and p.area >= MIN_AREA_M2]
    return shapely.normalize(shapely.MultiPolygon(ps) if len(ps) > 1 else ps[0]) if ps else None
