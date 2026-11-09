"""Explicit Hermes continuation data over the reusable request checkpoint store.

No clients, callbacks, arbitrary object deserialization, or private skill source.
The owning surface supplies a RequestCheckpoint only for an idempotent transport.
Fresh runtimes restore the saved turn, then enter the ordinary conversation loop.
"""
from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import threading

from agent.iteration_budget import IterationBudget
from agent.request_checkpoint import CheckpointUnavailable
from agent.turn_context import TurnContext, prepare_turn_resources

# Only state read by the loop after a dispatch boundary. Keep this list explicit:
# new runtime capabilities are resolved by construction, never loaded from disk.
AGENT_FIELDS = (
    "_persist_user_message_idx", "_persist_user_message_override", "_persist_user_message_timestamp",
    "_persist_api_content", "_invalid_tool_retries", "_invalid_json_retries", "_empty_content_retries",
    "_incomplete_scratchpad_retries", "_codex_incomplete_retries", "_thinking_prefill_retries",
    "_post_tool_empty_retried", "_last_content_with_tools", "_last_content_tools_all_housekeeping",
    "_mute_post_response", "_unicode_sanitization_passes", "_vision_supported", "_user_turn_count",
    "_turns_since_memory", "_iters_since_skill", "_turn_failed_file_mutations", "_verification_stop_nudges",
    "_pre_verify_nudges", "_kanban_stop_nudges", "_budget_grace_call", "_stream_needs_break",
    "_turn_received_provider_response", "_last_compaction_in_place", "_last_compression_attempt_recorded",
    "_last_compression_attempt_in_place", "_ephemeral_max_output_tokens", "_force_ascii_payload",
    "_last_flushed_db_idx", "_flushed_db_message_session_id", "_is_user_initiated_turn",
    "ephemeral_system_prompt", "prefill_messages", "_resolved_is_coding", "_turn_preflight_display_snapshot",
    "session_api_calls", "session_cache_read_tokens", "session_cache_write_tokens", "session_completion_tokens",
    "session_prompt_tokens", "session_input_tokens", "session_output_tokens", "session_reasoning_tokens",
    "session_total_tokens", "session_estimated_cost_usd", "session_cost_source", "session_cost_status",
)
LOOP_FIELDS = (
    "api_call_count", "codex_ack_continuations", "length_continue_retries", "truncated_tool_call_retries",
    "truncated_response_parts", "compression_attempts", "_last_preflight_pressure",
    "_pending_verification_response", "_pending_verification_response_previewed",
)
PREPARED_FIELDS = ("api_messages", "approx_tokens", "total_chars", "request_pressure_tokens")
CONTEXT_FIELDS = {
    "user_message": "user_message", "original_user_message": "original_user_message",
    "messages": "messages", "conversation_history": "conversation_history",
    "active_system_prompt": "active_system_prompt", "effective_task_id": "effective_task_id",
    "turn_id": "turn_id", "current_turn_user_idx": "current_turn_user_idx",
    "should_review_memory": "_should_review_memory", "plugin_user_context": "_plugin_user_context",
    "ext_prefetch_cache": "_ext_prefetch_cache", "preflight_compression_blocked": "_preflight_compression_blocked",
}
_TRANSPORT_FIELDS = {"extra_headers", "timeout", "stream", "stream_options"}


def _json_copy(value):
    try:
        return json.loads(json.dumps(value, allow_nan=False))
    except (ValueError, TypeError) as exc:
        raise CheckpointUnavailable("task_checkpoint_unserializable") from exc


def _digest(value):
    return hashlib.sha256(json.dumps(_json_copy(value), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@lru_cache(maxsize=1)
def build_id():
    """A changed loop implementation invalidates its private continuation format."""
    root = Path(__file__).resolve().parent.parent
    digest = hashlib.sha256()
    for name in ("agent/turn_checkpoint.py", "agent/conversation_loop.py", "agent/turn_context.py",
                 "agent/tool_executor.py", "agent/tool_guardrails.py", "agent/chat_completion_helpers.py", "run_agent.py"):
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def runtime_policy(agent):
    """Fingerprint resolved capabilities without saving credentials or config files."""
    from hermes_cli.plugins import has_middleware
    from hermes_cli.middleware import LLM_EXECUTION_MIDDLEWARE

    if has_middleware(LLM_EXECUTION_MIDDLEWARE):
        # An arbitrary wrapper may perform effects before calling the model.
        # It needs an explicit resumable contract before automatic replay is safe.
        raise CheckpointUnavailable("task_checkpoint_execution_middleware")
    config = asdict(agent._tool_guardrails.config)
    for name in ("idempotent_tools", "mutating_tools"):
        config[name] = sorted(config[name])
    return _digest({"provider": agent.provider, "model": agent.model, "api_mode": agent.api_mode,
                    "tools": agent.tools, "valid_tools": sorted(agent.valid_tool_names),
                    "max_iterations": agent.max_iterations, "guardrails": config})


def semantic_request(request):
    # Whitelist the request boundary, not arbitrary runtime locals. Unknown
    # non-JSON values fail before dispatch rather than becoming pickle payloads.
    if "_moa_prepared_request" in request:
        raise CheckpointUnavailable("task_checkpoint_transport_unsupported")
    return _json_copy({key: value for key, value in request.items() if key not in _TRANSPORT_FIELDS})


def capture_turn(agent, local_state):
    """Capture only declared fields from the actual prepared loop iteration."""
    try:
        guardrails = agent._tool_guardrails.checkpoint_state()
    except ValueError as exc:
        raise CheckpointUnavailable("task_checkpoint_guardrails_unavailable") from exc
    return _json_copy({
        "version": 1, "build_id": build_id(), "runtime_policy": runtime_policy(agent),
        "session_id": agent.session_id,
        "context": {key: local_state[name] for key, name in CONTEXT_FIELDS.items()},
        "loop": {name: local_state[name] for name in LOOP_FIELDS},
        "prepared": {name: local_state[name] for name in PREPARED_FIELDS},
        "agent": {name: getattr(agent, name) for name in AGENT_FIELDS if hasattr(agent, name)},
        "sets": {name: sorted(getattr(agent, name, set())) for name in
                 ("_turn_file_mutation_paths", "_delivered_interim_texts")},
        "budget": {"used": agent.iteration_budget.used, "max_total": agent.iteration_budget.max_total},
        "guardrails": guardrails,
        "retry_count": local_state["retry_count"], "retry": asdict(local_state["_retry"]),
    })


def validate_turn(agent, payload):
    try:
        if (payload["version"] != 1 or payload["build_id"] != build_id()
                or payload["runtime_policy"] != runtime_policy(agent)
                or payload["session_id"] != agent.session_id):
            raise ValueError("runtime or conversation changed")
        if set(payload["context"]) != set(CONTEXT_FIELDS) or set(payload["loop"]) != set(LOOP_FIELDS):
            raise ValueError("unsupported continuation shape")
        if set(payload["prepared"]) != set(PREPARED_FIELDS) or set(payload["agent"]) - set(AGENT_FIELDS):
            raise ValueError("unsupported state fields")
        budget = payload["budget"]
        if (type(budget["used"]) is not int or type(budget["max_total"]) is not int
                or not 0 <= budget["used"] <= budget["max_total"] <= agent.max_iterations):
            raise ValueError("invalid iteration budget")
        if type(payload["loop"]["api_call_count"]) is not int or not 1 <= payload["loop"]["api_call_count"] <= agent.max_iterations + 1:
            raise ValueError("invalid model ordinal")
        ctx = TurnContext(**payload["context"])
        if not isinstance(ctx.messages, list) or not isinstance(ctx.effective_task_id, str):
            raise ValueError("invalid turn context")
        if semantic_request(payload["request"]) != payload["request"]:
            raise ValueError("transport credentials in checkpoint")
        _json_copy(payload)
        return ctx
    except (KeyError, ValueError, TypeError) as exc:
        raise CheckpointUnavailable("task_checkpoint_context_changed") from exc


def restore_turn(agent, payload, stream_callback):
    """Rebind runtime-only state without appending a user turn or running hooks."""
    ctx = validate_turn(agent, payload)
    from agent.auxiliary_client import set_runtime_main
    from hermes_logging import set_session_context
    from tools.skill_provenance import set_current_write_origin
    from run_agent import _set_interrupt
    from agent.process_bootstrap import _install_safe_stdio
    from agent.agent_runtime_helpers import note_turn_start

    _install_safe_stdio()
    prepare_turn_resources(agent)
    set_session_context(agent.session_id)
    set_current_write_origin(getattr(agent, "_memory_write_origin", "assistant_tool"))
    set_runtime_main(agent.provider, agent.model, requested_provider=agent.requested_provider,
                     base_url=agent.base_url, api_key=agent.api_key, api_mode=agent.api_mode,
                     auth_mode=getattr(agent, "auth_mode", ""))
    if agent.provider == "atum-managed":
        from hermes_cli.atum_training import apply_training_context_budget
        apply_training_context_budget(agent, agent.session_id)
    for name, value in payload["agent"].items():
        setattr(agent, name, value)
    for name in ("_turn_file_mutation_paths", "_delivered_interim_texts"):
        setattr(agent, name, set(payload["sets"][name]))
    agent.iteration_budget = IterationBudget(payload["budget"]["max_total"])
    for _ in range(payload["budget"]["used"]):
        agent.iteration_budget.consume()
    agent._tool_guardrails.restore_checkpoint_state(payload["guardrails"])
    agent._cached_system_prompt = ctx.active_system_prompt
    agent._session_messages = ctx.messages
    agent._current_task_id = ctx.effective_task_id
    agent._current_turn_id = ctx.turn_id
    note_turn_start(agent, ctx.turn_id)
    agent._stream_callback = stream_callback
    agent._execution_thread_id = threading.current_thread().ident
    agent._flushed_db_message_ids = set()
    agent._hydrate_todo_store(ctx.messages)
    _set_interrupt(bool(agent._interrupt_requested), agent._execution_thread_id)
    return ctx


def checkpointed_call(agent, request, snapshot, perform, *, replace_unstarted=False):
    """Fence before a stream consumer (including TTS), or the complete response."""
    from agent.workspace_route_guard import protect_agent_request

    checkpoint = agent._request_checkpoint
    checkpoint.assert_current()
    protect_agent_request(agent, request)
    payload = {**snapshot, "request": semantic_request(request),
               "request_id": request["extra_headers"]["x-atum-request-id"]}
    if checkpoint.value["phase"] == "pending":
        retained = checkpoint.value["payload"]
        if replace_unstarted and checkpoint.value.get("recoveries", 0) == 0:
            checkpoint.pending(payload, replace_unstarted=True)
        elif payload["request_id"] != retained["request_id"] or payload["request"] != retained["request"]:
            raise CheckpointUnavailable("task_checkpoint_request_changed")
        # Recovery retains the original pre-dispatch state, including counters.
        checkpoint.assert_current()
    else:
        checkpoint.pending(payload)
    callbacks = {name: getattr(agent, name, None) for name in
                 ("stream_delta_callback", "_stream_callback", "reasoning_callback")}

    def consume():
        if checkpoint.value["phase"] == "pending":
            checkpoint.consume()
        else:
            checkpoint.assert_current()

    def fenced(callback):
        def deliver(*args, **kwargs):
            # Deltas may feed paid voice playback, so they are consumers too.
            # A crash after visible output pauses; it cannot replay that output.
            consume()
            return callback(*args, **kwargs)
        return deliver

    for name, callback in callbacks.items():
        if callback is not None:
            setattr(agent, name, fenced(callback))
    try:
        response = perform(request)
        consume()
    finally:
        for name, callback in callbacks.items():
            setattr(agent, name, callback)
    return response
