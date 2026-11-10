import numpy as np
import pytest
from shapely.geometry import Polygon

from pipeline import city, codes, s03_tiles, tiles_decode
from tests.tinycity import local_box


def gable_roof(box, eave=0.0, ridge=4.0):
    """A 10 x 10 m gable: four roof corners at the eaves and a ridge along the north-south axis."""
    x0, y0, x1, y1 = box.bounds
    mx = (x0 + x1) / 2
    return {
        "xz": np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [mx, y0], [mx, y1]], np.float64),
        "y": np.array([eave, eave, eave, eave, ridge, ridge], np.float64),
        "tri": np.array([[0, 4, 3], [3, 4, 5], [1, 4, 2], [2, 4, 5]], np.int64),
    }


def row(gid, geometry, roof=None, height=0.5):
    return {"gid": gid, "year": 1900, "yflag": codes.EXACT, "period": 1, "floors": 2, "ground_dm": 0,
            "height": height, "geometry": geometry, **({"roof": roof} if roof is not None else {})}


def test_v2_round_trip_keeps_the_v1_sections_and_the_roof():
    box = local_box(0, 0, 10, 10)
    buf = s03_tiles.pack_tile((0.0, 0.0), [row(7, box, gable_roof(box))])
    t = tiles_decode.parse(buf)
    assert t["v"] == 2 and tiles_decode.MAGIC2.to_bytes(4, "little") == b"HFH2"
    assert t["end"] == len(buf) and len(buf) % 4 == 0
    assert t["gid"].tolist() == [7]
    assert t["roofStart"].tolist() == [0, 68]
    r = t["roofs"][0]
    assert r["xz"].shape == (6, 2) and r["y"].shape == (6,) and r["tri"].shape == (4, 3)
    assert r["y"].tolist() == [0, 0, 0, 0, 40, 40]
    assert r["tri"].tolist() == [[0, 4, 3], [3, 4, 5], [1, 4, 2], [2, 4, 5]]


def test_v2_marks_a_building_without_a_roof_with_a_zero_block():
    box = local_box(0, 0, 10, 10)
    buf = s03_tiles.pack_tile((0.0, 0.0), [row(7, box, gable_roof(box)), row(8, local_box(20, 0, 30, 10))])
    t = tiles_decode.parse(buf)
    assert t["roofStart"].tolist() == [0, 68, 72]
    assert t["roofs"][0] is not None and t["roofs"][1] is None


def test_v1_tiles_stay_v1_when_no_row_has_a_roof():
    box = local_box(0, 0, 10, 10)
    t = tiles_decode.parse(s03_tiles.pack_tile((0.0, 0.0), [row(7, box)]))
    assert t["v"] == 1 and "roofs" not in t


def test_v2_roof_vertices_outside_i16_are_refused():
    box = local_box(0, 0, 10, 10)
    roof = gable_roof(box)
    roof["xz"] = roof["xz"] + 4000.0
    with pytest.raises(ValueError, match="roof vertex"):
        s03_tiles.pack_tile((0.0, 0.0), [row(7, box, roof)])


def test_v2_roof_above_u16_decimetres_is_refused():
    box = local_box(0, 0, 10, 10)
    roof = gable_roof(box)
    roof["y"][:] = 7000.0
    with pytest.raises(ValueError, match="above the ground"):
        s03_tiles.pack_tile((0.0, 0.0), [row(7, box, roof)])


def test_v2_roof_triangle_outside_its_vertices_is_refused():
    box = local_box(0, 0, 10, 10)
    roof = gable_roof(box)
    roof["tri"][0, 0] = 9
    with pytest.raises(ValueError, match="outside"):
        s03_tiles.pack_tile((0.0, 0.0), [row(7, box, roof)])


def test_v2_roof_origin_is_the_tile_origin():
    box = local_box(100, 200, 110, 210)
    t = tiles_decode.parse(s03_tiles.pack_tile((100.0, 200.0), [row(7, box, gable_roof(box))]))
    # Decimetres from the tile origin: the box starts at (0, 0), not at city coordinates.
    assert t["roofs"][0]["xz"].min() == 0 and t["roofs"][0]["xz"].max() == 100
