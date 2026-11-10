"""ZBSM cadastre-before dates are bounds, never fabricated construction years."""

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import box

from pipeline import city, codes, s03_tiles, s99_validate, yearrules
from pipeline import s01_zagreb as pilot
from pipeline import zagreb_city as zc


def test_zbsm_and_odo_before_columns_have_their_own_one_sided_meanings():
    assert zc.parse_zbsm("prije dnkat 1968", "") == (1968, 0, 1968, codes.BOUND)
    assert zc.parse_zbsm("prije skat 2007", "") == (2007, 0, 2007, codes.BOUND)
    assert zc.parse_zbsm("prije dnkat 1968", "prije skat 2007") == (2007, 0, 2007, codes.BOUND)
    # Only 2007 is special, not the nearby completion year 1967.
    assert zc.parse_zbsm("prije dnkat 1967", "") is None
    for form in ("prije dnkat 1968", "prije skat 2007", "prije 15.2.1968.", "prije 1.10.2007."):
        assert yearrules.parse_odo(form) == (0, 1968 if "1968" in form else 2007)
        assert yearrules.parse_odo(f"ODO: {form}") == (0, 1968 if "1968" in form else 2007)
    assert yearrules.parse_odo("prije dnkat 1967") is None


def _years_from_real_adapter():
    geometries = [box(i * 30, 0, i * 30 + 20, 20) for i in range(4)]
    b = gpd.GeoDataFrame({"gid": range(4), "osm": [-1] * 4}, geometry=geometries, crs=city.CRS)
    parts = b.copy()
    osm_b = gpd.GeoDataFrame({"start_date": [""] * 4}, geometry=geometries, crs=city.CRS)
    zbsm = gpd.GeoDataFrame(
        {
            "datacija": ["prije dnkat 1968", "prije dnkat 1968", "prije dnkat 1968", "prije dnkat 1968"],
            "datacija2": ["", "", "", "prije skat 2007"],
            "status": [None] * 4,
        },
        geometry=geometries,
        crs=city.CRS,
    )
    wd = pd.DataFrame(
        {
            "qid": pd.Series(dtype=str),
            "structure": pd.Series(dtype=bool),
            "prop": pd.Series(dtype=str),
            "prec": pd.Series(dtype=int),
        }
    )
    her = {"kd": {1: (1910, 1910, 1910, codes.EXACT, "", "record-1")}}
    return zc.assign_years(b, parts, np.arange(4), osm_b, zbsm, wd, her)


def test_bound_reaches_stats_and_timeline_at_its_bound_with_no_fabricated_from():
    y = _years_from_real_adapter()
    assert (y["year"].tolist(), y["y_from"].tolist(), y["y_to"].tolist()) == (
        [1968, 1910, 1968, 2007],
        [0, 1910, 0, 0],
        [1968, 1910, 1968, 2007],
    )
    assert y["yflag"].tolist() == [codes.BOUND, codes.EXACT, codes.BOUND, codes.BOUND]
    assert y["ysrc"].tolist() == [codes.SRC_ZBSM, codes.SRC_KD, codes.SRC_ZBSM, codes.SRC_ZBSM]
    y = pd.DataFrame({k: y[k] for k in ("year", "y_from", "y_to", "yflag", "ysrc")})
    y["gid"] = range(4)
    y["period"] = city.period_indices(y["year"].to_numpy())
    y["private"] = [False] * 4
    y["fsrc"] = codes.FLOORS_HEIGHT
    terrain = dict(source="test", x0=0, z0=0, cell=100, nx=0, nz=0, water_z=0.0, datum=0, fixed=0)
    cfg = s03_tiles.make_config(y, [], [], "test-bounds", 600, [], {}, terrain)
    stats = cfg["stats"]
    assert stats["byFlag"]["bound"] == 3 and stats["byFlag"]["exact"] == 1
    assert cfg["bounds"] == stats["byBound"] == {"pre1968": 2, "1968_2007": 1}
    assert sum(cfg["bounds"].values()) == stats["byFlag"]["bound"]
    assert cfg["histogram"]["1968"][city.period_index(1968)] == 2
    assert cfg["histogram"]["2007"][city.period_index(2007)] == 1
    assert "1968" not in cfg["histogramEst"] and "2007" not in cfg["histogramEst"]


def test_bounds_are_not_train_test_query_or_external_accuracy_input(monkeypatch):
    y = _years_from_real_adapter()
    y["yflag"][2] = codes.UNKNOWN
    y["year"][2] = y["y_from"][2] = y["y_to"][2] = 0
    y["ysrc"][2] = codes.SRC_NONE
    captured = {}

    def run(f, year, dated, query, *args):
        captured.update(dated=dated.copy(), query=query.copy(), years=year.copy())
        return pd.DataFrame({"yflag": [codes.UNKNOWN] * 4, "yhat": [0.0] * 4, "band": [0] * 4}), {
            "result": {"estimate": 0, "period": 0, "unknown": 1},
            "cells": [],
        }

    def external(f, year, core, ext, *args):
        captured.update(core=core.copy(), ext=ext.copy(), external_years=year.copy())
        return {"n_all": 0}

    monkeypatch.setattr(zc.est, "run", run)
    monkeypatch.setattr(zc.est, "check_external", external)
    geometries = gpd.GeoDataFrame({"gid": range(4)}, geometry=[box(i * 30, 0, i * 30 + 20, 20) for i in range(4)])
    table = zc.run_estimate(geometries, np.array(["apartments"] * 4), np.array([8.0] * 4), np.array(["C"] * 4), y)
    assert captured["dated"].tolist() == [False, True, False, False]
    assert captured["query"].tolist() == [False, False, True, False]
    assert captured["external_years"].tolist() == [0, 1910, 0, 0]
    assert captured["core"].tolist() == [False] * 4
    assert captured["ext"].tolist() == [False] * 4
    assert table["calibration"]["dated"]["n"] == 1  # the one exact residential building, not the two bounds


def test_the_geoparquet_adapter_sets_the_real_class_bound():
    got = pilot.years_for(["exact", "pre1968", "1968-2007", "unknown"], [1900, 0, 0, 0])
    assert got.year.tolist() == [1900, 1968, 2007, 0]
    assert got.year_from.tolist() == [1900, 0, 0, 0]
    assert got.year_to.tolist() == [1900, 1968, 2007, 0]
    assert got.yflag.tolist() == [codes.EXACT, codes.BOUND, codes.BOUND, codes.UNKNOWN]
    assert got.ysrc.tolist() == [codes.SRC_ZBSM, codes.SRC_ZBSM, codes.SRC_ZBSM, codes.SRC_NONE]
    assert all(ys != codes.SRC_ZBSM or f in (codes.EXACT, codes.BOUND) for ys, f in zip(got.ysrc, got.yflag))


def test_full_attrs_accept_valid_bound_and_reject_a_fabricated_start():
    attrs = np.zeros(1, dtype=s03_tiles.ATTR_DTYPE)
    attrs["h_dm"], attrs["floors"] = 200, 4
    attrs["year"] = attrs["year_to"] = 1968
    attrs["year_from"], attrs["period"], attrs["yflag"], attrs["ysrc"] = (
        0,
        city.period_index(1968),
        codes.BOUND,
        codes.SRC_ZBSM,
    )
    assert s99_validate.check_attrs(attrs) == []
    attrs["year_from"] = 1960
    assert any("BOUND" in error for error in s99_validate.check_attrs(attrs))


def test_s99_pins_bound_shape_and_reconciles_separate_header_counts():
    dtype = [("yflag", "u1"), ("year", "u2"), ("year_from", "u2"), ("year_to", "u2"), ("ysrc", "u1")]
    attrs = np.array(
        [(codes.BOUND, 1968, 0, 1968, codes.SRC_ZBSM)] * 2 + [(codes.BOUND, 2007, 0, 2007, codes.SRC_ZBSM)], dtype=dtype
    )
    cfg = {
        "stats": {"byFlag": {"bound": 3}},
        "bounds": {"pre1968": 2, "1968_2007": 1},
        "histogram": {"1968": [2], "2007": [1]},
        "histogramEst": {},
    }
    assert s99_validate.check_bounds(cfg, attrs) == []
    for column, value in (("year_from", 1960), ("year_to", 0)):
        bad = attrs[[0]].copy()
        bad[column] = value
        assert s99_validate.check_bounds(cfg, bad)
    assert s99_validate.check_bounds(dict(cfg, bounds={"pre1968": 1, "1968_2007": 1}), attrs)
    assert s99_validate.check_histograms(dict(cfg, stats={"buildings": 3, "byFlag": {"bound": 3}})) == []
