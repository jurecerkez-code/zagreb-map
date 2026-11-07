from pipeline import city


def test_zagreb_has_named_owner_and_repository_contact():
    assert city.MAKER == "Jure Čerkez"
    assert city.CONTACT == "https://github.com/jurecerkez-code/zagreb-map"


def test_licence_gate_is_still_explicit_and_not_silently_cleared():
    assert "licence check of every source" in city.RELEASE_WAITS_FOR
