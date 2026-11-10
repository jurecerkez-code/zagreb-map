"""The compact Zagreb data contract. Synthetic fixtures: no city measurements or fabricated build output."""
import math
import struct

import numpy as np
import pytest

from pipeline import compact


def test_decimetres_are_le_int32_and_reject_bad_values():
    assert compact.dm(12.34) == 123
    assert compact.dm(-0.06) == -1       # error < 0.1 m, not truncation of a legacy float
    assert compact.legacy_error([10.0, -0.06], [100, -1]) == pytest.approx(0.04)
    for value in [True, None, "1", math.nan, math.inf, 214748364.8, -214748364.9]:
        with pytest.raises(ValueError):
            compact.dm(value)
    for value in [True, -1, 1.5, math.nan, 65536]:
        with pytest.raises(ValueError):
            compact.u16(value)
    assert compact.u16(0) == 0
    assert compact.u16(65535) == 65535


def test_legacy_roads0_reader_keeps_way_identity_and_dm_decoding(tmp_path):
    ways = [{"id": 4_300_000_000, "name": 0, "cls": 1, "w": 65, "n": 2},
            {"id": 65, "name": -1, "cls": 0, "w": 100, "n": 1}]
    doc = {"version": 2, "format": "zagreb-roads2", "file": "roads0.bin", "classes": ["primary", "residential"],
           "names": ["Ilica"], "ways": ways, "count": 3}
    blob = (struct.pack("<I3i3i", 2, 100, -30, 20, 101, -29, 21)
            + struct.pack("<I3i", 1, 110, -31, 30))
    got = compact.read_roads2(doc, blob)
    assert got[0]["id"] == 4_300_000_000 and got[0]["name"] == "Ilica"
    assert got[0]["cls"] == "residential" and got[0]["w"] == 6.5
    assert got[1]["name"] == -1
    np.testing.assert_array_equal(got[0]["points"], [[10, 2, -3], [10.1, 2.1, -2.9]])
    with pytest.raises(ValueError, match="length|aligned"):
        compact.read_roads2(doc, blob[:-1])


def test_legacy_veg0_reader_retains_source_metadata(tmp_path):
    xyz = np.array([[1000.25, 17.8, -50.0], [1001.0, 18.0, -49.75]])
    blob = b"".join(compact.VEG18.pack(compact.dm(x), compact.dm(z), compact.dm(h), s, y)
                    for (x, h, z), s, y in zip(xyz, [0.88, 1.0], [0, 2024]))
    doc = {"version": 2, "format": "zagreb-veg2", "file": "veg0.bin", "kind": "trees", "count": 2,
           "speciesByItem": [-1, 2], "speciesNames": ["", "", "Quercus robur"], "metresPerScale": 11.8}
    got = compact.read_veg2(doc, blob)
    assert got[0]["kind"] == "trees" and got[0]["year"] == 0
    assert got[0]["scale"] == pytest.approx(np.float32(0.88))
    assert got[0]["width"] == pytest.approx(float(np.float32(0.88)) * 11.8)
    assert got[1]["species"] == "Quercus robur" and got[1]["year"] == 2024
    with pytest.raises(ValueError, match="length"):
        compact.read_veg2(doc, blob + b"x")


def test_hdr18_and_utf16_are_explicit_little_endian_and_bounded():
    # Local x, z, y, all dm; sampled RGB; source ortho index and slope milli-degrees.
    row = dict(x=1.2, z=-2.3, y=13.4, rgb=[1, 2, 3], ortho=1, slope=12.345)
    blob = compact.pack_hdr18([row])
    assert len(blob) == 18
    assert struct.unpack("<3i3BBH", blob) == (12, -23, 134, 1, 2, 3, 1, 12345)
    got = compact.read_hdr18(blob)
    assert got[0] == pytest.approx(dict(x=1.2, z=-2.3, y=13.4, r=1, g=2, b=3,
                                         ortho=1, slope=12.345))
    binary = compact.pack_utf16([(1, 0), (1, 12.346), (0, 45.0)])
    assert len(binary) == 12
    assert compact.read_utf16(binary) == [(1, 0.0), (1, 12.346), (0, 45.0)]
    assert compact.read_utf16(compact.pack_utf16([(0, 0.1)])) == [(0, 0.1)]
    assert compact.read_utf16(compact.pack_utf16([(0, 45000.1)])) == [(0, 45)]
    assert compact.read_utf16(compact.pack_utf16([(0, float("nan"))])) == [(0, None)]
    for codec, value in [(compact.read_hdr18, b"x" * 17), (compact.read_utf16, b"x" * 3)]:
        with pytest.raises(ValueError, match="length"):
            codec(value)
