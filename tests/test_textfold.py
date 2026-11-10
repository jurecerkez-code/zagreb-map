"""pipeline/textfold.py: the search fold, pinned by the vectors web/fold.js is tested against too."""
import json
from pathlib import Path

import pytest

from pipeline.textfold import fold, street_variants

VECTORS = json.loads((Path(__file__).parent.parent / "web/test/fixtures/fold.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(("text", "folded"), VECTORS)
def test_fold_matches_the_shared_vectors(text, folded):
    assert fold(text) == folded


def test_fold_is_idempotent():
    for text, folded in VECTORS:
        assert fold(folded) == folded, text


def test_croatian_street_lookup_variants_do_not_merge_names():
    assert street_variants("Ulica Đakovačka") == ["ulica dakovacka", "dakovacka"]
    assert street_variants("Đakovačka ulica") == ["dakovacka ulica", "dakovacka"]
    assert street_variants("ul. Đakovačka") == ["ul dakovacka", "dakovacka"]
    assert street_variants("Cesta Grgura Ninskog") == ["cesta grgura ninskog", "grgura ninskog"]
    assert street_variants("Hornsgatan") == ["hornsgatan"]
    assert street_variants("Ulica") == ["ulica"]       # a descriptor by itself never becomes an empty street
