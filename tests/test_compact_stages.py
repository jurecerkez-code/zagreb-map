"""Small stage-level compact writer tests. They exercise real writers on explicit synthetic source rows only."""
import gzip
import json

import numpy as np
import pytest

from pipeline import compact, s06_zagreb_ortho as s06, s07_zagreb_veg as s07, s17_zagreb_roads as s17
from pipeline import s99_validate, terrain


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
    got = compact.read_roads2(doc, gzip.decompress((tmp_path / doc["file"]).read_bytes()))
    assert [r["cls"] for r in got] == ["residential", "primary"]
    assert [r["w"] for r in got] == [6.5, 10]
    np.testing.assert_array_equal(got[0]["points"], [[10, 0, -3], [11, 0, -4]])
    np.testing.assert_array_equal(got[1]["points"], [[12, 0, -5]])
    assert json.loads((tmp_path / "zagreb.json").read_text())["roads2"]["file"] == "roads2.bin.gz"


def test_veg_writer_retains_visual_scale_and_does_not_invent_species_or_observation_year(tmp_path):
    config(tmp_path)
    points = np.array([[10, 3, -2], [11, 4, -3]], dtype=np.float32)
    meta = {"cable": {"points": 2}, "green": {"mask": {"w": 1, "h": 1, "x0": 0, "z0": 0, "cell": 16}},
            "licence": "OpenStreetMap contributors, ODbL"}
    doc = s07.write_compact(tmp_path, points, meta)
    got = compact.read_veg2(doc, gzip.decompress((tmp_path / doc["file"]).read_bytes()),
                                ground=lambda x, z: 99)
    assert [round(r["scale"], 3) for r in got] == [0.887, 1.076]
    assert [r["xyz"][1] for r in got] == [99, 99]
    assert [r["species"] for r in got] == [-1, -1]
    assert [r["year"] for r in got] == [0, 0]
    assert doc["cable"] == meta["cable"] and doc["green"]["mask"] == meta["green"]["mask"]
    assert doc["year_unknown"] == 0 and "measurement" in doc["scale"]
    assert json.loads((tmp_path / "zagreb.json").read_text())["veg2"]["file"] == "veg2.bin.gz"


def _compact_parity_city(out):
    config(out)
    classes = ['residential', 'service']
    old = np.array([[0, 0], [0.1, -0.1], [0.03, -0.07], [1000, 1000]], dtype='<f4')
    flat = old.reshape(-1)
    (out / 'roads.bin.gz').write_bytes(gzip.compress(flat.tobytes()))
    legacy = {'classes': classes, 'ways': [
        {'o': 0, 'c': 2, 'cls': 'residential', 'w': 1.5},
        {'o': 2, 'c': 2, 'cls': 'service', 'w': 2.25}]}
    (out / 'roads.json').write_text(json.dumps(legacy))
    chunks = [np.column_stack([old[:2, 0], np.full(2, 999, np.float32), old[:2, 1]]),
              np.column_stack([old[2:, 0], np.full(2, 999, np.float32), old[2:, 1]])]
    ways = [dict(w, id=i + 1, name=None) for i, w in enumerate(legacy['ways'])]
    road_doc = compact.write_roads2(out, ways, chunks, classes)
    trees = np.array([[1.1, 90, 2.2], [0.2, 80, 0.1]], dtype='<f4')
    (out / 'veg_trees.bin').write_bytes(trees.tobytes())
    (out / 'veg.json').write_text(json.dumps({'count': len(trees)}))
    scales = np.array([0.88, 0.908])
    veg_doc = compact.write_veg2(out, trees, scale=scales, width=scales * 11.8,
                                 year=np.zeros(2, dtype=np.uint16), species=[-1, -1], meta={'count': 2})
    grid = terrain.Grid(x0=0, z0=0, cell=10, nx=2, nz=2)
    h = np.full((2, 2), 12.5)
    packed = terrain.pack(grid, h, np.zeros_like(h), [], -4, np.ones((2, 2), np.uint8), b'', 0, b'', 0)
    (out / 'terrain.bin.gz').write_bytes(gzip.compress(packed))
    return {'roads2': road_doc, 'veg2': veg_doc}


def test_s99_independently_compares_legacy_roads_and_tree_positions(tmp_path):
    out = tmp_path / 'city'
    cfg = _compact_parity_city(out)
    assert s99_validate.check_compact(out, cfg) == []
    original = (out / 'roads.bin.gz').read_bytes()
    raw = np.frombuffer(gzip.decompress(original), dtype='<f4').copy()
    raw[0] += 2
    (out / 'roads.bin.gz').write_bytes(gzip.compress(raw.tobytes()))
    assert any('roads' in e and 'equal' in e for e in s99_validate.check_compact(out, cfg))
    (out / 'roads.bin.gz').write_bytes(original)
    old_trees = np.frombuffer((out / 'veg_trees.bin').read_bytes(), dtype='<f4').reshape(-1, 3).copy()
    old_trees[0, 0] += 1
    (out / 'veg_trees.bin').write_bytes(old_trees.tobytes())
    assert any('trees' in e and '0.5' in e for e in s99_validate.check_compact(out, cfg))


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
