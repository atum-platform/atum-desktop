"""Manifest verification and restore reconciliation over native Hermes stores.

The private timer owns capture/publication. This module only imports native
archives and bridges transport receipts to the canonical session authority.
"""
import hashlib
import json
from pathlib import Path


def mark_restore_ask(db, receipt, context):
    db._execute_write(lambda c: c.execute('INSERT OR REPLACE INTO state_meta(key,value) VALUES (?,?)',
        ('restore_backup:' + receipt, json.dumps(context))))


def reconcile(db, store, context):
    from hermes_state_runtime import get_session_admission
    reread, ask = list(context.get('reread', [])), []
    for event, receipt, room in store.db.execute(
            "SELECT event_id,receipt,room_id FROM intake_events WHERE state IN ('native','done') AND receipt IS NOT NULL").fetchall():
        row = get_session_admission(db, admission_id=receipt)
        if row is None:
            if not room:
                raise ValueError('Restored receipt has no room; offline recovery required')
            if [room, event] not in reread:
                reread.append([room, event])
        elif row['status'] in ('started', 'unknown'):
            mark_restore_ask(db, receipt, context)
            ask.append(receipt)
    # Older journal: seed only exact native Matrix source identities. The native
    # receipt lookup remains the guard for compacted/terminal admissions on replay.
    for row in db._read_all('SELECT admission_id,request_id,payload_json FROM session_admissions'):
        envelope = json.loads(row['payload_json']).get('native_text_v1', {})
        source = envelope.get('source', {})
        room = source.get('chat_id')
        if room and source.get('platform', 'matrix') == 'matrix' and store.state(row['request_id']) is None:
            store.mark(row['request_id'], 'native', row['admission_id'], room_id=room)
    result = dict(context, reread=reread, ask=ask)
    with store.db:
        store._put('restore', result)
        store._put('restore_boot_pending', True)
    return result


async def reconcile_before_intake(adapter, client):
    store = adapter._intake
    context = store.get('restore')
    if not context or not store.get('restore_boot_pending', True):
        return
    authority = adapter.gateway_runner.session_authority
    result = reconcile(authority.db, store, context)
    apply_restore_attention(authority.runner.session_store, authority.db, context)
    for room, event_id in result['reread']:
        event = await client.get_event(room, event_id)
        raw = event if isinstance(event, dict) else event.serialize()
        if raw.get('event_id') != event_id:
            raise ValueError('Restored source event unavailable; intake stopped')
        # Ordinary dispatch rechecks authorization and native admission identity.
        # Retain this task until the handoff succeeds; a crash retries it safely.
        with store.db:
            store.db.execute('DELETE FROM intake_events WHERE event_id=?', (event_id,))
        await adapter._dispatch_sync({'rooms': {'join': {room: {'timeline': {'events': [raw]}}}}})
        if store.state(event_id) not in ('native', 'done'):
            raise RuntimeError('Restored source did not reach durable admission')
    with store.db:
        store._put('restore', dict(result, reread=[]))
        store._put('restore_boot_pending', False)



def apply_restore_attention(sessions, db, context):
    """Use native pending Ask for stale markers and abandoned delivery obligations."""
    import time
    from gateway.resume_policy import ResumePolicy, pending_resume_policy
    from gateway.status import write_runtime_status
    tables = {r['name'] for r in db._read_all("SELECT name FROM sqlite_master WHERE type='table'")}
    abandoned = set()
    if 'delivery_obligations' in tables:
        abandoned = {r['session_key'] for r in db._read_all(
            "SELECT DISTINCT session_key FROM delivery_obligations WHERE state='abandoned'")}
    attention = []
    for entry in sessions.list_sessions():
        stamp = getattr(entry, 'last_resume_marked_at', None)
        stale = (getattr(entry, 'resume_pending', False) and
                 (stamp is None or time.time() - stamp.timestamp() > 3600))
        if stale or entry.session_key in abandoned:
            pending_resume_policy(sessions, entry,
                ResumePolicy(True, ('work restored from backup at ' + context['timestamp'] +
                    '; later actions may already have happened; check before repeating',), frozenset()),
                '', can_resolve=False)
            attention.append(entry.session_key)
    if attention:
        write_runtime_status(platform='recovery:restore:' + str(context['generation']),
            needs_attention=True, error_code='restore_requires_ask',
            platform_metrics={'alert': {'code': 'restore_requires_ask',
                'since': context['timestamp']}})
    return attention

def restore_generation(manifest_path, generation, target):
    """Restore a complete generation into a NEW scratch home; never a live home.

    Manifest v1: generation, timestamp, archives {private,persona}: {name,sha256}.
    Identity is inside the native private archive under identity/.
    """
    import os
    from types import SimpleNamespace
    from hermes_cli.backup import run_import, _validate_backup_zip, _import_members
    from hermes_cli.archive_safe import normalize_archive_parts
    import zipfile
    manifest_path = Path(manifest_path).resolve(strict=True)
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('version') != 1 or manifest.get('generation') != generation or not manifest.get('timestamp'):
        raise ValueError('Incomplete or wrong-generation manifest')
    archives = manifest.get('archives', {})
    if set(archives) != {'private', 'persona'}:
        raise ValueError('Manifest requires private and persona archives')
    verified = {}
    for part, entry in archives.items():
        name = entry['name']
        if Path(name).name != name:
            raise ValueError('Archive must be beside manifest')
        path = manifest_path.parent / name
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != entry['sha256']:
            raise ValueError('Archive hash mismatch')
        with zipfile.ZipFile(path) as archive:
            if part == 'private':
                ok, reason = _validate_backup_zip(archive)
                if not ok:
                    raise ValueError(reason)
            for member in archive.infolist():
                parts = normalize_archive_parts(member.filename)
                if (not parts or parts[0] == '_external' or
                        any(p in {'.env', 'auth.json', 'vault.key', 'vault.json.enc'} for p in parts) or
                        (member.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ValueError('Archive contains external state, credentials or links')
            if archive.testzip() is not None:
                raise ValueError('Archive CRC mismatch')
        verified[part] = path
    target = Path(target).resolve()
    if target.exists():
        raise ValueError('Restore requires a new scratch directory')
    previous = os.environ.get('HERMES_HOME')
    try:
        for part, path in verified.items():
            home = target / part
            os.environ['HERMES_HOME'] = str(home)
            if part == 'private':
                if run_import(SimpleNamespace(zipfile=str(path), force=True), start_gateway=False):
                    raise RuntimeError('Native import incomplete')
            else:
                home.mkdir(parents=True)
                with zipfile.ZipFile(path) as archive:
                    members = [n for n in archive.namelist() if not n.endswith('/')]
                    result = _import_members(archive, members, '', home, len(members))
                    if result[2]:
                        raise RuntimeError('Native persona import incomplete')
        from hermes_state import SessionDB
        from plugins.platforms.matrix.intake import MatrixIntakeStore
        home = target / 'private'
        journals = list((home / 'identity').glob('**/intake-*.sqlite3'))
        if not (home / 'state.db').is_file() or not journals:
            raise ValueError('Restore set lacks session database or intake journal')
        db = SessionDB(db_path=home / 'state.db')
        try:
            for path in journals:
                store = MatrixIntakeStore(path)
                try:
                    reconcile(db, store, {k: manifest[k] for k in ('generation', 'timestamp')})
                finally:
                    store.close()
        finally:
            db.close()
    finally:
        if previous is None:
            os.environ.pop('HERMES_HOME', None)
        else:
            os.environ['HERMES_HOME'] = previous
    return target
