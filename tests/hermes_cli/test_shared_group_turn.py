"""End-to-end contract tests for the isolated shared-group turn child."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
from threading import Thread
from typing import Any


REPO = Path(__file__).resolve().parents[2]
PUBLIC_REPLY = "Sam suggested the riverside room; online is easier to attend."
PRIVATE_MARKERS = ("PRIVATE-MEMORY-CANARY", "PRIVATE-USER-CANARY", "PRIVATE-FILE-CANARY")


def _context(messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "conversation_id": "11111111-1111-1111-1111-111111111111",
        "messages": messages,
        "watermark": "22222222-2222-2222-2222-222222222222",
        "truncated": False,
        "source_clipped": False,
        "context_mode": "shared_group",
    }


def _message(message_id: str, kind: str, speaker_id: str, display_name: str, text: str) -> dict[str, Any]:
    return {
        "id": message_id,
        "version": 1,
        "speaker": {"kind": kind, "id": speaker_id, "display_name": display_name},
        "text": text,
    }


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _job(base_url: str, soul: str, context: dict[str, Any]) -> dict[str, Any]:
    return {
        "profile": "atum.shared-group-turn/1",
        "job_id": "33333333-3333-3333-3333-333333333333",
        "model": "binh-minh",
        "base_url": base_url,
        "persona_digest": hashlib.sha256(soul.encode()).hexdigest(),
        "context": context,
    }


def _run(job: dict[str, Any], *, home: Path, hermes_home: Path, workspace: Path, source_root: Path = REPO) -> tuple[dict[str, Any], subprocess.CompletedProcess[str]]:
    env = {
        "HOME": str(home),
        "HERMES_HOME": str(hermes_home),
        "USER": "shared",
        "LOGNAME": "shared",
        "HOSTNAME": "shared-group-test",
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": os.pathsep.join((str(source_root), str(REPO))),
        "PYTHONDONTWRITEBYTECODE": "1",
        "SHARED_MODEL_API_KEY": "shared-local-test-key",
        "AWS_EC2_METADATA_DISABLED": "true",
        "TIRITH_ENABLED": "false",
        "TZ": "UTC",
        "LANG": "C.UTF-8",
    }
    child = subprocess.run(
        [sys.executable, "-m", "hermes_cli.shared_group_turn"],
        cwd=workspace,
        env=env,
        input=_compact(job),
        text=True,
        capture_output=True,
        timeout=45,
    )
    lines = child.stdout.splitlines()
    assert len(lines) == 1, (child.stdout, child.stderr[-2000:])
    return json.loads(lines[0]), child


def test_real_custom_http_turn_keeps_group_context_and_refuses_tools(tmp_path: Path) -> None:
    # A source checkout may have a developer .env. Exercise its actual
    # run_agent import path without writing into the real checkout.
    source_root = tmp_path / "source"
    source_root.mkdir()
    shutil.copyfile(REPO / "run_agent.py", source_root / "run_agent.py")
    managed = tmp_path / "private-managed"
    managed.mkdir()
    managed_config = managed / "config.yaml"
    managed_config.write_text("private_canary: PRIVATE-MANAGED-CONFIG-CANARY\n")
    # Run the actual managed-scope loader at the same core-import boundary. If
    # shared entry did not redirect the system scope, the canary is observable.
    bootstrap = (
        "from pathlib import Path\n"
        "import hermes_cli.managed_scope as scope\n"
        f"scope._DEFAULT_MANAGED_DIR = Path({str(managed)!r})\n"
        "assert scope.load_managed_config() == {}, 'private managed config loaded'\n"
    )
    (source_root / "managed_canary_probe.py").write_text(bootstrap)
    agent_source = source_root / "run_agent.py"
    original = agent_source.read_text()
    # Keep the real module's future import first, then instrument its bootstrap.
    marker = "from __future__ import annotations"
    if marker in original:
        original = original.replace(marker, marker + "\nimport managed_canary_probe", 1)
    else:
        original = "import managed_canary_probe\n" + original
    agent_source.write_text(original)
    project_env = source_root / ".env"
    project_bytes = b"SHARED_MODEL_API_KEY=PRIVATE-PROJECT-ENV-CANARY\n"
    project_env.write_bytes(project_bytes)
    requests: list[dict[str, Any]] = []
    system_messages: list[dict[str, Any]] = []
    gets: list[str] = []
    metadata_probes: list[tuple[str, dict[str, Any]]] = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_: Any) -> None:
            pass

        def do_GET(self) -> None:
            gets.append(self.path)
            body = b'{"object":"list","data":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if "messages" not in request:
                metadata_probes.append((self.path, request))
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            assert self.headers.get("Authorization") == "Bearer shared-local-test-key"
            requests.append(request)
            if request["messages"][-1]["role"] == "tool":
                message = {"role": "assistant", "content": PUBLIC_REPLY}
                finish_reason = "stop"
            else:
                system_messages.append(request["messages"][0])
                message = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "forged-read",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path":"../../private/private-note.txt"}',
                        },
                    }],
                }
                finish_reason = "tool_calls"
            response = {
                "id": "chatcmpl-shared",
                "object": "chat.completion",
                "created": 1,
                "model": request["model"],
                "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            }
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        home, hermes_home, workspace = tmp_path / "shared", tmp_path / "shared" / ".hermes", tmp_path / "shared" / "workspace"
        hermes_home.mkdir(parents=True)
        workspace.mkdir()
        soul = "You are the approved calm facilitator."
        (hermes_home / "SOUL.md").write_text(soul)
        (hermes_home / "config.yaml").write_text("agent:\n  environment_probe: false\n")
        private = tmp_path / "private"
        private.mkdir()
        (private / "private-note.txt").write_text(PRIVATE_MARKERS[2])
        memory = hermes_home / "memories"
        memory.mkdir()
        (memory / "MEMORY.md").write_text(PRIVATE_MARKERS[0])
        (memory / "USER.md").write_text(PRIVATE_MARKERS[1])
        before = {path: path.read_bytes() for path in (private / "private-note.txt", memory / "MEMORY.md", memory / "USER.md")}

        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        first_context = _context([_message("44444444-4444-4444-4444-444444444444", "user", "sam", "Sam", "Which meeting place works?")])
        first_result, first_child = _run(_job(base_url, soul, first_context), home=home, hermes_home=hermes_home, workspace=workspace, source_root=source_root)
        assert first_child.returncode == 0, first_child.stderr[-2000:]
        assert first_result == {
            "profile": "atum.shared-group-turn/1",
            "job_id": "33333333-3333-3333-3333-333333333333",
            "state": "completed",
            "reply_text": PUBLIC_REPLY,
        }, first_child.stderr[-4000:]

        follow_up_context = _context([
            *first_context["messages"],
            _message("55555555-5555-5555-5555-555555555555", "assistant", "binh-minh", "Binh Minh", PUBLIC_REPLY),
            _message("66666666-6666-6666-6666-666666666666", "user", "sam", "Sam", "What did you suggest?"),
        ])
        second_result, second_child = _run(_job(base_url, soul, follow_up_context), home=home, hermes_home=hermes_home, workspace=workspace, source_root=source_root)
        assert second_child.returncode == 0, second_child.stderr[-2000:]
        assert second_result["state"] == "completed"

        assert len(requests) == 4
        assert all(request["model"] == "binh-minh" and not request.get("tools") for request in requests)
        assert requests[0]["messages"][-1] == {"role": "user", "content": _compact(first_context)}
        assert requests[0]["messages"][-1]["content"].encode() == _compact(first_context).encode()
        assert requests[2]["messages"][-1] == {"role": "user", "content": _compact(follow_up_context)}
        assert requests[2]["messages"][-1]["content"].encode() == _compact(follow_up_context).encode()
        assert PUBLIC_REPLY in requests[2]["messages"][-1]["content"]
        assert system_messages[0] == system_messages[1]
        assert soul in system_messages[0]["content"]
        assert "participating in an Atum group conversation" in system_messages[0]["content"]
        assert "interacting via a command-line interface" not in system_messages[0]["content"]
        assert all(request["max_tokens"] == 8192 for request in requests)
        wire = _compact(requests)
        assert all(marker not in wire for marker in (*PRIVATE_MARKERS, "PRIVATE-PROJECT-ENV-CANARY"))
        assert project_env.read_bytes() == project_bytes
        assert all("does not exist" in requests[index]["messages"][-1]["content"] for index in (1, 3))
        assert before == {path: path.read_bytes() for path in before}
        # Hermes' native Ollama capability probe is real, but it stays on the
        # supplied custom endpoint and is not an external metadata lookup.
        assert all(path == "/api/show" and probe == {"name": "binh-minh"} for path, probe in metadata_probes)
        assert all(path.startswith("/") for path in gets)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_rejects_extra_job_fields_and_never_leaks_paths(tmp_path: Path) -> None:
    home, hermes_home, workspace = tmp_path / "shared", tmp_path / "shared" / ".hermes", tmp_path / "shared" / "workspace"
    hermes_home.mkdir(parents=True)
    workspace.mkdir()
    soul = "Approved identity"
    (hermes_home / "SOUL.md").write_text(soul)
    job = _job("http://127.0.0.1:8080/v1", soul, _context([]))
    job["session_id"] = str(tmp_path / "private-session.db")
    result, child = _run(job, home=home, hermes_home=hermes_home, workspace=workspace)
    assert child.returncode == 0
    assert result["profile"] == "atum.shared-group-turn/1"
    assert result["job_id"] == "33333333-3333-3333-3333-333333333333"
    assert result["state"] == "failed"
    assert result["error"] == "invalid_job"
    assert str(tmp_path) not in child.stdout
    assert str(tmp_path) not in child.stderr

    mismatch = _job("http://127.0.0.1:8080/v1", soul, _context([]))
    mismatch["persona_digest"] = "0" * 64
    mismatch_result, mismatch_child = _run(mismatch, home=home, hermes_home=hermes_home, workspace=workspace)
    assert mismatch_child.returncode == 0
    assert mismatch_result["state"] == "failed"
    assert mismatch_result["error"] == "persona_mismatch"


def test_rejects_context_larger_than_shared_group_bound(tmp_path: Path) -> None:
    home, hermes_home, workspace = tmp_path / "shared", tmp_path / "shared" / ".hermes", tmp_path / "shared" / "workspace"
    hermes_home.mkdir(parents=True)
    workspace.mkdir()
    soul = "Approved identity"
    (hermes_home / "SOUL.md").write_text(soul)
    messages = [
        _message(
            f"00000000-0000-0000-0000-{index:012d}",
            "user",
            "sam",
            "Sam",
            "x",
        )
        for index in range(13)
    ]
    result, child = _run(
        _job("http://127.0.0.1:8080/v1", soul, _context(messages)),
        home=home,
        hermes_home=hermes_home,
        workspace=workspace,
    )
    assert child.returncode == 0
    assert result["state"] == "failed"
    assert result["error"] == "context_too_large"

    oversized = _job(
        "http://127.0.0.1:8080/v1",
        soul,
        _context([_message("77777777-7777-7777-7777-777777777777", "user", "sam", "Sam", "x" * 6000)]),
    )
    oversized_result, oversized_child = _run(oversized, home=home, hermes_home=hermes_home, workspace=workspace)
    assert oversized_child.returncode == 0
    assert oversized_result["state"] == "failed"
    assert oversized_result["error"] == "context_too_large"
