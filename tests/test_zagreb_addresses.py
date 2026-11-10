"""Zagreb address attribution: canonical streets, inside/near matches, interpolation, references and the report."""
import geopandas as gpd
import pandas as pd
import pytest
import shapely

from pipeline import zagreb_addresses as za


def buildings(area=(200.0, 200.0, 20.0)):
    return gpd.GeoDataFrame({"gid": pd.array([10, 20, 30], dtype="int32"), "area": list(area)},
                            geometry=[shapely.box(0, 0, 10, 10), shapely.box(20, 0, 30, 10),
                                      shapely.box(5, 0, 15, 10)], crs=3765)


def lines(*rows):
    """[(street, y of a line in front of the buildings)] as the street centrelines match() faces against."""
    return gpd.GeoDataFrame({"street": [r[0] for r in rows]},
                            geometry=[shapely.LineString([(0, y), (40, y)]) for _, y in rows], crs=3765)


def points(*rows):
    """[(street, number, x, y)]."""
    return gpd.GeoDataFrame({"osm": [f"n/{i}" for i in range(len(rows))],
                             "street": [r[0] for r in rows], "number": [r[1] for r in rows]},
                            geometry=shapely.points([[r[2], r[3]] for r in rows]), crs=3765)


def test_street_key_makes_only_the_generic_ulica_optional():
    assert za.street_key("Adamičeva") == za.street_key("Adamičeva ulica") == "adamiceva"
    assert za.street_key("UL. Adamičeva") == "adamiceva"
    assert za.street_key("Ulica Jurja Križanića") == "jurja krizanica"
    # a real semantic difference is not folded away to make a pair look fixed
    assert za.street_key("Cesta Ilica") != za.street_key("Ulica Ilica")
    assert za.street_key("Trg bana Jelačića") == "trg bana jelacica"


def test_the_canonical_name_is_the_one_on_the_street_way_then_the_commonest_spelling():
    canonical = za.canonical_streets(
        ["Adamičeva", "Adamičeva", "Adamičeva ulica", "Ulica Ilica", "Ilica"],
        ["Adamičeva ulica", "Adamičeva ulica", "Ulica Ilica"])
    assert canonical["adamiceva"] == "Adamičeva ulica"          # the street way's own name wins
    assert canonical["ilica"] == "Ulica Ilica"                  # the way's "Ulica Ilica" wins over "Ilica"
    plain = za.canonical_streets(["Nepoznata", "Nepoznata ulica", "Nepoznata"], [])
    assert plain["nepoznata"] == "Nepoznata"                    # no way: the commonest address spelling


def test_canonicalise_rewrites_every_spelling_and_keeps_an_unknown_street():
    frame = pd.DataFrame({"street": ["Adamičeva", "Adamičeva ulica", "  ", "Nepoznata"]})
    got = za.canonicalise(frame, {"adamiceva": "Adamičeva ulica"})
    assert got.tolist() == ["Adamičeva ulica", "Adamičeva ulica", "", "Nepoznata"]


def test_a_unique_cover_is_inside_and_two_covers_stay_ambiguous():
    got, evidence = za.match(points(("Ulica A", "1", 1, 1), ("Ulica A", "2", 7, 1)),
                             buildings(), lines(("Ulica A", -3)))
    assert got[["gid", "street", "number"]].values.tolist() == [[10, "Ulica A", "1"]]
    assert evidence.set_index("osm").loc["n/0", "match_kind"] == "inside"
    assert evidence.set_index("osm").loc["n/1", "match_kind"] == "ambiguous_covered_by"
    assert evidence.set_index("osm").loc["n/1", "candidate_gids"] == [10, 30]
    assert pd.isna(evidence.set_index("osm").loc["n/1", "gid"])


def test_a_point_outside_is_near_only_when_the_footprint_faces_that_street():
    near, evidence = za.match(points(("Ulica A", "4", 2, -1)), buildings(), lines(("Ulica A", -3)))
    assert near.gid.tolist() == [10]
    assert evidence.match_kind.tolist() == ["near"]
    assert evidence.match_distance_m.iloc[0] == pytest.approx(1.0, abs=0.01)
    # the same point, but the street is 40 m behind the footprint: no near match, no guess
    far, evidence = za.match(points(("Ulica A", "4", 2, -1)), buildings(), lines(("Ulica A", -40)))
    assert far.empty and evidence.match_kind.tolist() == ["outside"]
    # no centreline for that street at all: never fall back to distance alone
    unknown, evidence = za.match(points(("Nepoznata", "4", 2, -1)), buildings(), lines(("Ulica A", -3)))
    assert unknown.empty and evidence.match_kind.tolist() == ["outside"]


def test_the_near_search_is_bounded_at_25_metres():
    # 30 m from the footprint, with the street in front: out of range
    out, evidence = za.match(points(("Ulica A", "4", 5, -31)), buildings(), lines(("Ulica A", -33)))
    assert out.empty and evidence.match_kind.tolist() == ["outside"]


def test_sentinel_numbers_and_empty_streets_are_never_attributed():
    got, evidence = za.match(points(("Ulica A", "bb", 1, 1), ("", "2", 1, 1), ("Ulica A", "3", 1, 1)),
                             buildings(), lines(("Ulica A", -3)))
    assert got.number.tolist() == ["3"]
    assert evidence.match_kind.tolist()[0] == "invalid_source_record"
    assert evidence.match_kind.tolist()[1] == "invalid_source_record"


def test_interpolation_expands_only_between_two_numbered_endpoints():
    way = {"id": 7, "tags": {"addr:interpolation": "odd", "addr:street": "Ulica A"}, "nodes": [1, 2],
           "geometry": [{"id": 1, "lat": 45.8, "lon": 15.9}, {"id": 2, "lat": 45.8, "lon": 15.91}]}
    endpoints = {1: {"number": "1", "street": "Ulica A"}, 2: {"number": "9", "street": "Ulica A"}}
    got = za.interpolation_points([way], endpoints)
    assert got.number.tolist() == ["3", "5", "7"]
    assert got.street.tolist() == ["Ulica A"] * 3
    assert got.osm.tolist() == ["w7"] * 3
    # one endpoint without a number: nothing is invented
    assert za.interpolation_points([way], {1: {"number": "1"}}).empty
    # the same way tagged "even" is even numbers, never the odd ones
    even = dict(way, tags=dict(way["tags"], **{"addr:interpolation": "even"}))
    even_ends = {1: {"number": "2", "street": "Ulica A"}, 2: {"number": "10", "street": "Ulica A"}}
    assert za.interpolation_points([even], even_ends).number.tolist() == ["4", "6", "8"]


def test_interpolation_takes_an_end_from_the_address_point_on_the_way_s_end():
    # Zagreb's Overpass extract carries the ways' vertices but not their node ids (0 of 22 ways): each end takes the
    # number of the address point standing there, within 20 m, so a range grows from real numbers and never a guess
    class Identity:                       # the fixture is already in the ways' coordinate space
        def transform(self, lon, lat):
            return lon, lat

    way = {"id": 8, "tags": {"addr:interpolation": "odd", "addr:street": "Ilica"},
           "geometry": [{"lat": 100.0, "lon": 0.0}, {"lat": 140.0, "lon": 0.0}]}
    pts = points(("Ilica", "7", 0.0, 100.0), ("Ilica", "15", 0.0, 140.0))
    got = za.interpolation_points([way], {}, None, transformer=Identity(), points=pts)
    assert sorted(got.number.tolist(), key=int) == ["9", "11", "13"]
    assert got.street.tolist() == ["Ilica"] * 3
    assert za.interpolation_points([way], {}, None, transformer=Identity(), points=points(("Ilica", "7", 0, 300))).empty


def test_street_references_are_the_nearest_street_within_60_metres_and_never_an_address():
    b = gpd.GeoDataFrame({"gid": pd.array([10, 20], dtype="int32")},
                         geometry=[shapely.box(0, 0, 10, 10), shapely.box(0, 100, 10, 110)], crs=3765)
    got = za.street_references(b, lines(("Ulica A", -3)), addressed=set())
    assert got.gid.tolist() == [10] and got.street.tolist() == ["Ulica A"]
    assert got.distance_m.iloc[0] == pytest.approx(3.0)
    assert za.street_references(b, lines(("Ulica A", -3)), addressed={10}).empty


def test_the_report_counts_numbers_references_and_neither_on_the_issue_denominator():
    b = buildings(area=(200.0, 200.0, 10.0))
    addresses = pd.DataFrame({"gid": pd.array([10], dtype="int32"), "street": ["Ulica A"], "number": ["1"],
                              "withheld": [False]})
    references = pd.DataFrame({"gid": pd.array([20], dtype="int32"), "street": ["Ulica B"], "distance_m": [4.0]})
    got = za.report(addresses, references, b)
    assert got["all"] == {"buildings": 3, "with_number": 1, "number_share": 1 / 3, "reference_only": 1,
                          "findable": 2, "findable_share": 2 / 3, "neither": 1}
    assert got["over_min_area"]["buildings"] == 2                  # the 20 m² garage is not in that denominator
    assert got["over_min_area"]["findable_share"] == 1.0
    assert got["target_met"] is True and got["number_target_met"] is False
    # a withheld address is not coverage
    withheld = addresses.assign(withheld=[True])
    assert za.report(withheld, references, b)["all"]["with_number"] == 0
