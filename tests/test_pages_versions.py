"""Pages must retain both immutable datasets named by current.json."""
import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CITY = "v20261103-fix"
TRAMS = "v20261107-t2ddf4051"


@pytest.mark.skipif(os.name == "nt", reason="Runs the Linux CI shell command.")
@pytest.mark.parametrize("independent_timetable", [True, False])
def test_pages_retains_the_datasets_current_config_names(tmp_path, independent_timetable):
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8"))
    prune = next(step["run"] for step in workflow["jobs"]["deploy"]["steps"]
                 if step.get("name") == "Prune data versions the site does not serve")

    data = tmp_path / "web" / "data"
    data.mkdir(parents=True)
    config = {"version": CITY}
    if independent_timetable:
        config["trams_version"] = TRAMS
    (data / "current.json").write_text(json.dumps(config), encoding="utf-8")
    for version in [CITY, TRAMS, "v20260101-unused"]:
        (data / version).mkdir()
        (data / version / "asset.json").write_text("{}", encoding="utf-8")

    result = subprocess.run(["bash", "-e", "-o", "pipefail"], cwd=tmp_path,
                            input=prune, text=True, capture_output=True, check=False,
                            env=None)

    assert result.returncode == 0, result.stderr + result.stdout
    expected = {CITY, TRAMS} if independent_timetable else {CITY}
    assert {path.name for path in data.iterdir() if path.is_dir()} == expected, result.stdout
    assert (data / "current.json").is_file()
