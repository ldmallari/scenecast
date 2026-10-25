import pytest

from scenecast_py.g2p import fetch_nltk_data, make_g2p, G2PFallback
from misaki.token import MToken


@pytest.fixture(scope="module")
def g2p():
    fetch_nltk_data()
    return make_g2p()


def test_phonemises_ui_sentence(g2p):
    ps, _ = g2p("Welcome to the dashboard. Tick the box and press Sign.")
    assert ps.strip()
    assert "❓" not in ps


def test_fallback_handles_unknown_word(g2p):
    ps, _ = g2p("Open the Zorblatrix panel.")
    assert "❓" not in ps
    fb = G2PFallback()
    out, _ = fb(MToken(text="zorblatrix", tag="NN", whitespace=""))
    assert out
