"""Little-endian, bounded Zagreb data v2 codecs (#29B).

All coordinates and y values are INTEGER decimetres at write time.  Do not use ``astype(int)``: it truncates.
Every binary reader checks its complete input length; there is no untrusted variable-length seek or JSON point array.
HDR18 is local x/z/y in integer dm, u8 RGB, an 8-bit source palette index and u16 slope in milli-degrees
(0 = level/unknown; otherwise 1001..45000). Per-record sample width belongs in its file's grid metadata, not in
an invented 23-byte record called 18. No measurement is inferred for absent data.
"""
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


def pack_roads2(ways, points_xyz, classes, names=()):
    """ways + one (x,y,z) array per way -> (index, LE u32 count then N*(i32 x,z,y dm)).

    Source osm_id survives whole, never an unsigned-16 slot. cls is an integer table index, width integer dm,
    names are interned (-1 = none), and geometry is one chunk, never a JSON list of coordinates.
    """
    if len(ways) != len(points_xyz):
        raise ValueError("roads: ways and point arrays differ in length")
    out, records, offset = bytearray(), [], 0
    for way, points in zip(ways, points_xyz, strict=True):
        p = np.asarray(points)
        if p.ndim != 2 or p.shape[1] != 3 or not len(p):
            raise ValueError("roads: every way needs a non-empty Nx3 point array")
        if len(p) > 0xFFFFFFFF:
            raise ValueError("roads: point count exceeds uint32")
        integers = np.array([[dm(x), dm(z), dm(y)] for x, y, z in p], dtype="<i4")
        name = None if way.get("name") is None else _optional_name(names, way.get("name", -1))
        cls = whole(classes.index(way["cls"]), maximum=len(classes) - 1)
        record = {"id": whole(way["id"]), "name": -1 if name is None else name, "cls": cls,
                  "w": width_dm(way["w"]), "n": len(p)}
        if "z" in way:
            record["z"] = float(way["z"])
        out += struct.pack("<I", len(p)) + integers.tobytes()
        records.append(record)
        offset += len(p)
    doc = {"version": 2, "format": ROADS_FORMAT, "file": "roads0.bin", "encoding": "u32-n + n*<i32 xdm zdm ydm>",
           "classes": list(classes), "names": list(names), "ways": records, "count": offset}
    return doc, bytes(out)


def read_roads2(doc, blob):
    if doc.get("version") != 2 or doc.get("format") != ROADS_FORMAT:
        raise ValueError("roads2: wrong format or version")
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


def write_roads2(out, ways, points_xyz, classes, names=(), metadata=None):
    doc, blob = pack_roads2(ways, points_xyz, classes, names)
    if metadata:
        doc.update(metadata)
    out = Path(out)
    io._write(out / "roads0.bin", blob)
    io.write_json(out / "roads2.json", doc)
    return doc


def pack_veg2(points_xyz, *, scale, width, year, kind="trees", species=(), species_names=(), mask=None, meta=None):
    """Flat vegetation records: i32 x/z/y dm, f32 display scale, u16 year (0 is unknown).

    This viewer's billboard width is scale * 11.8 m (web/veg.js), not a tree measurement. It lives once in
    the document, not a fourth per-record integer that would overrun the specified 18-byte layout.
    """
    n = len(points_xyz)
    if not all(len(v) == n for v in [scale, width, year, species]):
        raise ValueError("veg2: item metadata and coordinates differ in length")
    if kind not in {"trees", "bushes", "grass"}:
        raise ValueError("veg2: unknown kind")
    blob = bytearray()
    for p, s, w, y, sp in zip(points_xyz, scale, width, year, species, strict=True):
        if len(p) != 3:
            raise ValueError("veg2: item is not xyz")
        x, h, z = p
        _optional_name(species_names, sp)
        try:
            scale_value = float(s)
        except (TypeError, ValueError) as e:
            raise ValueError("veg2: scale is not a finite number") from e
        if not math.isfinite(scale_value) or scale_value <= 0:
            raise ValueError("veg2: scale is not finite and positive")
        if not math.isclose(float(w), scale_value * 11.8, abs_tol=0.1):
            raise ValueError("veg2: width is not the shader's scale * 11.8 m")
        blob += VEG18.pack(dm(x), dm(z), dm(h), float(s), u16(y))
    doc = {**(meta or {}), "version": 2, "format": VEG_FORMAT, "file": "veg0.bin",
           "encoding": "n*<i32 xdm zdm ydm, f32 scale, u16 year>", "kind": kind,
           "speciesByItem": [int(v) for v in species], "speciesNames": list(species_names), "count": n,
           "metresPerScale": 11.8, "scale": "display-scale-not-measurement", "year_unknown": 0}
    if mask is not None:
        doc["green"] = {**doc.get("green", {}), "mask": mask}
    return doc, bytes(blob)


def read_veg2(doc, blob):
    if doc.get("version") != 2 or doc.get("format") != VEG_FORMAT:
        raise ValueError("veg2: wrong format or version")
    raw = bytes(blob)
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
                    "scale": scale, "year": year,
                    "kind": doc["kind"], "species": -1 if name == -1 else names[name]})
    return out


def write_veg2(out, points_xyz, **kwargs):
    doc, blob = pack_veg2(points_xyz, **kwargs)
    out = Path(out)
    io._write(out / "veg0.bin", blob)
    io.write_json(out / "veg2.json", doc)
    return doc


def slope_code(value) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError("slope is not a finite number")
    if not math.isfinite(value) or not 0 <= value <= 45000:
        raise ValueError("slope is outside 0 or 1.001..45000 degrees")
    milli = 0 if value == 0 else round(float(value) * 1000)
    if milli and not 1001 <= milli <= 45000:
        raise ValueError("slope is below the 0.001-to-45-degree display clamp")
    return milli


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
        if slope and not 1001 <= slope <= 45000:
            raise ValueError("HDR18: slope outside its display bounds")
        out.append({"x": x / 10, "z": z / 10, "y": y / 10,
                    "r": r, "g": g, "b": b, "ortho": ortho, "slope": slope / 1000})
    return out


def pack_utf16(rows):
    return b"".join(struct.pack("<HH", u16(ortho), slope_code(slope)) for ortho, slope in rows)


def read_utf16(blob):
    raw = bytes(blob)
    if len(raw) % 4:
        raise ValueError("UTF16: length is not a whole ortho/slope pair")
    out = []
    for ortho, slope in struct.iter_unpack("<HH", raw):
        if slope and not 1001 <= slope <= 45000:
            raise ValueError("UTF16: slope outside its display bounds")
        out.append((ortho, slope / 1000))
    return out


def write_compact_config(out, key, file):
    """Name only bytes written by this version. Config schemas predate v2 fall back to their old files."""
    out = Path(out)
    cfg_path = out / "zagreb.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if not isinstance(file, str) or Path(file).name != file or file in {"", ".", ".."}:
        raise ValueError("compact data file must be a plain sibling file name")
    if not (out / file).is_file():
        raise ValueError(f"compact data config names a missing file: {file}")
    cfg[key] = file
    io.write_json(cfg_path, cfg)
    return cfg
