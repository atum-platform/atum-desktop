"""Safety boundary for source-upgrade E2E collection."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.e2e.core.upgrade._node_modules_guard import refusal_message


_CHECKOUT = Path(__file__).resolve().parents[4]


def pytest_collection_modifyitems(items) -> None:
    """Fail before fixtures can run installers against shared dependency trees."""
    if items and (reason := refusal_message(_CHECKOUT)):
        raise pytest.UsageError(reason)
