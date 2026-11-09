"""Selected-home preview and one-shot public sharing. No legacy auto-fallback.

Collection runs in an isolated child: neither stdout nor dotenv loading can
cross another request's home. Only captured, previewed bytes enter the uploader.
"""
import hashlib
import json
import logging
import os
import re
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

from hermes_constants import reset_hermes_home_override, set_hermes_home_override

LABELS = ("report", "agent.log", "gateway.log", "gui.log", "desktop.log")
MAX_BYTES = 3 * 1024 * 1024
PREVIEW_SECONDS = 600
_lock = threading.RLock()
_previews: dict[str, dict] = {}
_operations: dict[str, dict] = {}
_log = logging.getLogger(__name__)


def valid_url(value: str, destination: str) -> bool:
    host = re.escape(destination)
    return bool(re.fullmatch(rf"https://{host}/[A-Za-z0-9_-]{{1,100}}(?:\.txt)?/?", value))


def _safe_snapshot(home: Path, name: str, tail_lines: int):
    from hermes_cli.debug import LogSnapshot

    directory = home / "logs"
    if not directory.exists():
        return LogSnapshot(None, "(file not found)", None)
    if directory.is_symlink() or directory.resolve() != home / "logs":
        raise ValueError("debug_share_unsafe_logs")
    # Keep the POSIX parent directory pinned through leaf opening. A renamed
    # logs directory cannot redirect this capture to another profile's files.
    # Windows retains the existing guarded-path behavior (no dir_fd support).
    directory_fd = None
    try:
        if os.name == "posix":
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for suffix in ("", ".1"):
            candidate = directory / (name + ".log" + suffix)
            try:
                if directory_fd is not None:
                    fd = os.open(name + ".log" + suffix, os.O_RDONLY | os.O_NOFOLLOW,
                                 dir_fd=directory_fd)
                else:
                    fd = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            except FileNotFoundError:
                continue
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("debug_share_unsafe_log")
                if info.st_size == 0:
                    continue
                cap = 512_000
                source.seek(max(0, info.st_size - cap))
                raw = source.read(cap)
                truncated = info.st_size > cap
                if truncated and b"\n" in raw:
                    raw = raw.split(b"\n", 1)[1]
                text = raw.decode("utf-8", errors="replace")
                tail = "\n".join(text.splitlines()[-tail_lines:])
                full = ("[truncated: last 500 KB of this log]\n" if truncated else "") + text
                return LogSnapshot(candidate, tail, full)
        return LogSnapshot(None, "(file empty or not found)", None)
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def _diagnostic_config(value):
    # Configuration repr can otherwise expose opaque secrets that have no
    # vendor prefix (e.g. fallback_providers list with a plain api_key).
    if isinstance(value, dict):
        return {key: "[REDACTED]" if re.search(
            r"api.?key|token|secret|password|credential|authorization|bearer|private.?key",
            str(key), re.IGNORECASE) else _diagnostic_config(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_diagnostic_config(item) for item in value]
    return value


def capture_bundle(home: Path) -> dict[str, str]:
    """Child-only, read-only snapshot of this home's existing diagnostic data."""
    import yaml
    from dotenv import load_dotenv

    home = home.resolve()
    for name in (".env", "config.yaml", "auth.json"):
        p = home / name
        if p.is_symlink() or (p.exists() and (not p.is_file() or p.stat().st_size > 512_000)):
            raise ValueError("debug_share_unsafe_configuration")
    # No project .env fallback and no ambient provider credentials in this child.
    load_dotenv(home / ".env", override=False, interpolate=False)
    os.environ["HERMES_HOME"] = str(home)
    config_path = home / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8-sig")) if config_path.exists() else {}
    if not isinstance(config or {}, dict):
        raise ValueError("debug_share_invalid_configuration")
    from agent.redact import redact_sensitive_text
    from hermes_cli.debug import collect_debug_report
    from hermes_cli.debug_redaction import _EMAIL_ADDRESS_RE
    from hermes_cli.dump import collect_dump
    from hermes_cli.logs import LOG_FILES

    dump = collect_dump(SimpleNamespace(show_keys=False, skip_env_load=True, config_snapshot=_diagnostic_config(config or {}), read_only=True))
    snapshots = {name: _safe_snapshot(home, name, 200 if name == "agent" else 100)
                 for name in ("agent", "errors", "gateway", "gui", "desktop")}
    report = collect_debug_report(
        log_lines=200,
        dump_text=dump,
        log_snapshots=snapshots,
    )
    bundle = {"report": report}
    for name in ("agent", "gateway", "gui", "desktop"):
        if full := snapshots[name].full_text:
            filename = LOG_FILES.get(name, f"{name}.log")
            bundle[filename] = dump + f"\n\n--- full {filename} ---\n" + full
    # Redact the whole payload, including configuration/dump and URL credentials.
    bundle = {label: "[Credential and email redaction applied; personal content may remain.]\n" +
              _EMAIL_ADDRESS_RE.sub("[REDACTED_EMAIL]", redact_sensitive_text(
                  text, force=True, redact_url_credentials=True)) for label, text in bundle.items()}
    if sum(len(text.encode("utf-8")) for text in bundle.values()) > MAX_BYTES:
        raise ValueError("debug_share_too_large")
    return bundle


def _collect(home: Path) -> dict[str, str]:
    # Preserve platform/runtime basics, not provider secrets or project dotenv.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG")
           if key in os.environ}
    env["HERMES_HOME"] = str(home)
    project = Path(__file__).resolve().parent.parent
    try:
        result = subprocess.run(
            [sys.executable, "-m", "hermes_cli.matrix_debug_share"],
            cwd=project,
            env=env,
            capture_output=True,
            timeout=30,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        from hermes_cli.debug_redaction import redact_debug_support_text

        detail = redact_debug_support_text((exc.stderr or b"").decode("utf-8", "replace"))[-2000:]
        _log.error("Matrix debug capture child failed (exit %s): %s", exc.returncode, detail)
        raise RuntimeError("debug_share_capture_failed") from exc
    if len(result.stdout) > MAX_BYTES * 2:
        raise ValueError("debug_share_too_large")
    bundle = json.loads(result.stdout)
    if not isinstance(bundle, dict) or "report" not in bundle or any(
        label not in LABELS or not isinstance(content, str) for label, content in bundle.items()
    ) or sum(len(text.encode("utf-8")) for text in bundle.values()) > MAX_BYTES:
        raise ValueError("debug_share_invalid_capture")
    return bundle


def _prune():
    now = time.time()
    for key, value in list(_previews.items()):
        if value["expires_at"] <= now:
            del _previews[key]


def preview(home: Path) -> dict:
    key = str(home.resolve())
    with _lock:
        _prune()
        if _operations.get(key, {}).get("state") == "running":
            raise ValueError("debug_share_running")
        if key not in _previews and len(_previews) >= 32:
            raise ValueError("debug_share_busy")
    bundle = _collect(Path(key))
    captured = {"token": uuid.uuid4().hex, "expires_at": time.time() + PREVIEW_SECONDS,
                "bundle": bundle}
    with _lock:
        if _operations.get(key, {}).get("state") == "running":
            raise ValueError("debug_share_running")
        _prune()
        if key not in _previews and len(_previews) >= 32:
            raise ValueError("debug_share_busy")
        _previews[key] = captured
    return {"profile_scoped": True, "token": captured["token"], "expires_at": captured["expires_at"],
            "files": [{"label": label, "text": text, "bytes": len(text.encode("utf-8")),
                       "digest": hashlib.sha256(text.encode("utf-8")).hexdigest()}
                      for label, text in bundle.items()]}


def status(home: Path) -> dict:
    with _lock:
        value = _operations.get(str(home.resolve()))
        # Tokens remain private to deduplication and never enter status receipts.
        return {"profile_scoped": True, "state": value["state"] if value else "unknown",
                "destination": value["destination"] if value else None,
                "urls": [dict(item) for item in value["urls"]] if value else [],
                "uncertain_label": value["uncertain_label"] if value else None}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _upload(text: str, destination: str) -> str:
    if destination == "paste.rs":
        endpoint = "https://paste.rs/"
        data = text.encode("utf-8")
        content_type = "text/plain; charset=utf-8"
    elif destination == "dpaste.com":
        # Random delimiter cannot collide with a captured text body.
        boundary = "----AtumDebug" + uuid.uuid4().hex
        while boundary in text:
            boundary = "----AtumDebug" + uuid.uuid4().hex
        fields = {"content": text, "syntax": "text", "expiry_days": "7"}
        data = ("".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
                        for key, value in fields.items()) + f"--{boundary}--\r\n").encode("utf-8")
        endpoint = "https://dpaste.com/api/"
        content_type = "multipart/form-data; boundary=" + boundary
    else:
        raise ValueError("debug_share_destination_denied")
    request = urllib.request.Request(endpoint, data=data, method="POST", headers={
        "Content-Type": content_type, "User-Agent": "atum-matrix/debug-share"})
    deadline = time.monotonic() + 20
    with urllib.request.build_opener(_NoRedirect()).open(request, timeout=20) as response:
        chunks = []
        size = 0
        while size <= 4096:
            # read1 returns available bytes rather than waiting for a full
            # response buffer. An endless slow response must not hold this
            # operation indefinitely; one last socket read can take <=20s.
            chunk = response.read1(4097 - size)
            if time.monotonic() > deadline:
                raise TimeoutError("debug_share_response_timeout")
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        raw = b"".join(chunks)
    if len(raw) > 4096:
        raise ValueError("debug_share_invalid_url")
    url = raw.decode("utf-8").strip()
    if not valid_url(url, destination):
        raise ValueError("debug_share_invalid_url")
    return url


def _run(key: str, token: str, destination: str, files: list[tuple[str, str]]):
    urls = []
    uncertain = None
    for label, text in files:
        try:
            url = _upload(text, destination)
        except Exception:
            # A failed response does not prove the public server discarded bytes.
            # Never re-send it, fall back to another provider, or continue blindly.
            uncertain = label
            break
        urls.append({"label": label, "url": url})
        with _lock:
            _operations[key]["urls"] = list(urls)
    if destination == "paste.rs" and urls:
        context = set_hermes_home_override(key)
        try:
            from hermes_cli.debug import _schedule_auto_delete
            _schedule_auto_delete([item["url"] for item in urls])
        except Exception:
            pass  # best effort; no guaranteed expiry/deletion is advertised
        finally:
            reset_hermes_home_override(context)
    with _lock:
        _operations[key].update(state="uncertain" if uncertain else "succeeded",
                                urls=urls, uncertain_label=uncertain)
        value = _previews.get(key)
        if value and value["token"] == token:
            value["bundle"] = {}  # upload completion releases captured personal text


def start(home: Path, token: str, destination: str, labels: list[str]) -> dict:
    key = str(home.resolve())
    with _lock:
        current = _operations.get(key)
        if current and current.get("token") == token:
            return status(home)  # recovery of the same one-shot submission
        if current and current["state"] == "running":
            raise ValueError("debug_share_running")
        captured = _previews.get(key)
        if not captured or captured["token"] != token or captured["expires_at"] <= time.time():
            raise ValueError("debug_share_preview_expired")
        if destination not in ("paste.rs", "dpaste.com") or "report" not in labels or len(set(labels)) != len(labels) or any(
            label not in captured["bundle"] for label in labels
        ):
            raise ValueError("debug_share_selection_denied")
        files = [(label, captured["bundle"][label]) for label in LABELS if label in labels]
        _operations[key] = {"token": token, "state": "running", "destination": destination,
                            "urls": [], "uncertain_label": None}
        worker = threading.Thread(target=_run, args=(key, token, destination, files), daemon=True)
        try:
            worker.start()
        except Exception:
            _operations[key]["state"] = "uncertain"
            raise ValueError("debug_share_start_uncertain")
        return status(home)


if __name__ == "__main__":
    print(json.dumps(capture_bundle(Path(os.environ["HERMES_HOME"]))))
