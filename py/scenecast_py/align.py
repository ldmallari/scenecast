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

import numpy as np

WHISPER_RATE = 16000
WINDOW_SEC = 30  # Whisper's encoder sees 30 s at a time
N_SAMPLES = WINDOW_SEC * WHISPER_RATE
N_FRAMES = 3000  # mel frames in 30 s (hop 160)
HOP = 160
ONSET_CONTEXT_SEC = 0.05  # audio kept before the speech onset when the leading silence is cut


def words_from_tokens(text, token_words):
    """Maps Whisper's word pieces (`find_alignment` output: {word, start, end, probability?}) back to the whitespace
    words of `text`, by character span.

    Whisper splits "Sign-in" into " Sign", "-", "in" and "email," into " email", ","; each whitespace word takes the
    start of its first piece and the end of its last. Spans count non-space characters only, so the leading space of
    a piece doesn't matter. If the pieces don't spell the text exactly (a decode difference), their positions are
    scaled onto the text. The result always has one entry per `text.split()` word, in order, as {w, start, end, p};
    a word no piece covers takes the previous word's end (0.0 at the start), so times never go backwards.
    """
    words = text.split()
    spans, pos = [], 0
    for w in words:
        spans.append((pos, pos + len(w)))
        pos += len(w)
    total = pos

    pieces, pos = [], 0
    for t in token_words:
        n = len(re.sub(r"\s+", "", t["word"]))
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

    found = get_speech_timestamps(pcm16k, VadOptions(speech_pad_ms=0, min_silence_duration_ms=100))
    return refine_onset(pcm16k, found[0]["start"]) if found else 0.0


def align_text(model, pcm16k, text, offset=0.0):
    """Forced word times for `text` spoken in `pcm16k` (16 kHz mono float32, at most 30 s), in seconds from the
    start of the clip plus `offset`. Returns [{w, start, end, p}], one entry per `text.split()` word."""
    from faster_whisper.tokenizer import Tokenizer

    if not text.split():
        return []
    pcm = np.asarray(pcm16k, dtype=np.float32)
    onset = speech_onset(pcm)
    cut = max(0, round((onset - ONSET_CONTEXT_SEC) * WHISPER_RATE))
    pcm, offset = pcm[cut:], offset + cut / WHISPER_RATE
    onset -= cut / WHISPER_RATE
    if len(pcm) > N_SAMPLES:
        raise ValueError(f"align_text: {len(pcm) / WHISPER_RATE:.1f} s of audio is longer than Whisper's {WINDOW_SEC} s window")
    padded = np.pad(pcm, (0, N_SAMPLES - len(pcm)))
    features = model.feature_extractor(padded)[..., :N_FRAMES]
    enc = model.encode(features)
    tok = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language="en")
    # find_alignment is batched in faster-whisper 1.2: a list of token lists in, a list of word lists out.
    pieces = model.find_alignment(tok, [tok.encode(" " + text.strip())], enc, num_frames=max(1, len(pcm) // HOP))[0]
    out = words_from_tokens(text, pieces)
    if out:  # the alignment path starts at the clip's first frame: the first word starts where speech does
        out[0]["start"] = max(out[0]["start"], onset)
        out[0]["end"] = max(out[0]["end"], out[0]["start"])
    for w in out:
        w["start"] += offset
        w["end"] += offset
    return out


def align_phrases(pcm16k, phrases, model, pad=0.4):
    """Forced times on the video clock for every narration word.

    `pcm16k` is the whole video's audio at 16 kHz; each phrase ({start, end, text}, video clock) is aligned within
    its own window, widened by `pad` on both sides so the first word after a silence has context, but never into the
    phrase before or after it (whose words the aligner would take for this phrase's). Returns one
    {w, start, end, p} per whitespace word of the phrases, in order. A phrase that can't be aligned (too long, or the
    aligner fails) gives its words start/end None, and the caller uses another time for those.
    """
    out = []
    for k, ph in enumerate(phrases):
        before = phrases[k - 1]["end"] if k else float("-inf")
        after = phrases[k + 1]["start"] if k + 1 < len(phrases) else float("inf")
        lo = max(0, round(max(ph["start"] - pad, min(before, ph["start"])) * WHISPER_RATE))
        hi = min(len(pcm16k), round(min(ph["end"] + pad, max(after, ph["end"])) * WHISPER_RATE))
        words = ph["text"].split()
        try:
            aligned = align_text(model, pcm16k[lo:hi], ph["text"], offset=lo / WHISPER_RATE)
            if [w["w"] for w in aligned] != words:
                raise ValueError("word count differs")
        except (ValueError, RuntimeError, IndexError):  # this phrase stays untimed; the audit falls back
            aligned = [{"w": w, "start": None, "end": None, "p": None} for w in words]
        out += aligned
    return out
