"""The default assistant's Google tool forwards one closed request to Atum's broker."""

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tools import atum_google_tool
from tools.atum_google_tool import ATUM_GOOGLE_SCHEMA, atum_google

KEY = "a" * 64


class _Broker:
    """A loopback stand-in for Atum's broker that records what reached it."""

    def __init__(self, answer=None, status=200, hang=False, raw=None, headers=None):
        self.answer = answer if answer is not None else {"ok": True}
        self.status = status
        self.hang = hang
        #: (bytes, filename, mime type) served on the attachment route instead of JSON.
        self.raw = raw
        self.headers = headers or {}
        self.requests = []
        broker = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                broker.requests.append(
                    {
                        "path": self.path,
                        "auth": self.headers.get("Authorization"),
                        "body": json.loads(self.rfile.read(length) or b"{}"),
                    }
                )
                if broker.hang:
                    # Close without an answer: the caller cannot tell what happened.
                    self.close_connection = True
                    return
                if broker.raw is not None and self.path == "/v1/google/attachment":
                    data, filename, mime = broker.raw
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("X-Atum-Filename", urllib.parse.quote(filename))
                    self.send_header("X-Atum-Mime-Type", urllib.parse.quote(mime))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                body = json.dumps(broker.answer).encode()
                self.send_response(broker.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, value in broker.headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        assert not self.thread.is_alive()


@pytest.fixture(autouse=True)
def _fresh_process(monkeypatch):
    from agent import atum_google_fence

    monkeypatch.setattr(atum_google_fence, "_holding", False)
    monkeypatch.setenv(atum_google_fence.ROUTE_ENV, "http://127.0.0.1:43123/v1")
    monkeypatch.delenv(atum_google_fence.MODEL_BASE_ENV, raising=False)
    monkeypatch.delenv(atum_google_fence.LATCHED_ENV, raising=False)


@pytest.fixture
def broker(monkeypatch):
    created = []

    def make(**kwargs):
        instance = _Broker(**kwargs)
        created.append(instance)
        monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", instance.url)
        monkeypatch.setenv("ATUM_GOOGLE_TOOLS_TOKEN", KEY)
        return instance

    yield make
    for instance in created:
        instance.close()


def test_absent_without_atum_launch_environment(monkeypatch):
    monkeypatch.delenv("ATUM_GOOGLE_TOOLS_URL", raising=False)
    monkeypatch.delenv("ATUM_GOOGLE_TOOLS_TOKEN", raising=False)

    assert atum_google_tool._available() is False
    assert "not available" in json.loads(atum_google({"action": "status"}))["error"]


@pytest.mark.parametrize(
    "url,token",
    [
        ("https://127.0.0.1:5000", KEY),  # not plain loopback HTTP
        ("http://example.com:5000", KEY),  # not loopback
        ("http://127.0.0.1:5000/other", KEY),  # a path
        ("http://user:pw@127.0.0.1:5000", KEY),  # credentials in the URL
        ("http://127.0.0.1:5000", "short"),  # a weak key
        ("http://127.0.0.1:5000", "x" * 63 + "!"),  # not the key Atum mints
    ],
)
def test_refuses_anything_but_atums_bound_broker(monkeypatch, url, token):
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", url)
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_TOKEN", token)

    assert atum_google_tool._available() is False


def test_accepts_exactly_the_cloud_model_brokers_origin(monkeypatch):
    from agent import atum_google_fence

    route = "http://10.231.0.1:8080/v1"
    monkeypatch.setenv(atum_google_fence.MODEL_BASE_ENV, route)
    # Full-power platform routing (0290) uses the current turn broker without the retired
    # google-protected fence variable.
    monkeypatch.delenv(atum_google_fence.ROUTE_ENV, raising=False)
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", "http://10.231.0.1:8080")
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_TOKEN", "g" * 43)
    assert atum_google_tool._available() is True

    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", "http://10.231.0.2:8080")
    assert atum_google_tool._available() is False

    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", "http://10.231.0.1:8080")
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_TOKEN", "-_" * 21 + "-")
    assert atum_google_tool._available() is True


def test_forwards_only_the_actions_own_arguments_with_the_launch_key(broker):
    fake = broker(answer={"threads": []})

    result = json.loads(
        atum_google(
            {"action": "search_mail", "query": "from:lan", "body": "not for search", "sourceId": "", "extra": 1}
        )
    )

    assert result == {"threads": []}
    assert fake.requests == [
        {"path": "/v1/google", "auth": f"Bearer {KEY}", "body": {"action": "search_mail", "query": "from:lan"}}
    ]


def test_forwards_a_mail_page_cursor_with_its_mailbox(broker):
    fake = broker(answer={"threads": [], "nextPages": [{"sourceId": "google:gmail", "pageToken": "0987"}]})

    result = json.loads(
        atum_google(
            {"action": "search_mail", "query": "after:2020/01/01", "sourceId": "google:gmail", "pageToken": "1234"}
        )
    )

    assert result["nextPages"] == [{"sourceId": "google:gmail", "pageToken": "0987"}]
    assert fake.requests[0]["body"] == {
        "action": "search_mail", "query": "after:2020/01/01", "sourceId": "google:gmail", "pageToken": "1234"
    }
    readonly = atum_google_tool.ATUM_GOOGLE_READONLY_SCHEMA["parameters"]["properties"]
    assert "pageToken" in readonly and "sourceId" in readonly


def test_passes_the_brokers_refusal_through_for_the_assistant_to_explain(broker):
    broker(answer={"error": "not_allowed", "hint": "The owner chose not to share this with Atum."})

    assert json.loads(atum_google({"action": "search_drive", "query": "budget"}))["error"] == "not_allowed"


def test_forwards_the_drive_sort_and_modified_after(broker):
    fake = broker(answer={"files": []})

    result = json.loads(atum_google({
        "action": "search_drive", "query": "budget", "sort": "viewed", "modifiedAfter": "2026-01-01"}))

    assert result == {"files": []}
    assert fake.requests == [{"path": "/v1/google", "auth": f"Bearer {KEY}", "body": {
        "action": "search_drive", "query": "budget", "sort": "viewed", "modifiedAfter": "2026-01-01"}}]


def test_refuses_unknown_actions_without_calling_the_broker(broker):
    fake = broker()

    assert "action must be one of" in json.loads(atum_google({"action": "delete_all"}))["error"]
    assert fake.requests == []


def test_a_refused_key_is_reported_as_unavailable(broker):
    broker(answer={"error": "not_available"}, status=401)

    assert "not available" in json.loads(atum_google({"action": "status"}))["error"]


@pytest.mark.parametrize("status,code", [(429, "rate_limited"), (404, "not_found")])
def test_broker_read_refusals_preserve_codes_and_retry_after(broker, status, code):
    fake = broker(answer={"error": "private broker detail"}, status=status, headers={"Retry-After": "37"})
    result = json.loads(atum_google({"action": "agenda"}))
    assert result["code"] == code
    assert "private broker detail" not in json.dumps(result)
    assert len(fake.requests) == 1
    if code == "rate_limited":
        assert result["retryAfter"] == "37"


def test_a_write_without_an_answer_may_already_have_happened(broker):
    broker(hang=True)

    result = json.loads(
        atum_google(
            {"action": "send_email", "sourceId": "s:mail", "to": ["lan@example.com"], "subject": "Hi", "body": "Hello"}
        )
    )

    assert result["code"] == "outcome_unknown"
    assert "already" in result["error"]


def test_a_read_failure_does_not_claim_the_broker_runs_on_a_mac(broker):
    broker(hang=True)

    result = json.loads(atum_google({"action": "search_drive", "query": "budget"}))

    assert "could not reach Google" in result["error"]
    assert "Mac" not in result["error"]


def test_schema_offers_reads_and_confirmed_writes_but_no_delete_or_raw_access():
    actions = ATUM_GOOGLE_SCHEMA["parameters"]["properties"]["action"]["enum"]

    assert {"agenda", "waiting", "read_thread", "search_drive", "read_file", "send_email"} <= set(actions)
    assert not any(word in action for action in actions for word in ("delete", "trash", "forward", "share"))
    assert "url" not in ATUM_GOOGLE_SCHEMA["parameters"]["properties"]
    assert "untrusted" in ATUM_GOOGLE_SCHEMA["description"]
    assert "confirmationRequired" in ATUM_GOOGLE_SCHEMA["description"]
    assert "Omit on the first proposal" in ATUM_GOOGLE_SCHEMA["parameters"]["properties"]["operationId"]["description"]


def test_schema_teaches_the_deep_read_grammar_and_the_google_memory_boundary():
    schema = ATUM_GOOGLE_SCHEMA
    description = schema["description"]
    properties = schema["parameters"]["properties"]

    for phrase in ("category:promotions", "past 30/365 days", "modifiedAfter", "PDF and Word",
                   "25 results", "after:2022/01/01"):
        assert phrase in description
    assert "durable facts about the owner learned from Google" in description
    assert "never raw passages, credentials" in description
    assert "raw Google content out of web searches" in description
    assert {"next_7d", "past_30d", "past_365d"} <= set(properties["when"]["enum"])
    assert properties["sort"]["enum"] == ["modified", "viewed"]
    assert "YYYY-MM-DD" in properties["modifiedAfter"]["description"]


def test_google_data_entering_the_process_turns_its_egress_tools_off(broker):
    from agent import atum_google_fence

    broker(answer={"error": "not_connected", "hint": "Google is not connected."})
    atum_google({"action": "agenda"})
    # A refusal carries no Google data: nothing changes.
    assert not atum_google_fence.holding_google()

    broker(answer={"events": [{"title": "Quote review with Lan"}]})
    atum_google({"action": "agenda"})
    assert atum_google_fence.holding_google()
    assert atum_google_fence.egress_refusal("web_search") == atum_google_fence.EGRESS_MESSAGE


# --- mailbox control (agent email control, 2026-11-08) ---------------------------------------------


def test_forwards_each_mailbox_action_with_only_its_own_arguments(broker):
    fake = broker(answer={"done": True})

    atum_google({"action": "read_message", "sourceId": "google:gmail", "messageId": "m1", "offset": 20000, "body": "no"})
    atum_google({
        "action": "mailbox", "sourceId": "google:gmail", "operation": "add_labels", "messageId": "m1",
        "labels": ["Receipts"], "to": ["nobody@example.com"],
    })
    atum_google({"action": "create_draft", "sourceId": "s", "to": ["a@example.com"], "subject": "Hi", "body": "B", "operationId": "x"})

    assert [request["body"] for request in fake.requests] == [
        {"action": "read_message", "sourceId": "google:gmail", "messageId": "m1", "offset": 20000},
        {"action": "mailbox", "sourceId": "google:gmail", "operation": "add_labels", "messageId": "m1", "labels": ["Receipts"]},
        {"action": "create_draft", "sourceId": "s", "to": ["a@example.com"], "subject": "Hi", "body": "B"},
    ]
    assert {request["path"] for request in fake.requests} == {"/v1/google"}


def test_a_typed_scope_refusal_reaches_the_agent_and_does_not_hold_google_data(broker):
    from agent import atum_google_fence

    broker(answer={"error": "scope_missing", "hint": "Google must be reconnected with mailbox access."})
    result = json.loads(atum_google({"action": "mailbox", "sourceId": "s", "operation": "archive", "threadId": "t1"}))

    assert result["error"] == "scope_missing"
    assert not atum_google_fence.holding_google()


@pytest.mark.parametrize("variable", ["HERMES_CRON_SESSION", "HERMES_KANBAN_TASK"])
def test_scheduled_and_background_runs_never_change_the_mailbox_but_still_read(broker, monkeypatch, variable):
    fake = broker(answer={"id": "m1"})
    monkeypatch.setenv(variable, "1" if variable == "HERMES_CRON_SESSION" else "task-9")

    for request in (
        {"action": "mailbox", "sourceId": "s", "operation": "archive", "threadId": "t1"},
        {"action": "create_label", "sourceId": "s", "name": "Work"},
        {"action": "create_draft", "sourceId": "s", "to": [], "subject": "x", "body": "y"},
        {"action": "update_draft", "sourceId": "s", "draftId": "d1", "to": [], "subject": "x", "body": "y"},
        {"action": "download_attachment", "sourceId": "s", "messageId": "m1", "attachmentId": "ATT-1"},
        # Sending reaches other people (and may carry the owner's files): only while the owner is talking.
        {"action": "send_email", "sourceId": "s", "to": ["lan@example.com"], "subject": "x", "body": "y"},
        {"action": "send_email", "sourceId": "s", "reply": {"messageId": "m1"}, "body": "y"},
    ):
        refused = json.loads(atum_google(request))
        assert refused["error"] == "owner_turn_required"
        assert "scheduled" in refused["hint"]

    assert fake.requests == []
    assert json.loads(atum_google({"action": "read_message", "sourceId": "s", "messageId": "m1"})) == {"id": "m1"}
    assert len(fake.requests) == 1


def test_an_attachment_is_saved_as_a_file_in_the_workspace_and_never_returned_as_bytes(broker, monkeypatch, tmp_path):
    from tools import file_tools_paths

    monkeypatch.setattr(file_tools_paths, "_authoritative_workspace_root", lambda *a, **k: str(tmp_path))
    pdf = b"%PDF-1.4 canary \x00\x01 bytes"
    fake = broker(raw=(pdf, "../../etc/in voice.pdf", "application/pdf"))
    request = {"action": "download_attachment", "sourceId": "s", "messageId": "m1", "attachmentId": "ATT-1", "body": "no"}

    first = json.loads(atum_google(request))

    assert fake.requests[0]["path"] == "/v1/google/attachment"
    assert fake.requests[0]["body"] == {"action": "download_attachment", "sourceId": "s", "messageId": "m1", "attachmentId": "ATT-1"}
    assert first["done"] is True and first["size"] == len(pdf) and first["mimeType"] == "application/pdf"
    assert first["path"] == str(tmp_path / "Email attachments" / "in voice.pdf")
    assert (tmp_path / "Email attachments" / "in voice.pdf").read_bytes() == pdf
    assert "canary" not in json.dumps(first)

    # A second file with the same name never replaces the first.
    second = json.loads(atum_google(request))
    assert second["path"] == str(tmp_path / "Email attachments" / "in voice (2).pdf")
    assert (tmp_path / "Email attachments" / "in voice.pdf").read_bytes() == pdf
    assert not (tmp_path.parent / "etc").exists()


def test_an_attachment_refusal_is_passed_through_and_writes_nothing(broker, monkeypatch, tmp_path):
    from tools import file_tools_paths

    monkeypatch.setattr(file_tools_paths, "_authoritative_workspace_root", lambda *a, **k: str(tmp_path))
    broker(answer={"error": "too_large", "hint": "Name the file to the owner."})

    result = json.loads(atum_google({"action": "download_attachment", "sourceId": "s", "messageId": "m", "attachmentId": "A"}))

    assert result["error"] == "too_large"
    assert not (tmp_path / "Email attachments").exists()


def test_schema_teaches_mailbox_control_and_the_readonly_tool_stays_read_only():
    properties = ATUM_GOOGLE_SCHEMA["parameters"]["properties"]
    description = ATUM_GOOGLE_SCHEMA["description"]

    assert {"read_message", "download_attachment", "mailbox", "create_draft", "update_draft", "list_labels",
            "create_label", "list_drafts"} <= set(properties["action"]["enum"])
    assert properties["operation"]["enum"] == list(atum_google_tool._MAILBOX_OPERATIONS)
    for phrase in ("scope_missing", "never in a scheduled run", "never sent", "nextOffset", "olderMessages"):
        assert phrase in description

    readonly = atum_google_tool.ATUM_GOOGLE_READONLY_SCHEMA["parameters"]["properties"]
    # The first-learning fence is deliberately unchanged: no mailbox control, attachments or single-message reads there.
    assert not {"read_message", "list_labels", "mailbox", "create_label", "create_draft", "update_draft",
                "download_attachment", "send_email"} & set(readonly["action"]["enum"])
    assert "operation" not in readonly and "draftId" not in readonly


def test_the_readonly_tool_refuses_mailbox_changes_without_calling_the_broker(broker):
    fake = broker()

    refused = json.loads(atum_google_tool.atum_google_readonly(
        {"action": "mailbox", "sourceId": "s", "operation": "archive", "threadId": "t"}))

    assert "action must be one of" in refused["error"]
    assert fake.requests == []


@pytest.mark.parametrize("variable,value", [("HERMES_CRON_SESSION", "1"), ("HERMES_KANBAN_TASK", "task-9")])
def test_a_background_run_downloads_nothing_and_writes_no_file(broker, monkeypatch, tmp_path, variable, value):
    from tools import file_tools_paths

    monkeypatch.setattr(file_tools_paths, "_authoritative_workspace_root", lambda *a, **k: str(tmp_path))
    fake = broker(raw=(b"%PDF canary", "invoice.pdf", "application/pdf"))
    monkeypatch.setenv(variable, value)

    refused = json.loads(atum_google({"action": "download_attachment", "sourceId": "s", "messageId": "m1", "attachmentId": "A"}))

    assert refused["error"] == "owner_turn_required"
    assert fake.requests == []
    assert not (tmp_path / "Email attachments").exists()


def test_each_session_saves_attachments_in_its_own_workspace(broker, tmp_path):
    from tools.terminal_tool import clear_task_env_overrides, register_task_env_overrides

    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    broker(raw=(b"%PDF canary", "invoice.pdf", "application/pdf"))
    register_task_env_overrides("session-one", {"cwd": str(first)})
    register_task_env_overrides("session-two", {"cwd": str(second)})
    request = {"action": "download_attachment", "sourceId": "s", "messageId": "m1", "attachmentId": "A"}

    try:
        one = json.loads(atum_google(request, task_id="session-one"))
        two = json.loads(atum_google(request, task_id="session-two"))
        again = json.loads(atum_google(request, task_id="session-one"))
    finally:
        clear_task_env_overrides("session-one")
        clear_task_env_overrides("session-two")

    assert one["path"] == str(first / "Email attachments" / "invoice.pdf")
    assert two["path"] == str(second / "Email attachments" / "invoice.pdf")
    assert again["path"] == str(first / "Email attachments" / "invoice (2).pdf")
    assert not (first / "Email attachments" / "invoice.pdf").samefile(second / "Email attachments" / "invoice.pdf")


def test_the_registered_handler_hands_the_sessions_task_id_to_the_tool(broker, tmp_path):
    from tools.registry import registry
    from tools.terminal_tool import clear_task_env_overrides, register_task_env_overrides

    workspace = tmp_path / "ws"
    workspace.mkdir()
    broker(raw=(b"data", "a.txt", "text/plain"))
    register_task_env_overrides("session-h", {"cwd": str(workspace)})

    try:
        result = json.loads(registry.dispatch(
            "atum_google", {"action": "download_attachment", "sourceId": "s", "messageId": "m", "attachmentId": "A"},
            task_id="session-h"))
    finally:
        clear_task_env_overrides("session-h")

    assert result["path"] == str(workspace / "Email attachments" / "a.txt")


# --- outgoing mail: cc/bcc, reply, forward, attachments (agent email compose) ------------------------------


def test_forwards_cc_bcc_reply_and_forward_exactly_and_drops_empty_values(broker):
    fake = broker(answer={"done": True})

    atum_google({
        "action": "send_email", "sourceId": "s", "to": [], "cc": ["c@example.com"], "bcc": ["b@example.com"],
        "reply": {"messageId": "m1", "all": True}, "body": "Thanks", "subject": "", "unknown": "dropped",
    })
    atum_google({
        "action": "create_draft", "sourceId": "s", "to": ["a@example.com"], "forward": {"messageId": "m2", "attachments": False},
        "body": "FYI",
    })

    assert [request["body"] for request in fake.requests] == [
        {"action": "send_email", "sourceId": "s", "cc": ["c@example.com"], "bcc": ["b@example.com"],
         "reply": {"messageId": "m1", "all": True}, "body": "Thanks"},
        {"action": "create_draft", "sourceId": "s", "to": ["a@example.com"],
         "forward": {"messageId": "m2", "attachments": False}, "body": "FYI"},
    ]


def _workspace(monkeypatch, tmp_path):
    from tools import file_tools_paths

    monkeypatch.setattr(file_tools_paths, "_authoritative_workspace_root", lambda *a, **k: str(tmp_path))


def test_attachments_are_read_from_the_workspace_and_sent_as_base64_with_name_and_type(broker, monkeypatch, tmp_path):
    import base64

    _workspace(monkeypatch, tmp_path)
    (tmp_path / "Email attachments").mkdir()
    pdf = b"%PDF-1.4 canary \x00\x01\xff bytes"
    (tmp_path / "Email attachments" / "báo giá.pdf").write_bytes(pdf)
    (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
    fake = broker(answer={"done": True})

    atum_google({
        "action": "send_email", "sourceId": "s", "to": ["a@example.com"], "subject": "Files", "body": "See attached",
        "attachments": ["Email attachments/báo giá.pdf", {"path": str(tmp_path / "notes.txt"), "filename": "ghi chú.txt"}],
    })

    sent = fake.requests[0]["body"]
    assert [(file["filename"], file["mimeType"]) for file in sent["attachments"]] == [
        ("báo giá.pdf", "application/pdf"), ("ghi chú.txt", "text/plain"),
    ]
    assert base64.b64decode(sent["attachments"][0]["data"]) == pdf
    assert base64.b64decode(sent["attachments"][1]["data"]) == b"hello"
    # The agent named paths; only the file contents reach the broker, never the paths.
    assert str(tmp_path) not in json.dumps(sent)


@pytest.mark.parametrize("bad", ["../outside.txt", "/etc/hosts", "missing.txt", "Email attachments", "link.txt"])
def test_attachments_outside_or_missing_in_the_workspace_are_refused_before_the_broker(broker, monkeypatch, tmp_path, bad):
    import os

    workspace = tmp_path / "ws"
    (workspace / "Email attachments").mkdir(parents=True)
    (tmp_path / "outside.txt").write_text("secret")
    os.symlink(tmp_path / "outside.txt", workspace / "link.txt")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})

    result = json.loads(atum_google({
        "action": "create_draft", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y", "attachments": [bad],
    }))

    assert "error" in result
    assert fake.requests == []


def test_too_many_or_too_large_attachments_are_refused_with_a_typed_code(broker, monkeypatch, tmp_path):
    _workspace(monkeypatch, tmp_path)
    monkeypatch.setattr(atum_google_tool, "_OUTGOING_MAX_BYTES", 10)
    (tmp_path / "a.bin").write_bytes(b"x" * 8)
    (tmp_path / "b.bin").write_bytes(b"y" * 8)
    fake = broker(answer={"done": True})
    base = {"action": "send_email", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y"}

    too_large = json.loads(atum_google({**base, "attachments": ["a.bin", "b.bin"]}))
    too_many = json.loads(atum_google({**base, "attachments": ["a.bin"] * 11}))

    assert too_large["code"] == "message_too_large" or too_large.get("error")
    assert "error" in too_many
    assert fake.requests == []


def test_a_send_with_attachments_waits_longer_than_a_plain_send(broker, monkeypatch, tmp_path):
    _workspace(monkeypatch, tmp_path)
    (tmp_path / "a.txt").write_text("hi")
    broker(answer={"done": True})
    seen = []
    real = atum_google_tool.urllib.request.OpenerDirector.open

    def spy(self, request, data=None, timeout=None):
        seen.append(timeout)
        return real(self, request, data, timeout) if timeout is not None else real(self, request, data)

    monkeypatch.setattr(atum_google_tool.urllib.request.OpenerDirector, "open", spy)
    atum_google({"action": "send_email", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y"})
    atum_google({"action": "send_email", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y", "attachments": ["a.txt"]})

    assert seen[1] > seen[0]


def test_each_session_attaches_files_from_its_own_workspace(broker, tmp_path):
    import base64

    from tools.terminal_tool import clear_task_env_overrides, register_task_env_overrides

    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    (first / "doc.txt").write_text("from one")
    (second / "doc.txt").write_text("from two")
    fake = broker(answer={"done": True})
    register_task_env_overrides("session-a", {"cwd": str(first)})
    register_task_env_overrides("session-b", {"cwd": str(second)})
    request = {"action": "send_email", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y", "attachments": ["doc.txt"]}

    try:
        atum_google(request, task_id="session-a")
        atum_google(request, task_id="session-b")
    finally:
        clear_task_env_overrides("session-a")
        clear_task_env_overrides("session-b")

    assert [base64.b64decode(r["body"]["attachments"][0]["data"]) for r in fake.requests] == [b"from one", b"from two"]


def test_schema_teaches_reply_forward_cc_and_attachments_in_both_tools():
    properties = ATUM_GOOGLE_SCHEMA["parameters"]["properties"]
    for name in ("cc", "bcc", "reply", "forward", "attachments"):
        assert name in properties
    description = ATUM_GOOGLE_SCHEMA["description"]
    assert "reply" in description and "forward" in description and "cannot send" in description
    # Sending stays out of the read-only tool.
    assert "attachments" not in atum_google_tool.ATUM_GOOGLE_READONLY_SCHEMA["parameters"]["properties"]


# --- the workspace read cannot be raced: descriptor-relative, no-follow opens -----------------------------------


def _attach(paths):
    return json.loads(atum_google({
        "action": "create_draft", "sourceId": "s", "to": ["a@example.com"], "subject": "x", "body": "y",
        "attachments": paths,
    }))


def _sent_bytes(fake):
    import base64

    return [base64.b64decode(file["data"]) for request in fake.requests for file in request["body"].get("attachments", [])]


def test_a_file_swapped_for_a_symlink_just_before_it_is_opened_is_refused_and_no_outside_bytes_leave(broker, monkeypatch, tmp_path):
    import os

    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "doc.txt").write_text("approved content")
    secret = tmp_path / "secret.txt"
    secret.write_text("OUTSIDE SECRET")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})
    real = atum_google_tool._open_at

    def swap_then_open(name, flags, dir_fd):
        if name == "doc.txt":  # after the owner-visible name was chosen, before the file is opened
            os.unlink(workspace / "doc.txt")
            os.symlink(secret, workspace / "doc.txt")
        return real(name, flags, dir_fd)

    monkeypatch.setattr(atum_google_tool, "_open_at", swap_then_open)

    assert "error" in _attach(["doc.txt"])
    assert fake.requests == []


def test_a_parent_directory_swapped_for_a_symlink_just_before_it_is_opened_is_refused(broker, monkeypatch, tmp_path):
    import os

    workspace = tmp_path / "ws"
    (workspace / "sub").mkdir(parents=True)
    (workspace / "sub" / "doc.txt").write_text("inside")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "doc.txt").write_text("OUTSIDE SECRET")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})
    real = atum_google_tool._open_at

    def swap_then_open(name, flags, dir_fd):
        if name == "sub":
            (workspace / "sub" / "doc.txt").unlink()
            (workspace / "sub").rmdir()
            os.symlink(outside, workspace / "sub")
        return real(name, flags, dir_fd)

    monkeypatch.setattr(atum_google_tool, "_open_at", swap_then_open)

    assert "error" in _attach(["sub/doc.txt"])
    assert fake.requests == []


def test_a_directory_swapped_after_it_was_opened_cannot_redirect_the_next_open(broker, monkeypatch, tmp_path):
    """The held directory descriptor still names the original directory, so the file read is the approved one."""
    import os

    workspace = tmp_path / "ws"
    (workspace / "sub").mkdir(parents=True)
    (workspace / "sub" / "doc.txt").write_text("INSIDE CONTENT")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "doc.txt").write_text("OUTSIDE SECRET")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})
    real = atum_google_tool._open_at

    def open_then_swap(name, flags, dir_fd):
        descriptor = real(name, flags, dir_fd)
        if name == "sub":  # the directory is open; now replace its name with a link to the outside
            os.rename(workspace / "sub", workspace / "sub_old")
            os.symlink(outside, workspace / "sub")
        return descriptor

    monkeypatch.setattr(atum_google_tool, "_open_at", open_then_swap)

    assert _attach(["sub/doc.txt"]) == {"done": True}
    assert _sent_bytes(fake) == [b"INSIDE CONTENT"]


def test_links_special_files_and_a_file_that_outgrows_its_size_are_refused(broker, monkeypatch, tmp_path):
    import os
    import types

    workspace = tmp_path / "ws"
    workspace.mkdir()
    (tmp_path / "outside.txt").write_text("OUTSIDE SECRET")
    os.symlink(tmp_path / "outside.txt", workspace / "file-link.txt")
    os.symlink(tmp_path, workspace / "dir-link")
    os.mkfifo(workspace / "pipe")
    (workspace / "grows.txt").write_text("0123456789")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})

    for path in ("file-link.txt", "dir-link/outside.txt", "pipe", "./../ws/../outside.txt"):
        assert "error" in _attach([path]), path

    # The size read from the opened descriptor is the bound: a file longer than it said is not attached.
    real = atum_google_tool._fstat
    monkeypatch.setattr(
        atum_google_tool, "_fstat", lambda fd: types.SimpleNamespace(st_mode=real(fd).st_mode, st_size=real(fd).st_size - 3)
    )
    assert "error" in _attach(["grows.txt"])
    assert fake.requests == []


def test_an_ordinary_nested_file_is_still_attached_by_relative_or_absolute_path(broker, monkeypatch, tmp_path):
    workspace = tmp_path / "ws"
    (workspace / "a" / "b").mkdir(parents=True)
    (workspace / "a" / "b" / "c.txt").write_text("deep")
    _workspace(monkeypatch, workspace)
    fake = broker(answer={"done": True})

    assert _attach(["a/b/c.txt", str(workspace / "a" / "b" / "c.txt"), "./a/b/../b/c.txt"]) == {"done": True}
    assert _sent_bytes(fake) == [b"deep", b"deep", b"deep"]
