"""Run the scenarios in features/*.feature that carry a @check: tag.

    uv run python scripts/gherkin.py [features/x.feature]

No framework: a scenario that matters names the command that proves it, and this runs the commands and reports.
@pending:reason and @manual are listed but not run, so an unproven scenario stays visible instead of passing quietly.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def scenarios(text):
    """(tags, scenario name) for each scenario, plus its @check command if it has one."""
    tags = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("@check:"):
            tags = [s]          # the rest of the line is the command: spaces and all, not a word list
        elif s.startswith("@"):
            tags = s.split()
        elif s.startswith("Scenario:"):
            name = s.split(":", 1)[1].strip()
            check = next((t[len("@check:"):].strip() for t in tags if t.startswith("@check:")), None)
            state = next((t[1:] for t in tags if t.startswith(("@pending", "@manual"))), None)
            if check and check.startswith("manual"):
                state, check = check, None       # @check:manual:<what> is a scenario a person proves, not a command
            yield name, check, state
            tags = []


def main(argv):
    files = [Path(a) for a in argv] or sorted((ROOT / "features").glob("*.feature"))
    failed = 0
    for f in files:
        print(f"\n{f.name}")
        for name, check, state in scenarios(f.read_text(encoding="utf-8")):
            if state:
                print(f"  SKIP  {name}  ({state})")
                continue
            if not check:
                print(f"  TODO  {name}  (no check tagged)")
                continue
            try:
                r = subprocess.run(check, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=90)
                ok, out0 = r.returncode == 0, (r.stdout or r.stderr)
            except subprocess.TimeoutExpired:
                ok, out0 = False, 'timed out after 90 s'
            r = type('R', (), {'returncode': 0 if ok else 1, 'stdout': out0, 'stderr': ''})()
            failed += not ok
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")
            out = (r.stdout or r.stderr).strip().splitlines()
            if not ok or out:
                print(f"        {out[-1][:160] if out else 'no output'}")
    print(f"\n{failed} failing")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
