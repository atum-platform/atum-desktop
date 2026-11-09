"""Opt-in S1b: real cold Hermes import in an explicitly scoped child process."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((REPO / 'tests/fixtures/shared-group-feasibility.json').read_text())


def snapshot(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}


@pytest.fixture(scope='module')
def proof():
    # /tmp avoids embedding the OS username from pytest's default temp root.
    with tempfile.TemporaryDirectory(prefix='atum-shared-proof-', dir='/tmp') as directory:
        root = Path(directory).resolve()
        private = root / 'private-profile'
        private.mkdir()
        for key, marker in FIXTURE['private_canaries'].items():
            (private / f'{key}.txt').write_text(marker)
        (private / 'private-note.txt').write_text(FIXTURE['private_canaries']['private_file'])
        (private / '.env').write_text('PRIVATE_API_KEY=synthetic-private-credential\n')
        (private / 'config.yaml').write_text('context:\n  engine: private_plugin\nplatform_hints:\n  cli:\n    append: PRIVATE_CONFIG_SEQUOIA_907\n')
        (private / 'host-identity.txt').write_text('PRIVATE_OPERATOR_SEQUOIA_907 PRIVATE_HOST_CEDAR_907')
        before = snapshot(private)
        process_env = dict(os.environ)
        # As in the existing Desktop per-profile spawn, bind HERMES_HOME before
        # process start/import. Build an allowlist rather than merging private env.
        shared = root / 'shared'
        home = shared / '.hermes'
        workspace = shared / 'workspace'
        home.mkdir(parents=True)
        workspace.mkdir()
        (home / 'SOUL.md').write_text(FIXTURE['persona']['text'])
        (home / 'config.yaml').write_text('agent:\n  environment_probe: false\n')
        env = {
            'HOME': str(shared), 'HERMES_HOME': str(home), 'USER': 'shared', 'LOGNAME': 'shared',
            'HOSTNAME': 'shared-fixture', 'PATH': '/usr/bin:/bin',
            'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1',
            'SHARED_MODEL_API_KEY': 'synthetic-shared-credential',
            'TZ': 'UTC', 'LANG': 'C.UTF-8', 'TIRITH_ENABLED': 'false',
            'AWS_EC2_METADATA_DISABLED': 'true',
        }
        projection = json.dumps({key: FIXTURE[key] for key in ('conversation_id', 'messages', 'watermark', 'truncated')})
        assert len(FIXTURE['messages']) <= FIXTURE['history_limit']['messages']
        assert len(projection) <= FIXTURE['history_limit']['characters']
        child = subprocess.run(
            [sys.executable, str(REPO / 'tests/feasibility/hermes_child.py')],
            input=json.dumps({'private_root': str(private), 'message': projection, 'responses': ['forged_tool', 'reply']}),
            cwd=workspace, env=env, capture_output=True, text=True, timeout=30,
        )
        assert child.returncode == 0, child.stderr[-2000:]
        result = json.loads(next(line.removeprefix('SHARED_PROOF=') for line in child.stdout.splitlines() if line.startswith('SHARED_PROOF=')))
        # Inspect only the temporary shared store. Bootstrap-created ancillary
        # state is allowed by the plan's ephemeral-store option, not private state.
        databases = {}
        observed_databases = {Path(path) for path in result['sqlite_paths']}
        assert all(path.is_relative_to(shared) for path in observed_databases)
        # Observe every sqlite connect, not only conventional .db filenames.
        for path in sorted(observed_databases | set(shared.rglob('*.db'))):
            conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
            try:
                tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                databases[str(path.relative_to(shared))] = tables
            finally:
                conn.close()
        yield {**result, 'private_unchanged': snapshot(private) == before,
            'parent_env_unchanged': dict(os.environ) == process_env,
            'expected_home': str(home), 'databases': databases,
            'private_path': str(private), 'os_home': process_env.get('HOME', ''),
            'hostname': socket.gethostname(), 'shared_files': sorted(snapshot(shared))}


def test_cold_child_excludes_private_and_host_identity_from_requests(proof):
    request = json.dumps(proof['requests'])
    for marker in [*FIXTURE['private_canaries'].values(), proof['private_path'],
                   'PRIVATE_CONFIG_SEQUOIA_907', 'PRIVATE_OPERATOR_SEQUOIA_907', 'PRIVATE_HOST_CEDAR_907', proof['os_home'], proof['hostname']]:
        if marker:
            assert marker not in request
    assert proof['violations'] == []
    assert proof['credential_names'] == ['SHARED_MODEL_API_KEY']


def test_cold_child_preserves_real_persona_tools_and_followup(proof):
    assert proof['valid_tools'] == []
    assert proof['completed']
    calls = proof['requests']
    assert len(calls) == 3
    assert all(not call.get('tools') for call in calls)
    assert all(call['model'] == 'fixture/owned-advisor' for call in calls)
    assert FIXTURE['persona']['text'] in json.dumps(calls)
    assert 'riverside room' in json.dumps(calls[-1])
    assert calls[0]['messages'][0] == calls[-1]['messages'][0]
    refusals = [message for message in calls[1]['messages'] if message.get('role') == 'tool']
    assert len(refusals) == 1 and 'does not exist' in refusals[0]['content']


def test_cold_child_leaves_private_profile_and_parent_environment_unchanged(proof):
    assert proof['private_unchanged']
    assert proof['parent_env_unchanged']
    assert proof['resolved_home'] == proof['expected_home'] == proof['module_home']
    assert not proof['session_db_attached']
    assert all('sessions' not in tables and 'messages' not in tables for tables in proof['databases'].values())
