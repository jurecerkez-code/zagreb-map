"""Zagreb monuments: copy the hand-checked monuments list (data/monuments in the project folder, made by its work/
scripts from OpenStreetMap, Wikidata, Commons and Wikipedia) into the version folder as monuments.json, in the
viewer's compact form (local x/z metres, web/monuments.js), and its photos into web/data/photos/.

    uv run python -m pipeline.s05_zagreb_monuments [--version vYYYYMMDD-tag]

Prefers the complete data/monuments/work31 package, after checking ids, field totals, per-source rules, baselines and
unmet coverage gaps. Preserves its before -> after counts and conflicts in <out>/monuments_report.json. --source and
--out permit a scratch-only package without a new version or a current.json switch; --report can copy the audit to an
explicit path too. Only --version imports the registered-version machinery.
Fails if an enrichment package is incomplete or a named photo is missing or over city.WIKI['photo_bytes'].
"""
import argparse
from collections import Counter
import json
import shutil
import sys
from pathlib import Path

from . import city, io
# s03 is imported only when a registered version output is requested; scratch and unit work need no parquet stack.

SRC = Path(__file__).resolve().parents[2] / "data" / "monuments"
PHOTOS = Path("web/data/photos")
BUILDINGS = Path("data/buildings.parquet")
PLINTH_M2, PLINTH_MAX_M = 80.0, 12.0   # a small, low "building" under a monument is its plinth in the city model


def plinths(ms: list[dict]) -> dict[str, float]:
    """id -> height (m) of the city model's plinth under the monument: ZG3D models many pedestals (the ban Jelačić
    statue stands on a 17.6 m², 5.25 m part), so the viewer stands the figure on it instead of burying it inside."""
    if not BUILDINGS.exists():
        return {}
    import geopandas as gpd
    from shapely.geometry import Point
    b = gpd.read_parquet(BUILDINGS, columns=["gid", "height", "geometry"])
    b = b[(b.geometry.area < PLINTH_M2) & (b["height"] < PLINTH_MAX_M)]
    pts = gpd.GeoDataFrame({"id": [m["id"] for m in ms]}, geometry=[Point(m["x_3765"], m["y_3765"]) for m in ms], crs=b.crs)
    hit = gpd.sjoin(pts, b, predicate="within")
    return {r.id: round(float(r.height), 2) for r in hit.itertuples()}


def _year(value):
    """Only an exact integer year is drawable; never turn a range, decade or boolean into a guessed year."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit() and len(value.strip()) in (3, 4):
        year = int(value.strip())
        return year if year > 0 else None
    return None


def _year_rule(m: dict) -> str:
    raw = str(m.get("ysrc") or "unrecorded")
    # The audited report's canonical name for the same reviewed list source.
    return {"wikipedia:hr:list": "wikipedia_list_hr", "wikipedia:hr_list": "wikipedia_list_hr"}.get(raw, raw.replace(":", "_"))


def _source_dir(path=SRC) -> Path:
    root = Path(path or SRC)
    if root.is_file():
        if root.name != "monuments.json":
            raise ValueError(f"source file is not monuments.json: {root}")
        root = root.parent
    work = root / "work31"
    if work.exists():
        required = [work / name for name in ("monuments.json", "monuments_report.json", "verification.json")]
        if not all(p.exists() for p in required):
            raise ValueError("incomplete issue-31 enrichment: work31 needs records, report and verification")
        return work
    if (root / "monuments.json").is_file():
        return root
    raise SystemExit(f"{root / 'monuments.json'} is missing: run data/monuments/work/s1_osm.py and s2_build.py first")


def read_enrichment(path=SRC):
    """Read the complete review package; prefer work31 but never modify records in place."""
    source = _source_dir(path)
    records = json.loads((source / "monuments.json").read_text(encoding="utf-8"))
    report_path = source / "monuments_report.json"
    verification_path = source / "verification.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
    verification = json.loads(verification_path.read_text(encoding="utf-8")) if verification_path.exists() else {}
    validate_enrichment(records, report, verification, source)
    return source, records, report, verification


def validate_enrichment(records: list[dict], report: dict | None, verification: dict, source=None) -> None:
    """A report is an input to verification, never a licence to label unmet coverage targets as met."""
    if not isinstance(records, list) or len({m.get("id") for m in records}) != len(records):
        raise ValueError("monuments must be a list with unique ids")
    if report is None:
        return
    if verification.get("ok") is not True:
        raise ValueError("enrichment verification did not pass")
    after = report["after"]["all"]
    years = sum(_year(m.get("year")) is not None for m in records)
    photos = sum(m.get("photo") is not None for m in records)
    if after.get("entries") != len(records):
        raise ValueError("report entries do not match monuments.json")
    for field, actual in (("year", years), ("photo", photos)):
        if after.get(field) != actual:
            raise ValueError(f"report {field} total {after.get(field)} != data {actual}")
    for field, actual in (("year", years), ("photo", photos)):
        verified = report.get("source_rule_totals_verified", {}).get(f"{field}_after")
        if verified is not None and verified != actual:
            raise ValueError(f"source rule total for {field} {verified} != data {actual}")
    rules = report.get("source_rules", {})
    actual_year_rules = Counter(_year_rule(m) for m in records if _year(m.get("year")) is not None)
    actual_photo_rules = Counter(str(m.get("photo_rule") or m.get("photo", {}).get("rule") or "unrecorded")
                                 for m in records if m.get("photo"))
    for key, actual in (("year_after", actual_year_rules), ("photo_after", actual_photo_rules)):
        if key in rules and dict(rules[key]) != dict(actual):
            raise ValueError(f"report's source rules {key} do not match the records: {dict(actual)}")
    kind = [m for m in records if m.get("kind") in ("statue", "bust")]
    actual = {"denominator": len(kind),
              "year_target_min": (70 * len(kind) + 99) // 100,
              "year_actual": sum(_year(m.get("year")) is not None for m in kind),
              "photo_target_min": (75 * len(kind) + 99) // 100,
              "photo_actual": sum(m.get("photo") is not None for m in kind)}
    actual.update(year_gap=max(0, actual["year_target_min"] - actual["year_actual"]),
                  photo_gap=max(0, actual["photo_target_min"] - actual["photo_actual"]),
                  year_met=actual["year_actual"] >= actual["year_target_min"],
                  photo_met=actual["photo_actual"] >= actual["photo_target_min"])
    target = report.get("targets_for_statues_and_busts")
    if target is not None:
        for key, value in actual.items():
            if target.get(key) != value:
                raise ValueError(f"target {key} {target.get(key)!r} != measured {value!r}")
    for key, _group in report.get("after", {}).get("per_kind", {}).items():
        rows = [m for m in records if m.get("kind") == key]
        expected = report["after"]["per_kind"][key]
        if expected.get("entries") != len(rows) or expected.get("year") != sum(_year(m.get("year")) is not None for m in rows) \
                or expected.get("photo") != sum(m.get("photo") is not None for m in rows):
            raise ValueError(f"per-kind report counts do not match {key}")
    if source is not None and (source / "monuments_before.json").exists():
        before = json.loads((source / "monuments_before.json").read_text(encoding="utf-8"))
        baseline = report.get("before", {}).get("all", {})
        measured = {"entries": len(before), "year": sum(_year(m.get("year")) is not None for m in before),
                    "photo": sum(m.get("photo") is not None for m in before)}
        for key, count in measured.items():
            if baseline.get(key) != count:
                raise ValueError(f"baseline {key} {baseline.get(key)} != measured {count}")


def write_audit_report(report: dict, destination):
    """Preserve the complete verified report verbatim (semantically), including target gaps and all conflicts."""
    if not isinstance(report, dict):
        raise ValueError("cannot write an enrichment report that was not supplied")
    destination = Path(destination)
    io.write_json(destination, report)
    return destination


def compact(m: dict, plinth: float | None = None) -> dict:
    x, z = city.to_local(m["x_3765"], m["y_3765"])
    out = {"id": m["id"], "name": m["name"], "kind": m["kind"], "x": round(float(x), 2), "z": round(float(z), 2),
           "h": m["height_m"], "mat": m["material"]}
    for k, v in (("en", m.get("name_en")), ("removed", m.get("removed")),
                 ("by", m.get("creators")), ("dir", m.get("direction")), ("qid", m.get("wikidata")),
                 ("wp", m.get("wikipedia")), ("hsrc", None if m.get("height_source") == "type default" else m.get("height_source"))):
        if v:
            out[k] = v
    year = _year(m.get("year"))
    if year is not None:
        out["year"] = year
        for key in ("ysrc", "yquote", "yurl"):
            if m.get(key):
                out[key] = m[key]
        if "yquote" in out and len(out["yquote"].split()) > 15:
            raise ValueError(f"year evidence quote has more than 15 words: {m['id']}")
    for key, value in (("depicts", m.get("depicts")), ("evidence", m.get("evidence")),
                       ("commons", m.get("commons") or m.get("osm_tags", {}).get("wikimedia_commons")
                        or m.get("osm_tags", {}).get("commons"))):
        if value:
            out[key] = value
    if plinth:
        out["plinth"] = plinth
    ex = {lang: {"t": e["t"], "r": e["r"], "title": e["title"]} for lang, e in (m.get("extracts") or {}).items()}
    if ex:
        out["ex"] = ex
    p = m.get("photo")
    if p:
        out["photo"] = {"key": p["key"], "w": p["w"], "h": p["h"], "by": p["author"] or "unknown", "lic": p["licence"],
                        "lu": p["licence_url"], "page": p["source_page"], **({"title": p["title"]} if p.get("title") else {})}
    ins = m.get("inscription") or m.get("osm_tags", {}).get("inscription")   # a hand-checked one wins over OSM's
    if ins:
        out["ins"] = ins[:300]
    if m["id"].startswith(("node/", "way/", "relation/")):
        out["osm"] = m["id"]
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="s05_zagreb_monuments", description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="output version (default: the one in web/data/current.json)")
    ap.add_argument("--source", type=Path, default=SRC, help="records directory or monuments.json (work31 preferred)")
    ap.add_argument("--out", type=Path, help="explicit scratch/output directory instead of a registered version directory")
    ap.add_argument("--report", type=Path, help="also copy the verified audit report to this explicit path")
    args = ap.parse_args(argv)
    if args.out and args.version:
        ap.error("--out and --version are mutually exclusive; choose an explicit scratch directory or a version")
    source, ms, report, _ = read_enrichment(args.source)
    if args.out:
        out = args.out
    else:
        from .s03_tiles import out_dir  # heavy geometry/parquet imports live only on a registered-version build
        out = out_dir(args.version)
    PHOTOS.mkdir(parents=True, exist_ok=True)
    copied, source_root = 0, source.resolve()
    for m in ms:
        p = m.get("photo")
        if not p:
            continue
        f = source / p["file"]
        if not f.is_file() or not f.resolve().is_relative_to(source_root):
            raise SystemExit(f"photo missing or outside the enrichment package: {f} ({m['name']})")
        if f.stat().st_size > city.WIKI["photo_bytes"]:
            raise SystemExit(f"photo over {city.WIKI['photo_bytes']} bytes: {f}")
        if Path(p["key"]).name != p["key"]:
            raise SystemExit(f"photo key is not a plain filename: {p['key']}")
        dst = PHOTOS / p["key"]
        if not dst.exists() or dst.stat().st_size != f.stat().st_size:
            shutil.copyfile(f, dst)
            copied += 1
    pl = plinths(ms)
    rows = [compact(m, pl.get(m["id"])) for m in ms]
    size = io.write_json(out / "monuments.json", rows)
    if report is not None:
        write_audit_report(report, out / "monuments_report.json")
        if args.report:
            write_audit_report(report, args.report)
    print(f"{len(rows)} monuments ({sum('photo' in r for r in rows)} with photo, {len(pl)} on a city-model plinth, "
          f"{copied} photos copied), {size / 1024:.0f} KB → {out / 'monuments.json'}")
    if report:
        before, after = report["before"]["all"], report["after"]["all"]
        print(f"coverage all: years {before['year']} → {after['year']}, photos {before['photo']} → {after['photo']}; "
              f"source rules {report.get('source_rules', {})}")
        target = report["targets_for_statues_and_busts"]
        print(f"statues+busts ({target['denominator']}): years {target['year_actual']}/{target['year_target_min']} "
              f"(gap {target['year_gap']}, met={target['year_met']}), photos {target['photo_actual']}/"
              f"{target['photo_target_min']} (gap {target['photo_gap']}, met={target['photo_met']})")


if __name__ == "__main__":
    main(sys.argv[1:])
