"""The live Word tool steers requests about files on disk away from itself."""

import json

from tools import desktop_ui, word_document_tool


def _desktop(monkeypatch, receipt):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("ATUM_WORD_COMPANION", "1")
    monkeypatch.setattr(desktop_ui, "request", lambda *args, **kwargs: json.dumps(receipt))


def test_no_linked_document_points_the_model_at_file_tools(monkeypatch):
    _desktop(monkeypatch, {"error": "WORD_DOCUMENT_UNAVAILABLE"})

    result = json.loads(word_document_tool.word_document("read"))

    assert result["error"] == "WORD_DOCUMENT_UNAVAILABLE"
    assert "file and terminal tools" in result["hint"]


def test_a_linked_document_receipt_passes_through_unchanged(monkeypatch):
    receipt = {"text": "Hello", "revision": "r1"}
    _desktop(monkeypatch, receipt)

    assert json.loads(word_document_tool.word_document("read")) == receipt


def test_the_schema_says_it_is_not_for_files_on_disk():
    from tools.registry import registry

    assert "never for files or folders on disk" in registry.get_entry("word_document").schema["description"]
