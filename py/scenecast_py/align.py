"""Forced alignment of a known script with faster-whisper's own aligner.

`WhisperModel.find_alignment` runs CTranslate2's cross-attention alignment of given text tokens against the audio
(faster-whisper uses it for `word_timestamps`). Given the script, it returns one time for each script word: none are
missed, merged or invented, unlike free decoding. It needs no new dependency or model (the cached `small.en`).

Whisper's alignment path always starts at the first audio frame, so a first word after silence would get the start
of the clip. `align_text` therefore cuts the leading silence, up to the first speech that Silero VAD finds (the VAD
model ships inside faster-whisper, MIT) moved back to where its first sound begins, and gives the first word that
onset. Later words are not affected.

The model must come from `scenecast_py.whisper.whisper_model`, which keeps PyAV from loading.
"""
import re
import sys

import numpy as np

WHISPER_RATE = 16000
WINDOW_SEC = 30  # Whisper's encoder sees 30 s at a time
N_SAMPLES = WINDOW_SEC * WHISPER_RATE
N_FRAMES = 3000  # mel frames in 30 s (hop 160)
HOP = 160
ALIGN_FRAME_SEC = 0.02  # the aligner's time step (one encoder frame)
ONSET_CONTEXT_SEC = 0.05  # audio kept before the speech onset when the leading silence is cut
VAD_THRESHOLD = 0.5  # Silero speech probability (faster-whisper's default)
VAD_MIN_SILENCE_MS = 100  # a pause shorter than this does not end a speech chunk
VAD_SPEECH_PAD_MS = 0  # no padding: the chunk start is the onset


class AlignmentError(ValueError):
    """The aligner's output for a phrase can't be trusted (empty, not covering the text, or going backwards)."""


def log(message):
    """A diagnostic line on stderr (the CLI shows it with the stage output)."""
    print(f"scenecast: align: {message}", file=sys.stderr, flush=True)


def _spell(text):
    return re.sub(r"\s+", "", text)


def check_pieces(text, token_words):
    """Why the aligner's pieces can't time `text` word by word, or None when they can: there must be pieces, they
    must spell the text exactly (non-space characters), and every whitespace word must have a piece of its own."""
    if not token_words:
        return "the aligner returned no words"
    if _spell("".join(t["word"] for t in token_words)) != _spell(text):
        return "the aligned pieces don't spell the text"
    return None


def words_from_tokens(text, token_words):
    """Maps Whisper's word pieces (`find_alignment` output: {word, start, end, probability?}) back to the whitespace
    words of `text`, by character span.

    Whisper splits "Sign-in" into " Sign", "-", "in" and "email," into " email", ","; each whitespace word takes the
    start of its first piece and the end of its last. Spans count non-space characters only, so the leading space of
    a piece doesn't matter. If the pieces don't spell the text exactly (a decode difference), their positions are
    scaled onto the text. The result always has one entry per `text.split()` word, in order, as {w, start, end, p};
    a word no piece covers takes the previous word's end (0.0 at the start), so times never go backwards. Whether the
    result can be trusted is `check_pieces`'s call, not this function's.
    """
    words = text.split()
    spans, pos = [], 0
    for w in words:
        spans.append((pos, pos + len(w)))
        pos += len(w)
    total = pos

    pieces, pos = [], 0
    for t in token_words:
        n = len(_spell(t["word"]))
        pieces.append((pos, pos + n, t))
        pos += n
    scale = total / pos if pos and pos != total else 1.0

    out, prev_end = [], 0.0
    for w, (a, b) in zip(words, spans):
        hits = [t for lo, hi, t in pieces if lo * scale < b and hi * scale > a]
        if not hits:  # zero-width pieces (or none at all): the nearest piece at or before this word
            hits = [t for lo, hi, t in pieces if lo * scale <= a][-1:]
        if hits:
            start, end = float(hits[0]["start"]), float(hits[-1]["end"])
            probs = [float(t["probability"]) for t in hits if t.get("probability") is not None]
            p = sum(probs) / len(probs) if probs else None
        else:
            start = end = prev_end
            p = None
        start = max(start, out[-1]["start"] if out else 0.0)
        end = max(end, start)
        out.append({"w": w, "start": start, "end": end, "p": p})
        prev_end = end
    return out


def is_lexical(word):
    """A word with a letter or a digit in it. Punctuation-only words (" — ", "-") are usually silent: the aligner can
    give them no frames, so they may share a start with their neighbour."""
    return re.search(r"[^\W_]", word) is not None


def check_times(words):
    """Why the word times can't be trusted, or None: no start may come before the one before it, and each word with
    a letter or digit must start strictly after the previous such word (all zeros, or two spoken words on one frame,
    means the aligner had nothing to go on). Punctuation-only words may tie."""
    last = None
    for a, b in zip(words, words[1:]):
        if b["start"] < a["start"]:
            return f'"{b["w"]}" starts before "{a["w"]}" ({b["start"]:.3f} s vs {a["start"]:.3f} s)'
    for w in words:
        if not is_lexical(w["w"]):
            continue
        if last is not None and not w["start"] > last["start"]:
            return f'"{w["w"]}" does not start after "{last["w"]}" ({w["start"]:.3f} s vs {last["start"]:.3f} s)'
        last = w
    return None


ONSET_FRAME = 160  # 10 ms energy frames
ONSET_LOOKBACK = 30  # frames (0.3 s) the onset may lie before the VAD's
ONSET_BRIDGE = 8  # quieter frames (80 ms: a stop closure, as in "speed") bridged while walking back
ONSET_OVER_FLOOR_DB = 8
ONSET_UNDER_PEAK_DB = 45


def refine_onset(pcm16k, vad_start):
    """Moves a VAD speech start (in samples) back to where the sound of the first word begins.

    Silero VAD marks voiced speech, so it starts late on a word that opens with a fricative or a stop ("speed",
    "Fine"), by up to ~0.2 s. Walking back from it over 10 ms frames that are louder than the clip's floor (its
    quietest 10% before the VAD start, plus 8 dB; never lower than 45 dB under its peak), bridging up to 80 ms of
    quieter frames, finds that sound. A music bed louder than the consonant hides it, and the VAD start stands.
    Returns seconds from the start of the clip.
    """
    n = len(pcm16k) // ONSET_FRAME
    v = min(int(vad_start) // ONSET_FRAME, n)
    if n == 0 or v == 0:
        return v * ONSET_FRAME / WHISPER_RATE
    frames = np.asarray(pcm16k[: n * ONSET_FRAME], dtype=np.float64).reshape(n, ONSET_FRAME)
    db = 10 * np.log10(np.mean(frames**2, axis=1) + 1e-20)
    threshold = max(float(np.percentile(db[:v], 10)) + ONSET_OVER_FLOOR_DB, float(db.max()) - ONSET_UNDER_PEAK_DB)
    onset, quiet = v, 0
    for f in range(v - 1, max(-1, v - 1 - ONSET_LOOKBACK), -1):
        if db[f] > threshold:
            onset, quiet = f, 0
        else:
            quiet += 1
            if quiet > ONSET_BRIDGE:
                break
    return onset * ONSET_FRAME / WHISPER_RATE


def speech_onset(pcm16k):
    """Seconds from the start of the clip to its first speech (Silero VAD, refined by energy), or 0.0 when the VAD
    finds none."""
    from scenecast_py.whisper import install_av_stub

    install_av_stub()
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    found = get_speech_timestamps(pcm16k, VadOptions(threshold=VAD_THRESHOLD, speech_pad_ms=VAD_SPEECH_PAD_MS,
                                                     min_silence_duration_ms=VAD_MIN_SILENCE_MS))
    return refine_onset(pcm16k, found[0]["start"]) if found else 0.0


def align_text(model, pcm16k, text, offset=0.0):
    """Forced word times for `text` spoken in `pcm16k` (16 kHz mono float32, at most 30 s), in seconds from the
    start of the clip plus `offset`. Returns [{w, start, end, p, from}], one entry per `text.split()` word; `from` is
    "onset" for the first word (it starts where speech does) and "forced" for the rest.

    Raises AlignmentError when the aligner's output can't be trusted: no pieces, pieces that don't spell the text, or
    starts that don't strictly increase.
    """
    from scenecast_py.whisper import install_av_stub

    install_av_stub()  # before anything from faster_whisper is imported (it imports PyAV)
    from faster_whisper.tokenizer import Tokenizer

    if not text.split():
        return []
    pcm = np.asarray(pcm16k, dtype=np.float32)
    onset = speech_onset(pcm)
    cut = max(0, round((onset - ONSET_CONTEXT_SEC) * WHISPER_RATE))
    pcm, offset = pcm[cut:], offset + cut / WHISPER_RATE
    onset -= cut / WHISPER_RATE
    if len(pcm) > N_SAMPLES:
        raise AlignmentError(f"{len(pcm) / WHISPER_RATE:.1f} s of audio is longer than Whisper's {WINDOW_SEC} s window")
    padded = np.pad(pcm, (0, N_SAMPLES - len(pcm)))
    features = model.feature_extractor(padded)[..., :N_FRAMES]
    enc = model.encode(features)
    tok = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language="en")
    # find_alignment is batched in faster-whisper 1.2: a list of token lists in, a list of word lists out.
    pieces = model.find_alignment(tok, [tok.encode(" " + text.strip())], enc, num_frames=max(1, len(pcm) // HOP))[0]
    return finish_alignment(text, pieces, onset, offset)


def finish_alignment(text, pieces, onset, offset):
    """The aligner's pieces as checked word times: the first word starts at the speech onset (the alignment path
    starts at the clip's first frame), but no later than one frame before the second word; then everything moves by
    `offset`."""
    reason = check_pieces(text, pieces)
    if reason:
        raise AlignmentError(reason)
    out = words_from_tokens(text, pieces)
    for w in out:
        w["from"] = "forced"
    first = out[0]
    if len(out) > 1:  # never at or after the second word: at most one alignment frame before it
        onset = min(onset, out[1]["start"] - ALIGN_FRAME_SEC)
    if onset > first["start"]:  # the aligner's own start is pinned to the clip start; the onset is later and wins
        first["start"] = onset
        first["from"] = "onset"
    first["end"] = max(first["end"], first["start"])
    for w in out:
        w["start"] += offset
        w["end"] += offset
    reason = check_times(out)
    if reason:
        raise AlignmentError(reason)
    return out


def align_phrases(pcm16k, phrases, model, pad=0.4, bounds=(0.0, float("inf"))):
    """Forced times on the video clock for every narration word.

    `pcm16k` is the whole video's audio at 16 kHz; each phrase ({start, end, text}, video clock) is aligned within
    its own window, widened by `pad` on both sides so the first word after a silence has context, but never into the
    phrase before or after it (whose words the aligner would take for this phrase's), nor past `bounds` (the
    neighbouring scenes' speech). Returns one {w, start, end, p, from} per whitespace word of the phrases, in order.
    A phrase whose alignment fails or can't be trusted gives its words start/end None and `from` None, logs why, and
    the caller uses another time for those.
    """
    out = []
    for k, ph in enumerate(phrases):
        before = phrases[k - 1]["end"] if k else bounds[0]
        after = phrases[k + 1]["start"] if k + 1 < len(phrases) else bounds[1]
        lo = max(0, round(max(ph["start"] - pad, min(before, ph["start"])) * WHISPER_RATE))
        hi = min(len(pcm16k), round(min(ph["end"] + pad, max(after, ph["end"])) * WHISPER_RATE))
        words = ph["text"].split()
        try:
            aligned = align_text(model, pcm16k[lo:hi], ph["text"], offset=lo / WHISPER_RATE)
            if [w["w"] for w in aligned] != words:
                raise AlignmentError("the word count differs")
        except Exception as e:  # noqa: BLE001 (any failure leaves only this phrase untimed; the audit falls back)
            log(f'phrase at {ph["start"]:.3f} s ("{ph["text"][:40]}") left untimed: {e}')
            aligned = [{"w": w, "start": None, "end": None, "p": None, "from": None} for w in words]
        out += aligned
    return out
