"""Disposable W3 source-composition proof; no model, credentials or live account.

Supply the immutable KS #414 package and Node 22 explicitly. The KS CLI verifies
its pinned engine. This controller owns synthetic ingest/withdraw verbs; the
Hermes provider gets ONLY a bound brain.retrieve callback, never this RPC peer.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.atum_awareness import (  # noqa: E402
    AtumAwarenessProvider, AwarenessRunBinding, AwarenessSessionError,
)
from agent.memory_manager import MemoryManager  # noqa: E402

AGENT = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e42"
PRIVATE = {"class": "private_owner"}
CANARY = "W3-PRIVATE-CANARY-9173"
PRIVATE_ROOM = "!W3Private:example.test"


class BrainPeer:
    """One sequential, bounded, disposable stdio proof controller (not RT)."""

    def __init__(self, package: Path, node: str, root: Path):
        self.messages: queue.Queue = queue.Queue(maxsize=32)
        self.lock = threading.Lock()
        self.process = subprocess.Popen(
            [node, str(package / "src/cli.mjs"), "serve", "--root", str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "HOME": str(root.parent), "TMPDIR": str(root.parent)},
            start_new_session=True,
        )
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.input = self.process.stdin
        self.output = self.process.stdout
        self.logs = self.process.stderr
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.drain = threading.Thread(target=self._drain, daemon=True)
        self.drain.start()
        try:
            ready = self.messages.get(timeout=120)
            if ready.get("method") != "brain.ready":
                raise RuntimeError("brain not ready")
        except BaseException:
            self.stop()
            raise

    def _read(self):
        try:
            while True:
                frame = self.output.readline(2 * 1024 * 1024)
                if not frame:
                    return
                if not frame.endswith(b"\n"):
                    raise RuntimeError("proof frame too large")
                self.messages.put(json.loads(frame), timeout=5)
        except Exception:
            self.messages.put({"error": {"code": "proof_transport_failed"}}, timeout=5)

    def _drain(self):
        # Drain without exposing provider diagnostics or source content.
        while self.logs.read(4096):
            pass

    def call(self, method, params, cancelled=None):
        with self.lock:
            request_id = str(uuid4())
            frame = json.dumps({"jsonrpc": "2.0", "id": request_id,
                                "method": method, "params": params}).encode() + b"\n"
            self.input.write(frame)
            self.input.flush()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if cancelled and cancelled.is_set():
                    raise RuntimeError("proof read cancelled")
                try:
                    message = self.messages.get(timeout=0.1)
                except queue.Empty:
                    continue
                if "error" in message:
                    raise RuntimeError("proof RPC failed")
                if message.get("id") == request_id:
                    return message["result"]
            raise RuntimeError("proof RPC timed out")

    def stop(self):
        try:
            if self.process.poll() is None:
                self.input.close()
                try:
                    self.process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    # Only the disposable process group started by this object.
                    os.killpg(self.process.pid, signal.SIGTERM)  # windows-footgun: ok — POSIX-only proof
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(self.process.pid, signal.SIGKILL)  # windows-footgun: ok — POSIX-only proof
                        self.process.wait(timeout=5)
        finally:
            self.reader.join(timeout=2)
            self.drain.join(timeout=2)
            for stream in (self.output, self.logs, self.input):
                stream.close()


def check(condition, name):
    if not condition:
        raise RuntimeError(f"proof failed: {name}")


def proof(package: Path, node: str):
    with tempfile.TemporaryDirectory(prefix="w3-brain-", dir=package) as directory:
        root = Path(directory)
        peer = BrainPeer(package, node, root / "account")
        stopped = []
        marks = []

        def provider(session, audience=PRIVATE, fence=False):
            home = root / session
            home.mkdir(mode=0o700)
            binding = AwarenessRunBinding(session, str(home), AGENT, audience, fence)
            value = AtumAwarenessProvider(
                binding, retrieve=lambda request, stop: peer.call("brain.retrieve", request, stop),
                is_current=lambda: True, mark_google_derived=lambda: marks.append(session) or True,
                invalidate_run=lambda: stopped.append(session),
            )
            manager = MemoryManager()
            manager.add_provider(value)
            manager.initialize_all(session_id=session, hermes_home=str(home))
            return value, manager

        fixture_root = package / "contract/awareness-v1/fixtures"
        def fixture(name):
            return json.loads((fixture_root / f"{name}.json").read_text(encoding="utf-8-sig"))

        try:
            message = fixture("envelope-human-group-message.managed")
            edited = fixture("envelope-edit.managed")
            drive = fixture("envelope-drive-file.managed")
            canary = copy.deepcopy(message)
            canary.update(operationId=str(uuid4()), source={"kind": "human_dm", "id": PRIVATE_ROOM},
                          object={"kind": "message", "id": "$privateCanary", "revision": 1},
                          content={"text": CANARY + " October salary", "attachments": []},
                          digest=hashlib.sha256((CANARY + " October salary").encode()).hexdigest())
            for envelope in (message, edited, drive, canary):
                check(peer.call("brain.ingest", envelope)["state"] == "accepted", "real ingest")

            private, manager = provider("private", fence=True)
            before = manager.build_system_prompt()
            schemas = manager.get_all_tool_schemas()
            began = time.monotonic()
            result = json.loads(manager.handle_tool_call("atum_recall", {"query": "October"}))
            recall_ms = round((time.monotonic() - began) * 1000)
            check(result["status"] in {"ok", "degraded"}, "real recall availability")
            group = next(row for row in result["items"] if row["source"]["id"] == message["source"]["id"])
            check(group["citation"]["eventId"] == edited["object"]["id"], "edit citation")
            check(group["digest"] == edited["digest"] and group["untrustedInput"] is True, "source identity")
            check(any(row["source"]["kind"] == "drive_file" for row in result["items"]), "real Drive retrieval")
            check(private.local_only and marks == ["private"], "Drive native taint ack")
            check(before == manager.build_system_prompt() and schemas == manager.get_all_tool_schemas(), "cache stability")
            check(manager.prefetch_all("October", session_id="private") == "", "no implicit prefetch")

            # Synthetic logical-scoping proof only: no OS/shared/model acceptance.
            shared, child = provider("shared", {"class": "shared_room", "roomId": message["source"]["id"]})
            wire = child.handle_tool_call("atum_recall", {"query": "October salary " + CANARY})
            scoped = json.loads(wire)
            check(scoped["status"] != "unavailable", "scoped real recall")
            check(CANARY not in wire and PRIVATE_ROOM not in wire, "full-bundle private canary")
            check(all(row["scope"].get("roomId") == message["source"]["id"] for row in scoped["items"]), "room items")
            check(all(row["source"]["id"] == message["source"]["id"] for row in scoped["coverage"]), "room metadata")

            receipt = peer.call("brain.withdraw", {
                "operationId": str(uuid4()), "withdrawalId": str(uuid4()),
                "scope": {"kind": "fact", "evidenceId": group["evidenceId"]},
                "reason": "forget", "requestedAt": time.time_ns() // 1_000_000,
            })
            check(receipt["state"] == "recorded", "durable withdrawal")
            check(receipt["purgeBy"] - receipt["recordedAt"] <= 86_400_000, "purge deadline")
            private.invalidate()
            shared.invalidate()
            try:
                private.assert_clean()
            except AwarenessSessionError:
                pass
            else:
                raise RuntimeError("proof failed: old held context remained usable")
            peer.stop()
            check(peer.process.poll() is not None, "first service stopped")
            peer = BrainPeer(package, node, root / "account")
            fresh, refreshed = provider("fresh", fence=True)
            after = json.loads(refreshed.handle_tool_call("atum_recall", {"query": "October"}))
            check(after["status"] != "unavailable", "post-restart recall")
            check(all(row["evidenceId"] != group["evidenceId"] for row in after["items"]), "withdrawal survives restart")
            fresh.shutdown()
            peer.stop()
            check(peer.process.poll() is not None, "service lease released")
            check(set(stopped) == {"private", "shared", "fresh"}, "native cancellation ack")
            print(json.dumps({"result": "passed", "scope": "source-only", "real_brain": True,
                              "citations": True, "scoped_canary": True,
                              "withdrawal_restart": True, "cache_stable": True,
                              "native_taint_ack": True, "service_stopped": True,
                              "default_deadline_seconds": 1.5, "first_recall_ms": recall_ms}))
        finally:
            peer.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("This disposable KS/GBrain proof requires macOS or Linux.")
    proof(args.package_root.resolve(), args.node)


if __name__ == "__main__":
    main()
