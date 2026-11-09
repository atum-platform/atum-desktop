"""End-to-end durability contract for the Desktop advisory session_search source.

The model is deliberately stubbed, but its tool call travels through the real
``AIAgent`` loop, the real ``session_search`` dispatcher, and the real SQLite
session writer.  The Desktop requester is represented by a loopback HTTP
fixture so this test proves the bridge seam without touching an installed app
or any private conversation data.
"""

from __future__ import annotations

import copy
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request, urlopen
from unittest.mock import MagicMock, patch

import pytest

from gateway.session_context import reset_session_vars, set_session_vars
from hermes_state import SessionDB
from run_agent import AIAgent
from tools import desktop_ui


def _tool_defs() -> list[dict]:
    return [{
        "type": "function",
        "function": {
            "name": "session_search",
            "description": "Search past sessions.",
            "parameters": {"type": "object", "properties": {}},
        },
    }]


def _response(*, content: str = "", tool_calls=None, finish_reason: str = "stop"):
    return SimpleNamespace(
        choices=[SimpleNamespace(
            message=SimpleNamespace(content=content, tool_calls=tool_calls),
            finish_reason=finish_reason,
        )],
        model="fixture/model",
        usage=None,
    )


def _session_search_call() -> SimpleNamespace:
    return SimpleNamespace(
        id="advisory_call_1",
        type="function",
        function=SimpleNamespace(
            name="session_search",
            arguments=json.dumps({"query": "launch decision", "limit": 2}),
        ),
    )


def _make_agent(db: SessionDB, session_id: str, hermes_home: Path) -> AIAgent:
    """Build an actual agent loop with only the existing session_search tool."""
    with (
        patch("model_tools.get_tool_definitions", return_value=_tool_defs()),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
        patch("run_agent._hermes_home", hermes_home),
        patch("agent.model_metadata.fetch_model_metadata", return_value={}),
    ):
        agent = AIAgent(
            api_key="fixture-key",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            session_db=db,
            session_id=session_id,
        )
    agent.client = MagicMock()
    # Use a byte-stable prefix supplied by the harness. The regression is that
    # advisory retrieval is ordinary tool history, not a prompt rewrite.
    agent._cached_system_prompt = "You are a concise, helpful advisor."
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


class _AdvisoryFixture:
    """Loopback HTTP fixture behind the actual Desktop requester callback."""

    response = {
        "status": "ok",
        "results": [{
            "session_id": "atum-advisory:fixture_room_1",
            "conversation_id": "00000000-0000-4000-8000-bd7662a5eeb4",
            "title": "Launch advisors",
            "audience_revision": 7,
            "context_revision": 4,
            "messages": [
                {
                    "id": "00000000-0000-4000-8000-b454f82c5857",
                    "version": 1,
                    "created_at": "2026-09-06T09:00:00Z",
                    "speaker": {"kind": "app", "id": "moon"},
                    "text": "Delay launch until support staffing is ready.",
                },
                {
                    "id": "00000000-0000-4000-8000-f6222a1106ee",
                    "version": 1,
                    "created_at": "2026-09-06T09:02:00Z",
                    "speaker": {"kind": "app", "id": "andy"},
                    "text": "Ship the limited beta this Friday with staffed support.",
                },
            ],
        }],
        "next_reference": "atum-advisory:fixture_room_1_next",
    }

    def __init__(self):
        self.requests: list[dict] = []

        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - stdlib handler API
                length = int(self.headers["Content-Length"])
                fixture.requests.append(json.loads(self.rfile.read(length)))
                payload = json.dumps(fixture.response, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format, *_args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def requester(self, ui_session_id: str, event: str, payload: dict, timeout: float) -> str:
        assert ui_session_id == "desktop-fixture-window"
        assert event == "atum.advisory.search.request"
        request = Request(
            f"http://127.0.0.1:{self.server.server_port}/advisory-search",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=timeout) as response:  # nosec B310 -- loopback fixture
            return response.read().decode("utf-8")

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def _as_wire_text(messages: list[dict]) -> str:
    return json.dumps(messages, ensure_ascii=False, sort_keys=True)


@pytest.mark.skip(
    reason="session_search now owns local SQLite recall; Desktop advisory retrieval is no longer its native seam"
)
def test_advisory_search_dispatch_persists_and_replays_after_agent_restart(tmp_path):
    """A remote result follows ordinary tool history across a reconstructed agent.

    This proves the first vertical slice: the model calls existing
    ``session_search``; the response comes through the Desktop requester; and
    the returned attributed content survives the SQLite session boundary
    without changing the cached system prefix.
    """
    hermes_home = tmp_path / "hermes-home"
    (hermes_home / "logs").mkdir(parents=True)
    db = SessionDB(tmp_path / "state.db")
    session_id = "advisory-retrieval-history"
    fixture = _AdvisoryFixture()
    set_session_vars(
        session_id=session_id,
        ui_session_id="desktop-fixture-window",
        profile="moon",
    )
    desktop_ui.set_requester(fixture.requester)
    try:
        agent = _make_agent(db, session_id, hermes_home)
        cached_prefix = copy.deepcopy(agent._cached_system_prompt)
        agent.client.chat.completions.create.side_effect = [
            _response(tool_calls=[_session_search_call()], finish_reason="tool_calls"),
            _response(content="The advisors recommend a staffed limited beta on Friday."),
        ]

        first = agent.run_conversation("What did Moon and Andy decide about launch?")

        assert first["completed"] is True
        assert fixture.requests == [{
            "query": "launch decision",
            "reference": None,
            "limit": 2,
        }]
        assert agent._cached_system_prompt == cached_prefix

        persisted = db.get_messages(session_id)
        tool_rows = [row for row in persisted if row["role"] == "tool"]
        assert len(tool_rows) == 1
        # Attribution is source data, not a synthetic user message or hidden
        # context. The exact same content becomes ordinary durable tool history.
        assert '"source": "atum-advisory"' in tool_rows[0]["content"]
        assert '"speaker": {"kind": "app", "id": "moon"}' in tool_rows[0]["content"]
        assert "Delay launch until support staffing is ready." in tool_rows[0]["content"]
        assert "Ship the limited beta this Friday with staffed support." in tool_rows[0]["content"]

        # Simulate process restart: reconstruct a fresh AIAgent from the DB's
        # conversation projection and issue a normal next turn. Do not call
        # the source again; prove the persisted tool result is replayed.
        restored_history = db.get_messages_as_conversation(
            session_id, repair_alternation=True
        )
        restarted = _make_agent(db, session_id, hermes_home)
        restarted.client.chat.completions.create.return_value = _response(
            content="The retained advisory history says to launch the staffed beta Friday."
        )
        replay_prefix = copy.deepcopy(restarted._cached_system_prompt)

        second = restarted.run_conversation(
            "Give me the prior group recommendation.",
            conversation_history=restored_history,
        )

        assert second["completed"] is True
        assert len(fixture.requests) == 1, "the next turn should replay, not re-read the source"
        replay_request = restarted.client.chat.completions.create.call_args.kwargs
        wire_text = _as_wire_text(replay_request["messages"])
        assert "Delay launch until support staffing is ready." in wire_text
        assert "Ship the limited beta this Friday with staffed support." in wire_text
        assert restarted._cached_system_prompt == replay_prefix == cached_prefix

        # Normal Hermes in-place compaction is allowed to rebuild the system
        # prompt, but it must treat advisory output exactly like any other
        # persisted tool result: archive it durably and replace the live window
        # with an ordinary summary. This uses the production compaction path,
        # with only the summarizer itself deterministic.
        from agent.conversation_compression import compress_context

        agent.compression_in_place = True
        agent.context_compressor.compress = lambda *_args, **_kwargs: [
            {
                "role": "user",
                "content": "[CONTEXT COMPACTION] Advisors recommended a staffed Friday beta.",
            },
            {"role": "assistant", "content": "Retained the group recommendation."},
        ]
        agent.context_compressor._last_compress_aborted = False
        agent.context_compressor._last_summary_error = None
        agent.context_compressor.compression_count = 1
        compacted, _ = compress_context(
            agent,
            first["messages"],
            approx_tokens=100_000,
            system_message=cached_prefix,
        )

        assert agent._last_compaction_in_place is True
        assert [message["role"] for message in compacted] == ["user", "assistant"]
        live_history = db.get_messages_as_conversation(session_id)
        assert [message["content"] for message in live_history] == [
            "[CONTEXT COMPACTION] Advisors recommended a staffed Friday beta.",
            "Retained the group recommendation.",
        ]
        archived_rows = [
            row for row in db.get_messages(session_id, include_inactive=True)
            if not row["active"]
        ]
        assert any(
            row["role"] == "tool" and "Ship the limited beta this Friday" in row["content"]
            for row in archived_rows
        )
    finally:
        desktop_ui.set_requester(None)
        reset_session_vars()
        fixture.close()
        db.close()
