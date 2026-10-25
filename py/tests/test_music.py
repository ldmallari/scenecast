import hashlib

import numpy as np
import soundfile as sf

from scenecast_py.music import SAMPLE_RATE, generate


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_pad_is_deterministic_per_seed(tmp_path):
    a, b, c = (tmp_path / f"{n}.wav" for n in "abc")
    generate(6, a, seed=7)
    generate(6, b, seed=7)
    generate(6, c, seed=8)
    assert digest(a) == digest(b)
    assert digest(a) != digest(c)


def test_pad_format_and_fades(tmp_path):
    p = tmp_path / "pad.wav"
    generate(12, p, seed=1)
    audio, sr = sf.read(str(p))
    assert sr == SAMPLE_RATE == 48000
    assert audio.shape == (12 * 48000, 2)
    assert np.abs(audio).max() > 0.1
    assert np.abs(audio[:48]).max() < 0.01 and np.abs(audio[-48:]).max() < 0.01
