"""The petdex manifest comes through the same pinned, capped fetch as every
other petdex byte, and only lists pets whose slug can be a directory name.
"""

from __future__ import annotations

import json

import httpx
import pytest

from agent.pet import manifest, store


@pytest.fixture(autouse=True)
def fresh_cache():
    manifest.clear_cache()
    yield
    manifest.clear_cache()


def _transport(monkeypatch: pytest.MonkeyPatch, table: dict) -> list[str]:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        entry = table.get(str(request.url))
        return entry if entry is not None else httpx.Response(404)

    monkeypatch.setattr(store, "_http_transport", httpx.MockTransport(handler))
    return calls


def _manifest(*pets: dict) -> bytes:
    return json.dumps({"pets": list(pets)}).encode("utf-8")


def test_follows_petdex_redirect_to_its_cdn_and_drops_unusable_slugs(monkeypatch: pytest.MonkeyPatch) -> None:
    cdn = "https://cdn.petdex.dev/manifest.json"
    calls = _transport(
        monkeypatch,
        {
            manifest.MANIFEST_URL: httpx.Response(307, headers={"location": cdn}),
            cdn: httpx.Response(
                200,
                content=_manifest(
                    {"slug": "boba", "displayName": "Boba", "spritesheetUrl": "https://petdex.dev/p/boba.webp"},
                    {"slug": "Boba-2", "displayName": "Shouty", "spritesheetUrl": "https://petdex.dev/p/b2.webp"},
                    {"slug": "../x", "displayName": "Traversal", "spritesheetUrl": "https://petdex.dev/p/x.webp"},
                    {"slug": "no-sheet", "displayName": "No sheet"},
                ),
            ),
        },
    )

    entries = manifest.fetch_manifest()

    assert [e.slug for e in entries] == ["boba"]
    assert calls == [manifest.MANIFEST_URL, cdn]
    assert manifest.fetch_manifest() is entries, "cached"


def test_refuses_a_manifest_redirect_off_petdex(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _transport(monkeypatch, {manifest.MANIFEST_URL: httpx.Response(307, headers={"location": "https://example.com/m.json"})})

    with pytest.raises(manifest.ManifestError, match="refusing to fetch"):
        manifest.fetch_manifest()

    assert calls == [manifest.MANIFEST_URL]


def test_refuses_an_oversize_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    _transport(monkeypatch, {manifest.MANIFEST_URL: httpx.Response(200, stream=httpx.ByteStream(b"[" * (store._MAX_MANIFEST_BYTES + 1)))})

    with pytest.raises(manifest.ManifestError, match="too large"):
        manifest.fetch_manifest()
