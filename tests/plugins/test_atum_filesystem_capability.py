"""Atum's consent adapter on Hermes tool dispatch.

Hermes owns consent: the plugin asks Hermes's own approval gate under a stable
account-scoped rule key, then Electron main binds the approved operation to
the account as a one-operation lease (interaction tools) or performs and
publishes the write (workspace ``write_file``). Everything else passes
through to Hermes untouched.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PLUGIN = Path(__file__).parents[2] / "plugins" / "atum-filesystem-capability" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("atum_filesystem_capability", PLUGIN)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ALLOW = {"action": "atum_filesystem_allow", "authority": "atum-filesystem"}
RULE_KEY = "atum:0123abcd:browser"


@pytest.fixture(autouse=True)
def required(monkeypatch):
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "test-token")
    with MODULE._interaction_lock:
        MODULE._active_interactions.clear()
        MODULE._interaction_overrides.clear()


def authority(account="account-a", generation=4):
    return {
        "account": {"accountId": account, "accountGeneration": generation},
        "actor": {"kind": "personal", "personalAgentId": "atum-personal-assistant"},
    }


def described(rule_key=RULE_KEY, effect="Open https://example.com", consent="browser"):
    return {
        "ok": True,
        "version": 1,
        "capability": "browser.navigate",
        "intendedEffect": effect,
        "scope": {"kind": "browser-origin", "origin": "https://example.com", "workspaceId": "w"},
        "consent": consent,
        "ruleKey": rule_key,
    }


def leased(operation_id="call-1", grant_id="grant-1"):
    return {"allowed": True, "grantId": grant_id, "operationId": operation_id, "capability": "browser.navigate"}


class Broker:
    """Scripted loopback broker: records every call, answers by route."""

    def __init__(self, **answers):
        self.calls = []
        self.answers = answers

    def __call__(self, method, route, body=None):
        self.calls.append((method, route, body))
        key = route.rsplit("/", 1)[-1] if method == "POST" else "authority"
        answer = self.answers.get(key)
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            return answer(body)
        if answer is None:
            raise RuntimeError("unexpected_route:" + route)
        return answer

    def routes(self):
        return [route for _method, route, _body in self.calls]


def install(monkeypatch, broker, approval=None):
    monkeypatch.setattr(MODULE, "_request_json", broker)
    gate_calls = []

    def gate(tool_name, intended_effect, rule_key):
        gate_calls.append((tool_name, intended_effect, rule_key))
        return approval if approval is not None else {"approved": True, "message": None}

    monkeypatch.setattr(MODULE, "_request_hermes_approval", gate)
    return gate_calls


# ── Pass-through: everything Hermes ships runs as Hermes ships it ────────


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("terminal", {"command": "rm -rf /private/workspace"}),
        ("execute_code", {"code": "import os; os.system('ls')"}),
        ("patch", {"path": "/private/workspace/a"}),
        ("search_files", {"path": "/private/workspace"}),
        ("skill_manage", {"action": "write_file", "file_path": "SKILL.md"}),
        ("open_preview", {"path": "/private/workspace/a"}),
        ("vision_analyze", {"images": ["/private/workspace/a.png"]}),
        ("read_file", {"path": "/private/workspace/../etc/passwd"}),
        ("mcp__filesystem__read_file", {"path": "/private/workspace/a"}),
        ("todo", {"items": []}),
    ],
)
def test_lifted_tools_are_never_touched_by_atum(monkeypatch, tool, args):
    broker = Broker()
    install(monkeypatch, broker)
    original = dict(args)

    assert MODULE._on_pre_tool_call(tool, args, tool_call_id="call-1", session_id="s-1") is None
    assert args == original
    assert broker.calls == []
    assert MODULE._on_post_tool_call(tool, tool_call_id="call-1", status="ok", session_id="s-1") is None
    assert MODULE._on_transform_tool_result(tool, tool_call_id="call-1", session_id="s-1") is None


def test_non_atum_process_leaves_every_tool_alone(monkeypatch):
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED")
    broker = Broker()
    install(monkeypatch, broker)

    for tool, args in [
        ("computer_use", {"action": "capture"}),
        ("write_file", {"path": "/private/workspace/a.md", "content": "x"}),
        ("browser_click", {"selector": "#x"}),
    ]:
        assert MODULE._on_pre_tool_call(tool, args, tool_call_id="call-1", session_id="s-1") is None
    assert broker.calls == []


# ── Interaction tools: describe → Hermes gate → lease ────────────────────


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("web_search", {"query": "atum"}),
        ("web_extract", {"urls": ["https://example.com"]}),
        ("browser_navigate", {"url": "https://example.com"}),
        ("browser_click", {"selector": "#save"}),
        ("computer_use", {"action": "capture", "app": "Safari"}),
    ],
)
def test_interaction_tools_describe_then_gate_then_lease_under_the_stable_rule_key(monkeypatch, tool, args):
    broker = Broker(**{"authority": authority(), "describe": described(), "request-use": leased()})
    gate_calls = install(monkeypatch, broker)

    assert MODULE._on_pre_tool_call(tool, args, tool_call_id="call-1", session_id="s-1") == ALLOW

    assert broker.routes() == [
        "/v1/filesystem/authority",
        "/v1/interaction/describe",
        "/v1/interaction/request-use",
    ]
    assert broker.calls[1][2] == {
        "account": authority()["account"],
        "actor": authority()["actor"],
        "runtimeSessionId": "s-1",
        "toolName": tool,
        "toolArgs": args,
    }
    # The gate is asked under main's stable, account-scoped rule key with the
    # default choice set, so "Always allow" lands in Hermes's allowlist.
    assert gate_calls == [(tool, "Open https://example.com", RULE_KEY)]
    lease = broker.calls[2][2]
    assert lease["operationId"] == "call-1"
    assert lease["runtimeSessionId"] == "s-1"
    assert lease["toolName"] == tool
    assert lease["toolArgs"] == args
    assert lease["durationMs"] == MODULE._INTERACTION_DURATION_MS
    assert lease["approval"] == {"authority": "hermes"}
    with MODULE._interaction_lock:
        assert MODULE._active_interactions[("s-1", "call-1")] == "grant-1"


def test_hermes_gate_uses_request_tool_approval_defaults(monkeypatch):
    """The real gate call: default choices (once/session/always/deny) and the
    default bypass behavior, keyed by ``plugin_rule:<ruleKey>``."""
    seen = {}

    def request_tool_approval(tool_name, reason, **kwargs):
        seen.update({"tool": tool_name, "reason": reason, **kwargs})
        return {"approved": True, "message": None}

    monkeypatch.setattr("tools.approval.request_tool_approval", request_tool_approval)

    assert MODULE._request_hermes_approval("computer_use", "Observe Safari", "atum:acct:computer.observe") == {
        "approved": True,
        "message": None,
    }
    assert seen == {"tool": "computer_use", "reason": "Observe Safari", "rule_key": "atum:acct:computer.observe"}


@pytest.mark.parametrize(
    "approval",
    [
        {"approved": False, "message": "BLOCKED: Action denied by user. Do NOT retry."},
        {"approved": False, "message": "BLOCKED: Action timed out without user response."},
        {"approved": False},
        {"status": "approval_required"},
        "malformed",
        None,
    ],
)
def test_denied_or_unsettled_consent_never_leases(monkeypatch, approval):
    broker = Broker(**{"authority": authority(), "describe": described(), "request-use": leased()})
    install(monkeypatch, broker, approval=approval if approval is not None else {"approved": None})

    result = MODULE._on_pre_tool_call("web_search", {"query": "x"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["authority"] == "atum-filesystem"
    assert result["message"].startswith("CAPABILITY_DENIED: ")
    if isinstance(approval, dict) and approval.get("message"):
        assert approval["message"] in result["message"]
    assert "/v1/interaction/request-use" not in broker.routes()
    with MODULE._interaction_lock:
        assert MODULE._active_interactions == {}


@pytest.mark.parametrize(
    ("describe", "code"),
    [
        ({"ok": False, "code": "CAPABILITY_INVALID", "rendererMessage": "This action request was not valid."}, "CAPABILITY_INVALID"),
        ({"ok": False, "code": "CAPABILITY_STALE", "rendererMessage": "The active account changed."}, "CAPABILITY_STALE"),
        ({"ok": True, "intendedEffect": "x"}, "CAPABILITY_INVALID"),
        ({"ok": True, "ruleKey": "  ", "intendedEffect": "x"}, "CAPABILITY_INVALID"),
        ("malformed", "CAPABILITY_INVALID"),
    ],
)
def test_undescribed_operations_fail_closed_before_the_gate(monkeypatch, describe, code):
    broker = Broker(authority=authority(), describe=describe)
    gate_calls = install(monkeypatch, broker)

    result = MODULE._on_pre_tool_call("computer_use", {"action": "format_disk"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["message"].startswith(f"{code}: ")
    assert gate_calls == []
    assert broker.routes() == ["/v1/filesystem/authority", "/v1/interaction/describe"]


@pytest.mark.parametrize(
    "decision",
    [
        {"allowed": False, "code": "CAPABILITY_STALE", "rendererMessage": "stale"},
        {"allowed": False, "code": "CAPABILITY_REPLAYED", "rendererMessage": "replayed"},
        {"allowed": False, "code": "CAPABILITY_INVALID", "rendererMessage": "invalid"},
        {"allowed": False, "code": "CAPABILITY_DENIED", "rendererMessage": "no approval"},
        {"allowed": True},
        {"allowed": True, "grantId": "grant-1", "operationId": "other-call"},
        "malformed",
    ],
)
def test_lease_refusal_after_consent_fails_closed(monkeypatch, decision):
    broker = Broker(**{"authority": authority(), "describe": described(), "request-use": decision})
    install(monkeypatch, broker)

    result = MODULE._on_pre_tool_call("browser_navigate", {"url": "https://example.com"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    expected = decision.get("code") if isinstance(decision, dict) and decision.get("code") else "CAPABILITY_DENIED"
    assert result["message"].startswith(f"{expected}: ")
    with MODULE._interaction_lock:
        assert MODULE._active_interactions == {}


def test_missing_ids_invalid_authority_and_transport_failure_fail_closed(monkeypatch):
    broker = Broker(**{"authority": authority(), "describe": described(), "request-use": leased()})
    gate_calls = install(monkeypatch, broker)

    assert MODULE._on_pre_tool_call("web_search", {"query": "x"}, tool_call_id="", session_id="s-1")["action"] == "block"
    assert MODULE._on_pre_tool_call("web_search", {"query": "x"}, tool_call_id="call-1", session_id="")["action"] == "block"
    assert MODULE._on_pre_tool_call("web_search", "not-a-dict", tool_call_id="call-1", session_id="s-1")["action"] == "block"
    assert broker.calls == [] and gate_calls == []

    for bad_authority in [{}, {"account": {"accountId": "", "accountGeneration": 1}}, "malformed"]:
        broker = Broker(authority=bad_authority)
        install(monkeypatch, broker)
        result = MODULE._on_pre_tool_call("web_search", {"query": "x"}, tool_call_id="call-1", session_id="s-1")
        assert result["message"].startswith("CAPABILITY_REVOKED: ")

    for failing in ["authority", "describe", "request-use"]:
        answers = {"authority": authority(), "describe": described(), "request-use": leased()}
        answers[failing] = RuntimeError("filesystem_broker_unavailable")
        broker = Broker(**answers)
        install(monkeypatch, broker)
        result = MODULE._on_pre_tool_call("web_search", {"query": "x"}, tool_call_id="call-1", session_id="s-1")
        assert result["action"] == "block"
        assert result["message"].startswith("CAPABILITY_DENIED: ")


def test_interaction_lease_finishes_at_the_safe_boundary_and_revocation_replaces_the_result(monkeypatch):
    broker = Broker(**{
        "authority": authority(),
        "describe": described(),
        "request-use": lambda body: leased(body["operationId"], f"grant-{body['operationId']}"),
        "finish-use": {"allowed": True},
    })
    install(monkeypatch, broker)

    assert MODULE._on_pre_tool_call("computer_use", {"action": "click", "app": "Notes"}, tool_call_id="call-1", session_id="s-1") == ALLOW
    assert MODULE._on_post_tool_call("computer_use", tool_call_id="call-1", status="ok", session_id="s-1") is None
    assert broker.calls[-1] == (
        "POST",
        "/v1/interaction/finish-use",
        {"operationId": "call-1", "runtimeSessionId": "s-1", "completedOperation": True},
    )
    assert MODULE._on_transform_tool_result("computer_use", tool_call_id="call-1", session_id="s-1") is None
    with MODULE._interaction_lock:
        assert MODULE._active_interactions == {}

    broker.answers["finish-use"] = {
        "allowed": False,
        "code": "CAPABILITY_REVOKED",
        "safeBoundary": "partial_effects",
        "completedOperation": True,
        "rendererMessage": "Permission was revoked while the action was running.",
    }
    assert MODULE._on_pre_tool_call("computer_use", {"action": "click", "app": "Notes"}, tool_call_id="call-2", session_id="s-1") == ALLOW
    MODULE._on_post_tool_call("computer_use", tool_call_id="call-2", status="ok", session_id="s-1")
    override = json.loads(MODULE._on_transform_tool_result("computer_use", tool_call_id="call-2", session_id="s-1"))
    assert override == {
        "error": "CAPABILITY_REVOKED",
        "safeBoundary": "partial_effects",
        "completedOperation": True,
        "message": "Permission was revoked while the action was running.",
    }

    broker.answers["finish-use"] = RuntimeError("filesystem_broker_unavailable")
    assert MODULE._on_pre_tool_call("computer_use", {"action": "click", "app": "Notes"}, tool_call_id="call-3", session_id="s-1") == ALLOW
    MODULE._on_post_tool_call("computer_use", tool_call_id="call-3", status="error", session_id="s-1")
    override = json.loads(MODULE._on_transform_tool_result("computer_use", tool_call_id="call-3", session_id="s-1"))
    assert override["error"] == "CAPABILITY_REVOKED"
    assert override["completedOperation"] is False

    # Identical call ids in different runtime sessions never share a lease.
    assert MODULE._on_post_tool_call("computer_use", tool_call_id="call-3", status="ok", session_id="s-2") is None


# ── Workspace write_file: describe → Hermes gate → main writes ───────────


def test_workspace_write_is_gated_by_hermes_then_handed_to_main(monkeypatch):
    broker = Broker(**{
        "authority": authority(),
        "describe-write": {
            "ok": True,
            "version": 1,
            "consent": "workspace.write",
            "ruleKey": "atum:0123abcd:workspace.write",
            "intendedEffect": "Create notes/todo.md (5 B) in your workspace",
            "workspaceRelativePath": "notes/todo.md",
            "disposition": "create",
            "byteSize": 5,
            "existingByteSize": 0,
        },
        "request-write": {"ok": True},
    })
    gate_calls = install(monkeypatch, broker)
    args = {"path": "notes/todo.md", "content": "hello"}

    result = MODULE._on_pre_tool_call("write_file", args, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["message"].startswith("CAPABILITY_HANDOFF: ")
    assert broker.routes() == [
        "/v1/filesystem/authority",
        "/v1/filesystem/describe-write",
        "/v1/filesystem/request-write",
    ]
    assert broker.calls[1][2] == {
        "account": authority()["account"],
        "actor": authority()["actor"],
        "operationId": "call-1",
        "resourcePath": "notes/todo.md",
        "contentByteSize": 5,
        "sessionId": "s-1",
    }
    assert gate_calls == [("write_file", "Create notes/todo.md (5 B) in your workspace", "atum:0123abcd:workspace.write")]
    assert broker.calls[2][2] == {
        "account": authority()["account"],
        "actor": authority()["actor"],
        "content": "hello",
        "operationId": "call-1",
        "resourcePath": "notes/todo.md",
        "sessionId": "s-1",
        "approval": {"authority": "hermes"},
    }


@pytest.mark.parametrize(
    "describe",
    [
        {"ok": False, "code": "CAPABILITY_SCOPE_ESCAPE"},
        {"ok": False, "code": "CAPABILITY_UNSUPPORTED_TYPE"},
        {"ok": False, "code": "CAPABILITY_TOO_LARGE"},
    ],
)
def test_only_mains_explicit_not_ours_answers_pass_a_write_through_to_hermes(monkeypatch, describe):
    broker = Broker(**{"authority": authority(), "describe-write": describe})
    gate_calls = install(monkeypatch, broker)

    result = MODULE._on_pre_tool_call(
        "write_file", {"path": "/tmp/outside.md", "content": "x"}, tool_call_id="call-1", session_id="s-1"
    )

    assert result == ALLOW
    assert gate_calls == []
    assert "/v1/filesystem/request-write" not in broker.routes()


@pytest.mark.parametrize(
    ("describe", "code"),
    [
        ({"ok": False, "code": "CAPABILITY_STALE"}, "CAPABILITY_STALE"),
        ({"ok": False, "code": "CAPABILITY_INVALID"}, "CAPABILITY_INVALID"),
        # Main maps every unexpected failure to CAPABILITY_DENIED: never pass-through.
        ({"ok": False, "code": "CAPABILITY_DENIED"}, "CAPABILITY_DENIED"),
        ({"ok": False}, "CAPABILITY_DENIED"),
        ({"ok": True, "intendedEffect": "x"}, "CAPABILITY_DENIED"),
        ("malformed", "CAPABILITY_DENIED"),
        (MODULE._BrokerHttpError("/v1/filesystem/describe-write", 401), "CAPABILITY_DENIED"),
        (MODULE._BrokerHttpError("/v1/filesystem/describe-write", 400), "CAPABILITY_DENIED"),
        (MODULE._BrokerHttpError("/v1/filesystem/describe-write", 500), "CAPABILITY_DENIED"),
        (ValueError("invalid json"), "CAPABILITY_DENIED"),
        (TimeoutError("slow"), "CAPABILITY_DENIED"),
        (RuntimeError("filesystem_broker_unavailable"), "CAPABILITY_DENIED"),
    ],
)
def test_any_other_describe_failure_blocks_the_write_instead_of_falling_open(monkeypatch, describe, code):
    """A contract mismatch, an authentication failure, a main-side fault, or
    an unreachable broker must never turn a workspace write into an
    unmediated Hermes write."""
    broker = Broker(**{"authority": authority(), "describe-write": describe})
    gate_calls = install(monkeypatch, broker)

    result = MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["message"].startswith(f"{code}: ")
    assert gate_calls == []


def test_write_without_a_signed_in_atum_account_is_a_plain_hermes_write_but_other_authority_faults_block(monkeypatch):
    broker = Broker(authority=MODULE._BrokerHttpError("/v1/filesystem/authority", 403))
    gate_calls = install(monkeypatch, broker)
    assert MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1") == ALLOW
    assert gate_calls == []

    for bad in [{}, "malformed"]:
        broker = Broker(authority=bad)
        install(monkeypatch, broker)
        result = MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1")
        assert result["message"].startswith("CAPABILITY_REVOKED: ")

    for bad in [
        MODULE._BrokerHttpError("/v1/filesystem/authority", 401),
        MODULE._BrokerHttpError("/v1/filesystem/authority", 500),
        RuntimeError("filesystem_broker_unavailable"),
        TimeoutError("slow"),
    ]:
        broker = Broker(authority=bad)
        install(monkeypatch, broker)
        result = MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1")
        assert result["action"] == "block"
        assert result["message"].startswith("CAPABILITY_DENIED: ")


def test_http_error_statuses_surface_as_broker_http_errors(monkeypatch):
    import io
    import urllib.error

    def urlopen(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b"{}"))

    monkeypatch.setattr(MODULE.urllib.request, "urlopen", urlopen)

    with pytest.raises(MODULE._BrokerHttpError) as raised:
        MODULE._request_json("GET", "/v1/filesystem/authority")
    assert raised.value.status == 403
    assert raised.value.route == "/v1/filesystem/authority"
    assert isinstance(raised.value, RuntimeError)


def test_write_with_missing_ids_or_malformed_args_is_left_to_hermes_validation(monkeypatch):
    broker = Broker()
    install(monkeypatch, broker)

    for args, call_id, session in [
        ({"path": "a.md", "content": "x"}, "", "s-1"),
        ({"path": "a.md", "content": "x"}, "call-1", ""),
        ({"path": "a.md"}, "call-1", "s-1"),
        ({"path": "", "content": "x"}, "call-1", "s-1"),
        ("not-a-dict", "call-1", "s-1"),
    ]:
        assert MODULE._on_pre_tool_call("write_file", args, tool_call_id=call_id, session_id=session) == ALLOW
    assert broker.calls == []


def test_denied_workspace_write_blocks_without_touching_main(monkeypatch):
    broker = Broker(**{
        "authority": authority(),
        "describe-write": {"ok": True, "ruleKey": "atum:0123abcd:workspace.write", "intendedEffect": "Create a.md (1 B) in your workspace"},
        "request-write": {"ok": True},
    })
    install(monkeypatch, broker, approval={"approved": False, "message": "BLOCKED: Action denied by user."})

    result = MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["message"] == "CAPABILITY_DENIED: BLOCKED: Action denied by user."
    assert "/v1/filesystem/request-write" not in broker.routes()


@pytest.mark.parametrize(
    "write_result",
    [
        {"ok": False, "code": "CAPABILITY_DENIED", "rendererMessage": "The file changed before the write completed."},
        {"ok": False},
        "malformed",
        RuntimeError("filesystem_broker_unavailable"),
    ],
)
def test_approved_write_that_main_cannot_perform_fails_closed(monkeypatch, write_result):
    broker = Broker(**{
        "authority": authority(),
        "describe-write": {"ok": True, "ruleKey": "atum:0123abcd:workspace.write", "intendedEffect": "Create a.md (1 B) in your workspace"},
        "request-write": write_result,
    })
    install(monkeypatch, broker)

    result = MODULE._on_pre_tool_call("write_file", {"path": "a.md", "content": "x"}, tool_call_id="call-1", session_id="s-1")

    assert result["action"] == "block"
    assert result["message"].startswith("CAPABILITY_DENIED: ")
    if isinstance(write_result, dict) and write_result.get("rendererMessage"):
        assert write_result["rendererMessage"] in result["message"]


def test_request_write_transport_bound_covers_disk_work_not_a_human_decision(monkeypatch):
    seen = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return b'{"ok": true}'

    def urlopen(request, timeout):
        seen["timeout"] = timeout
        seen["url"] = request.full_url
        return Response()

    monkeypatch.setattr(MODULE.urllib.request, "urlopen", urlopen)

    assert MODULE._request_json("POST", "/v1/filesystem/request-write", {"x": 1}) == {"ok": True}
    assert seen["timeout"] == MODULE._WRITE_TIMEOUT_SECONDS
    assert MODULE._WRITE_TIMEOUT_SECONDS < 60
    assert MODULE._request_json("POST", "/v1/interaction/describe", {"x": 1}) == {"ok": True}
    assert seen["timeout"] == MODULE._HTTP_TIMEOUT_SECONDS


def test_bundled_backend_manifest_loads_the_pre_dispatch_guard():
    class Context:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, callback):
            self.hooks[name] = callback

    ctx = Context()
    MODULE.register(ctx)

    assert set(ctx.hooks) == {"pre_tool_call", "post_tool_call", "transform_tool_result"}


def test_end_to_end_through_the_real_hermes_gate_always_is_durable_and_revocable(monkeypatch, tmp_path):
    """No gate mock: the plugin's first call raises Hermes's own gateway
    approval card; answering "always" persists the stable key so the second
    call never asks, and revoking makes the third call ask again."""
    from tools import approval

    home = tmp_path / "hermes"
    home.mkdir()
    (home / "config.yaml").write_text("command_allowlist: []\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_cli.config as config_module

    monkeypatch.setattr(config_module, "_LAST_EXPANDED_CONFIG_BY_PATH", {}, raising=False)
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()
    monkeypatch.setattr(approval, "get_current_session_key", lambda default="default": "desk-1")
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)
    monkeypatch.setattr(approval.approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
    monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: True)

    cards = []

    def notify(data):
        cards.append(data)
        approval.resolve_gateway_approval("desk-1", "always", pattern_key=data["pattern_key"])

    approval.register_gateway_notify("desk-1", notify)
    broker = Broker(**{
        "authority": authority(),
        "describe": described(rule_key="atum:acct:computer.observe", effect="Observe Safari"),
        "request-use": lambda body: leased(body["operationId"], f"grant-{body['operationId']}"),
    })
    monkeypatch.setattr(MODULE, "_request_json", broker)

    try:
        assert MODULE._on_pre_tool_call("computer_use", {"action": "capture"}, tool_call_id="c1", session_id="s-1") == ALLOW
        assert len(cards) == 1
        assert cards[0]["pattern_key"] == "plugin_rule:atum:acct:computer.observe"
        assert cards[0]["choices"] == ["once", "session", "always", "deny"]
        assert cards[0]["allow_permanent"] is True
        assert cards[0]["description"] == "Observe Safari"
        assert "plugin_rule:atum:acct:computer.observe" in (home / "config.yaml").read_text()

        assert MODULE._on_pre_tool_call("computer_use", {"action": "capture"}, tool_call_id="c2", session_id="s-1") == ALLOW
        assert len(cards) == 1, "durable consent: no second card"

        assert approval.revoke_approval("plugin_rule:atum:acct:computer.observe") is True
        assert MODULE._on_pre_tool_call("computer_use", {"action": "capture"}, tool_call_id="c3", session_id="s-1") == ALLOW
        assert len(cards) == 2, "revoked consent asks again"
    finally:
        approval.unregister_gateway_notify("desk-1")
        approval.reset_permanent_approvals()
        with approval._lock:
            approval._session_approved.clear()


def test_file_reads_inside_a_folder_the_owner_kept_closed_are_refused(tmp_path, monkeypatch):
    from tools.atum_source_policy import POLICY_ENV

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    policy = tmp_path / "acct.json"
    policy.write_text(
        json.dumps({"version": 1, "google": True, "folders": True, "messages": True,
                    "browser": True, "location": True, "team_spaces": True}),
        encoding="utf-8",
    )
    (tmp_path / "acct.folders.json").write_text(
        json.dumps({"version": 1, "blocked": [str(home / "Downloads")], "shared": [str(home / "Desktop")]}),
        encoding="utf-8",
    )
    monkeypatch.setenv(POLICY_ENV, str(policy))
    broker = Broker()
    install(monkeypatch, broker)

    refused = MODULE._on_pre_tool_call("search_files", {"path": "~/Downloads", "pattern": "x"},
                                       tool_call_id="call-1", session_id="s-1")
    assert refused["action"] == "block"
    assert "Downloads" in refused["message"] and "Settings" in refused["message"]

    assert MODULE._on_pre_tool_call("read_file", {"path": "~/Desktop/plan.md"},
                                    tool_call_id="call-2", session_id="s-1") is None
    assert broker.calls == []


def test_closed_folder_reads_are_refused_however_the_path_is_spelled(tmp_path, monkeypatch):
    """The hook checks the path the tool will open: task cwd, omitted search path, symlinks."""
    import os

    from tools import terminal_tool
    from tools.atum_source_policy import POLICY_ENV

    home = Path(os.path.realpath(tmp_path)) / "home"
    (home / "Desktop" / "notes").mkdir(parents=True)
    (home / "Desktop" / "notes" / "plan.md").write_text("secret", encoding="utf-8")
    (home / "Projects").mkdir()
    (home / "Projects" / "plan.md").symlink_to(home / "Desktop" / "notes" / "plan.md")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.chdir(home / "Projects")
    policy = tmp_path / "acct.json"
    policy.write_text(
        json.dumps({"version": 1, "google": True, "folders": True, "messages": True,
                    "browser": True, "location": True, "team_spaces": True}),
        encoding="utf-8",
    )
    (tmp_path / "acct.folders.json").write_text(
        json.dumps({"version": 1, "blocked": [str(home / "Desktop")], "shared": []}), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))
    install(monkeypatch, Broker())
    terminal_tool.register_task_env_overrides("t-desk", {"env_type": "local", "cwd": str(home / "Desktop" / "notes")})
    try:
        for tool, args, task in (
            ("read_file", {"path": str(home / "Projects" / "plan.md")}, "t-other"),
            ("read_file", {"path": "plan.md"}, "t-desk"),
            ("search_files", {"pattern": "secret"}, "t-desk"),
            ("read_file", {"path": str(home / "desktop" / "notes" / "plan.md")}, "t-other"),
        ):
            verdict = MODULE._on_pre_tool_call(tool, args, tool_call_id="c", session_id="s-1", task_id=task)
            assert verdict and verdict["action"] == "block" and "Desktop" in verdict["message"], (tool, args, task)
    finally:
        terminal_tool.clear_task_env_overrides("t-desk")
