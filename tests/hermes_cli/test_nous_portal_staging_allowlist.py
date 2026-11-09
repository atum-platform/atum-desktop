"""Preserve recovery, isolation and completion behavior across failures."""

from __future__ import annotations

import json
import logging

from hermes_cli.auth import (
    DEFAULT_NOUS_PORTAL_URL,
)


class TestResolveAccessTokenEnvOverrideWins:
    """End-to-end: resolve_nous_access_token must use the env override for
    the refresh call, bypassing the allowlist, even when state also has a
    portal_base_url set (the exact incident shape)."""

    def _write_auth_file(self, tmp_path, *, stored_portal_url):
        auth_file = tmp_path / "auth.json"
        auth_file.write_text(
            json.dumps(
                {
                    "version": 1,
                    "active_provider": "nous",
                    "providers": {
                        "nous": {
                            "portal_base_url": stored_portal_url,
                            "access_token": "expired-access",
                            "refresh_token": "staging-refresh",
                            "client_id": "hermes-cli-vps",
                            "expires_at": "2000-01-01T00:00:00+00:00",
                        }
                    },
                }
            )
        )
        return auth_file

    def _run_and_capture(self, monkeypatch, auth):
        from hermes_cli import auth_nous
        seen_portal_urls = []

        # The resolve memo is module-level state; clear it so each test's
        # resolution actually exercises the refresh path instead of serving
        # a token cached by a previous test.
        monkeypatch.setattr(auth, "_RESOLVE_TOKEN_CACHE", {})

        def _fake_refresh(*, client, portal_base_url, client_id, refresh_token):
            seen_portal_urls.append(portal_base_url)
            return {
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 3600,
            }

        monkeypatch.setattr(auth, "_refresh_access_token", _fake_refresh)
        monkeypatch.setattr(auth_nous, "_refresh_access_token", _fake_refresh)

        caplog_records = []
        logger = logging.getLogger("hermes_cli.auth")
        handler = logging.Handler()
        handler.emit = lambda record: caplog_records.append(record.getMessage())
        logger.addHandler(handler)
        try:
            auth.resolve_nous_access_token()
        finally:
            logger.removeHandler(handler)
        return seen_portal_urls, caplog_records

    def test_env_override_wins_even_with_staging_state_stored(
        self, monkeypatch, tmp_path
    ):
        """Preserve recovery, isolation and completion behavior across failures."""
        from hermes_cli import auth

        staging_portal = "https://portal.staging-nousresearch.com"
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("HERMES_PORTAL_BASE_URL", staging_portal)
        self._write_auth_file(tmp_path, stored_portal_url=staging_portal)

        seen_portal_urls, records = self._run_and_capture(monkeypatch, auth)

        assert seen_portal_urls == [staging_portal]
        assert not any(
            "ignoring invalid portal_base_url" in msg for msg in records
        ), "env override must bypass the allowlist gate entirely"



    def test_no_env_no_staging_state_prod_url_used_unmodified(
        self, monkeypatch, tmp_path
    ):
        """Baseline: no override, no staging state — prod is used and the
        allowlist never even logs a warning (nothing was rejected)."""
        from hermes_cli import auth

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.delenv("HERMES_PORTAL_BASE_URL", raising=False)
        monkeypatch.delenv("NOUS_PORTAL_BASE_URL", raising=False)
        self._write_auth_file(tmp_path, stored_portal_url=DEFAULT_NOUS_PORTAL_URL)

        seen_portal_urls, records = self._run_and_capture(monkeypatch, auth)

        assert seen_portal_urls == [DEFAULT_NOUS_PORTAL_URL]
        assert not any("ignoring invalid portal_base_url" in msg for msg in records)
