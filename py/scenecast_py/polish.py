"""Light processing for a voice clip (`voice.polish`), numpy only: a soft high-pass, a gentle de-esser and light
compression. Nothing moves in time (the filters are zero-phase), so the word times measured before stay right. The
mix still brings the voice to its loudness target (-16 LUFS) afterwards.
"""
import numpy as np

HIGHPASS_HZ = 80.0
DEESS_LO_HZ, DEESS_HI_HZ = 5000.0, 10000.0
DEESS_RATIO_DB = 0.0  # the sibilance band may be at most this loud against the rest of the voice before it is dipped
DEESS_MAX_CUT_DB = 6.0
COMP_THRESHOLD_DB = -24.0  # dBFS (RMS over 10 ms)
COMP_RATIO = 2.0
COMP_ATTACK_SEC = 0.010
COMP_RELEASE_SEC = 0.150
FRAME_SEC = 0.005


def _fft_filter(audio, sr, gain_of_freq):
    """Zero-phase filtering: the spectrum times a real gain per frequency (padded, so nothing wraps round)."""
    n = len(audio)
    size = 1 << int(np.ceil(np.log2(max(2 * n, 2))))
    spec = np.fft.rfft(audio.astype(np.float64), size)
    freqs = np.fft.rfftfreq(size, 1 / sr)
    return np.fft.irfft(spec * gain_of_freq(freqs), size)[:n]


def highpass(audio, sr, cutoff=HIGHPASS_HZ):
    """A second-order (12 dB/octave) Butterworth magnitude high-pass, applied with zero phase."""
    return _fft_filter(audio, sr, lambda f: (f / cutoff) ** 2 / np.sqrt(1 + (f / cutoff) ** 4))


def _band(audio, sr, lo=DEESS_LO_HZ, hi=DEESS_HI_HZ):
    def gain(f):
        # Raised-cosine edges 1 kHz wide, so the split adds back to the input exactly where the gain is 1.
        g = np.zeros_like(f)
        g[(f >= lo) & (f <= hi)] = 1.0
        for edge, rising in ((lo, True), (hi, False)):
            w = 1000.0
            band = (f > edge - w / 2) & (f < edge + w / 2)
            x = (f[band] - (edge - w / 2)) / w
            g[band] = 0.5 - 0.5 * np.cos(np.pi * x) if rising else 0.5 + 0.5 * np.cos(np.pi * x)
        return g

    return _fft_filter(audio, sr, gain)


def _frame_db(x, hop):
    n = max(1, len(x) // hop)
    frames = np.asarray(x[: n * hop], dtype=np.float64).reshape(n, hop)
    return 10 * np.log10(np.mean(frames**2, axis=1) + 1e-12)


def _per_sample(gain_db, hop, n):
    centres = (np.arange(len(gain_db)) + 0.5) * hop
    return 10 ** (np.interp(np.arange(n), centres, gain_db) / 20)


def deess(audio, sr):
    """Dips the 5-10 kHz band by up to 6 dB in the moments it is louder than the rest of the voice (an "s")."""
    hop = max(1, round(FRAME_SEC * sr))
    band = _band(audio, sr)
    rest = audio - band
    over = _frame_db(band, hop) - _frame_db(rest, hop) - DEESS_RATIO_DB
    cut = -np.clip(over, 0, DEESS_MAX_CUT_DB)
    cut = np.convolve(cut, np.ones(3) / 3, mode="same")  # no 5 ms steps
    return rest + band * _per_sample(cut, hop, len(audio))


def compress(audio, sr, threshold=COMP_THRESHOLD_DB, ratio=COMP_RATIO):
    """RMS compression with attack and release smoothing: levels over `threshold` rise at 1/`ratio`. No make-up gain."""
    hop = max(1, round(FRAME_SEC * sr))
    level = _frame_db(audio, hop)
    target = -np.maximum(level - threshold, 0) * (1 - 1 / ratio)
    a_att = np.exp(-FRAME_SEC / COMP_ATTACK_SEC)
    a_rel = np.exp(-FRAME_SEC / COMP_RELEASE_SEC)
    g = np.empty_like(target)
    cur = 0.0
    for i, t in enumerate(target):
        a = a_att if t < cur else a_rel
        cur = a * cur + (1 - a) * t
        g[i] = cur
    return audio * _per_sample(g, hop, len(audio))


def polish(audio, sr):
    """High-pass, de-ess and compress a voice clip; float32 out, the same length, never clipping."""
    if len(audio) == 0:
        return np.asarray(audio, dtype=np.float32)
    out = compress(deess(highpass(np.asarray(audio, dtype=np.float64), sr), sr), sr)
    peak = float(np.max(np.abs(out)))
    if peak > 0.99:
        out = out * (0.99 / peak)
    return out.astype(np.float32)
