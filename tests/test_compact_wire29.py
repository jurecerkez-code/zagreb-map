"""Issue #29's published binary formats, with one independent fixture for Python and JS."""
import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import compact, s06_zagreb_ortho as s06

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "compact-wire.json").read_text())
ROAD_CLASSES = ["residential", "service"]


def road_doc():
    return {"format": compact.ROADS_FORMAT, "version": 2, "file": "roads2.bin.gz",
            "classes": ROAD_CLASSES, "origin": [0, 0]}


def road_ways():
    return [{"id": 1, "name": None, "cls": "residential", "w": 1.5},
            {"id": 2, "name": None, "cls": "service", "w": 2.25}]


def road_points():
    return [np.array([[0, 999, 0], [0.1, 999, -0.1]], dtype="<f4"),
            np.array([[0.03, 999, -0.07], [1000, 999, 1000]], dtype="<f4")]


def veg_doc():
    return {"format": compact.VEG_FORMAT, "version": 2, "file": "veg2.bin.gz",
            "height_m": 17.2, "radius_m": 5.9, "size_quantum_m": 0.25}


def test_roads2_exact_shared_little_endian_fixture():
    pts = road_points()
    doc, written = compact.pack_roads2(road_ways(), pts, classes=ROAD_CLASSES)
    assert written.hex() == FIXTURE["zgr2_hex"]
    got = compact.read_roads2(doc, written)
    for i, points in enumerate(got):
        expected = pts[i][:, [0, 2]]
        assert np.array_equal(points["points"][:, [0, 2]], expected)  # exact escapes, no tolerance


def test_nonquarter_legacy_class_width_is_preserved_without_changing_the_measurement():
    xyz = np.array([[[0, 999, 0]]], dtype='<f4')
    doc, raw = compact.pack_roads2([{'id': 1, 'name': None, 'cls': 'footway', 'w': 1.8}], [xyz[0]], ['footway'])
    assert raw[21] == 7  # nearest quarter metre in the required w4 byte (1.75 m)
    assert doc['classWidths'] == {'footway': 1.8}
    assert compact.read_roads2(doc, raw)[0]['w'] == 1.8


def test_roads2_rejects_bad_count_and_truncated_escape():
    doc, raw = compact.pack_roads2(road_ways(), road_points(), classes=ROAD_CLASSES)
    bad = bytearray(raw)
    bad[24:26] = (3).to_bytes(2, "little")
    with pytest.raises(ValueError, match="point count"):
        compact.read_roads2(doc, bad)
    raw_truncated = raw[:43]
    raw_truncated = raw_truncated[:8] + (3).to_bytes(4, "little") + raw_truncated[12:]
    raw_truncated = raw_truncated[:26] + (1).to_bytes(2, "little") + raw_truncated[28:]
    with pytest.raises(ValueError, match="absolute"):
        compact.read_roads2({**doc, 'count': 3}, raw_truncated)


def test_veg2_exact_sorted_records_and_ground_sampling():
    # Input order is deliberately not sorted. Display height/radius follow their original tree, not its sorted index.
    rows = np.array([[1.1, 90, 2.2], [0.2, 80, 0.1]], dtype=np.float64)
    scales = [0.88 + i * 0.028 for i in range(len(rows))]
    doc, written = compact.pack_veg2(rows, scale=scales, width=np.asarray(scales) * 11.8,
                                     year=[0] * len(rows), species=[-1] * len(rows), meta=veg_doc())
    assert written.hex() == FIXTURE["zgv2_hex"]
    decoded = compact.read_veg2(doc, written, ground=lambda x, z: 12.5)
    trees = np.asarray([row["xyz"] for row in decoded], dtype=np.float32)
    scales = np.asarray([row["scale"] for row in decoded])
    assert np.array_equal(trees[:, 0], np.array([0, 1], dtype=np.float32))
    assert np.array_equal(trees[:, 2], np.array([0, 2], dtype=np.float32))
    assert np.array_equal(trees[:, 1], np.array([12.5, 12.5], dtype=np.float32))
    assert scales.tolist() == pytest.approx([62 * 0.25 / 17.2, 61 * 0.25 / 17.2])


def test_veg2_requires_terrain_instead_of_accepting_packaged_y():
    doc, raw = compact.pack_veg2([[0, 99, 0]], scale=[0.88], width=[0.88 * 11.8], year=[0], species=[-1], meta=veg_doc())
    with pytest.raises(TypeError, match="terrain"):
        compact.read_veg2(doc, raw)


def test_slope_codec_handles_ordinary_angles_and_marks_unavailable_values():
    for degrees in (0, 0.0001, 0.5, 1.0, 44.9, 45, 46, 70, 89.9):
        encoded = compact.slope_code(degrees)
        assert 0 <= encoded <= 65534
        row = compact.HDR18.pack(0, 0, 0, 1, 2, 3, 1, encoded)
        decoded = compact.read_hdr18(row)[0]["slope"]
        if degrees <= 45:
            assert decoded == pytest.approx(round(degrees * 1000) / 1000)
        else:
            assert decoded == 45
    assert compact.slope_code(None) == 65535
    assert compact.slope_code(float("nan")) == 65535
    unavailable = compact.HDR18.pack(0, 0, 0, 1, 2, 3, 1, 65535)
    assert compact.read_hdr18(unavailable)[0]["slope"] is None
    assert compact.read_utf16(b"\0\0" + (65535).to_bytes(2, "little"))[0][1] is None


def test_ortho_payloads_keep_their_names_and_gain_only_gzip(tmp_path):
    import gzip
    import struct
    roof = np.arange(16, dtype=np.uint8).reshape(2, 2, 4)
    ground = np.arange(12, dtype=np.uint8).reshape(1, 3, 4)
    s06.write_ortho_payloads(tmp_path, roof, ground)
    for name, rgba in [('roof_rgb.bin.gz', roof), ('ground_rgb.bin.gz', ground)]:
        raw = gzip.decompress((tmp_path / name).read_bytes())
        w, h = struct.unpack_from('<II', raw)
        assert (w, h) == (rgba.shape[1], rgba.shape[0])
        assert raw[8:] == rgba.tobytes()
    assert not (tmp_path / 'ground2.json').exists()
    assert not (tmp_path / 'ground0.bin').exists()
