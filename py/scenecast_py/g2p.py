"""Licence-clean English G2P: misaki (Apache-2.0) with a g2p_en (Apache-2.0) fallback.

No eSpeak / phonemizer (GPL). NLTK data lives in the scenecast cache and is fetched by
`python -m scenecast_py.g2p --fetch` (run by the toolchain), never at first synthesis.
"""
import os
import sys
from pathlib import Path

NLTK_PACKAGES = {
    "taggers/averaged_perceptron_tagger_eng.zip": "averaged_perceptron_tagger_eng",
    "taggers/averaged_perceptron_tagger.zip": "averaged_perceptron_tagger",
    "corpora/cmudict.zip": "cmudict",
}

# ARPAbet -> misaki US phonemes
ARPA = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "W", "AY": "I", "B": "b", "CH": "ʧ",
    "D": "d", "DH": "ð", "EH": "ɛ", "ER": "ɜɹ", "EY": "A", "F": "f", "G": "ɡ", "HH": "h",
    "IH": "ɪ", "IY": "i", "JH": "ʤ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "O", "OY": "Y", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ",
    "UH": "ʊ", "UW": "u", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}


def cache_dir() -> Path:
    return Path(os.environ.get("SCENECAST_CACHE") or Path.home() / ".cache" / "scenecast")


def _setup_nltk() -> Path:
    d = Path(os.environ.get("NLTK_DATA") or cache_dir() / "nltk")
    os.environ["NLTK_DATA"] = str(d)
    return d


def fetch_nltk_data() -> None:
    import nltk

    d = _setup_nltk()
    d.mkdir(parents=True, exist_ok=True)
    for path, name in NLTK_PACKAGES.items():
        try:
            nltk.data.find(path, paths=[str(d)])
        except LookupError:
            if not nltk.download(name, download_dir=str(d), quiet=True):
                raise RuntimeError(f"could not download nltk data {name}")


def arpa_to_misaki(phones: list[str]) -> str:
    out = []
    for p in phones:
        base, stress = (p[:-1], p[-1]) if p[-1].isdigit() else (p, "")
        if base not in ARPA:
            continue
        sym = ARPA[base]
        if base == "AH" and stress == "0":
            sym = "ə"
        elif base == "ER" and stress == "0":
            sym = "əɹ"
        if stress == "1":
            out.append("ˈ")
        elif stress == "2":
            out.append("ˌ")
        out.append(sym)
    return "".join(out)


class G2PFallback:
    """misaki `fallback` hook: called with an MToken, returns (phonemes, rating)."""

    def __init__(self):
        _setup_nltk()
        from g2p_en import G2p

        self._g2p = G2p()

    def __call__(self, token):
        ps = arpa_to_misaki([p for p in self._g2p(token.text) if p.strip() and p[0].isalpha()])
        return (ps, 1) if ps else (None, None)


def make_g2p(british: bool = False):
    from misaki import en

    return en.G2P(trf=False, british=british, fallback=G2PFallback())


if __name__ == "__main__":
    if "--fetch" in sys.argv:
        fetch_nltk_data()
        print("nltk data ready")
