"""Dashboard cron payloads keep an explicit empty toolset list.

``[]`` means a job with no tools and ``None`` means the platform defaults
(cron/jobs.py). Collapsing ``[]`` to ``None`` in the dashboard adapter would run a
zero-tool job with the full default toolset.
"""

from hermes_cli.web_routers.cron import _normalize_dashboard_cron_updates
from hermes_cli.web_server_cron import _cron_toolset_list


def test_explicit_empty_list_is_kept():
    assert _cron_toolset_list([]) == []
    assert _cron_toolset_list(["", "  "]) == []


def test_unset_and_named_toolsets_are_unchanged():
    assert _cron_toolset_list(None) is None
    assert _cron_toolset_list(["web", " terminal "]) == ["web", "terminal"]
    assert _cron_toolset_list("web, terminal") == ["web", "terminal"]


def test_dashboard_update_keeps_explicit_empty(tmp_path):
    normalized = _normalize_dashboard_cron_updates({"enabled_toolsets": []}, tmp_path)
    assert normalized["enabled_toolsets"] == []
