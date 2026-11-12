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
    return result


async def reconcile_before_intake(adapter, client):
    store = adapter._intake
    context = store.get('restore')
    if not context:
        return
    authority = adapter.gateway_runner.session_authority
    result = reconcile(authority.db, store, context)
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


def restore_generation(manifest_path, generation, target):
    """Restore a complete generation into a NEW scratch home; never a live home.

    Manifest v1: generation, timestamp, archives {private,persona}: {name,sha256}.
    Identity is inside the native private archive under identity/.
    """
    import os
    from types import SimpleNamespace
    from hermes_cli.backup import run_import, _validate_backup_zip
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
            ok, reason = _validate_backup_zip(archive)
            if not ok:
                raise ValueError(reason)
        verified[part] = path
    target = Path(target).resolve()
    if target.exists():
        raise ValueError('Restore requires a new scratch directory')
    previous = os.environ.get('HERMES_HOME')
    try:
        for part, path in verified.items():
            home = target / part
            os.environ['HERMES_HOME'] = str(home)
            if run_import(SimpleNamespace(zipfile=str(path), force=True)):
                raise RuntimeError('Native import incomplete')
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
