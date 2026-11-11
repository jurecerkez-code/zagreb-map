"""Python port of the worker's tile parser, for tests and s99_validate.

Mirrors `parse()` in web/tile.js (upstream kept it in web/worker.js): every section starts on a 4-byte boundary.
"""
import struct

import numpy as np

MAGIC = 0x31484648  # 'HFH1' read as a little-endian u32
MAGIC2 = 0x32484648  # 'HFH2': v1 plus each building's own roof triangles (issue #32)
HEADER = struct.Struct("<5I2f")  # magic, nB, nP, nR, nV, originX, originZ (28 bytes)


def parse(buf: bytes | memoryview, offset: int = 0) -> dict:
    """Decode one tile starting at `offset`. Arrays are read-only views into `buf`."""
    magic, nB, nP, nR, nV, ox, oz = HEADER.unpack_from(buf, offset)
    if magic not in (MAGIC, MAGIC2):
        raise ValueError(f"bad tile magic {magic:#010x} at offset {offset}")
    o = offset + HEADER.size

    def take(dtype: str, n: int) -> np.ndarray:
        nonlocal o
        dt = np.dtype(dtype)
        a = np.frombuffer(buf, dtype=dt, count=n, offset=o)
        o += -(-n * dt.itemsize // 4) * 4
        return a

    t = {"nB": nB, "nP": nP, "nR": nR, "nV": nV, "origin": (ox, oz)}
    t["gid"] = take("<u4", nB)
    t["year"] = take("<i2", nB)
    t["yflag"] = take("u1", nB)
    t["period"] = take("u1", nB)
    t["floors"] = take("u1", nB)
    t["ground"] = take("<i2", nB)
    t["lay0"] = take("<u4", nB)
    t["lay1"] = take("<u4", nB)
    t["partStart"] = take("<u4", nB + 1)
    t["height"] = take("<f4", nP)
    t["ringStart"] = take("<u4", nP + 1)
    t["vertStart"] = take("<u4", nR + 1)
    t["hole"] = take("u1", nR)
    t["xz"] = take("<i2", 2 * nV).reshape(-1, 2)
    t["v"] = 2 if magic == MAGIC2 else 1
    if t["v"] == 2:
        t["roofStart"] = take("<u4", nB + 1)
        base = o
        if t["roofStart"][0] != 0 or t["roofStart"][-1] > len(buf) - base:
            raise ValueError("roofStart is not a section starting at 0 and ending inside the tile")
        if np.any(np.diff(t["roofStart"]) < 4):
            raise ValueError("roofStart does not advance by at least one u32")
        roofs = []
        for b in range(nB):
            at = base + int(t["roofStart"][b])
            nRV = struct.unpack_from("<I", buf, at)[0]
            if not nRV:
                roofs.append(None)
                continue
            p = at + 4
            if p + 6 * nRV + 4 > len(buf):
                raise ValueError(f"building {b}: roof vertices are truncated")
            rxz = np.frombuffer(buf, "<i2", 2 * nRV, p).reshape(-1, 2)
            p += 4 * nRV
            ry = np.frombuffer(buf, "<u2", nRV, p)
            p = (p + 2 * nRV + 3) & ~3
            nRT = struct.unpack_from("<I", buf, p)[0]
            p += 4
            if p + 6 * nRT > len(buf):
                raise ValueError(f"building {b}: roof triangles are truncated")
            rtri = np.frombuffer(buf, "<u2", 3 * nRT, p).reshape(-1, 3)
            if len(rtri) and int(rtri.max()) >= nRV:
                raise ValueError(f"building {b}: a roof triangle points outside its vertices")
            roofs.append({"xz": rxz, "y": ry, "tri": rtri})
        t["roofs"] = roofs
        o = base + int(t["roofStart"][nB])
    t["end"] = o
    return t


def rings(t: dict, b: int) -> list[tuple[np.ndarray, int]]:
    """Rings of building index `b` (not gid) in local metres (x east, z south), with their hole flag: every part's."""
    out = []
    ox, oz = t["origin"]
    for p in range(t["partStart"][b], t["partStart"][b + 1]):
        for r in range(t["ringStart"][p], t["ringStart"][p + 1]):
            s, e = t["vertStart"][r], t["vertStart"][r + 1]
            xz = t["xz"][s:e].astype(np.float64) / 10.0 + (ox, oz)
            out.append((xz, int(t["hole"][r])))
    return out


def parts(t: dict, b: int) -> list[tuple[float, list[tuple[np.ndarray, int]]]]:
    """(height in metres, rings in local metres with their hole flag) for each part of building index `b`: the
    footprint first, then any laser tower parts (s03_tiles.tower_parts)."""
    out = []
    ox, oz = t["origin"]
    for p in range(t["partStart"][b], t["partStart"][b + 1]):
        rs = []
        for r in range(t["ringStart"][p], t["ringStart"][p + 1]):
            s, e = t["vertStart"][r], t["vertStart"][r + 1]
            rs.append((t["xz"][s:e].astype(np.float64) / 10.0 + (ox, oz), int(t["hole"][r])))
        out.append((float(t["height"][p]), rs))
    return out
