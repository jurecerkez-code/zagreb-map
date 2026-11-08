"""Little-endian, bounded Zagreb data v2 codecs (#29B).

All coordinates and y values are INTEGER decimetres at write time.  Do not use ``astype(int)``: it truncates.
Every binary reader checks its complete input length; there is no untrusted variable-length seek or JSON point array.
HDR18 is local x/z/y in integer dm, u8 RGB, an 8-bit source palette index and u16 slope in milli-degrees
(0 = level/unknown; otherwise 1001..45000). Per-record sample width belongs in its file's grid metadata, not in
an invented 23-byte record called 18. No measurement is inferred for absent data.
"""
import gzip
import json
import math
import struct
from numbers import Integral
from pathlib import Path

import numpy as np

from . import io

I32_MIN, I32_MAX = -(1 << 31), (1 << 31) - 1
ROADS_FORMAT = "zagreb-roads2"
VEG_FORMAT = "zagreb-veg2"
HDR18 = struct.Struct("<3i3BBH")
VEG18 = struct.Struct("<3ifH")
assert HDR18.size == VEG18.size == 18


def dm(value) -> int:
    """Finite metres to signed integer decimetres; reject bools, nonsense and overflow before packing."""
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError("coordinate is not a finite number")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("coordinate is not finite")
    # Same tie direction as Math.round, unlike Python's bankers' round. Negative zero has the same integer encoding.
    scaled = value * 10
    out = math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)
    if not I32_MIN <= out <= I32_MAX:
        raise ValueError("coordinate exceeds signed int32 decimetres")
    return out


def u16(value) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral) or not 0 <= value <= 65535:
        raise ValueError("value is not an unsigned 16-bit integer")
    return int(value)


def whole(value, *, minimum=0, maximum=(1 << 53) - 1) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral) or not minimum <= value <= maximum:
        raise ValueError("value is not a safe whole number")
    return int(value)


def width_dm(value) -> int:
    out = dm(value)
    if out < 0:
        raise ValueError("width is negative")
    return out


def legacy_error(raw, encoded) -> float:
    """Maximum |legacy metres - int32 dm / 10| (expected <0.1 m), never a recast of an old fractional coordinate."""
    raw, encoded = np.asarray(raw, dtype=np.float64), np.asarray(encoded)
    if raw.shape != encoded.shape or not np.isfinite(raw).all():
        raise ValueError("legacy coordinates and integer decimetres differ in shape or are not finite")
    return float(np.max(np.abs(raw - encoded / 10))) if raw.size else 0.0


def _optional_name(names, index):
    if index == -1:
        return -1
    if not isinstance(index, Integral) or isinstance(index, (bool, np.bool_)) or not 0 <= index < len(names):
        raise ValueError("name index is out of bounds")
    return index


def _f32(value):
    return float(np.float32(value))


def _absolute_point(out, x, z):
    """An i16 sentinel pair followed by an exact legacy float32 x/z pair in metres."""
    out += struct.pack("<hhff", -32768, -32768, x, z)


def pack_roads2(ways, points_xyz, classes, names=()):
    """The published ZGR2 stream: columnar way indexes and exact xz point records.

    A first point uses signed 1.6 m cells and following points signed decimetre deltas only when those values
    decode to exactly the old float32 coordinates. Otherwise the -32768 pair escapes to absolute float32 x/z;
    this is what lets s99 require equality instead of silently accepting coordinate drift. The display terrain
    supplies y in the viewer, as it did for roads.json/roads.bin.gz.
    """
    if len(ways) != len(points_xyz) or not 0 < len(classes) <= 256:
        raise ValueError("roads: invalid way/point arrays or class table")
    chunks = [np.asarray(p, dtype="<f4") for p in points_xyz]
    if any(p.ndim != 2 or p.shape[1] != 3 or not len(p) or len(p) > 65535 or not np.isfinite(p).all()
           for p in chunks):
        raise ValueError("roads: every way needs 1..65535 finite Nx3 points")
    count = sum(map(len, chunks))
    if count > 0xFFFFFFFF:
        raise ValueError("roads: point count exceeds uint32")
    classes = list(classes)
    indices = [classes.index(w["cls"]) for w in ways]
    widths, class_widths = [], {}
    for way in ways:
        original = float(way["w"])
        encoded = round(original * 4)
        if not 0 <= encoded <= 255:
            raise ValueError("roads: width is not an unsigned quarter-metre value")
        widths.append(encoded)
        if not math.isclose(original, encoded / 4, abs_tol=1e-9):
            # OSM's footways/cycleways are 1.8 m. Keep their real class width in metadata instead of changing it.
            if class_widths.setdefault(way["cls"], original) != original:
                raise ValueError("roads: nonquarter widths differ within one class")
            class_widths[way["cls"]] = original
    origin = (0.0, 0.0)
    out = bytearray(struct.pack("<4sIIff", b"ZGR2", len(ways), count, *origin))
    out += bytes(indices)
    out += bytes(widths)
    out += struct.pack(f"<{len(ways)}H", *(len(p) for p in chunks))
    for p in chunks:
        xz = p[:, [0, 2]]
        x, z = map(_f32, xz[0])
        qx, qz = round(float(x) / 1.6), round(float(z) / 1.6)
        if all(-32767 <= q <= 32767 for q in (qx, qz)) and _f32(qx * 1.6) == x and _f32(qz * 1.6) == z:
            out += struct.pack("<hh", qx, qz)
        else:
            _absolute_point(out, x, z)
        previous = np.array([x, z], dtype=np.float32)
        for point in xz[1:]:
            x, z = map(_f32, point)
            dx, dz = round((x - float(previous[0])) * 10), round((z - float(previous[1])) * 10)
            decoded = np.array([_f32(previous[0] + np.float32(dx / 10)),
                                _f32(previous[1] + np.float32(dz / 10))], dtype=np.float32)
            if all(-32767 <= q <= 32767 for q in (dx, dz)) and decoded[0] == x and decoded[1] == z:
                out += struct.pack("<hh", dx, dz)
                previous = decoded
            else:
                _absolute_point(out, x, z)
                previous = np.array([x, z], dtype=np.float32)
    doc = {"version": 2, "format": ROADS_FORMAT, "file": "roads2.bin.gz",
           "encoding": "ZGR2/u8-cls/u8-quarter-m/u16-count/i16-delta+absolute-f32-escape",
           "classes": classes, "classWidths": class_widths, "count": count, "nWays": len(ways), "origin": list(origin)}
    return doc, bytes(out)


def _read_roads0(doc, blob):
    """One-release legacy reader for the superseded roads2.json + roads0.bin experiment."""
    raw = bytes(blob)
    if len(raw) % 4:
        raise ValueError("roads2: chunk length is not aligned")
    view = memoryview(raw)
    at, out, total = 0, [], 0
    for way in doc["ways"]:
        if at + 4 > len(raw):
            raise ValueError("roads2: chunk length ends at a way header")
        n = struct.unpack_from("<I", view, at)[0]
        if n != way.get("n"):
            raise ValueError("roads2: way point count disagrees with its header")
        at += 4
        size = n * 12
        if at + size > len(raw):
            raise ValueError("roads2: chunk length ends inside a way")
        points = np.frombuffer(view, dtype="<i4", count=n * 3, offset=at).reshape(n, 3)
        name = _optional_name(doc["names"], way["name"])
        cls = whole(way["cls"], maximum=len(doc["classes"]) - 1)
        w = whole(way["w"], maximum=I32_MAX) / 10
        item = {"id": whole(way["id"]), "name": -1 if name == -1 else doc["names"][name],
                "cls": doc["classes"][cls], "w": w, "points": points[:, [0, 2, 1]].astype(float) / 10}
        if "z" in way:
            item["z"] = float(way["z"])
        out.append(item)
        at += size
        total += n
    if at != len(raw) or total != doc.get("count", total):
        raise ValueError("roads2: chunk length or point count has trailing/missing data")
    return out


def _need(raw, at, size, what):
    if at + size > len(raw):
        raise ValueError(f"roads2: truncated {what}")


def read_roads2(doc, blob):
    if doc.get("version") != 2 or doc.get("format") != ROADS_FORMAT:
        raise ValueError("roads2: wrong format or version")
    if doc.get("file") != "roads2.bin.gz":
        return _read_roads0(doc, blob)
    raw = bytes(blob)
    _need(raw, 0, 20, "header")
    magic, n_ways, n_points, ox, oz = struct.unpack_from("<4sIIff", raw)
    if magic != b"ZGR2" or n_ways != doc.get("nWays", n_ways) or n_points != doc.get("count", n_points):
        raise ValueError("roads2: bad magic or declared counts")
    _need(raw, 20, n_ways * 4, "way indexes")
    cls = np.frombuffer(raw, np.uint8, n_ways, 20)
    w4 = np.frombuffer(raw, np.uint8, n_ways, 20 + n_ways)
    counts = np.frombuffer(raw, "<u2", n_ways, 20 + 2 * n_ways)
    if int(counts.sum(dtype=np.uint64)) != n_points:
        raise ValueError("roads2: way point count total differs from nPts")
    at, out = 20 + 4 * n_ways, []
    offset = 0
    for i, n_value in enumerate(counts):
        n = int(n_value)
        _need(raw, at, 4, "first point")
        x, z = struct.unpack_from("<hh", raw, at)
        at += 4
        if x == -32768 or z == -32768:
            _need(raw, at, 8, "absolute first pair")
            x, z = struct.unpack_from("<ff", raw, at)
            at += 8
        else:
            x, z = _f32(ox + x * 1.6), _f32(oz + z * 1.6)
        points = [(_f32(x), 0.0, _f32(z))]
        for _ in range(1, n):
            _need(raw, at, 4, "point delta")
            dx, dz = struct.unpack_from("<hh", raw, at)
            at += 4
            if dx == -32768 or dz == -32768:
                _need(raw, at, 8, "absolute delta pair")
                x, z = struct.unpack_from("<ff", raw, at)
                at += 8
            else:
                x, z = _f32(points[-1][0] + np.float32(dx / 10)), _f32(points[-1][2] + np.float32(dz / 10))
            points.append((_f32(x), 0.0, _f32(z)))
        class_index = int(cls[i])
        if class_index >= len(doc["classes"]):
            raise ValueError("roads2: class index outside its table")
        cls_name = doc["classes"][class_index]
        width = float(doc.get("classWidths", {}).get(cls_name, int(w4[i]) / 4))
        out.append({"id": i, "name": -1, "cls": cls_name, "w": width,
                    "points": np.asarray(points, dtype="<f4")})
        offset += n
    if at != len(raw) or offset != n_points:
        raise ValueError("roads2: trailing bytes or point count mismatch")
    return out


def write_roads2(out, ways, points_xyz, classes, names=(), metadata=None):
    doc, blob = pack_roads2(ways, points_xyz, classes, names)
    if metadata:
        doc.update(metadata)
    out = Path(out)
    io._write(out / doc["file"], gzip.compress(blob, 6, mtime=0))
    return doc


def pack_veg2(points_xyz, *, scale, width, year, kind="trees", species=(), species_names=(), mask=None, meta=None):
    """Sorted half-metre xz cells and u8 species/display-height/radius records.

    OSM supplies no measured species, crown dimensions or observation year here. Unknown species is 255;
    height/radius quantize the existing display scale and are documented as visual properties. y comes from terrain.
    """
    rows = np.asarray(points_xyz, dtype=np.float64)
    n = len(rows)
    if (rows.ndim != 2 or rows.shape[1] != 3 or not np.isfinite(rows).all()
            or not all(len(v) == n for v in [scale, width, year, species])):
        raise ValueError("veg2: item metadata and coordinates differ in length")
    if kind not in {"trees", "bushes", "grass"} or not n:
        raise ValueError("veg2: empty stream or unknown kind")
    cells = np.rint(rows[:, [0, 2]] * 2).astype(np.int64)
    if np.any(np.abs(cells) > I32_MAX):
        raise ValueError("veg2: half-metre cell outside int32")
    names = list(species_names)
    species_codes = []
    for value in species:
        code = _optional_name(names, value)
        species_codes.append(255 if code == -1 else code)
        if species_codes[-1] > 255:
            raise ValueError("veg2: species table exceeds its u8 index")
    heights, radii = [], []
    for s, w in zip(scale, width, strict=True):
        scale_value = float(s)
        if not math.isfinite(scale_value) or scale_value <= 0 or not math.isclose(float(w), scale_value * 11.8, abs_tol=0.1):
            raise ValueError("veg2: scale is not finite and consistent with the shader's width")
        heights.append(round(17.2 * scale_value / 0.25))
        radii.append(round(5.9 * scale_value / 0.25))
        if not 0 < heights[-1] <= 255 or not 0 < radii[-1] <= 255:
            raise ValueError("veg2: billboard height/radius exceeds its u8 quarter-metre value")
    order = np.lexsort((np.arange(n), cells[:, 1], cells[:, 0]))
    out = bytearray(struct.pack("<4sI", b"ZGV2", n))
    previous = None
    for source in order:
        x, z = map(int, cells[source])
        attrs = (species_codes[source], heights[source], radii[source])
        if previous is None:
            out += struct.pack("<iiBBB", x, z, *attrs)
        else:
            dx, dz = x - previous[0], z - previous[1]
            if -32767 <= dx <= 32767 and -32767 <= dz <= 32767:
                out += struct.pack("<hhBBB", dx, dz, *attrs)
            else:
                out += struct.pack("<hhiiBBB", -32768, -32768, x, z, *attrs)
        previous = (x, z)
    doc = {**(meta or {}), "version": 2, "format": VEG_FORMAT, "file": "veg2.bin.gz",
           "encoding": "ZGV2/sorted-half-metre-xz-cells/u8-species-height-radius",
           "kind": kind, "speciesNames": names, "count": n, "metresPerScale": 11.8,
           "height_m": 17.2, "radius_m": 5.9, "size_quantum_m": 0.25, "species_unknown": 255,
           "scale": "quantized-display-scale-not-measurement", "year_unknown": 0}
    if mask is not None:
        doc["green"] = {**doc.get("green", {}), "mask": mask}
    return doc, bytes(out)


def _read_veg0(doc, raw):
    n = whole(doc.get("count"), maximum=0xFFFFFFFF)
    if len(raw) != n * VEG18.size or len(raw) % VEG18.size:
        raise ValueError("veg2: chunk length is not exactly count * 18")
    species, names = doc.get("speciesByItem", []), doc.get("speciesNames", [])
    if len(species) != n:
        raise ValueError("veg2: species indexes differ in length")
    out = []
    for i, values in enumerate(struct.iter_unpack(VEG18.format, raw)):
        x, z, y, scale, year = values
        name = _optional_name(names, species[i])
        out.append({"xyz": (x / 10, y / 10, z / 10), "width": scale * doc["metresPerScale"],
                    "scale": scale, "year": year, "kind": doc["kind"],
                    "species": -1 if name == -1 else names[name]})
    return out


def read_veg2(doc, blob, *, ground=None):
    if doc.get("version") != 2 or doc.get("format") != VEG_FORMAT:
        raise ValueError("veg2: wrong format or version")
    if doc.get("file") != "veg2.bin.gz":
        return _read_veg0(doc, bytes(blob))
    if ground is None:
        raise TypeError("veg2: terrain ground sampler is required; this format has no absolute y")
    raw = bytes(blob)
    if len(raw) < 8:
        raise ValueError("veg2: truncated header")
    magic, n = struct.unpack_from("<4sI", raw)
    if magic != b"ZGV2" or n != whole(doc.get("count", n), maximum=0xFFFFFFFF):
        raise ValueError("veg2: bad magic or item count")
    at, cells, attrs_all, previous = 8, [], [], None
    names = doc.get("speciesNames", [])
    for i in range(n):
        size = 11 if i == 0 else 7
        if at + size > len(raw):
            raise ValueError("veg2: truncated coordinate/attribute record")
        x, z = struct.unpack_from("<ii" if i == 0 else "<hh", raw, at)
        if i == 0:
            attrs_at = at + 8
        elif x == -32768 or z == -32768:
            if at + 15 > len(raw):
                raise ValueError("veg2: truncated absolute cell escape")
            x, z = struct.unpack_from("<ii", raw, at + 4)
            attrs_at = at + 12
        else:
            x, z = previous[0] + x, previous[1] + z
            attrs_at = at + 4
        attrs = struct.unpack_from("<BBB", raw, attrs_at)
        at = attrs_at + 3
        if previous is not None and (x, z) < previous:
            raise ValueError("veg2: cells are not sorted")
        cells.append((x, z))
        attrs_all.append(attrs)
        previous = (x, z)
    if at != len(raw):
        raise ValueError("veg2: trailing bytes")
    xz = np.asarray(cells, dtype=np.float64) / 2
    ys = np.asarray(ground(xz[:, 0], xz[:, 1]), dtype=np.float64)
    if ys.ndim == 0:
        ys = np.full(n, float(ys))
    if ys.shape != (n,) or not np.isfinite(ys).all():
        raise ValueError("veg2: terrain sampler returned invalid ground heights")
    out = []
    for i, ((x, z), (sp, height, radius)) in enumerate(zip(cells, attrs_all, strict=True)):
        code = 255 if sp == 255 else _optional_name(names, sp)
        scale = height * doc.get("size_quantum_m", 0.25) / doc.get("height_m", 17.2)
        out.append({"xyz": (x / 2, float(ys[i]), z / 2), "width": scale * doc["metresPerScale"],
                    "scale": scale, "height": height * doc.get("size_quantum_m", 0.25),
                    "radius": radius * doc.get("size_quantum_m", 0.25), "year": 0, "kind": doc["kind"],
                    "species": -1 if code == 255 else names[code]})
    return out


def write_veg2(out, points_xyz, **kwargs):
    doc, blob = pack_veg2(points_xyz, **kwargs)
    out = Path(out)
    io._write(out / doc["file"], gzip.compress(blob, 6, mtime=0))
    return doc


def slope_code(value) -> int:
    """Milli-degrees for the legacy annotation codecs; 65535 means unavailable.

    Gentle real slopes below 1.001 degrees are not errors. The display already caps slope at 45 degrees, so
    larger legitimate terrain angles saturate instead of aborting an RGB build. Missing/non-finite samples are
    explicitly marked unavailable, never turned into a measurement.
    """
    if isinstance(value, (bool, np.bool_)):
        return 65535
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 65535
    if not math.isfinite(number) or number < 0:
        return 65535
    return min(45000, max(0, round(number * 1000)))


def pack_hdr18(rows):
    if isinstance(rows, dict):
        rows = [rows]
    try:
        return b"".join(HDR18.pack(dm(r["x"]), dm(r["z"]), dm(r["y"]),
                                   *(whole(c, maximum=255) for c in r["rgb"]), whole(r["ortho"], maximum=255),
                                   slope_code(r["slope"]))
                        for r in rows)
    except KeyError as e:
        raise ValueError(f"HDR18: missing {e.args[0]}") from e


def read_hdr18(blob):
    raw = bytes(blob)
    if len(raw) % HDR18.size:
        raise ValueError("HDR18: length is not a whole 18-byte record")
    out = []
    for x, z, y, r, g, b, ortho, slope in HDR18.iter_unpack(raw):
        if slope != 65535 and slope > 45000:
            raise ValueError("HDR18: slope outside its display bounds")
        out.append({"x": x / 10, "z": z / 10, "y": y / 10,
                    "r": r, "g": g, "b": b, "ortho": ortho, "slope": None if slope == 65535 else slope / 1000})
    return out


def pack_utf16(rows):
    return b"".join(struct.pack("<HH", u16(ortho), slope_code(slope)) for ortho, slope in rows)


def read_utf16(blob):
    raw = bytes(blob)
    if len(raw) % 4:
        raise ValueError("UTF16: length is not a whole ortho/slope pair")
    out = []
    for ortho, slope in struct.iter_unpack("<HH", raw):
        if slope != 65535 and slope > 45000:
            raise ValueError("UTF16: slope outside its display bounds")
        out.append((ortho, None if slope == 65535 else slope / 1000))
    return out


def write_compact_config(out, key, file):
    """Name only bytes written by this version. Config schemas predate v2 fall back to their old files."""
    out = Path(out)
    cfg_path = out / "zagreb.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if isinstance(file, dict):
        filename = file.get("file")
        if not isinstance(filename, str) or Path(filename).name != filename or filename in {"", ".", ".."}:
            raise ValueError("compact data file must be a plain sibling file name")
        if not (out / filename).is_file():
            raise ValueError(f"compact data config names a missing file: {filename}")
    elif isinstance(file, bool):
        pass  # Ortho gzip is a config flag, not a sidecar document.
    elif isinstance(file, str) and Path(file).name == file and file not in {"", ".", ".."}:
        if not (out / file).is_file():
            raise ValueError(f"compact data config names a missing file: {file}")
    else:
        raise ValueError("compact data value must be a metadata document, flag or sibling filename")
    cfg[key] = file
    io.write_json(cfg_path, cfg)
    return cfg
