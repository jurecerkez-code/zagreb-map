"""Address coverage and source matching, on tiny measured building footprints."""
import geopandas as gpd
import pandas as pd
import shapely

from pipeline import address_sources as sources


def buildings():
    return gpd.GeoDataFrame({
        "gid": pd.array([10, 20, 30], dtype="int32"),
        "area": [200.0, 20.0, 100.0],
    }, geometry=[shapely.box(0, 0, 10, 10), shapely.box(20, 0, 30, 10),
                 shapely.box(5, 0, 15, 10)], crs=3765)


def test_rpj_adapter_preserves_the_source_record_and_does_not_expand_numbers(tmp_path):
    frame = gpd.GeoDataFrame({
        "OBJECTID": [42, 43, 44],
        "KB": ["12a", "7-9", "bez kućnog broja"],
        "UL_IME": [" Đakovačka ulica ", "Testna ulica", "Prazna ulica"],
        "UL_JID": ["street-42", "street-43", "street-44"],
    }, geometry=shapely.points([[456000, 5073000], [456001, 5073001], [456002, 5073002]]), crs=3765)
    got = sources.rpj_addresses(frame)
    assert len(got) == 2
    assert got.street.tolist() == ["Đakovačka ulica", "Testna ulica"]
    assert got.number.tolist() == ["12a", "7-9"]                   # no inferred 7, 8 or 9
    assert got.source_ref.tolist() == ["RPJKucniBroj:42", "RPJKucniBroj:43"]
    assert got.source.tolist() == ["grad_zagreb_rpj"] * 2
    assert got.street_id.tolist() == ["street-42", "street-43"]

    path = tmp_path / "sample.geojson"
    frame.iloc[:1].to_file(path, driver="GeoJSON")
    assert sources.read_rpj(path).source_ref.tolist() == ["RPJKucniBroj:42"]


def test_only_a_unique_point_on_footprint_match_is_attributed():
    points = gpd.GeoDataFrame({
        "street": ["A ulica", "A ulica", "A ulica", "B ulica"],
        "number": ["1", "2", "3", "bb"],
        "source": ["test"] * 4,
        "source_ref": ["one", "ambiguous", "outside", "no-number"],
    }, geometry=shapely.points([[1, 1], [7, 1], [31, 1], [2, 2]]), crs=3765)
    matched, evidence = sources.match_unique(points.iloc[:3], buildings(), source="test")
    assert matched[["gid", "street", "number", "withheld"]].values.tolist() == [[10, "A ulica", "1", False]]
    evidence = evidence.set_index("source_ref")
    assert evidence.loc["one", "match_kind"] == "unique_covered_by"
    assert evidence.loc["one", "candidate_gids"] == [10]
    assert evidence.loc["one", "match_distance_m"] == 0.0
    assert evidence.loc["ambiguous", "match_kind"] == "ambiguous_covered_by"
    assert evidence.loc["ambiguous", "candidate_gids"] == [10, 30]
    assert pd.isna(evidence.loc["ambiguous", "gid"])
    assert evidence.loc["outside", "match_kind"] == "outside"
    assert evidence.loc["outside", "candidate_gids"] == []
    assert pd.isna(evidence.loc["outside", "match_distance_m"])       # never secretly measured as a nearest match
    assert not (matched.gid == 20).any()                              # do not infer from the nearest small building


def test_a_boundary_point_is_on_a_building_but_a_shared_boundary_is_ambiguous():
    b = gpd.GeoDataFrame({"gid": [1, 2], "area": [100, 100]},
                         geometry=[shapely.box(0, 0, 10, 10), shapely.box(10, 0, 20, 10)], crs=3765)
    points = gpd.GeoDataFrame({"street": ["A", "B"], "number": ["1", "2"]},
                              geometry=shapely.points([[0, 5], [10, 5]]), crs=3765)
    matched, evidence = sources.match_unique(points, b)
    assert matched.gid.tolist() == [1]
    assert evidence.match_kind.tolist() == ["unique_covered_by", "ambiguous_covered_by"]


def test_coordinates_are_explicitly_transformed_not_assumed():
    b = buildings().to_crs(4326)
    p = gpd.GeoDataFrame({"street": ["A"], "number": ["1"]},
                         geometry=shapely.points([[1, 1]]), crs=3765)
    matched, evidence = sources.match_unique(p, b)
    assert matched.gid.tolist() == [10]
    assert "geometry" not in evidence


def test_merge_cannot_undo_a_takedown_or_inflate_the_coverage_count():
    old = pd.DataFrame({"gid": pd.array([10, 20], dtype="int32"), "street": ["A ulica", "B ulica"],
                        "number": ["1", "2"], "withheld": [True, False]})
    new = pd.DataFrame({"gid": pd.array([10, 30, 30, 999], dtype="int32"),
                        "street": ["A ulica", "Cesta C", "Cesta C", "Neispravna"],
                        "number": ["1", "3", "3", "4"], "withheld": [False] * 4})
    merged = sources.merge_addresses(old, new, {10, 20, 30})
    assert merged[["gid", "street", "number", "withheld"]].values.tolist() == [
        [10, "A ulica", "1", True], [20, "B ulica", "2", False], [30, "Cesta C", "3", False]]
    assert merged.dtypes["gid"] == "int32"
    report = sources.coverage(merged, buildings(), min_area=30)
    assert report["all"] == {"buildings": 3, "addressed": 2, "coverage": 2 / 3, "target_met": False}
    assert report["over_30_m2"] == {"buildings": 2, "addressed": 1, "coverage": 0.5, "target_met": False}
    assert report["unknown_gids_excluded"] == 0                         # the merge rejected 999
    assert report["withheld_rows"] == 1


def test_coverage_computes_distinct_real_gids_not_address_rows():
    a = pd.DataFrame({"gid": [10, 10, 20, 20, 30, 12345],
                      "street": ["A", "A", "B", "B", " ", "D"],
                      "number": ["1", "2", "1", "1", "3", "4"],
                      "withheld": [False, False, True, True, False, False]})
    got = sources.coverage(a, buildings())
    assert got["all"]["buildings"] == 3 and got["all"]["addressed"] == 1
    assert got["address_rows_present"] == 4
    assert got["address_rows_shown"] == 3
    assert got["unknown_gids_excluded"] == 1


def test_missing_withheld_means_visible_and_an_explicit_new_takedown_survives():
    old = pd.DataFrame({"gid": [10], "street": ["A"], "number": ["1"]})
    added = pd.DataFrame({"gid": [20], "street": ["B"], "number": ["2"], "withheld": [True]})
    merged = sources.merge_addresses(old, added, known_gids={10, 20})
    assert merged.withheld.tolist() == [False, True]
    assert sources.coverage(merged, buildings())["all"]["addressed"] == 1
    # An absent known-gid set never infers a new building just because an address names one.
    unknown_only = sources.merge_addresses(old, added)
    assert unknown_only.gid.tolist() == [10]
    assert sources.coverage(old, buildings())["all"]["addressed"] == 1


def test_osm_source_id_stays_in_evidence_not_in_the_public_shape():
    p = gpd.GeoDataFrame({"osm_id": ["n/42"], "street": ["A"], "number": ["1"]},
                         geometry=shapely.points([[1, 1]]), crs=3765)
    matched, evidence = sources.match_unique(p, buildings())
    assert evidence.source_ref.tolist() == ["n/42"]
    assert matched.columns.tolist() == ["gid", "street", "number", "withheld"]


def test_search_coverage_reads_actual_pairs_and_rejects_unknown_or_empty_addresses(tmp_path):
    (tmp_path / "a.json").write_text('{"A ulica":[["1",10,0],["",20,0]],"Druga":[["2",10,0]]}')
    (tmp_path / "b.json").write_text('{"B ulica":[["3",999,0]],"C ulica":[]}')
    got = sources.search_coverage(tmp_path, buildings())
    assert got == {"shards": 2, "address_pairs": 3, "invalid_pairs": 1, "unknown_gids": 1,
                   "addressed": 1, "buildings": 3, "coverage": 1 / 3, "target_met": False}


def test_empty_sources_are_safe_and_have_the_standard_schema():
    p = gpd.GeoDataFrame({"street": pd.Series(dtype=str), "number": pd.Series(dtype=str)},
                         geometry=gpd.GeoSeries([], crs=3765), crs=3765)
    matched, evidence = sources.match_unique(p, buildings())
    assert matched.columns.tolist() == ["gid", "street", "number", "withheld"]
    assert matched.empty and evidence.empty
