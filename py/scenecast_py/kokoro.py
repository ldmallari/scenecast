"""Minimal Kokoro v1.0 ONNX inference (no kokoro-onnx package: it pulls GPL dependencies).

Attribution: the phoneme vocabulary below is copied from the `vocab` table of
hexgrad/Kokoro-82M `config.json` (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M).
The token padding and per-length style selection follow thewh1teagle/kokoro-onnx
(MIT, https://github.com/thewh1teagle/kokoro-onnx).
"""
import re

import numpy as np

SAMPLE_RATE = 24000
MAX_TOKENS = 510  # the model's 512-token context minus the two pad tokens

# fmt: off
VOCAB = {
    ";": 1, ":": 2, ",": 3, ".": 4, "!": 5, "?": 6, "—": 9, "…": 10, "\"": 11, "(": 12, ")": 13,
    "“": 14, "”": 15, " ": 16, "̃": 17, "ʣ": 18, "ʥ": 19, "ʦ": 20, "ʨ": 21, "ᵝ": 22, "ꭧ": 23,
    "A": 24, "I": 25, "O": 31, "Q": 33, "S": 35, "T": 36, "W": 39, "Y": 41, "ᵊ": 42, "a": 43,
    "b": 44, "c": 45, "d": 46, "e": 47, "f": 48, "h": 50, "i": 51, "j": 52, "k": 53, "l": 54,
    "m": 55, "n": 56, "o": 57, "p": 58, "q": 59, "r": 60, "s": 61, "t": 62, "u": 63, "v": 64,
    "w": 65, "x": 66, "y": 67, "z": 68, "ɑ": 69, "ɐ": 70, "ɒ": 71, "æ": 72, "β": 75, "ɔ": 76,
    "ɕ": 77, "ç": 78, "ɖ": 80, "ð": 81, "ʤ": 82, "ə": 83, "ɚ": 85, "ɛ": 86, "ɜ": 87, "ɟ": 90,
    "ɡ": 92, "ɥ": 99, "ɨ": 101, "ɪ": 102, "ʝ": 103, "ɯ": 110, "ɰ": 111, "ŋ": 112, "ɳ": 113,
    "ɲ": 114, "ɴ": 115, "ø": 116, "ɸ": 118, "θ": 119, "œ": 120, "ɹ": 123, "ɾ": 125, "ɻ": 126,
    "ʁ": 128, "ɽ": 129, "ʂ": 130, "ʃ": 131, "ʈ": 132, "ʧ": 133, "ʊ": 135, "ʋ": 136, "ʌ": 138,
    "ɣ": 139, "ɤ": 140, "χ": 142, "ʎ": 143, "ʒ": 147, "ʔ": 148, "ˈ": 156, "ˌ": 157, "ː": 158,
    "ʰ": 162, "ʲ": 164, "↓": 169, "→": 171, "↗": 172, "↘": 173, "ᵻ": 177,
}
# fmt: on

_BREAK = re.compile(r"(?<=[.,;:!?…—])\s*")


def tokenize(phonemes: str) -> list[int]:
    """Phoneme string -> Kokoro token ids; symbols outside the vocabulary are dropped."""
    return [VOCAB[c] for c in phonemes if c in VOCAB]


def chunk_phonemes(phonemes: str, limit: int = MAX_TOKENS) -> list[str]:
    """Split a phoneme string at punctuation so each chunk has at most `limit` tokens."""
    chunks, cur = [], ""
    for part in (p for p in _BREAK.split(phonemes) if p):
        while len(tokenize(part)) > limit:  # no punctuation to break at: hard split
            head, part = part[:limit], part[limit:]
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(head)
        candidate = f"{cur} {part}" if cur else part
        if len(tokenize(candidate)) > limit:
            chunks.append(cur)
            cur = part
        else:
            cur = candidate
    if cur.strip():
        chunks.append(cur)
    return chunks


def trim_silence(audio: np.ndarray, top_db: float = 60.0, frame: int = 2048, hop: int = 512) -> np.ndarray:
    """Drop leading/trailing frames quieter than `top_db` below the loudest frame (Kokoro pads its output)."""
    if len(audio) < frame:
        return audio
    starts = np.arange(0, len(audio) - frame + 1, hop)
    rms = np.array([np.sqrt(np.mean(audio[i : i + frame] ** 2)) for i in starts])
    peak = rms.max()
    if peak <= 0:
        return audio[:0]
    loud = np.nonzero(20 * np.log10(np.maximum(rms, 1e-10) / peak) > -top_db)[0]
    return audio[starts[loud[0]] : min(len(audio), starts[loud[-1]] + frame)]


class Kokoro:
    """`Kokoro(model, voices).create(text, voice, speed, lang)` -> float32 mono audio at 24 kHz."""

    def __init__(self, model_path: str, voices_path: str):
        import onnxruntime as ort

        self._session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self._inputs = [i.name for i in self._session.get_inputs()]
        self._voices = np.load(voices_path)
        self._g2p = {}

    def _phonemise(self, text: str, lang: str) -> str:
        if not lang.lower().startswith("en"):
            raise ValueError(f'unsupported voice lang "{lang}" (English only: en-us, en-gb)')
        british = lang.lower() in ("en-gb", "en_gb", "b")
        if british not in self._g2p:
            from scenecast_py.g2p import make_g2p

            self._g2p[british] = make_g2p(british=british)
        phonemes, _ = self._g2p[british](text)
        return phonemes

    @staticmethod
    def _role(name: str) -> str:
        if name in ("tokens", "input_ids"):
            return "tokens"
        if name in ("style", "speed"):
            return name
        raise RuntimeError(f'unexpected Kokoro model input "{name}"')

    def _infer(self, tokens: list[int], style: np.ndarray, speed: float) -> np.ndarray:
        values = {
            "tokens": np.array([[0, *tokens, 0]], dtype=np.int64),
            "style": style,
            "speed": np.array([speed], dtype=np.float32),
        }
        feeds = {name: values[self._role(name)] for name in self._inputs}
        return self._session.run(None, feeds)[0].astype(np.float32).reshape(-1)

    def create(self, text: str, voice: str, speed: float = 1.0, lang: str = "en-us", trim: bool = True) -> np.ndarray:
        if voice not in self._voices.files:
            raise ValueError(f'unknown voice "{voice}"')
        pack = self._voices[voice]  # (510, 1, 256): one style row per token count
        parts = []
        for chunk in chunk_phonemes(self._phonemise(text, lang)):
            tokens = tokenize(chunk)
            if tokens:
                parts.append(self._infer(tokens, pack[min(len(tokens), len(pack) - 1)], speed))
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return trim_silence(audio) if trim else audio
