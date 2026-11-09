"""Runtime proof for the split gateway's asynchronous session-store facade."""

import threading

import pytest

from gateway.session import AsyncSessionStore


class _SpyStore:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []
        self.label = "store"

    def read(self, value: str) -> str:
        self.calls.append((value, threading.get_ident()))
        return value


@pytest.mark.asyncio
async def test_async_session_store_offloads_calls() -> None:
    store = _SpyStore()
    facade = AsyncSessionStore(store)  # type: ignore[arg-type]
    loop_thread = threading.get_ident()

    assert await facade.read("ok") == "ok"
    assert store.calls == [("ok", store.calls[0][1])]
    assert store.calls[0][1] != loop_thread
    assert facade.label == "store"
    assert facade._store is store
