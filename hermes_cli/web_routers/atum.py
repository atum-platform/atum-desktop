"""Thin Atum HTTP adapters over native Hermes profile and request seams."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()
_log = logging.getLogger("hermes_cli.web_server")


class MatrixDebugUploadRequest(BaseModel):
    token: str
    destination: str
    labels: list[str]
    model_config = {"extra": "forbid"}


def _matrix_debug_home(profile: str) -> Path:
    from hermes_cli.web_server_cron import _cron_profile_home
    return _cron_profile_home(profile)[1].resolve()


@router.post("/api/debug-share/preview")
async def matrix_debug_preview_endpoint(profile: str):
    from hermes_cli import matrix_debug_share
    try:
        return await asyncio.to_thread(matrix_debug_share.preview, _matrix_debug_home(profile))
    except Exception:
        _log.exception("Matrix debug preview failed for profile %s", profile)
        raise HTTPException(status_code=409, detail="debug_share_preview_unavailable")


@router.get("/api/debug-share/status")
def matrix_debug_status_endpoint(profile: str):
    from hermes_cli import matrix_debug_share
    return matrix_debug_share.status(_matrix_debug_home(profile))


@router.post("/api/debug-share/upload")
def matrix_debug_upload_endpoint(body: MatrixDebugUploadRequest, profile: str):
    from hermes_cli import matrix_debug_share
    try:
        return matrix_debug_share.start(
            _matrix_debug_home(profile), body.token, body.destination, body.labels)
    except ValueError:
        raise HTTPException(status_code=409, detail="debug_share_submission_unavailable")


def _bridge_body(body, *, require_values: bool) -> dict[str, str]:
    if not isinstance(body, dict) or set(body) != {"request_id", "session_id", "turn_id"}:
        raise HTTPException(status_code=400, detail="invalid_request")
    if any(not isinstance(value, str) or (require_values and not value) or len(value) > 256
           for value in body.values()):
        raise HTTPException(status_code=400, detail="invalid_request")
    return body


@router.post("/api/desktop/advisory-search-request")
async def desktop_advisory_search_request(request: Request):
    from tui_gateway.server import advisory_search_request_scope
    body = _bridge_body(await request.json(), require_values=False)
    scope = advisory_search_request_scope(body["request_id"], body["session_id"], body["turn_id"])
    if scope is None:
        raise HTTPException(status_code=403, detail="request_unavailable")
    return scope


@router.post("/api/desktop/word-document-request")
async def desktop_word_document_request(request: Request):
    from tui_gateway.server import word_document_request_scope
    body = _bridge_body(await request.json(), require_values=True)
    scope = word_document_request_scope(body["request_id"], body["session_id"], body["turn_id"])
    if scope is None:
        raise HTTPException(status_code=403, detail="request_unavailable")
    return scope
