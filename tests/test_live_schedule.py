"""The live feed must consume the timetable current.json names, not stale city trips."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("serve_live_schedule_test", ROOT / "scripts" / "serve.py")
serve = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(serve)


@pytest.fixture
def data_root(tmp_path, monkeypatch):
    web = tmp_path / "web"
    (web / "data" / "city").mkdir(parents=True)
    (web / "data" / "city" / "trams.json").write_text('{"trip_ids": ["old-trip"]}', encoding="utf-8")
    monkeypatch.setattr(serve, "WEB", web)
    monkeypatch.setattr(serve, "_schedule", {"version": None, "trips": frozenset()})
    return web / "data"


def test_reads_the_versioned_tram_schedule(data_root):
    current = data_root / "current.json"
    current.write_text(json.dumps({"version": "city"}), encoding="utf-8")
    assert serve._trip_ids() == {"old-trip"}

    target = data_root / "trams-fresh"
    target.mkdir()
    trip = "0_7_203_2_20529"
    (target / "trams.json").write_text(json.dumps({"trip_ids": [trip]}), encoding="utf-8")
    current.write_text(json.dumps({
        "version": "city", "trams_version": "trams-fresh",
    }), encoding="utf-8")

    assert serve._trip_ids() == {trip}
