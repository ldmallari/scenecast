"""The audit's pronunciation check (scenecast_py.pronounce)."""
import pytest

from scenecast_py import pronounce
from scenecast_py.audit import run
from scenecast_py.narration import SceneSpeech

from tests.test_audit import fixture


@pytest.fixture(scope="module")
def g2p():
    from scenecast_py.g2p import make_g2p

    return make_g2p()


def heard(text, start=1.0, step=0.4):
    return [{"w": " " + w, "start": start + k * step, "end": start + k * step + 0.3} for k, w in enumerate(text.split())]


def check(narration, said, g2p, allow=(), say=None, forced=None):
    scene = {"id": "s1", "start": 0.0, "end": 30.0, "narration": narration}
    speech = SceneSpeech(scene, heard(said), list(allow), forced=forced)
    return pronounce.check_scene(scene, speech, lambda: g2p, say)


def test_a_name_heard_differently_is_flagged_with_time_and_a_say_suggestion(g2p):
    found = check("Send it to Mira Solano today.", "Send it to Meera Solana today.", g2p)
    assert len(found) == 1
    f = found[0]
    assert (f["expected"], f["heard"]) == ("Mira Solano", "Meera Solana")
    assert f["time"] == pytest.approx(2.2)  # the heard word's start (no forced times here)
    assert f["similarity"] >= pronounce.MIN_SIMILARITY
    assert f["suggestion"].startswith('Mira Solano: "/') and f["suggestion"].endswith('/"')


def test_the_forced_time_is_used_when_there_is_one(g2p):
    forced = [{"start": t} for t in (0.5, 0.9, 1.3, 2.75, 3.1, 3.6)]
    found = check("Send it to Mira Solano today.", "Send it to Meera Solana today.", g2p, forced=forced)
    assert found[0]["time"] == pytest.approx(2.75)


def test_acronyms_spelled_out_and_split_compounds_are_not_flagged(g2p):
    assert check("Ask the SKU team.", "Ask the S K U team.", g2p) == []
    assert check("Ask the SKU team.", "Ask the SKU team.", g2p) == []
    assert check("Open your worklist now.", "Open your work list now.", g2p) == []
    assert check("Open your work list now.", "Open your worklist now.", g2p) == []
    assert check("Pay 25 dollars.", "Pay twenty-five dollars.", g2p) == []


def test_an_acronym_heard_as_other_letters_suggests_its_letters(g2p):
    found = check("Ask the SKU team.", "Ask the SKV team.", g2p)
    assert [(f["expected"], f["heard"]) for f in found] == [("SKU", "SKV")]
    assert found[0]["suggestion"] == 'SKU: "S K U"'
    found = check("Check the SLAs now.", "Check the SLIs now.", g2p)
    assert found and found[0]["suggestion"] == "SLAs: \"S L A's\""


def test_homophones_filler_and_recognition_slips_are_not_flagged(g2p):
    assert check("Press Sign to finish.", "Press sine to finish.", g2p) == []  # the same sound
    assert check("Put it there now.", "Put it their now.", g2p) == []
    assert check("Open the dashboard now.", "Open the um dashboard now.", g2p) == []  # filler is an insert
    assert check("Open the dashboard now.", "Open the banana now.", g2p) == []  # nothing like it: a slip
    assert check("Open the dashboard now.", "Open the now.", g2p) == []  # left out: not pronunciation


def test_allow_listed_names_and_say_entries(g2p):
    assert check("Send it to Mira Solano.", "Send it to Meera Solana.", g2p, allow=["Mira Solano"]) == []
    # A replacement that was said and heard as written is fine.
    say = [{"from": 3, "to": 4, "text": "Meera"}]
    assert check("Send it to Mira now.", "Send it to Meera now.", g2p, say=say) == []
    # Phonemes given in say: are what the heard word is compared with.
    say = [{"from": 3, "to": 4, "ph": "mˈiɹə"}]
    assert check("Send it to Mira now.", "Send it to Meera now.", g2p, say=say) == []
    # A word with a say: entry that is still heard wrong gets a note, not a suggestion.
    say = [{"from": 3, "to": 4, "text": "Myra"}]
    found = check("Send it to Mira now.", "Send it to Moira now.", g2p, say=say)
    assert found and found[0]["suggestion"] is None and "already has a say: entry" in found[0]["note"]


def test_the_audit_reports_it_as_a_warn_by_default_a_fail_when_asked_and_skips_it_when_off(tmp_path):
    v = run(fixture(tmp_path, allowList=[]))
    pron = v["pronunciation"]
    assert pron["mode"] == "warn" and pron["verdict"] == "WARN"
    assert [(w["expected"], w["heard"]) for w in pron["words"]] == [("Mira Solano", "Meera Solana")]
    assert v["pass"] is True
    table = (tmp_path / "audit" / "audit-table.md").read_text()
    assert "## Pronunciation" in table and "| s1 | 2.500 | Mira Solano | Meera Solana |" in table
    assert 'Mira Solano: "/' in table

    failed = run(fixture(tmp_path, allowList=[], pronunciation="fail"))
    assert failed["pronunciation"]["verdict"] == "FAIL" and failed["pass"] is False

    off = run(fixture(tmp_path, allowList=[], pronunciation="off"))
    assert off["pronunciation"] == {"mode": "off", "verdict": "PASS", "words": []}
    assert "## Pronunciation" not in (tmp_path / "audit" / "audit-table.md").read_text()
