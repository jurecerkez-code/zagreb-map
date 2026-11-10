# Crowd dating: public issue → review → contribution PR

For an undated card — `UNKNOWN`, or a one-sided cadastre `BOUND` that names no construction year — **“Do you know
when it was built?”** opens GitHub's
[`year.yml` issue form](/.github/ISSUE_TEMPLATE/year.yml) with **gid**, any already-public card address,
and the labels `contributions,needs-human`. No Worker endpoint or guessed year API is called.

For a public building only: give the four-digit construction year, a public **HTTPS** source URL,
and a **one-sentence explanation of what it evidences**. Do not post residents’, owners’, or other
personal data. A bare source URL, a source-less “I think it is old”, a year span, a guessed uuid,
or a wrong gid is not accepted.

## Maintainer loop

1. Check the gid and the linked source, then add **`accepted`**. The form itself never carries `accepted`.
2. The weekly `.github/workflows/year-contributions.yml` (also manually dispatchable) reads open
   `accepted,contributions` issues. `accepted` is the human gate: it is never auto-added by the map or bot.
3. `scripts/year_contributions.py` parses those forms and appends new rows to `pipeline/contributions.csv`.
   A `gid:42` marker is **not a parcel UUID**: `pipeline/contributions.py` resolves it against the actual
   build's gid and refuses it if absent or ambiguous. Existing UUID-keyed rows retain their semantics.
   Two accepted year rows for one gid are not silently merged. A duplicate issue URL is idempotent;
   another URL for an already-used gid or ref is explicitly rejected as `needs-human`.
4. The workflow validates the table using the existing `pipeline.contributions` reader, then opens a
   reviewed PR on `crowd/building-years`. **No data version, production publication, `current.json` switch,
   or issue resolution is performed.** Merge an open contribution PR before running a new batch.
5. On the next Zagreb data build, the reader tier applies accepted, validated years after other records
   and the neighbour estimate, before privacy flags. Private-home rules remain as they were.
   Re-run both data generation and validation separately afterward; do not automatically publish a year.

To test the parser locally without the GitHub API, save the Issues API array as `issues.json`, make a
local copy of the CSV, and run `uv run python scripts/year_contributions.py --issues-json issues.json
--csv /path/to/local-check.csv`. `tests/test_year_contributions.py` exercises exactly this path against a
local copy and applies the resulting row to a real test footprint.
