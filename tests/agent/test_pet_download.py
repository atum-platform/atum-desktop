"""What the gateway will fetch on a client's or a manifest's say-so.

The host pin is a boundary only if a redirect cannot step over it, a body
cannot be endless, and a file that is not a sheet never lands in the cache.
Every case here runs through ``httpx.MockTransport``; nothing touches the net.
"""

from __future__ import annotations

import io
from pathlib import Path

import httpx
import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from agent.pet import store  # noqa: E402

PETDEX = "https://petdex.dev/pets/boba/spritesheet.webp"


def _sheet_bytes(fmt: str = "WEBP", size: tuple[int, int] = (16, 16)) -> bytes:
    buf = io.BytesIO()
    mode = "RGB" if fmt in ("JPEG", "BMP") else "RGBA"
    Image.new(mode, size, (255, 0, 0, 255) if mode == "RGBA" else (255, 0, 0)).save(buf, format=fmt)
    return buf.getvalue()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("ATUM_BUNDLED_PETS_DIR", raising=False)
    return tmp_path


@pytest.fixture
def transport(monkeypatch: pytest.MonkeyPatch):
    """Install a mock transport from a ``{url: response-or-callable}`` table."""
    calls: list[str] = []

    def install(table: dict):
        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            entry = table.get(str(request.url))
            if entry is None:
                return httpx.Response(404)
            return entry(request) if callable(entry) else entry

        monkeypatch.setattr(store, "_http_transport", httpx.MockTransport(handler))
        return calls

    return install


def _no_leftovers(directory: Path) -> None:
    assert not [p.name for p in directory.iterdir() if p.name.startswith(".spritesheet") or p.suffix == ".part"]


def test_a_same_host_redirect_is_followed_and_the_sheet_lands_in_one_move(home: Path, transport) -> None:
    calls = transport(
        {
            PETDEX: httpx.Response(302, headers={"location": "/cdn/boba.webp"}),
            "https://petdex.dev/cdn/boba.webp": httpx.Response(200, content=_sheet_bytes()),
        }
    )
    dest = home / "out" / "boba.webp"

    store._download(PETDEX, dest, timeout=5)

    assert dest.read_bytes() == _sheet_bytes()
    assert calls == [PETDEX, "https://petdex.dev/cdn/boba.webp"]
    _no_leftovers(dest.parent)


@pytest.mark.parametrize(
    "location",
    ["https://example.com/boba.webp", "http://petdex.dev/boba.webp", "http://127.0.0.1:8080/x", "https://petdex.dev.evil.net/x"],
)
def test_a_redirect_off_petdex_or_off_https_is_refused(home: Path, transport, location: str) -> None:
    calls = transport({PETDEX: httpx.Response(302, headers={"location": location}), location: httpx.Response(200, content=_sheet_bytes())})
    dest = home / "out" / "boba.webp"

    with pytest.raises(store.PetStoreError, match="refusing to fetch"):
        store._download(PETDEX, dest, timeout=5)

    assert calls == [PETDEX], "the hop after the boundary is never requested"
    assert not dest.exists()


def test_a_plain_http_url_is_refused_before_any_request(home: Path, transport) -> None:
    calls = transport({})

    with pytest.raises(store.PetStoreError, match="refusing to fetch"):
        store._fetch_bytes("http://petdex.dev/x.webp", timeout=5)

    assert calls == []


def test_a_redirect_loop_ends(home: Path, transport) -> None:
    calls = transport({PETDEX: httpx.Response(302, headers={"location": PETDEX})})

    with pytest.raises(store.PetStoreError, match="too many redirects"):
        store._fetch_bytes(PETDEX, timeout=5)

    assert len(calls) == store._MAX_REDIRECTS + 1


def test_a_declared_oversize_body_is_refused_without_reading_it(home: Path, transport) -> None:
    big = store._MAX_SHEET_BYTES + 1
    transport({PETDEX: httpx.Response(200, headers={"content-length": str(big)}, stream=httpx.ByteStream(b"x" * 64))})

    with pytest.raises(store.PetStoreError, match="too large"):
        store._fetch_bytes(PETDEX, timeout=5)


def test_an_undeclared_oversize_body_is_cut_off_while_streaming(home: Path, transport) -> None:
    transport({PETDEX: httpx.Response(200, stream=httpx.ByteStream(b"x" * (store._MAX_SHEET_BYTES + 1)))})

    with pytest.raises(store.PetStoreError, match="too large"):
        store._fetch_bytes(PETDEX, timeout=5)


def test_a_body_that_is_not_a_sheet_never_reaches_the_cache(home: Path, transport) -> None:
    transport({PETDEX: httpx.Response(200, content=b"<html>not a sheet</html>")})
    dest = home / "out" / "boba.webp"
    dest.parent.mkdir(parents=True)

    with pytest.raises(store.PetStoreError, match="not a spritesheet"):
        store._download(PETDEX, dest, timeout=5)

    assert not dest.exists()
    _no_leftovers(dest.parent)


@pytest.mark.parametrize("fmt", ["JPEG", "GIF", "BMP"])
def test_only_png_and_webp_are_sheets(home: Path, transport, fmt: str) -> None:
    transport({PETDEX: httpx.Response(200, content=_sheet_bytes(fmt))})

    with pytest.raises(store.PetStoreError, match="not a spritesheet"):
        store._download(PETDEX, home / "out" / "boba.webp", timeout=5)


def test_an_absurd_image_is_not_a_sheet(home: Path, transport) -> None:
    transport({PETDEX: httpx.Response(200, content=_sheet_bytes("PNG", (store._MAX_SHEET_SIDE + 1, 1)))})

    with pytest.raises(store.PetStoreError, match="not a spritesheet"):
        store._download(PETDEX, home / "out" / "boba.png", timeout=5)


def test_pet_json_is_pinned_and_capped_too(home: Path, transport) -> None:
    url = "https://petdex.dev/pets/boba/pet.json"
    transport({url: httpx.Response(200, content=b'{"id": "boba"}')})
    assert store._download_json(url, timeout=5) == {"id": "boba"}

    transport({url: httpx.Response(302, headers={"location": "https://example.com/pet.json"})})
    with pytest.raises(store.PetStoreError, match="refusing to fetch"):
        store._download_json(url, timeout=5)

    transport({url: httpx.Response(200, stream=httpx.ByteStream(b"[" * (store._MAX_JSON_BYTES + 1)))})
    with pytest.raises(store.PetStoreError, match="too large"):
        store._download_json(url, timeout=5)


def test_sheet_for_refuses_a_redirect_off_petdex_and_caches_nothing(home: Path, transport) -> None:
    transport({PETDEX: httpx.Response(302, headers={"location": "https://example.com/boba.webp"})})

    assert store.sheet_for("boba", source_url=PETDEX) is None
    assert list((store.pets_dir() / ".sheets").iterdir()) == []


def test_sheet_for_caches_a_good_sheet_once_per_profile(home: Path, transport, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = transport({PETDEX: httpx.Response(200, content=_sheet_bytes())})

    first = store.sheet_for("boba", source_url=PETDEX)
    again = store.sheet_for("boba", source_url=PETDEX)

    assert first is not None and first.exists and again is not None
    assert first.spritesheet == home / "home" / "pets" / ".sheets" / "boba.webp"
    assert calls == [PETDEX], "fetched once; the second read is the cache"

    # Another profile has its own cache — a sheet fetched for one is not the other's.
    monkeypatch.setenv("HERMES_HOME", str(home / "home-b"))
    other = store.sheet_for("boba", source_url=PETDEX)

    assert other is not None and other.spritesheet == home / "home-b" / "pets" / ".sheets" / "boba.webp"
    assert calls == [PETDEX, PETDEX]


def test_the_thumbnail_fetch_is_pinned_the_same_way(home: Path, transport) -> None:
    transport({PETDEX: httpx.Response(302, headers={"location": "https://example.com/boba.webp"})})

    assert store.thumbnail_png("boba", source_url=PETDEX) is None


def test_the_rpc_never_fetches_from_a_client_supplied_host(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from tui_gateway import server

    monkeypatch.setattr(store, "_fetch_bytes", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))

    resp = server._methods["pet.sheet"]("r1", {"slug": "boba", "url": "https://evil.example/boba.webp"})

    assert resp["result"] == {"ok": False, "slug": "boba"}
