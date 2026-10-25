"""PyAV never loads: faster-whisper is imported behind a stub `av`, and audio is decoded by ffmpeg."""
import subprocess
import sys
import textwrap

import pytest

from scenecast_py.whisper import _AvStub


def _run(code):
    """Runs code in a fresh interpreter (sys.modules here may already hold other test imports)."""
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True)


def test_stub_imports_but_raises_on_use():
    stub = _AvStub("av")
    with pytest.raises(RuntimeError, match="never loads PyAV"):
        stub.open("x.mp4")
    with pytest.raises(AttributeError):
        stub.__file__  # noqa: B018 (dunder lookups stay plain AttributeErrors for import machinery)


def test_transcription_path_never_loads_pyav():
    """The audit's transcribe() with a stand-in model: the real decode and import path, no model weights."""
    r = _run(
        """
        import sys, tempfile, os, subprocess
        import imageio_ffmpeg
        import scenecast_py.whisper as w
        from scenecast_py import audit

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        wav = os.path.join(tempfile.mkdtemp(), "tone.wav")
        subprocess.run([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                        "-ar", "48000", "-ac", "2", wav], check=True)

        seen = {}
        class FakeModel:
            def __init__(self, *a, **k): pass
            def transcribe(self, pcm, **k):
                seen["n"], seen["dtype"] = len(pcm), str(pcm.dtype)
                return iter([]), None

        w.install_av_stub()
        import faster_whisper
        faster_whisper.WhisperModel = FakeModel
        assert audit.transcribe(wav, "unused", ffmpeg) == []
        assert seen["dtype"] == "float32" and abs(seen["n"] - 16000) < 200, seen
        assert getattr(sys.modules["av"], "SCENECAST_STUB", False), "real PyAV in sys.modules"
        assert not any(m.startswith("av.") for m in sys.modules), [m for m in sys.modules if m.startswith("av.")]
        print("ok")
        """
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "ok"


def test_whisper_model_installs_the_stub_before_faster_whisper():
    r = _run(
        """
        import sys
        from scenecast_py import whisper
        try:
            whisper.whisper_model("/nonexistent-model-dir")
        except Exception:
            pass  # no model there; the import already happened
        assert "faster_whisper" in sys.modules
        assert getattr(sys.modules["av"], "SCENECAST_STUB", False)
        print("ok")
        """
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "ok"


def test_refuses_when_real_pyav_is_already_loaded():
    r = _run(
        """
        import av  # the real one
        from scenecast_py.whisper import install_av_stub
        try:
            install_av_stub()
        except RuntimeError as e:
            print("refused" if "already imported" in str(e) else e)
        """
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "refused"
