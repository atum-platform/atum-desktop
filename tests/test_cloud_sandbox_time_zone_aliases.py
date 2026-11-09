"""A38 S4 alias gate: the names Apple's and Chrome's clients send must resolve.

Apple sends ``Asia/Saigon`` and ``Asia/Calcutta`` as-is, and a browser's
``Intl.DateTimeFormat().resolvedOptions().timeZone`` may return any IANA link. Hermes reads the
sandbox's zone through ``zoneinfo`` (the image's system tzdata). Debian trixie's ``tzdata``
splits the legacy links into ``tzdata-legacy``, which the sandbox image installs explicitly
(``packages/cloud-sandbox/Dockerfile``): without it a routine's zone would be refused and the
task would silently fall back to the image clock.

Run this against a host whose tzdata the sandbox image uses at staging:

    docker run --rm --entrypoint /opt/hermes/.venv/bin/python3 <sandbox-image> -c "<the probe>"

or, in the image build lane, ``scripts/run_tests.sh tests/test_cloud_sandbox_time_zone_aliases.py``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

# The sandbox image's layer creates /opt/atum; a developer/CI host has no such marker. The gate
# is authoritative inside the image and must not fail a host whose tzdata is not the image's.
IN_SANDBOX_IMAGE = os.path.isdir("/opt/atum")

ALIASES = {
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Katmandu": "Asia/Kathmandu",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "Europe/Kiev": "Europe/Kyiv",
    "US/Pacific": "America/Los_Angeles",
}

_PROBE = """
import json, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

pairs = json.loads(sys.argv[1])
at = datetime(2027, 1, 15, 12, 0, tzinfo=timezone.utc)
resolved = {}
for alias, canonical in pairs.items():
    try:
        resolved[alias] = ZoneInfo(alias).utcoffset(at) == ZoneInfo(canonical).utcoffset(at)
    except Exception as exc:
        resolved[alias] = type(exc).__name__
print(json.dumps(resolved, sort_keys=True))
"""


def test_apple_and_chrome_legacy_zone_names_resolve_like_their_canonical_zones():
    env = os.environ.copy()
    env["TZ"] = "UTC"
    env.pop("HERMES_TIMEZONE", None)
    env.pop("PYTHONTZPATH", None)  # the image's Python reads the system tzdata
    output = subprocess.check_output(
        [sys.executable, "-c", _PROBE, json.dumps(ALIASES)],
        env=env,
        text=True,
    )
    resolved = json.loads(output)
    missing = {name: result for name, result in resolved.items() if result is not True}
    if missing and not IN_SANDBOX_IMAGE:
        pytest.skip(
            "this host's tzdata lacks legacy links (expected off the sandbox image); "
            f"run this gate inside the pinned image: {missing}"
        )
    assert not missing, (
        "the sandbox image's tzdata lacks legacy links; install tzdata-legacy "
        f"(see packages/cloud-sandbox/Dockerfile): {missing}"
    )
