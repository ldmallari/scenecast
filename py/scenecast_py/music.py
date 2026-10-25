"""Procedural ambient pad: three detuned sine/triangle voices per chord tone on a slow chord cycle.

Usage: python -m scenecast_py.music --seconds <n> --out <file.wav> [--seed <int>]

Writes a 48 kHz stereo 16-bit WAV. The same (seconds, seed) always gives byte-identical output.
The pad is low-passed and faded in and out over 4 s; its loudness is set later, in the mix.
"""
import argparse

import numpy as np
import soundfile as sf

SAMPLE_RATE = 48000
FADE_SEC = 4.0
CHORD_SEC = 8.0  # one chord, with the next one crossfading over its last half
LOWPASS_HZ = 900.0
PEAK = 0.5
DETUNE_CENTS = (-9.0, 0.0, 8.0)  # three voices per tone
# Am - F - C - G, as MIDI notes of the chord tones (root an octave lower is added as a bass)
CHORDS = ((57, 60, 64), (53, 57, 60), (48, 55, 64), (55, 59, 62))


def _midi_hz(note, cents=0.0):
    return 440.0 * 2.0 ** ((note - 69 + cents / 100.0) / 12.0)


def _triangle(phase):
    return 2.0 / np.pi * np.arcsin(np.sin(phase))


def _chord_gain(t, k):
    """Smooth 0..1 weight of chord slot `k`: it fades in over the previous half-slot and out over its own last half."""
    x = (t - k * CHORD_SEC) / CHORD_SEC  # slot-relative position; slot k is x in [0, 1)
    up = np.clip(x * 2.0 + 1.0, 0.0, 1.0)  # rises over x in [-0.5, 0]
    down = np.clip((1.0 - x) * 2.0, 0.0, 1.0)  # falls over x in [0.5, 1]
    return np.sin(np.pi / 2.0 * np.minimum(up, down)) ** 2


def _lowpass(x, fc):
    spec = np.fft.rfft(x, axis=0)
    freqs = np.fft.rfftfreq(len(x), 1.0 / SAMPLE_RATE)
    return np.fft.irfft(spec / np.sqrt(1.0 + (freqs / fc) ** 4)[:, None], n=len(x), axis=0)


def generate(seconds, out_wav, seed=0):
    """Write `seconds` of pad to `out_wav` (48 kHz stereo). Deterministic per seed."""
    n = max(int(round(seconds * SAMPLE_RATE)), 1)
    t = np.arange(n) / SAMPLE_RATE
    rng = np.random.default_rng(seed)
    slots = int(np.ceil(seconds / CHORD_SEC)) + 1
    channels = []
    for _side in range(2):
        mix = np.zeros(n)
        for k in range(slots):
            gain = _chord_gain(t, k)
            if not gain.any():
                continue
            chord = CHORDS[k % len(CHORDS)]
            for note in (chord[0] - 12, *chord):
                for cents in DETUNE_CENTS:
                    # a slow vibrato-free drift: random phase and a tiny random detune per voice
                    f = _midi_hz(note, cents + rng.uniform(-1.5, 1.5))
                    phase = 2 * np.pi * f * t + rng.uniform(0, 2 * np.pi)
                    voice = np.sin(phase) if rng.random() < 0.5 else _triangle(phase)
                    mix += gain * voice
        channels.append(mix)
    audio = _lowpass(np.stack(channels, axis=1), LOWPASS_HZ)
    fade = min(int(FADE_SEC * SAMPLE_RATE), n // 2)
    if fade > 0:
        ramp = np.sin(np.linspace(0.0, np.pi / 2.0, fade, endpoint=False)) ** 2
        audio[:fade] *= ramp[:, None]
        audio[n - fade:] *= ramp[::-1][:, None]
    audio = audio / max(float(np.abs(audio).max()), 1e-9) * PEAK
    sf.write(str(out_wav), audio.astype(np.float32), SAMPLE_RATE, subtype="PCM_16")


def main():
    ap = argparse.ArgumentParser(prog="scenecast_py.music")
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    generate(a.seconds, a.out, a.seed)


if __name__ == "__main__":
    main()
