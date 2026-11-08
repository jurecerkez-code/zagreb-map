"""Small stage-level compact writer tests. They exercise real writers on explicit synthetic source rows only."""
import json

import numpy as np
import pytest

from pipeline import compact, s06_zagreb_ortho as s06, s07_zagreb_veg as s07, s17_zagreb_roads as s17
from pipeline import s99_validate


def config(out):
    out.mkdir(exist_ok=True, parents=True)
    (out / "zagreb.json").write_text(json.dumps({"version": "test"}), encoding="utf-8")


def test_roads_writer_keeps_ids_names_widths_and_bulk_terrain_sampling(tmp_path):
    config(tmp_path)
    ways = [{"o": 0, "c": 2, "cls": "residential", "w": 6.5, "id": 4_300_000_000, "name": "Ilica"},
            {"o": 2, "c": 1, "cls": "primary", "w": 10.0, "id": 65, "name": None}]
    points = np.array([[10, -3], [11, -4], [12, -5]], dtype=float)

    def ground(x, z):
        return np.asarray(x) + np.asarray(z)   # same bulk sampler for every way, including the chunk seam

    doc = s17.write_compact(tmp_path, ways, points, ground)
    got = compact.read_roads2(doc, (tmp_path / doc["file"]).read_bytes())
    assert [r["id"] for r in got] == [4_300_000_000, 65]
    assert [r["name"] for r in got] == ["Ilica", -1]
    assert [r["w"] for r in got] == [6.5, 10]
    np.testing.assert_array_equal(got[0]["points"], [[10, 7, -3], [11, 7, -4]])
    np.testing.assert_array_equal(got[1]["points"], [[12, 7, -5]])
    assert json.loads((tmp_path / "zagreb.json").read_text())["roads2"] == "roads2.json"


def test_veg_writer_retains_visual_scale_and_does_not_invent_species_or_observation_year(tmp_path):
    config(tmp_path)
    points = np.array([[10, 3, -2], [11, 4, -3]], dtype=np.float32)
    meta = {"cable": {"points": 2}, "green": {"mask": {"w": 1, "h": 1, "x0": 0, "z0": 0, "cell": 16}},
            "licence": "OpenStreetMap contributors, ODbL"}
    doc = s07.write_compact(tmp_path, points, meta)
    got = compact.read_veg2(doc, (tmp_path / doc["file"]).read_bytes())
    assert [round(r["scale"], 3) for r in got] == [0.88, 1.076]
    assert [r["species"] for r in got] == [-1, -1]
    assert [r["year"] for r in got] == [0, 0]
    assert doc["cable"] == meta["cable"] and doc["green"]["mask"] == meta["green"]["mask"]
    assert doc["year_unknown"] == 0 and "measurement" in doc["scale"]
    assert json.loads((tmp_path / "zagreb.json").read_text())["veg2"] == "veg2.json"


def test_ground_writer_and_release_validator_accept_only_complete_version_files(tmp_path):
    config(tmp_path)
    rgb = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
    grid = {"x0": 0, "z0": -40, "cell": 40, "h": np.array([[10, 12], [11, 13]], dtype=float)}
    slopes = np.array([[0, 0], [12.345, 0]])
    doc = s06.write_ground_compact(tmp_path, rgb, grid, slopes)
    rows = compact.read_hdr18((tmp_path / doc["file"]).read_bytes())
    assert len(rows) == doc["count"] == 4
    assert rows[2] == pytest.approx(dict(x=0, z=0, y=11, r=6, g=7, b=8, ortho=1, slope=12.345))
    cfg = compact.write_compact_config(tmp_path, "ground2", "ground2.json")
    assert s99_validate.check_compact(tmp_path, cfg) == []
    (tmp_path / "ground0.bin").write_bytes((tmp_path / "ground0.bin").read_bytes()[:-1])
    assert any("ground2" in e and "length" in e for e in s99_validate.check_compact(tmp_path, cfg))
    assert s99_validate.check_compact(tmp_path, {"version": "old"}) == []
