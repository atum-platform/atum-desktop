from types import SimpleNamespace

import pytest

from tui_gateway.managed_model_failure import project_managed_failure


def managed_session(alias="binh-minh"):
    return {"agent": SimpleNamespace(provider="atum-managed", model=alias)}


@pytest.mark.parametrize(
    "code",
    [
        "authentication_expired",
        "rate_limited",
        "provider_rate_limited",
        "provider_call_limit_exceeded",
        "insufficient_protons",
        "funding_required",
        "managed_capacity_wait",
        "managed_request_in_progress",
        "managed_request_outcome_unknown",
        "managed_request_cancelled",
        "invalid_managed_request_id",
        "managed_model_disabled",
        "reconciliation_pending",
        "reservation_active",
        "managed_request_too_large",
        "invalid_managed_request",
        "unsupported_managed_parameter",
        "managed_turn_in_progress",
        "managed_model_transport_failed",
        "managed_model_invalid_response",
        "managed_model_unavailable",
        "managed_proxy_authentication_required",
    ],
)
def test_projects_every_frozen_managed_error(code):
    projected = project_managed_failure(managed_session("nguyet-thuc"), text=f"Error: {code}")
    assert projected and projected["code"] == code
    assert projected["access_alias"] == "nguyet-thuc"
    assert set(projected) == {
        "version", "code", "access_alias", "phase", "recovery", "transient", "preserve_draft"
    }


def test_unknown_and_non_managed_fail_closed():
    assert project_managed_failure(managed_session(), text="secret upstream body") is None
    assert project_managed_failure({"agent": SimpleNamespace(provider="openrouter", model="x")}, text="rate_limited") is None
    assert project_managed_failure({"agent": SimpleNamespace(provider="openrouter", model="binh-minh")}, text="rate_limited") is None
    assert project_managed_failure({"agent": SimpleNamespace(provider="atum-managed", model="unknown")}, text="rate_limited") is None


@pytest.mark.parametrize(
    ("reason", "code"),
    [
        ("auth", "authentication_expired"),
        ("rate_limit", "rate_limited"),
        ("upstream_rate_limit", "provider_rate_limited"),
        ("context_overflow", "managed_request_too_large"),
        ("format_error", "invalid_managed_request"),
        ("timeout", "managed_model_transport_failed"),
        ("server_error", "managed_model_transport_failed"),
    ],
)
def test_generic_hermes_reason_is_used_only_under_managed_identity(reason, code):
    projected = project_managed_failure(managed_session(), failure_reason=reason)
    assert projected and projected["code"] == code
    if reason in {"context_overflow", "format_error"}:
        assert projected["phase"] == "unknown"
        assert projected["preserve_draft"] is False


@pytest.mark.parametrize(
    ("code", "phase", "recovery", "preserve"),
    [
        ("authentication_expired", "pre_dispatch", "reauthenticate", True),
        ("rate_limited", "pre_dispatch", "retry", True),
        ("provider_rate_limited", "post_dispatch", "retry", False),
        ("provider_call_limit_exceeded", "post_dispatch", "edit_request", False),
        ("insufficient_protons", "pre_dispatch", "review_access", True),
        ("funding_required", "pre_dispatch", "review_access", True),
        ("managed_capacity_wait", "pre_dispatch", "wait_for_turn", True),
        ("managed_request_in_progress", "unknown", "pause", False),
        ("managed_request_outcome_unknown", "unknown", "pause", False),
        ("managed_request_cancelled", "unknown", "pause", False),
        ("invalid_managed_request_id", "pre_dispatch", "repair", True),
        ("managed_model_disabled", "pre_dispatch", "retry", True),
        ("reconciliation_pending", "pre_dispatch", "retry", True),
        ("reservation_active", "pre_dispatch", "wait_for_turn", True),
        ("managed_turn_in_progress", "pre_dispatch", "wait_for_turn", True),
        ("managed_request_too_large", "pre_dispatch", "edit_request", True),
        ("invalid_managed_request", "pre_dispatch", "edit_request", True),
        ("unsupported_managed_parameter", "pre_dispatch", "edit_request", True),
        ("managed_model_transport_failed", "unknown", "retry", False),
        ("managed_model_invalid_response", "post_dispatch", "retry", False),
        ("managed_model_unavailable", "unknown", "retry", False),
        ("managed_proxy_authentication_required", "pre_dispatch", "repair", True),
        ("managed_proxy_unavailable", "pre_dispatch", "repair", True),
    ],
)
def test_frozen_policy_drives_truthful_recovery(code, phase, recovery, preserve):
    projected = project_managed_failure(managed_session(), forced_code=code)
    assert projected and projected["phase"] == phase
    assert projected["recovery"] == recovery
    assert projected["preserve_draft"] is preserve


def test_deferred_session_identity_and_proxy_start_failure():
    session = {"model_override": {"provider": "atum-managed", "model": "binh-minh"}}
    projected = project_managed_failure(session, forced_code="managed_proxy_unavailable")
    assert projected == {
        "version": 1,
        "code": "managed_proxy_unavailable",
        "access_alias": "binh-minh",
        "phase": "pre_dispatch",
        "recovery": "repair",
        "transient": False,
        "preserve_draft": True,
    }


@pytest.mark.parametrize("code,recovery", [
    ("training_required", "review_training"),
    ("training_unavailable", "retry"),
    ("training_task_invalid", "review_training"),
    ("hire_task_required", "review_hiring"),
    ("denied", "review_account"),
    ("model_reserved", "edit_request"),
    ("managed_request_conflict", "pause"),
    ("managed_response_expired", "pause"),
    ("managed_retry_exhausted", "retry"),
    ("managed_dispatch_rejected", "retry"),
])
def test_domain_failure_wins_over_lossy_auth_summary(code, recovery):
    result = project_managed_failure(managed_session(), text=f'HTTP 403: {{"error": "{code}"}}', failure_reason='auth')
    assert result['code'] == code
    assert result['recovery'] == recovery
    if recovery != 'retry':
        assert result['transient'] is False


@pytest.mark.parametrize('message', ['Permission denied', '[Errno 13] Permission denied',
                                    'Tool approval denied', 'The search was denied'])
def test_local_denial_is_not_a_managed_account_failure(message):
    assert project_managed_failure(managed_session(), text=message) is None
    result = project_managed_failure(managed_session(), text=message + ': training_required')
    assert result['code'] == 'training_required'


@pytest.mark.parametrize('message', ['owner_managed_denied',
                                    "Error code: 403 - {'error': {'code': 'denied'}}"])
def test_explicit_wire_denial_keeps_account_recovery(message):
    result = project_managed_failure(managed_session(), text=message)
    assert result['code'] == 'denied' and result['recovery'] == 'review_account'
