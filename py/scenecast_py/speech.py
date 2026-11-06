"""What the voice says for a phrase, and how its timing maps back onto the script's words.

A phrase comes from the TypeScript side (packages/core/src/speech.ts, voicePlan) as
  {"text": str, "speed": float, "spans": [{from, to, text?|ph?|word?, before, after}], "stress": [int]}
or, as before 1.3, a plain string. `text` is the clean script: the words captions show and cues match.

Each phrase becomes units: a unit covers script words [from, to) and has
  - `tts`: what Kokoro is given for them (misaki markup: `[word](/phonemes/)`, `[word](+2)`), and
  - `spoken`: the words the forced aligner is given for them (a replacement's words, else the script words).
`map_times` turns the aligner's times for the spoken words back into one time per script word.
"""
import re

ACRONYM = re.compile(r"^([A-Z]{2,6})(s?)$")
EDGE = re.compile(r"^(\W*)(.*?)(\W*)$", re.S)
STRESS = "+2"  # misaki: raise the word to primary stress


def split_edges(word):
    """(lead, core, trail): the punctuation before and after a word's letters and digits."""
    m = EDGE.match(word)
    lead, core, trail = m.group(1), m.group(2), m.group(3)
    # \W leaves "_" in the core; edge underscores are not word characters for this purpose either.
    return lead, core, trail


def as_phrase(p):
    """A phrase in the 1.3 form (a plain string is a phrase with no marks)."""
    if isinstance(p, str):
        return {"text": p, "spans": [], "stress": []}
    return {"text": p["text"], "speed": p.get("speed"), "spans": p.get("spans") or [], "stress": p.get("stress") or []}


def _known(lexicon, word):
    return any(w in lexicon.golds or w in lexicon.silvers for w in (word, word.lower()))


def acronym_phonemes(core, lexicon):
    """misaki phonemes spelling `core` letter by letter, or None when it is not an acronym: 2 to 6 capital letters
    (plus an optional trailing "s", as in "IDs") that misaki's dictionaries don't know as a word (NASA, SCUBA, OK and
    ID are known and left to misaki)."""
    m = ACRONYM.match(core)
    if not m or lexicon is None:
        return None
    base, plural = m.group(1), m.group(2)
    if _known(lexicon, core) or _known(lexicon, base):
        return None
    ps, _rating = lexicon.get_NNP(base)
    if not ps:
        return None
    return lexicon._s(ps) if plural else ps


def units(phrase, lexicon=None, acronyms=True):
    """The phrase's units in order, covering every script word once: [{from, to, tts, spoken}]."""
    words = phrase["text"].split()
    spans = sorted(phrase["spans"], key=lambda s: s["from"])
    stress = set(phrase["stress"])
    out, i, k = [], 0, 0
    while i < len(words):
        if k < len(spans) and spans[k]["from"] == i:
            s = spans[k]
            k += 1
            joined = " ".join(words[s["from"]:s["to"]])
            before, after = s.get("before", ""), s.get("after", "")
            core = joined[len(before):len(joined) - len(after)] if after else joined[len(before):]
            if s.get("text") is not None:
                said = f'{before}{s["text"]}{after}'
                out.append({"from": s["from"], "to": s["to"], "tts": said, "spoken": said.split()})
            elif s.get("ph") is not None:
                out.append({"from": s["from"], "to": s["to"], "tts": f'{before}[{core}](/{s["ph"]}/){after}',
                            "spoken": words[s["from"]:s["to"]]})
            else:  # said as a word, never spelled out
                out.append({"from": s["from"], "to": s["to"], "tts": f"{before}{core.lower()}{after}",
                            "spoken": words[s["from"]:s["to"]]})
            i = s["to"]
            continue
        w = words[i]
        lead, core, trail = split_edges(w)
        tts = w
        ps = acronym_phonemes(core, lexicon) if acronyms else None
        if ps:
            tts = f"{lead}[{core}](/{ps}/){trail}"
        elif ACRONYM.match(core) and not acronyms and lexicon is not None and not _known(lexicon, core):
            tts = f"{lead}{core.lower()}{trail}"  # acronyms off: read as a word
        elif i in stress and core:
            tts = f"{lead}[{core}]({STRESS}){trail}"
        out.append({"from": i, "to": i + 1, "tts": tts, "spoken": [w]})
        i += 1
    return out


def tts_text(us):
    return " ".join(u["tts"] for u in us)


def spoken_text(us):
    return " ".join(w for u in us for w in u["spoken"])


def map_times(us, script_words, timed):
    """One {w, start, end, from} per script word, from `timed` (one entry per spoken word, in order).

    A unit whose spoken words are its script words one to one copies their times. Otherwise (a replacement) the first
    script word starts with the first spoken word, the last ends with the last spoken word, and the script words in
    between share that time by character position."""
    out, j = [], 0
    for u in us:
        got = timed[j:j + len(u["spoken"])]
        j += len(u["spoken"])
        mine = script_words[u["from"]:u["to"]]
        if not got:
            raise ValueError("a unit has no spoken words")
        if len(got) == len(mine) and u["spoken"] == mine:
            out += [{**g, "w": w} for g, w in zip(got, mine)]
            continue
        start, end = got[0]["start"], max(got[-1]["end"], got[0]["start"])
        total = sum(len(w) for w in mine) + len(mine) - 1
        pos = 0
        for w in mine:
            a = start + (end - start) * pos / total
            pos += len(w)
            b = start + (end - start) * pos / total
            pos += 1
            out.append({"w": w, "start": a, "end": b, "from": got[0].get("from", "forced"),
                        **({"p": got[0]["p"]} if "p" in got[0] else {})})
    return out
