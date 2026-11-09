"""Cron delivery through the desktop host app.

A desktop backend (``HERMES_DESKTOP=1``) runs Hermes cron without a messaging
gateway. For Matrix, the host app is the Matrix client: it holds the agent's
device and room keys, so only it can post into encrypted rooms. This adapter
hands each delivery to the host over the backend's live connection and reports
the host's receipt, so ``delivery_error`` is real.

``host_delivery`` tells the scheduler that the platform needs no gateway config
and has no standalone fallback (see ``cron.scheduler._deliver_result``).

Trust: Hermes trusts the host's receipt and the room the job names. The host
enforces the room: it posts only into the agent's own room with its owner.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional

from tui_gateway import server_requests

# The scheduler waits 60 s for a live send; answer before that with a real result.
_HOST_TIMEOUT_SECONDS = 45.0
_MAX_ERROR_CHARS = 200


def _host_request(event: str, payload: dict, timeout: float) -> str:
    """The only session-less host request currently supported."""
    if event != "cron.delivery.request":
        return ""
    return server_requests.request_host("cron.delivery.request", payload, timeout=timeout)


class DesktopMatrixDelivery:
    """Live Matrix adapter whose ``send`` asks the desktop host to post."""

    host_delivery = True
    splits_long_messages = False

    def __init__(
        self,
        request: Optional[Callable[[str, dict, float], str]] = None,
        timeout: float = _HOST_TIMEOUT_SECONDS,
    ) -> None:
        if request is None:
            request = _host_request
        self._request = request
        self._timeout = timeout

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> Any:
        from gateway.platforms.base import SendResult

        meta = metadata or {}
        if not meta.get("job_id") or not meta.get("execution_id"):
            # The host posts a run at most once by its identity; without one it
            # cannot, so nothing is asked.
            return SendResult(success=False, error="no run identity for the Atum app")
        payload = {
            "platform": "matrix",
            "room_id": str(chat_id),
            "text": content,
            "job_id": str(meta.get("job_id") or ""),
            # The host posts a run at most once: it looks for this run's post
            # before posting, and uses the run as the Matrix transaction.
            "execution_id": str(meta.get("execution_id") or ""),
        }
        raw = await asyncio.get_running_loop().run_in_executor(
            None, self._request, "cron.delivery.request", payload, self._timeout
        )
        if not raw:
            return SendResult(success=False, error="the Atum app did not answer")
        try:
            receipt = json.loads(raw)
        except (TypeError, ValueError):
            return SendResult(success=False, error="the Atum app sent an unreadable receipt")
        if not isinstance(receipt, dict):
            return SendResult(success=False, error="the Atum app sent an unreadable receipt")
        if receipt.get("status") == "delivered":
            event_id = receipt.get("event_id")
            return SendResult(success=True, message_id=str(event_id) if event_id else None)
        error = str(receipt.get("error") or "the Atum app did not deliver it")
        return SendResult(success=False, error=error[:_MAX_ERROR_CHARS])
