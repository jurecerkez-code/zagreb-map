"""Accepted .github/ISSUE_TEMPLATE/year.yml issues -> reviewed pipeline/contributions.csv rows.

This is a deliberately offline parser: the workflow obtains the real issue bodies with `gh api`.
No HTTP Worker, guest hallucination or production data write is involved. A `gid:<n>` marker resolves
against the actual build's gid, then follows the existing contribution checks. It fails closed if
that gid is absent, ambiguous, or already has a reader-year contribution.

    uv run python scripts/year_contributions.py --issues-json issues.json

The workflow opens a PR; it never publishes a data version or marks an issue resolved. Run it again after
that PR is merged to avoid duplicate pending review work. Invalid rows are reported as `rejected`, not
silently repaired with invented UUIDs, years, addresses or evidence.
"""

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # both `python scripts/year_contributions.py` and pytest imports work
    sys.path.insert(0, str(ROOT))

from pipeline import contributions  # noqa: E402  # ROOT above handles direct script execution

FIELDS = {
    "gid": "Building ID (gid)",
    "address": "Address (if public)",
    "year": "Construction year",
    "source": "Source URL",
    "evidence": "How do you know?",
}


class Rejected(ValueError):
    """An unsuitable issue or a conflicting existing accepted contribution."""


@dataclass
class Result:
    added: list[str] = field(default_factory=list)
    skipped_existing: list[str] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)


def labels(issue: dict) -> set[str]:
    return {row.get("name", row) if isinstance(row, dict) else row for row in issue.get("labels", [])}


def form_values(body: str) -> dict[str, str]:
    """Parse GitHub's rendered issue-form headings, not guessed multiline arbitrary key/value text."""
    sections = re.split(r"(?m)^###[ \t]+(.+?)[ \t]*\r?$", body or "")
    found = {}
    for title, value in zip(sections[1::2], sections[2::2]):
        found[title.strip().casefold()] = value.strip()
    return {name: found.get(title.casefold(), "").strip() for name, title in FIELDS.items()}


def issue_with(issue: dict, field: str, value: str) -> dict:
    """Test/fixture helper: an issue with one field replaced (empty = the field left blank)."""
    import copy

    title = FIELDS.get(field, field)
    body = re.sub(rf"(?ms)^### {re.escape(title)}\s*\n\s*.*?(?=^###|\Z)", f"### {title}\n\n{value}\n\n", issue["body"])
    return copy.deepcopy(issue | {"body": body})


def contribution_row(issue: dict) -> dict | None:
    """A valid new contribution row, or None for anything that should stay with a human reviewer."""
    if not {"accepted", "contributions"} <= labels(issue) or issue.get("pull_request") is not None:
        return None
    if not str(issue.get("title", "")).casefold().startswith("[year]"):
        return None
    v, number = form_values(issue.get("body", "")), issue.get("number")
    gid, year = v["gid"], v["year"]
    if not re.fullmatch(r"(?:0|[1-9]\d*)", gid) or not re.fullmatch(r"\d{4}", year):
        return None
    try:
        first, last = contributions.year_span(year)
    except ValueError:
        return None
    source = v["source"]
    evidence = " ".join(v["evidence"].split())
    if (
        not source.startswith("https://")
        or any(c.isspace() for c in source)
        or "@" in source.partition("//")[2].partition("/")[0]
    ):
        return None
    if (
        not evidence
        or not issue.get("html_url")
        or not isinstance(number, int)
        or isinstance(number, bool)
        or number < 1
    ):
        return None
    expected = f"https://github.com/jurecerkez-code/zagreb-map/issues/{number}"
    if issue["html_url"] != expected:
        return None
    # The public source and explanation stay inspectable; no silent trimming or synthetic note.
    note = f"{source} — {evidence}"
    if len(note) > 200 or first != last:
        return None
    row = {
        "ref": f"HFH-{number}",
        "uuid": f"gid:{int(gid)}",
        "kind": "year",
        "value": year,
        "public_note": note,
        "replaces_register": "no",
        "issue_url": issue["html_url"],
        "photo": "",
    }
    return None if contributions.row_errors(row) else row


def integrate(issues: list[dict], path: Path = contributions.PATH) -> Result:
    """Idempotently append accepted rows; duplicate/stale/conflicting records remain explicitly rejected."""
    result = Result()
    rows = contributions.read(path).to_dict("records") if path.exists() else []
    by_url = {r["issue_url"]: r for r in rows if r["issue_url"]}
    refs = {r["ref"]: r for r in rows}
    gids = {r["uuid"]: r["ref"] for r in rows if r["kind"] == "year" and r["uuid"].startswith("gid:")}
    pending = []
    for issue in issues:
        number = issue.get("number")
        try:
            url = issue.get("html_url", "")
            if url in by_url:
                result.skipped_existing.append(by_url[url]["ref"])
                continue
            row = contribution_row(issue)
            if row is None:
                raise Rejected("not a fully evidenced year contribution")
            if row["ref"] in refs:
                raise Rejected("reference already exists in the accepted table")
            if row["uuid"] in gids:
                raise Rejected(f"gid already accepted in {gids[row['uuid']]}; edit the existing data instead")
            pending.append(row)
            result.added.append(row["ref"])
        except Rejected as e:
            result.rejected.append({"number": number, "reason": str(e), "action": "needs-human"})
            continue
        if row["uuid"] in gids:
            result.added.remove(row["ref"])
            result.rejected.append({"number": number, "reason": "duplicate gid in this batch", "action": "needs-human"})
            continue
        gids[row["uuid"]] = row["ref"]
    if pending:
        # Preserve the original rows byte-for-byte in order. The writer, then reader, prove the real schema.
        contributions.write(rows + pending, path)
        contributions.read(path)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--issues-json", type=Path, required=True)
    parser.add_argument("--csv", type=Path, default=ROOT / "pipeline" / "contributions.csv")
    args = parser.parse_args(argv)
    raw = json.loads(args.issues_json.read_text(encoding="utf-8"))
    assert isinstance(raw, list), "the issue input must be the array returned by GitHub's Issues API"
    # `gh api --paginate --slurp` writes one array per page, so a build with two pages arrives as [[...], [...]];
    # a single page is [[...]] too. Flatten only lists, never an object that is not an issue.
    issues = [issue for page in raw for issue in (page if isinstance(page, list) else [page])]
    result = integrate([issue for issue in issues if isinstance(issue, dict)], args.csv)
    print(
        json.dumps(
            {"added": result.added, "skipped_existing": result.skipped_existing, "rejected": result.rejected},
            ensure_ascii=False,
            indent=2,
        )
    )
    for rejected in result.rejected:
        print(f"not proposed: issue #{rejected['number']}: {rejected['reason']} ({rejected['action']})")
    print(f"{len(result.added)} new candidate rows in {args.csv}; open a reviewed PR and merge it before running again")


if __name__ == "__main__":
    main()
