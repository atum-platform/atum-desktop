"""The CLI smart-deny prompt normalizes catalog words and keyboard input alike."""

import unicodedata

import pytest

from agent import i18n
from tools.approval_prompt import _ask_human


@pytest.mark.parametrize("reply, expected", [
    ("một lần", "once"), ("từ chối", "deny"),
    ("once", "once"), ("deny", "deny"),
    ("tôi không đồng ý", "deny"), ("xin một lần", "deny"),
])
@pytest.mark.parametrize("catalog_form", ["NFC", "NFD"])
def test_smart_deny_normalizes_reply_and_catalog(monkeypatch, reply, expected, catalog_form):
    monkeypatch.setenv("HERMES_LANGUAGE", "vi")
    i18n.reset_language_cache()
    translate = i18n.t
    monkeypatch.setattr(i18n, "t", lambda *a, **kw: unicodedata.normalize(catalog_form, translate(*a, **kw)))
    monkeypatch.setattr("builtins.input", lambda _: "  " + unicodedata.normalize("NFD", reply.upper()) + "  ")
    try:
        assert _ask_human("echo test", "test", 5, False, None, False, True) == expected
    finally:
        i18n.reset_language_cache()
