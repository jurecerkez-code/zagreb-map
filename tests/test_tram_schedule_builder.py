"""A tram timetable refresh uses explicit GTFS input and does not discard the mapped rails."""
import json
import struct
from pathlib import Path

from pipeline import s16_zagreb_trams as builder


def gtfs_fixture(root: Path):
    root.mkdir()
    files = {
        "routes.txt": "route_id,route_short_name,route_long_name,route_type\ntram,1,Test line,0\nbus,99,Not a tram,3\n",
        "trips.txt": "trip_id,route_id,service_id,shape_id,trip_headsign\nfresh-trip,tram,sat,shape,Test destination\nbus-trip,bus,sat,shape,Not a tram\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsat,0,0,0,0,0,1,0,20260101,20261231\n",
        "calendar_dates.txt": "service_id,date,exception_type\n",
        "shapes.txt": "shape_id,shape_pt_sequence,shape_pt_lon,shape_pt_lat\nshape,1,15.974,45.81\nshape,2,15.975,45.81\n",
        "stops.txt": "stop_id,stop_name,stop_lon,stop_lat\none,First,15.974,45.81\ntwo,Second,15.975,45.81\n",
        "stop_times.txt": "trip_id,stop_sequence,arrival_time,departure_time,stop_id\nfresh-trip,1,07:00:00,07:00:20,one\nfresh-trip,2,07:05:00,07:05:20,two\n",
    }
    for name, text in files.items():
        (root / name).write_text(text, encoding="utf-8")
    return root


def test_refreshes_timetable_without_rebuilding_rails(tmp_path, monkeypatch):
    web = tmp_path / "web"
    previous = tmp_path / "previous"
    previous.mkdir()
    rails = {"ways": 1, "points": 2, "index": [{"offset": 0, "count": 2}]}
    (previous / "trams.json").write_text(json.dumps({"rails": rails}), encoding="utf-8")
    rail_bytes = struct.pack("<4f", 0.0, 0.0, 1.0, 1.0)
    (previous / "trams_rails.bin.gz").write_bytes(rail_bytes)
    monkeypatch.setattr(builder, "WEB", web)

    source = gtfs_fixture(tmp_path / "gtfs")
    builder.main([
        "--version", "trams-fresh", "--date", "2026-11-07",
        "--gtfs", str(source), "--rails-from", str(previous / "trams.json"),
    ])

    result = web / "data" / "trams-fresh"
    metadata = json.loads((result / "trams.json").read_text(encoding="utf-8"))
    assert metadata["trip_ids"] == ["fresh-trip"]
    assert metadata["rails"] == rails
    assert (result / "trams_rails.bin.gz").read_bytes() == rail_bytes
