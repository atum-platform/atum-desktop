"""Catalog downloads must not hold session readiness or process exit hostage."""

from contextvars import ContextVar
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Event, Thread, current_thread
from time import monotonic
from unittest.mock import Mock

import pytest

from agent._model_catalog_refresh import CatalogRefresh


def test_slow_download_shares_one_budget_and_preserves_context():
    refresh = CatalogRefresh("test-catalog", wait_seconds=0.03)
    release = Event()
    entered = Event()
    profile = ContextVar("test_profile", default="wrong")
    token = profile.set("caller-profile")
    observed = []

    def download():
        observed.append((profile.get(), current_thread().daemon))
        entered.set()
        assert release.wait(2)
        return {"live": True}

    result = []
    caller = Thread(target=lambda: result.append(refresh.get(download)))
    try:
        started = monotonic()
        assert refresh.get(download) is None
        assert entered.is_set()
        caller.start()
        caller.join(0.5)
        assert not caller.is_alive()
        assert result == [None]
        assert monotonic() - started < 0.5
        assert observed == [("caller-profile", True)]
    finally:
        release.set()
        refresh._pending[0].result(timeout=1)
        profile.reset(token)


def test_completed_refresh_allows_an_explicit_new_refresh():
    refresh = CatalogRefresh("test-catalog")
    assert refresh.get(lambda: {"version": 1}) == {"version": 1}
    assert refresh.get(lambda: {"version": 2}) == {"version": 2}


def test_thread_start_failure_falls_back_without_poisoning_next_lookup(monkeypatch):
    import agent._model_catalog_refresh as catalog
    refresh = CatalogRefresh("test-catalog")
    factory = Mock()
    factory.return_value.start.side_effect = RuntimeError("cannot start thread")
    download = Mock(return_value={"live": True})
    with monkeypatch.context() as scope:
        scope.setattr(catalog, "Thread", factory)
        assert refresh.get(download) is None
        assert refresh._pending is None
        download.assert_not_called()
    assert refresh.get(download) == {"live": True}
    download.assert_called_once()


def test_fetch_failure_is_visible_and_does_not_poison_next_refresh():
    refresh = CatalogRefresh("test-catalog")

    def fail():
        raise ValueError("fixture")

    with pytest.raises(ValueError, match="fixture"):
        refresh.get(fail)
    assert refresh.get(lambda: {}) == {}


def test_stalled_download_cannot_prevent_interpreter_exit():
    completed = subprocess.run(
        [sys.executable, "-c", """
from threading import Event
from agent._model_catalog_refresh import CatalogRefresh
assert CatalogRefresh('stalled', 0.01).get(lambda: Event().wait()) is None
print('finished', flush=True)
"""],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True, text=True, timeout=3,
    )
    assert completed.returncode == 0
    assert completed.stdout.strip() == "finished"


@pytest.mark.parametrize("catalog", ["openrouter", "models_dev"])
@pytest.mark.parametrize("cached", [False, True])
@pytest.mark.skip(
    reason="catalogs now own separate native cache/refresh implementations; covered by test_models_dev and test_model_metadata"
)
def test_catalog_timeout_uses_stale_data_then_publishes_live_data(
    catalog, cached, tmp_path, monkeypatch,
):
    import agent.model_metadata as mm
    import agent.models_dev as md

    stale = {"old/model": {"context_length": 1234}}
    live = {"live/model": {"context_length": 9999}}
    path = tmp_path / "catalog.json"
    if cached:
        path.write_text(json.dumps(stale), encoding="utf-8")
        os.utime(path, (1, 1))
    refresh = CatalogRefresh("test-catalog", wait_seconds=0.03)
    release = Event()

    if catalog == "openrouter":
        module, fetch = mm, mm.fetch_model_metadata
        monkeypatch.setattr(mm, "_model_metadata_cache", {})
        monkeypatch.setattr(mm, "_model_metadata_cache_time", 0)
        monkeypatch.setattr(mm, "_get_model_metadata_cache_path", lambda: path)
        monkeypatch.setattr(mm, "_model_catalog_refresh", refresh)
        payload = {"data": [{"id": "live/model", "context_length": 9999}]}
    else:
        module, fetch = md, md.fetch_models_dev
        monkeypatch.setattr(md, "_models_dev_cache", {})
        monkeypatch.setattr(md, "_models_dev_cache_time", 0)
        monkeypatch.setattr(md, "_get_cache_path", lambda: path)
        monkeypatch.setattr(md, "_catalog_refresh", refresh)
        payload = live

    def blocked_json():
        assert release.wait(2)
        return payload

    response = Mock()
    response.json.side_effect = blocked_json
    get = Mock(return_value=response)
    monkeypatch.setattr(module.requests, "get", get)
    try:
        started = monotonic()
        expected = stale if cached else {}
        assert fetch() == expected
        # Prewarm + foreground callers, including force-refresh, share one job.
        assert fetch(force_refresh=True) == expected
        assert fetch() == expected
        assert monotonic() - started < 0.5
        get.assert_called_once()
    finally:
        release.set()
        refresh._pending[0].result(timeout=1)

    assert fetch()["live/model"]["context_length"] == 9999
    assert json.loads(path.read_text())["live/model"]["context_length"] == 9999
    get.assert_called_once()
