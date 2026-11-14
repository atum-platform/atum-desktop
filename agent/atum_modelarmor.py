"""Credential-free client for the host's local Model Armor scanner socket."""

from __future__ import annotations

import json
import socket
import time

DEFAULT_SOCKET = "/run/atum-model-armor/scanner.sock"
TIMEOUT = 2.8
MAX_REQUEST = 8 * 1024 * 1024
MAX_RESPONSE = 1024
FINDING = "prompt_injection"


def scan(text: str) -> tuple[str, ...]:
    """Only fixed finding IDs cross back into Hermes. No cloud credential is read."""
    from hermes_cli.config import load_config_readonly

    security = (load_config_readonly() or {}).get("security", {})
    path = security.get("modelarmor_socket", DEFAULT_SOCKET)
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("Invalid scanner socket")
    payload = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8") + b"\n"
    if len(payload) > MAX_REQUEST:
        raise ValueError("Scanner request too large")
    deadline = time.monotonic() + TIMEOUT
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        connection.connect(path)
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        connection.sendall(payload)
        response = bytearray()
        while not response.endswith(b"\n"):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Scanner deadline")
            connection.settimeout(remaining)
            block = connection.recv(MAX_RESPONSE + 1 - len(response))
            if not block:
                raise ValueError("Incomplete scanner response")
            response.extend(block)
            if len(response) > MAX_RESPONSE:
                raise ValueError("Scanner response too large")
    result = json.loads(response)
    # Reject unknown IDs, error replies and arbitrary strings (which could contain content).
    if not isinstance(result, dict) or result.get("findings") not in ([], [FINDING]):
        raise ValueError("Invalid scanner response")
    return tuple(result["findings"])
