import pytest

from tui_gateway.error_diagnostic import error_diagnostic
from agent.model_metadata import ContextWindowTooSmallError


@pytest.mark.parametrize(
    "text", ["private email body", "short-key", "https://example.test/private"]
)
def test_only_closed_metadata_survives(text):
    assert error_diagnostic(ContextWindowTooSmallError(text)) == {
        "class": "ContextWindowTooSmallError",
        "kind": "context_window_too_small",
    }
    unknown = type("private_identifier", (Exception,), {"code": text})
    assert error_diagnostic(unknown(text)) == {"class": "Exception"}
    assert error_diagnostic(ValueError(text)) == {"class": "ValueError"}
