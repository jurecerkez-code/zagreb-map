"""The research spike refuses unvalidated classifier output, without inventing a precision result."""

from pathlib import Path

import pytest


def test_two_licensed_epochs_and_the_evidence_gate_are_documented():
    text = Path("docs/research/epochs.md").read_text()
    assert "## Decision: `needs-human`" in text
    for endpoint in ("orthophoto_2011/wms", "orthophoto_2018/wms"):
        assert endpoint in text
    for date in ("2011-06-21", "2018-09-06"):
        assert date in text
    assert "dateStamp`: **2026-09-09**" in text
    assert "dateStamp`: **2026-03-31**" in text
    for right in (
        "explicit Croatian Open Licence",
        "Otvorena dozvola RH",
        "reproduction, redistribution and adaptation",
    ):
        assert right in text


def test_sample_metrics_are_actual_observations_not_a_precision_claim():
    text = Path("docs/research/epochs.md").read_text()
    for token in (
        "131,946",
        "135,602",
        "08eb29396d14d20cf99a782fc1bf07964fac4c1dd090ade1960f919e6023daf6",
        "54a6b6c48a7a23311acf6d2005f66717e613a289ea1df875da0fc8972f846cac",
        "0.61",
        "0.87",
    ):
        assert token in text
    assert "No `EPOCH` class, production year change, or precision claim is made." in text
    assert "per-class precision" in text
    assert "At least 90%" not in text  # the required minimum, never an achieved percentage
    assert "≥90% precision in every published class" in text
    assert "stop" in text.lower()


def test_no_classifier_or_production_epoch_came_from_the_feasibility_failure():
    text = Path("docs/research/epochs.md").read_text()
    assert "full-city/cache manifest" in text
    assert "balanced" in text
    assert "3 m external buffer" in text
    assert "per-class precision" in text
    for class_name in ("pipeline/years_image.py", "pipeline/epoch_classifier.py"):
        assert not Path(class_name).exists(), f"unvalidated classifier appeared: {class_name}"
    assert "HTTP 404" in text
    assert "not independently established" in text
    assert "production migration or `current.json` change" in text


@pytest.mark.parametrize("token", ["[1]", "[2]", "[3]", "[4]", "[5]", "[6]", "[7]", "[8]", "[9]", "[10]", "[11]"])
def test_its_selected_sources_and_project_stop_rule_are_linked(token):
    text = Path("docs/research/epochs.md").read_text()
    assert token in text
    assert "## Sources" in text
