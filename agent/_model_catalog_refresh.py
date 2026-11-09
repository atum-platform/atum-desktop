"""Bound the startup wait for optional public model catalogs.

Socket read timeouts do not bound a slowly streaming response. Keep at most one
daemon download per catalog, and share its wall-clock wait budget across callers
(including Hermes' existing prewarm). The existing catalog loaders still own
parsing, cache publication and failure handling; this is not an inference retry.
"""

from concurrent.futures import Future, TimeoutError
from contextvars import copy_context
from threading import Lock, Thread
from time import monotonic
from typing import Any, Callable


class CatalogRefresh:
    def __init__(self, name: str, wait_seconds: float = 2.0):
        self._name = name
        self._wait_seconds = wait_seconds
        self._lock = Lock()
        self._pending: tuple[Future, float] | None = None

    def get(self, fetch: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
        """Return fresh data within the shared budget, or None for cached fallback.

        A timed-out download may finish and populate the cache later. Repeated
        callers neither spawn duplicate downloads nor restart the wait budget.
        A stalled worker is daemonized so it cannot prevent process shutdown.
        """
        with self._lock:
            if self._pending is None or self._pending[0].done():
                future = Future()
                self._pending = (future, monotonic() + self._wait_seconds)
                context = copy_context()

                def run():
                    try:
                        future.set_result(context.run(fetch))
                    except Exception as exc:
                        future.set_exception(exc)

                try:
                    Thread(target=run, name=self._name, daemon=True).start()
                except RuntimeError:
                    # Resource exhaustion must not fail session construction or
                    # leave a future which can never complete. A later caller
                    # can attempt refresh normally; this one uses cached data.
                    self._pending = None
                    return None
            future, deadline = self._pending
        try:
            return future.result(timeout=max(0.0, deadline - monotonic()))
        except TimeoutError:
            return None
