"""Legacy token-file recognition for the standalone Google Workspace scripts.

Long-lived managed gateways use the existing atum_google tool, bound by the
host-authority plugin to the account broker. The Workspace skill already routes
managed calls there. Legacy placeholder files remain recognizable, but cannot
renew authority. Refresh custody belongs to the host, outside the agent home.
"""

from __future__ import annotations

# The refresh token (and client ID and secret) the controller writes; see
# packages/cloud-controller/src/google/credentials.ts (GOOGLE_MANAGED).
MANAGED_REFRESH_TOKEN = "atum-cloud-managed"

EXPIRED_MESSAGE = (
    "Google access expired. Use the atum_google tool through Atum's connection. "
    "If unavailable, report that Google is unavailable for this run. Do not run setup.py."
)


def is_managed(refresh_token: object) -> bool:
    """Whether a token file's refresh token is Atum's placeholder."""
    return refresh_token == MANAGED_REFRESH_TOKEN
