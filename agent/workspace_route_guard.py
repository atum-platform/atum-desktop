"""Atum-owned Google-data boundary, independent of model-authored context.

Ordinary Hermes installs do not enter this path. Atum's account-bound broker is
the durable authority. Never cache an unprotected decision or fail open when the
broker is missing: another conversation can acquire Google data between turns.
"""
import json
import hashlib
import os
import re
import uuid
import urllib.request
from urllib.parse import urlparse


class WorkspaceRouteRequired(RuntimeError):
    pass


class TrainingRouteRequired(RuntimeError):
    pass


def managed_backend_headers(base_url, session_id=None):
    """Keep the local capability off configurable remote provider endpoints."""
    expected = os.environ.get("ATUM_MANAGED_MODEL_BASE_URL", "").rstrip("/")
    try:
        parsed = urlparse(expected)
        trusted = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                   and parsed.port and not parsed.username and not parsed.password
                   and parsed.path == "/v1" and not parsed.query and not parsed.fragment
                   and str(base_url).rstrip("/") == expected)
    except ValueError:
        trusted = False
    headers = {}
    if trusted:
        if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id):
            headers["x-atum-session-id"] = session_id
        token = os.environ.get("ATUM_FILESYSTEM_BROKER_TOKEN")
        if token:
            headers["x-atum-backend-token"] = token
        from hermes_cli.atum_training import training_context
        training = training_context(session_id)
        if training:
            headers.update({key: training[key] for key in (
                "x-atum-assistant-identity-id", "x-atum-conversation-id", "x-atum-training-task-id"
            ) if key in training})
    return headers


def _clear_atum_workspace_source_reads() -> None:
    """Invalidate a protected-source permit before a different model runs.

    The loopback broker is the authority and does not need a success response
    here: when it is unavailable, utility reads are unavailable as well. This
    guard runs before any non-managed model can receive a tool request, closing
    a same-session model switch without trusting renderer state.
    """
    if os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") != "1":
        return

    base_url = os.environ.get("ATUM_FILESYSTEM_BROKER_URL", "")
    token = os.environ.get("ATUM_FILESYSTEM_BROKER_TOKEN", "")
    parsed = urlparse(base_url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or not parsed.port
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
        or not token
    ):
        return

    request = urllib.request.Request(
        f"{base_url}/v1/utilities/revoke-workspace-source-reads",
        data=b"",
        headers={"Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=0.25):
            pass
    except (OSError, ValueError):
        pass


def read_route_authority():
    """Read current account authority using this backend's loopback capability."""
    url = os.environ.get("ATUM_FILESYSTEM_BROKER_URL", "")
    token = os.environ.get("ATUM_FILESYSTEM_BROKER_TOKEN", "")
    try:
        parsed = urlparse(url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not token:
            raise ValueError("broker")

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(url + "/v1/utilities/route-authority", headers={"Authorization": "Bearer " + token})
        with opener.open(request, timeout=3) as response:
            data = json.loads(response.read(4097))
        if not isinstance(data, dict) or not isinstance(data.get("protected"), bool):
            raise ValueError("authority")
        return data
    except Exception:
        raise WorkspaceRouteRequired("Atum could not verify the protected Google-data route. Reconnect to Atum and retry; no other AI provider was used.") from None


def protected_workspace_route():
    if os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") != "1":
        return None
    try:
        data = read_route_authority()
        if not data["protected"]:
            return None
        base_url = os.environ.get("ATUM_MANAGED_MODEL_BASE_URL", "")
        api_key = os.environ.get("ATUM_MANAGED_MODEL_PROXY_TOKEN", "")
        proxy = urlparse(base_url)
        if proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port or proxy.username or proxy.password or proxy.path.rstrip("/") != "/v1" or proxy.query or proxy.fragment or not api_key or data.get("workspaceAlias") != "binh-minh":
            raise ValueError("proxy")
        return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": "binh-minh"}
    except Exception:
        raise WorkspaceRouteRequired("Atum could not verify the protected Google-data route. Reconnect to Atum and retry; no other AI provider was used.") from None


def protect_agent_request(agent, kwargs=None, *, purpose="main"):
    session_id = getattr(agent, "session_id", None)
    if kwargs is not None and purpose == "auxiliary":
        existing = kwargs.get("extra_headers", {}).get("x-atum-session-id", "")
        session_id = existing if str(existing).startswith("aux:") else "aux:" + uuid.uuid4().hex
        headers = kwargs.setdefault("extra_headers", {})
        for key in ("x-atum-training-task-id", "x-atum-conversation-id", "x-atum-assistant-identity-id"):
            headers.pop(key, None)
    if os.environ.get("ATUM_MANAGED_MODEL_BASE_URL"):
        from hermes_cli.atum_training import training_context
        training = training_context(session_id)
        if training and training.get("x-atum-training-task-id") and (
            getattr(agent, "provider", None) != "atum-managed"
            or getattr(agent, "api_mode", None) != "chat_completions"
            or not managed_backend_headers(getattr(agent, "base_url", ""))
        ):
            raise TrainingRouteRequired("training_managed_route_required")
    if kwargs is not None and getattr(agent, "provider", None) == "atum-managed":
        headers = managed_backend_headers(getattr(agent, "base_url", ""), session_id)
        if headers:
            kwargs["extra_headers"] = {**kwargs.get("extra_headers", {}), **headers}
    route = protected_workspace_route()
    if not route:
        _managed_request_identity(agent, kwargs)
        return
    if getattr(agent, "provider", None) != "atum-managed" or getattr(agent, "api_mode", None) != "chat_completions" or str(getattr(agent, "base_url", "")).rstrip("/") != route["base_url"]:
        raise WorkspaceRouteRequired("This Atum account contains Google data. Use the Atum managed assistant; its work stays on protected Gemini.")
    if kwargs is not None:
        # This is request routing, never a rewrite of prompt/history/tool schemas.
        kwargs["model"] = route["model"]
        if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id):
            kwargs["extra_headers"] = {**kwargs.get("extra_headers", {}), "x-atum-session-id": session_id}
        enabled = not (isinstance(getattr(agent, "reasoning_config", None), dict) and agent.reasoning_config.get("enabled") is False)
        kwargs["extra_body"] = {"thinking": {"type": "enabled" if enabled else "disabled"}}
    _managed_request_identity(agent, kwargs)


def _managed_request_identity(agent, kwargs):
    if kwargs is None or not managed_backend_headers(getattr(agent, "base_url", "")):
        return
    headers = kwargs.setdefault("extra_headers", {})
    # The runtime assigns this before its retry loop and advances it for the
    # next logical call. Content alone never identifies billable work: an
    # intentional regeneration has a different turn/call identity. A summary
    # or grace request within that call has its own payload and request ID.
    logical_id = getattr(agent, "_current_api_request_id", None)
    if logical_id:
        submission = getattr(agent, "_atum_submission_identity", None)
        ordinal = re.search(r":api:(\d+)$", str(logical_id))
        if submission and ordinal:
            logical_id = f"{submission}:api:{ordinal.group(1)}"
        semantic = {key: value for key, value in kwargs.items()
                    if key not in {"extra_headers", "timeout", "stream", "stream_options"}}
        fingerprint = hashlib.sha256(json.dumps(semantic, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
        headers["x-atum-request-id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, f"atum-model-request:{logical_id}:{fingerprint}"))
    elif "x-atum-request-id" not in headers:
        headers["x-atum-request-id"] = str(uuid.uuid4())
    record = getattr(agent, "_atum_record_model_request", None)
    if callable(record):
        record(headers["x-atum-request-id"], str(logical_id or "auxiliary"))


def protected_auxiliary_client(async_mode=False):
    route = protected_workspace_route()
    if not route:
        return None
    # Main/server enforce the protected route. Isolate auxiliary reservations
    # from a main turn that is still waiting on tools.
    from types import SimpleNamespace
    from openai import OpenAI, AsyncOpenAI
    client_type = AsyncOpenAI if async_mode else OpenAI
    session_id = "aux:" + uuid.uuid4().hex

    def prepare(kwargs):
        current = protected_workspace_route()
        if current != route:
            raise WorkspaceRouteRequired("Atum account routing changed. Retry this operation.")
        allowed = {"messages", "temperature", "top_p", "max_tokens", "tools", "tool_choice", "timeout", "stop", "stream", "stream_options", "response_format"}
        request = {key: value for key, value in kwargs.items() if key in allowed and value is not None}
        request["model"] = route["model"]
        request["max_tokens"] = min(request.get("max_tokens") or 4096, 8192)
        request["extra_headers"] = managed_backend_headers(route["base_url"], session_id)
        request["extra_headers"]["x-atum-request-id"] = str(uuid.uuid4())
        request["extra_body"] = {"thinking": {"type": "enabled"}}
        request["reasoning_effort"] = "low"
        return request

    def create(**kwargs):
        request = prepare(kwargs)
        client = client_type(base_url=route["base_url"], api_key=route["api_key"], max_retries=0)
        streaming = False
        try:
            result = client.chat.completions.create(**request)
            if request.get("stream"):
                def chunks():
                    try:
                        yield from result
                    finally:
                        result.close()
                        client.close()
                streaming = True
                return chunks()
            return result
        finally:
            if not streaming:
                client.close()

    async def async_create(**kwargs):
        request = prepare(kwargs)
        client = client_type(base_url=route["base_url"], api_key=route["api_key"], max_retries=0)
        streaming = False
        async def close_client():
            import inspect
            closed = client.close()
            if inspect.isawaitable(closed):
                await closed
        try:
            result = await client.chat.completions.create(**request)
            if request.get("stream"):
                async def chunks():
                    try:
                        async for chunk in result:
                            yield chunk
                    finally:
                        await result.close()
                        await close_client()
                streaming = True
                return chunks()
            return result
        finally:
            if not streaming:
                await close_client()

    async def async_close():
        pass

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=async_create if async_mode else create)), base_url=route["base_url"], close=async_close if async_mode else lambda: None), route["model"]


def guard_auxiliary_resolution(resolve):
    """Recheck cached clients at dispatch, including clients made before consent."""
    from functools import wraps
    import inspect
    signature = inspect.signature(resolve)

    @wraps(resolve)
    def guarded(*args, **kwargs):
        result = resolve(*args, **kwargs)
        # Ordinary resolution returns (client, model); vision adds provider.
        client, _model = result[-2:]
        if os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") != "1" or client is None:
            return result
        completions = client.chat.completions
        if getattr(completions.create, "_atum_route_guarded", False):
            return result
        original = completions.create
        asynchronous = signature.bind_partial(*args, **kwargs).arguments.get("async_mode", False)

        def managed_auxiliary_headers(request):
            headers = managed_backend_headers(getattr(client, "base_url", ""), "aux:" + uuid.uuid4().hex)
            if headers:
                headers["x-atum-request-id"] = str(uuid.uuid4())
                inherited = {key: value for key, value in request.get("extra_headers", {}).items()
                             if key.lower() not in {"x-atum-training-task-id", "x-atum-conversation-id", "x-atum-assistant-identity-id"}}
                request["extra_headers"] = {**inherited, **headers}

        def create(**request):
            protected = protected_auxiliary_client()
            if protected:
                return protected[0].chat.completions.create(**request)
            managed_auxiliary_headers(request)
            return original(**request)

        async def async_create(**request):
            protected = protected_auxiliary_client(async_mode=True)
            if protected:
                return await protected[0].chat.completions.create(**request)
            managed_auxiliary_headers(request)
            return await original(**request)

        wrapped = async_create if asynchronous else create
        wrapped._atum_route_guarded = True
        completions.create = wrapped
        return result

    return guarded
