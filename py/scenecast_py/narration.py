"""Narration check for the audit: normalise script and heard words, align them, find cue word times.

Numbers are spelled out by a small built-in converter (no third-party number library), so "2" and
"two" compare equal on both sides.
"""
import bisect
import difflib
import re

_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand"))
_ORDINAL = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
            "nine": "ninth", "twelve": "twelfth"}
# An allow-listed name may come back as this many more heard tokens than it has (e.g. "Mira" -> "An na").
_ALLOW_SLACK = 1
SCENE_EDGE_SEC = 0.05  # recognised times this close to the scene start count as inside it
# A word stamped before the scene counts only when it runs this far into it (a stretched tail of the previous scene,
# or a short false word in the pre-roll, does not).
SCENE_RUN_ON_SEC = 0.15


def _under_thousand(n):
    out = []
    if n >= 100:
        out += [_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        out.append(_TENS[n // 10])
        n %= 10
        if n:
            out.append(_ONES[n])
    elif n or not out:
        out.append(_ONES[n])
    return out


def number_to_words(n):
    """English words for a non-negative integer, e.g. 1200 -> ["one", "thousand", "two", "hundred"]."""
    if n >= 10**15:
        return [_ONES[int(d)] for d in str(n)]
    if n == 0:
        return ["zero"]
    out = []
    for value, name in _SCALES:
        if n >= value:
            out += _under_thousand(n // value) + [name]
            n %= value
    if n:
        out += _under_thousand(n)
    return out


def _ordinal(words):
    last = words[-1]
    if last in _ORDINAL:
        last = _ORDINAL[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return words[:-1] + [last]


_NUMBER = re.compile(r"^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(st|nd|rd|th)?$")
_CLOCK = re.compile(r"^(\d{1,2}):(\d{2})$")
_STRIP = ".,;:!?\"'()[]{}“”‘’…"


def _token_words(piece):
    w = piece.strip(_STRIP)
    if not w:
        return []
    if w == "&":
        return ["and"]
    clock = _CLOCK.match(w)
    if clock:
        h, m = int(clock.group(1)), int(clock.group(2))
        return number_to_words(h) + ([] if m == 0 else ["oh", _ONES[m]] if m < 10 else number_to_words(m))
    post = []
    if w.startswith("$"):
        w, post = w[1:], ["dollars"]
    if w.endswith("%"):
        w, post = w[:-1], ["percent"] + post
    m = _NUMBER.match(w)
    if m:
        whole, frac, suffix = m.groups()
        words = number_to_words(int(whole.replace(",", "")))
        if suffix and not frac:
            words = _ordinal(words)
        if frac and not (post == ["dollars"] and set(frac) == {"0"}):  # "$1,500.00" is "$1,500"
            words += ["point"] + [_ONES[int(d)] for d in frac]
        return words + post
    w = re.sub(r"[^a-z0-9]", "", w.replace("’", "").replace("'", ""))
    return ([w] if w else []) + post


def normalise_words(text):
    """Lowercase comparable tokens: punctuation dropped, hyphens split, numbers and clock times spelled out."""
    out = []
    for piece in re.split(r"[\s\-–—/]+", text.lower()):
        out += _token_words(piece)
    return out


def _find(tokens, needle, occ):
    """Index of the `occ`-th non-overlapping occurrence of `needle` in `tokens`, or None."""
    if not needle:
        return None
    seen, i = 0, 0
    while i + len(needle) <= len(tokens):
        if tokens[i:i + len(needle)] == needle:
            seen += 1
            if seen == occ:
                return i
            i += len(needle)
        else:
            i += 1
    return None


def _allowed_positions(script, allow_list):
    allowed = set()
    for name in allow_list:
        needle = normalise_words(name)
        if not needle:
            continue
        for i in range(len(script) - len(needle) + 1):
            if script[i:i + len(needle)] == needle:
                allowed.update(range(i, i + len(needle)))
    return allowed


class SceneSpeech:
    """The scene's script aligned to what was heard in its time window."""

    def __init__(self, scene, words, allow_list, forced=None):
        # Script tokens word by word (whitespace split, as the voice timeline and scheduler count words),
        # so a cue's word index maps to its first token.
        self.script, self.word_token = [], []
        for w in scene["narration"].split():
            self.word_token.append(len(self.script))
            self.script += normalise_words(w)
        # A word belongs to the scene when it starts in it, or runs on past its start: free decoding of a window that
        # begins in the silence before the scene stamps the first word with the window's start.
        self.words = [w for w in words if w["start"] < scene["end"]
                      and (w["start"] >= scene["start"] - SCENE_EDGE_SEC or w["end"] - scene["start"] >= SCENE_RUN_ON_SEC)]
        self.heard, self.owner = [], []
        for i, w in enumerate(self.words):
            for t in normalise_words(w["w"]):
                self.heard.append(t)
                self.owner.append(i)
        self.matcher = difflib.SequenceMatcher(None, self.script, self.heard, autojunk=False)
        self.ops = self.matcher.get_opcodes()
        self.pairs = {}
        for tag, i1, i2, j1, _j2 in self.ops:
            if tag == "equal":
                for k in range(i2 - i1):
                    self.pairs[i1 + k] = j1 + k
        self.allowed = _allowed_positions(self.script, allow_list)
        # Phrase windows (video clock) by narration word: a heard word can't start outside its phrase.
        self.word_phrase = []
        phrases = scene.get("phrases") or []
        if sum(p["words"] for p in phrases) == len(self.word_token):
            for p in phrases:
                self.word_phrase += [(p["start"], p["end"])] * p["words"]
        # Forced-aligned times by narration word ({start} per whitespace word, start None where a phrase could not be
        # aligned); used only when they line up with the narration word for word.
        self.forced = forced if forced is not None and len(forced) == len(self.word_token) else None

    def _clamp(self, t, word):
        """Clamp a heard start time into the phrase window of narration word `word`.

        The voice track places each phrase at a known time, so a word heard before its phrase starts (or
        after it ends) is a recognition timing error, not something the viewer hears.
        """
        if not self.word_phrase or word is None or not 0 <= word < len(self.word_phrase):
            return t
        lo, hi = self.word_phrase[word]
        return min(max(t, lo), hi)

    def _heard_index(self, i):
        """Heard token for script token i: equal blocks map exactly; a replaced (misheard) span maps by position."""
        if i in self.pairs:
            return self.pairs[i]
        for tag, i1, i2, j1, j2 in self.ops:
            if tag == "replace" and i1 <= i < i2:
                return j1 + min(i - i1, j2 - j1 - 1)
        return None

    def _forced_time(self, word):
        """The forced-aligned start of narration word `word`, kept inside its phrase, and its source ("forced" or
        "onset"), or (None, None)."""
        if self.forced is None or word is None or not 0 <= word < len(self.forced):
            return None, None
        t = self.forced[word].get("start")
        if t is None:
            return None, None
        return self._clamp(float(t), word), self.forced[word].get("from") or "forced"

    def cue_time(self, cue, occ, word_index=None):
        """Start time of the heard word for the cue, or None if it was not heard at all (see cue_timing)."""
        return self.cue_timing(cue, occ, word_index)[0]

    def cue_timing(self, cue, occ, word_index=None):
        """(start time, source) of the heard word for the cue, or (None, None) if it was not heard at all. The source
        is "forced" or "onset" (forced alignment) or "free" (the transcript).

        Whether the cue was heard comes from the free transcript (an equal or replace opcode, or an allow-listed
        position); its time comes from forced alignment when there is one, else from the transcript.

        `word_index` is the cue's first word in the narration as the scheduler counted it; without it the
        cue's occ-th occurrence in the normalised script is used.
        """
        if word_index is not None and 0 <= word_index < len(self.word_token):
            i = self.word_token[word_index]
        else:
            i = _find(self.script, normalise_words(cue), occ)
            word_index = None if i is None else bisect.bisect_right(self.word_token, i) - 1
        if i is None or i >= len(self.script):
            return None, None
        j = self._heard_index(i)
        if j is None and i not in self.allowed:
            return None, None
        forced, source = self._forced_time(word_index)
        if forced is not None:
            return forced, source
        if j is not None:
            return self._clamp(float(self.words[self.owner[j]]["start"]), word_index), "free"
        t = self._allowed_gap_time(i, word_index)
        return t, (None if t is None else "free")

    def _allowed_gap_time(self, i, word_index):
        """An allow-listed cue the recogniser left out (a `delete`): place it by position, where the heard words
        around it leave a gap for it, the same way a misheard (replaced) word maps by position. The start is the
        end of the heard word before the gap (or the start of the one after it), kept inside the phrase."""
        for tag, i1, i2, j1, _j2 in self.ops:
            if tag == "delete" and i1 <= i < i2:
                if j1 > 0:
                    t = float(self.words[self.owner[j1 - 1]]["end"])
                elif j1 < len(self.heard):
                    t = float(self.words[self.owner[j1]]["start"])
                else:
                    return None
                return self._clamp(t, word_index)
        return None

    def diff(self):
        """Differences outside the allow-list, as '-"script" +"heard"' strings.

        An allow-listed name may be heard differently, but only within a token of its own length:
        extra heard words around it are still reported.
        """
        out = []
        for tag, i1, i2, j1, j2 in self.ops:
            if tag == "equal":
                continue
            span = range(i1, i2)
            if tag in ("replace", "delete") and all(i in self.allowed for i in span) and j2 - j1 <= (i2 - i1) + _ALLOW_SLACK:
                continue
            if tag == "insert" and (i1 - 1 in self.allowed or i1 in self.allowed) and j2 - j1 <= _ALLOW_SLACK:
                continue
            said = " ".join(self.script[i1:i2])
            heard = " ".join(self.heard[j1:j2])
            out.append(f'-"{said}" +"{heard}"' if said and heard else (f'-"{said}"' if said else f'+"{heard}"'))
        return out
