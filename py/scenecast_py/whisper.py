"""faster-whisper without PyAV.

faster-whisper imports PyAV (`av`) when it loads, only to decode audio files. PyAV's wheels bundle native
libraries that include GPL encoders (x264, x265), and scenecast never hands faster-whisper a file: audio is
decoded by the toolchain ffmpeg (a separate program) into a 16 kHz mono float32 array first. So before
faster_whisper is imported, a stub takes the place of `av` in sys.modules and the real PyAV never loads.
The stub raises if anything actually uses it.
"""
import subprocess
import sys
import types

import numpy as np

WHISPER_RATE = 16000


class _AvStub(types.ModuleType):
    """Stands in for PyAV. Importing it works; using any of it raises."""

    SCENECAST_STUB = True

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        raise RuntimeError(
            f"PyAV (av.{name}) was used, but scenecast never loads PyAV: decode audio with the toolchain "
            "ffmpeg (scenecast_py.whisper.decode_audio) and pass faster-whisper the array instead."
        )


def install_av_stub():
    """Puts the stub in sys.modules as `av`, unless faster_whisper or the real av is already loaded."""
    current = sys.modules.get("av")
    if current is not None:
        if getattr(current, "SCENECAST_STUB", False):
            return current
        raise RuntimeError("the real PyAV is already imported; scenecast must load faster-whisper first")
    stub = _AvStub("av")
    sys.modules["av"] = stub
    return stub


def whisper_model(model_dir):
    """A faster-whisper model on the CPU (int8), loaded with the PyAV stub in place."""
    install_av_stub()
    from faster_whisper import WhisperModel

    return WhisperModel(model_dir, device="cpu", compute_type="int8")


def decode_audio(path, ffmpeg):
    """The audio of a media file as a 16 kHz mono float32 array, decoded by the toolchain ffmpeg."""
    raw = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1",
         "-ar", str(WHISPER_RATE), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)
