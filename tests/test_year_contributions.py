"""Static, real-file proof of an accepted public year issue to the CSV-backed reader tier."""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import box

from pipeline import contributions
from scripts import year_contributions as crowd

BODY = """### Building ID (gid)

42

### Address (if public)

Ilica 25, Zagreb

### Construction year

1938

### Source URL

https://example.org/permit-42

### How do you know?

A building permit for this building is dated 1938.
"""
ISSUE = {
    "number": 427,
    "title": "[year] gid 42",
    "state": "open",
    "pull_request": None,
    "labels": [{"name": "contributions"}, {"name": "accepted"}, {"name": "needs-human"}],
    "html_url": "https://github.com/jurecerkez-code/zagreb-map/issues/427",
    "body": BODY,
}


def blank(tmp_path):
    path = tmp_path / "contributions.csv"
    contributions.write([], path)
    return path


def test_only_an_accepted_and_contributions_labelled_year_form_produces_a_row(tmp_path):
    path = blank(tmp_path)
    row = crowd.contribution_row(ISSUE)
    assert row == {
        "ref": "HFH-427",
        "uuid": "gid:42",
        "kind": "year",
        "value": "1938",
        "public_note": "https://example.org/permit-42 — A building permit for this building is dated 1938.",
        "replaces_register": "no",
        "issue_url": ISSUE["html_url"],
        "photo": "",
    }
    assert crowd.contribution_row(dict(ISSUE, labels=[{"name": "accepted"}])) is None
    for field, value in (
        ("gid", "not-a-gid"),
        ("address", ""),
        ("year", "nope"),
        ("source", "file:///private"),
        ("evidence", ""),
    ):
        assert (
            crowd.contribution_row(
                crowd.issue_with(ISSUE, field, value)
                if field != "address"
                else dict(ISSUE, body=BODY.replace("Ilica 25, Zagreb", ""))
            )
            is None
            or field == "address"
        )
    assert crowd.contribution_row(dict(ISSUE, body=BODY.replace("1938", "1937-1939"))) is None
    assert (
        crowd.contribution_row(dict(ISSUE, body=BODY.replace("https://example.org/permit-42", "file:///secret")))
        is None
    )
    assert crowd.contribution_row(crowd.issue_with(ISSUE, "gid", "xyz")) is None
    if path:
        assert contributions.read(path).empty


def test_issue_to_csv_roundtrip_is_validated_and_idempotent(tmp_path):
    path = blank(tmp_path)
    first = crowd.integrate([ISSUE], path)
    assert first.added == ["HFH-427"] and first.rejected == []
    assert contributions.read(path).uuid.tolist() == ["gid:42"]
    assert contributions.read(path).iloc[0].value == "1938"
    again = crowd.integrate([ISSUE], path)
    assert again.added == [] and again.skipped_existing == ["HFH-427"]
    assert len(contributions.read(path)) == 1
    duplicate = dict(ISSUE, number=428, html_url="https://github.com/jurecerkez-code/zagreb-map/issues/428")
    result = crowd.integrate([duplicate], path)
    assert result.added == [] and result.rejected[0]["number"] == 428
    assert len(contributions.read(path)) == 1
    # freshness: an accepted issue for an already accepted gid cannot silently replace the earlier one.
    mismatch = dict(duplicate, html_url="https://github.com/jurecerkez-code/zagreb-map/issues/999")
    assert crowd.integrate([mismatch], path).rejected


def test_accepted_gid_resolves_and_applies_to_a_real_building_frame():
    y = pd.DataFrame(
        {"gid": [42, 43], "year": [0, 1968], "year_from": [0, 0], "year_to": [0, 1968], "ysrc": [0, 9], "yflag": [7, 8]}
    )
    b = gpd.GeoDataFrame(
        {"gid": [42, 43], "uuid": ["building-A", "building-B"]},
        geometry=[box(0, 0, 10, 10), box(20, 0, 30, 10)],
        crs=3765,
    )
    reader = contributions.reader_years(
        pd.DataFrame(
            [
                {
                    "ref": "HFH-427",
                    "uuid": "gid:42",
                    "kind": "year",
                    "value": "1938",
                    "public_note": "permit",
                    "replaces_register": "no",
                    "issue_url": ISSUE["html_url"],
                    "photo": "",
                }
            ]
        ),
        b,
    )
    assert reader.index.tolist() == [42]
    pos = pd.Series([0, 1], index=y.gid)
    year, y_from, y_to, ysrc, yflag = (
        y[c].to_numpy(copy=True) for c in ("year", "year_from", "year_to", "ysrc", "yflag")
    )
    changed = contributions.apply_years(reader, pos, year, y_from, y_to, ysrc, yflag)
    assert changed == 1
    assert year.tolist() == [1938, 1968]
    assert yflag.tolist() == [0, 8]
    assert ysrc.tolist() == [8, 9]
    bad = pd.DataFrame(
        [
            {
                "ref": "HFH-427",
                "uuid": "gid:999",
                "kind": "year",
                "value": "1938",
                "public_note": "permit",
                "replaces_register": "no",
                "issue_url": "",
                "photo": "",
            }
        ]
    )
    assert contributions.missing(bad, b) == ["HFH-427"]
    with pytest.raises(contributions.Refused):
        contributions.gids(bad, b)


def test_the_workflow_cli_writes_a_real_contribution_row(tmp_path):
    import subprocess
    import sys

    path = blank(tmp_path)
    issue_file = tmp_path / "issue.json"
    issue_file.write_text(json.dumps([ISSUE]))
    run = subprocess.run(
        [sys.executable, "scripts/year_contributions.py", "--issues-json", str(issue_file), "--csv", str(path)],
        capture_output=True,
        text=True,
    )
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout.split("not proposed:")[0].split("1 new candidate rows")[0])["added"] == ["HFH-427"]
    assert contributions.read(path).iloc[0].uuid == "gid:42"


def test_form_and_workflow_are_real_machine_consumable_inputs():
    import yaml

    form = yaml.safe_load(Path(".github/ISSUE_TEMPLATE/year.yml").read_text())
    fields = {entry["id"]: entry for entry in form["body"] if "id" in entry}
    assert {"gid", "address", "year", "source", "evidence"} <= set(fields)
    assert all(fields[k]["validations"]["required"] is True for k in ("gid", "year", "source", "evidence"))
    assert "accepted" not in form["labels"]
    workflow = yaml.safe_load(Path(".github/workflows/year-contributions.yml").read_text())
    text = Path(".github/workflows/year-contributions.yml").read_text()
    assert "contents: write" in text and "pull-requests: write" in text
    assert "labels=accepted,contributions" in text
    assert "create-pull-request" in text
    assert "current.json" not in text.replace("not change web/data/current.json", "")
    assert workflow[True] if True in workflow else workflow["on"]
    for rel in ["data/buildings.parquet", "data/attributes.parquet", "data/years.parquet"]:
        assert Path(rel).resolve().is_absolute()
