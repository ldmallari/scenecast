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


def test_fetch_keeps_the_nltk_folder_private_under_umask_002(tmp_path, monkeypatch):
    """NLTK refuses to install into a group-writable folder; a umask of 002 would make one."""
    import os
    import stat

    import nltk

    d = tmp_path / "nltk"
    monkeypatch.setenv("NLTK_DATA", str(d))
    seen = []
    monkeypatch.setattr(nltk.data, "find", lambda *a, **k: (_ for _ in ()).throw(LookupError("missing")))
    monkeypatch.setattr(nltk, "download", lambda name, download_dir, quiet: seen.append(oct(os.stat(download_dir).st_mode)) or True)
    old = os.umask(0o002)
    try:
        fetch_nltk_data()
    finally:
        os.umask(old)
    assert len(seen) == 3
    assert not stat.S_IMODE(d.stat().st_mode) & (stat.S_IWGRP | stat.S_IWOTH)
