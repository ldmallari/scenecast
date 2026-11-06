"""The audit's pronunciation check: script words the transcript heard as something else, with a `say:` suggestion.

The free transcript is already aligned with the script (narration.SceneSpeech, on normalised tokens: case and
punctuation dropped, numbers spelled out). A word is flagged only when the voice most likely said it differently,
not when the recogniser slipped:

- only a replaced span counts (a word heard as other words), at most MAX_SCRIPT_TOKENS script tokens long; words left
  out or added are not pronunciation;
- filler ("um", "uh") is ignored, and so are allow-listed names;
- the two sides joined without spaces must differ ("work list" is "worklist", "S K U" is "SKU");
- a word with a `say:` replacement is compared with the replacement;
- the two sides' phonemes (misaki, stress marks dropped) must differ (homophones such as "two"/"to" are the same
  sound), and be at least MIN_SIMILARITY alike: a heard word that sounds nothing like the script word is a
  recognition slip, not a mispronunciation.
"""
import bisect
import difflib
import re

from scenecast_py.narration import normalise_words

FILLER = {"um", "uh", "er", "erm", "ah", "eh", "hmm", "mm", "mhm"}
MAX_SCRIPT_TOKENS = 3
MAX_HEARD_TOKENS = 4
MIN_SIMILARITY = 0.5
ACRONYM = re.compile(r"^([A-Z]{2,6})(s?)$")
_STRIP_PH = re.compile(r"[ˈˌː\s.,;:!?—…\"“”()]")


def _phonemes(g2p, text):
    if not text.strip():
        return ""
    ps, _ = g2p(text)
    return _STRIP_PH.sub("", ps or "")


def similarity(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() if a and b else 0.0


def suggestion(word, g2p):
    """A `say:` entry to start from: an acronym's letters, else misaki's phonemes for the word or words (to edit)."""
    core = word.strip(".,;:!?\"'()[]{}“”‘’…")
    m = ACRONYM.match(core)
    if m:
        letters = " ".join(m.group(1)) + ("'s" if m.group(2) else "")
        return f'{core}: "{letters}"'
    ps, _ = g2p(core)
    ps = re.sub(r"[.,;:!?…]", "", ps or "").strip()
    return f'{core}: "/{ps}/"' if ps else None


def check_scene(scene, speech, g2p_factory, say_spans=None):
    """Flagged words for one scene: [{scene, time, expected, heard, similarity, suggestion}].

    `speech` is the scene's narration.SceneSpeech; `g2p_factory()` returns a misaki G2P (called only when there is a
    candidate); `say_spans` are the scene's pronunciation spans on narration word indices ({from, to, text?, ph?}).
    """
    words = scene["narration"].split()
    by_word = {}
    for s in say_spans or []:
        for i in range(s["from"], s["to"]):
            by_word[i] = s
    out, g2p = [], None
    for tag, i1, i2, j1, j2 in speech.ops:
        if tag != "replace" or i2 - i1 > MAX_SCRIPT_TOKENS:
            continue
        heard_idx = [j for j in range(j1, j2) if speech.heard[j] not in FILLER]
        if not heard_idx or len(heard_idx) > MAX_HEARD_TOKENS:
            continue
        if all(i in speech.allowed for i in range(i1, i2)):
            continue
        expected_tokens = speech.script[i1:i2]
        heard_tokens = [speech.heard[j] for j in heard_idx]
        if "".join(expected_tokens) == "".join(heard_tokens):
            continue
        w1 = bisect.bisect_right(speech.word_token, i1) - 1
        w2 = bisect.bisect_right(speech.word_token, i2 - 1) - 1
        expected = " ".join(words[w1:w2 + 1])
        span = by_word.get(w1)
        said_text = expected
        if span is not None and span.get("text"):
            said_text = span["text"]
            if "".join(normalise_words(said_text)) == "".join(heard_tokens):
                continue
        owners = list(dict.fromkeys(speech.owner[j] for j in heard_idx))
        heard = " ".join(speech.words[o]["w"].strip() for o in owners)
        if g2p is None:
            g2p = g2p_factory()
        want = span["ph"] if span is not None and span.get("ph") else _phonemes(g2p, said_text)
        want = _STRIP_PH.sub("", want)
        got = _phonemes(g2p, heard)
        if want == got:
            continue  # the same sound (homophones, spellings)
        sim = similarity(want, got)
        if sim < MIN_SIMILARITY:
            continue
        forced, _src = speech._forced_time(w1)
        t = forced if forced is not None else float(speech.words[speech.owner[heard_idx[0]]]["start"])
        entry = {"scene": scene["id"], "time": round(float(t), 3), "expected": expected.strip(".,;:!?\"“”"),
                 "heard": heard.strip(".,;:!?\"“”"), "similarity": round(sim, 2)}
        if span is None:
            entry["suggestion"] = suggestion(" ".join(words[w1:w2 + 1]), g2p)
        else:
            entry["suggestion"] = None
            entry["note"] = "this word already has a say: entry; try another spelling or phonemes"
        out.append(entry)
    return out


def verdict(found, mode, PASS="PASS", WARN="WARN", FAIL="FAIL"):
    if mode == "off" or not found:
        return PASS
    return FAIL if mode == "fail" else WARN
