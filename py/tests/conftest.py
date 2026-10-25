"""Test settings that apply however pytest is started (from py/ or from the repository root)."""


def pytest_configure(config):
    # misaki uses importlib.resources.open_text, deprecated on Python 3.12+ (third-party, harmless).
    config.addinivalue_line("filterwarnings", "ignore:open_text is deprecated:DeprecationWarning:misaki")
