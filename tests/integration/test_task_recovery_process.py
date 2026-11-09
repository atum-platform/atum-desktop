"""Kill a real backend running Hermes; recover via the actual receipt adapter.

The loopback receiver models idempotent operation results. Its unique-operation
counter is NOT a PostgreSQL debit assertion; billing has a separate paired harness.
The pytest child inherits the repository's credential and Keychain isolation.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]
CHILD_INPUT = "ATUM_TASK_RECOVERY_TEST_INPUT"


def _completion(tool):
    message = {"role": "assistant", "content": "The retained file says ORIGINAL."}
    if tool:
        message = {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_note", "type": "function", "function": {
                "name": "read_file", "arguments": '{"path":"note.txt"}',
            },
        }]}
    return {"id": "result", "object": "chat.completion", "created": 1, "model": "binh-minh",
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool else "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _json(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):  # noqa: N802
        assert self.path == "/v1/utilities/route-authority"
        assert self.headers["Authorization"] == "Bearer temporary-broker-capability"
        self._json({"protected": False, "workspaceAlias": "binh-minh", "accountKey": self.server.account_key, "agentId": "test-agent"})

    def do_POST(self):  # noqa: N802
        assert self.path == "/v1/chat/completions"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        request_id = self.headers["x-atum-request-id"]
        with self.server.lock:
            self.server.requests.append((request_id, body))
            if request_id not in self.server.results:
                result = _completion(tool=not self.server.results)
                self.server.results[request_id] = (body, result)
            original, result = self.server.results[request_id]
            assert original == body, "same operation changed its request"
            should_wait = len(self.server.results) == 2 and not self.server.release.is_set()
        if should_wait:
            self.server.waiting.set()
            self.server.release.wait(30)
        if body.get("stream"):
            delta = dict(result["choices"][0]["message"])
            if delta.get("tool_calls"):
                delta["tool_calls"] = [{**call, "index": i} for i, call in enumerate(delta["tool_calls"])]
            chunk = {**result, "object": "chat.completion.chunk", "choices": [{
                "index": 0, "delta": delta, "finish_reason": result["choices"][0]["finish_reason"],
            }]}
            data = ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._json(result)


@pytest.mark.skipif(bool(os.environ.get(CHILD_INPUT)), reason="parent-only process test")
@pytest.mark.parametrize("kill_at,change_account", [("pending", False), ("consuming", False),
                                                     ("before_dispatch", False), ("pending", True)])
def test_real_process_restart(tmp_path, kill_at, change_account):
    home = tmp_path / "home"
    home.mkdir()
    (home / "profile.yaml").write_text("identity_id: " + str(uuid.uuid4()) + "\n")
    (home / "config.yaml").write_text("model:\n  context_length: 75000\n")
    (tmp_path / "note.txt").write_text("ORIGINAL")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    server.daemon_threads = True
    server.lock = threading.Lock()
    server.account_key = "a" * 64
    server.requests, server.results = [], {}
    server.waiting, server.release = threading.Event(), threading.Event()
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    payload = {"home": str(home), "workspace": str(tmp_path), "url": f"http://127.0.0.1:{server.server_port}",
               "submission_id": str(uuid.uuid4()), "conversation_id": "recovery-test-conversation",
               "kill_at": kill_at, "recover": False, "change_account": change_account}
    input_path = tmp_path / "input.json"

    def launch(recover):
        input_path.write_text(json.dumps({**payload, "recover": recover}))
        env = {**os.environ, CHILD_INPUT: str(input_path), "PYTHONPATH": str(ROOT)}
        output = open(tmp_path / ("resume.log" if recover else "start.log"), "w")
        proc = subprocess.Popen([sys.executable, "-m", "pytest", "-q", str(Path(__file__).resolve()) + "::test_child"],
                                cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
        return proc, output

    first = second = None
    first_log = second_log = None
    try:
        first, first_log = launch(False)
        if kill_at == "pending":
            assert server.waiting.wait(20), (tmp_path / "start.log").read_text()
        elif kill_at == "consuming":
            # Child exits itself immediately after the real tool effect.
            first.wait(20)
            assert (tmp_path / "tool-effects.txt").read_text() == "read_file\n"
        else:
            first.wait(20)
            assert not server.requests
        if first.poll() is None:
            first.kill()
        first.wait(10)
        first_log.close()
        server.release.set()
        if change_account:
            server.account_key = "b" * 64
        (tmp_path / "note.txt").write_text("CHANGED AFTER PROCESS DEATH")
        second, second_log = launch(True)
        second.wait(30)
        second_log.close()
        assert second.returncode == 0, (tmp_path / "resume.log").read_text()
        report = json.loads((tmp_path / "result.json").read_text())
        assert (tmp_path / "tool-effects.txt").read_text() == "read_file\n"
        if change_account:
            assert report["paused"]
            assert len(server.requests) == len(server.results) == 2
        elif kill_at in {"pending", "before_dispatch"}:
            assert report["completed"]
            assert report["user_rows"] == 1
            assert report["assistant_rows"] == 2
            assert report["tool_rows"] == 1
            assert any("ORIGINAL" in delta for delta in report["deltas"])
            assert report["api_calls"] == 2
            assert "ORIGINAL" in report["final_response"]
            assert len(server.results) == 2
            assert len(server.requests) == (3 if kill_at == "pending" else 2)
            if kill_at == "pending":
                assert server.requests[-1] == server.requests[-2]
        else:
            assert report["paused"]
            assert len(server.requests) == len(server.results) == 1
    finally:
        server.release.set()
        for process in (first, second):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(10)
        for output in (first_log, second_log):
            if output is not None:
                output.close()
        server.shutdown()
        server.server_close()
        serving.join(2)


@pytest.mark.skipif(not os.environ.get(CHILD_INPUT), reason="invoked by the isolated parent test")
def test_child(monkeypatch):
    payload = json.loads(Path(os.environ[CHILD_INPUT]).read_text())
    home, workspace = Path(payload["home"]), Path(payload["workspace"])
    monkeypatch.chdir(workspace)
    for key, value in {
        "HERMES_HOME": str(home), "TERMINAL_CWD": str(workspace),
        "ATUM_MANAGED_MODEL_BASE_URL": payload["url"] + "/v1",
        "ATUM_MANAGED_MODEL_PROXY_TOKEN": "temporary-proxy-capability",
        "ATUM_FILESYSTEM_BROKER_URL": payload["url"],
        "ATUM_FILESYSTEM_BROKER_TOKEN": "temporary-broker-capability",
        "ATUM_FILESYSTEM_CAPABILITY_REQUIRED": "1",
    }.items():
        monkeypatch.setenv(key, value)
    from agent.request_checkpoint import CheckpointUnavailable, RequestCheckpoint
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from tui_gateway.surface_context import bind_managed_submission, capabilities, claim_submission, finish_submission
    from tui_gateway.request_recovery import pending_submission

    db = SessionDB(db_path=home / "state.db")
    owner = capabilities(home, {"session_key": payload["conversation_id"], "profile_home": str(home)})
    if payload["recover"]:
        handle = pending_submission(home, owner)
        assert handle
    else:
        _, _, handle = claim_submission(home, owner, payload["submission_id"], "Read note.txt.", None, [], None)
    agent = AIAgent(
        api_key="temporary-proxy-capability", base_url=payload["url"] + "/v1", provider="atum-managed",
        model="binh-minh", api_mode="chat_completions", max_iterations=4, max_tokens=1024,
        enabled_toolsets=["file"], quiet_mode=True, tool_delay=0, skip_context_files=True,
        skip_memory=True, reasoning_config={"enabled": False}, session_id=payload["conversation_id"],
        session_db=db, platform="cli",
    )
    execute = agent._execute_tool_calls

    if payload["kill_at"] == "before_dispatch" and not payload["recover"]:
        pending = RequestCheckpoint.pending

        def arm_then_die(checkpoint, data):
            pending(checkpoint, data)
            os._exit(92)

        monkeypatch.setattr(RequestCheckpoint, "pending", arm_then_die)

    def counted_tool(*args):
        result = execute(*args)
        with open(workspace / "tool-effects.txt", "a") as output:
            output.write("read_file\n")
            output.flush()
            os.fsync(output.fileno())
        if payload["kill_at"] == "consuming":
            os._exit(91)  # actual process death: no context manager/finalizer runs
        return result

    monkeypatch.setattr(agent, "_execute_tool_calls", counted_tool)
    deltas = []
    try:
        with bind_managed_submission(agent, handle, recover=payload["recover"]):
            result = agent.run_conversation("Read note.txt.", task_id=payload["conversation_id"], stream_callback=deltas.append)
        finish_submission(handle, "complete")
        report = {"completed": result["completed"], "api_calls": result["api_calls"],
                  "final_response": result["final_response"],
                  "deltas": deltas}
        persisted = db.get_messages_as_conversation(payload["conversation_id"])
        for role in ("user", "assistant", "tool"):
            report[role + "_rows"] = sum(m["role"] == role for m in persisted)
    except CheckpointUnavailable:
        assert payload["recover"] and (payload["kill_at"] == "consuming" or payload["change_account"])
        report = {"paused": True}
    finally:
        agent.close()
        db.close()
    (workspace / "result.json").write_text(json.dumps(report))
