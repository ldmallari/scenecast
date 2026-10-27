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


def test_pyav_is_not_installed():
    """pyproject.toml overrides faster-whisper's `av` requirement away, so the GPL-linked wheel never lands.
    Checked in a fresh interpreter: other tests may have put the stub in this one's sys.modules."""
    r = _run("import importlib.util; print(importlib.util.find_spec('av'))")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "None"


def test_refuses_when_real_pyav_is_already_loaded(tmp_path):
    """PyAV is not installed, so a stand-in `av` (first on the path) plays the real one."""
    (tmp_path / "av.py").write_text("")
    r = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(
            """
            import av  # stands in for the real one
            from scenecast_py.whisper import install_av_stub
            try:
                install_av_stub()
            except RuntimeError as e:
                print("refused" if "already imported" in str(e) else e)
            """
        )],
        capture_output=True, text=True, env={**__import__("os").environ, "PYTHONPATH": str(tmp_path)},
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "refused"


def test_transcribe_installs_the_stub_itself(tmp_path):
    """audit.transcribe, called with nothing set up first, imports faster_whisper with the stub in place. A stand-in
    faster_whisper (first on the path) records what `av` is when it is imported."""
    fake = tmp_path / "faster_whisper"
    fake.mkdir()
    (fake / "__init__.py").write_text(textwrap.dedent(
        """
        import sys, av
        STUB = getattr(sys.modules["av"], "SCENECAST_STUB", False)
        class WhisperModel:
            def __init__(self, *a, **k): pass
            def transcribe(self, pcm, **k): return iter([]), None
        """
    ))
    r = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(
            """
            import os, subprocess, sys, tempfile
            import imageio_ffmpeg
            from scenecast_py import audit
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            wav = os.path.join(tempfile.mkdtemp(), "t.wav")
            subprocess.run([ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=0.5", wav], check=True)
            audit.transcribe(wav, "unused", ffmpeg)
            import faster_whisper
            print("stub" if faster_whisper.STUB else "real av")
            """
        )],
        capture_output=True, text=True, env={**__import__("os").environ, "PYTHONPATH": str(tmp_path)},
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "stub"
