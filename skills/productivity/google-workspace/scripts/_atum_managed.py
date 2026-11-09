"""Atum's cloud and this skill's token file.

On Atum's cloud the controller writes ``$HERMES_HOME/google_token.json`` for each turn: one
short-lived Google access token for the owner's account, and placeholders where Hermes' reader
requires a refresh token and an OAuth client. The platform keeps the real refresh token sealed on
its own side; the next turn gets a new access token. So these scripts must never try to refresh
a managed token (the placeholders can only fail at Google), and an expired one has one remedy: a
new turn. A token from this skill's own ``setup.py`` flow carries a real refresh token and is
unaffected.
"""

from __future__ import annotations

# The refresh token (and client ID and secret) the controller writes; see
# packages/cloud-controller/src/google/credentials.ts (GOOGLE_MANAGED).
MANAGED_REFRESH_TOKEN = "atum-cloud-managed"

EXPIRED_MESSAGE = (
    "The Google access token Atum gave this turn has expired. Atum issues a new one at the start of "
    "every turn, so ask the owner to send another message. Do not run setup.py or ask for credentials."
)


def is_managed(refresh_token: object) -> bool:
    """Whether a token file's refresh token is Atum's placeholder."""
    return refresh_token == MANAGED_REFRESH_TOKEN
