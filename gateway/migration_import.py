"""Offline adapter for ``hermes.migration/1`` JSON exports.

The private producer supplies agent_id, generation (current target fence),
session_id, messages, and cutover {next_batch, frontier: {room_id: event_id}}.
Messages have source_id (immutable Matrix event ID), room_id, role
(user/assistant/system/tool), content (text), timestamp (finite Unix seconds),
and optional tool_summaries (text list). Tool summaries are provenance, never
executable tool calls. The frontier must name an imported event in each room.
Source identity is (agent_id, room_id, source_id), independent of export/session.
Changed content for an existing identity is an error, never a silent overwrite.

Call only with both runtimes stopped and identity/home mounts exclusively held.
``authorize(agent, generation, target_runtime)`` MUST check the trusted current
runtime record after confirmed stop; it must not accept a caller-provided fence.
This module cannot revoke Matrix sessions, stop hosts, or advance platform epochs.
Import commits history first, then seeds B1; after a crash repeat before starting
intake. An exact retry never rewinds a live cursor. No model/dispatch/send occurs.
Memory/files travel through the existing portable-home tool, outside this adapter.

Reverse output preserves native records verbatim for the private controller
consumer. Pending/being-sent obligations require final source/chunk evidence
from the agent's own Matrix account before resending, per the handover contract.
A cursor/receipt alone is never evidence of an answered message.
"""
import hashlib
import json
import math

VERSION = 'hermes.migration/1'


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False,
                                     separators=(',', ':')).encode()).hexdigest()


def _text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('nonempty text required')
    return value


def _fence(agent, generation, runtime, authorize):
    _text(agent)
    if type(generation) is not int or not 1 <= generation <= 9007199254740990:
        raise ValueError('invalid generation')
    if authorize(agent, generation, runtime) is not True:
        raise PermissionError('current stopped-runtime fence required')


def _validate(db, export):
    if export.get('version') != VERSION:
        raise ValueError('unsupported migration version')
    sid = _text(export.get('session_id'))
    cutover = export['cutover']
    _text(cutover['next_batch'])
    frontier = cutover['frontier']
    if not isinstance(frontier, dict) or not frontier:
        raise ValueError('room frontier required')
    messages = export['messages']
    if not isinstance(messages, list):
        raise ValueError('messages must be a list')
    normalized, identities, seen = [], [], set()
    for raw in messages:
        room, source = _text(raw['room_id']), _text(raw['source_id'])
        identity = _digest([export['agent_id'], room, source])
        if identity in seen:
            raise ValueError('duplicate source identity')
        seen.add(identity)
        if raw['role'] not in {'user', 'assistant', 'system', 'tool'}:
            raise ValueError('invalid role')
        if not isinstance(raw['content'], str):
            raise ValueError('content must be text')
        ts = raw['timestamp']
        if type(ts) not in (int, float) or not math.isfinite(ts):
            raise ValueError('finite Unix timestamp required')
        summaries = raw.get('tool_summaries', [])
        if not isinstance(summaries, list) or any(not isinstance(s, str) for s in summaries):
            raise ValueError('tool summaries must be text list')
        normalized.append({'role': raw['role'], 'content': raw['content'], 'timestamp': ts,
                           'platform_message_id': source,
                           'display_metadata': {'imported': True, 'source_id': source,
                                                'room_id': room, 'tool_summaries': summaries}})
        identities.append((identity, _digest(raw), source, room))
    last_by_room = {room: source for _, _, source, room in identities}
    if frontier != last_by_room:
        raise ValueError('frontier must name the last imported event in every room')
    items, errors = db._validate_import_payload([{'id': sid, 'source': 'migration',
                                                  'messages': normalized}])
    if errors:
        raise ValueError(errors[0]['error'])
    return items[0], identities


def import_history(db, intake, export, *, authorize):
    """Consume a decoded JSON export into the supplied native agent-home stores."""
    _fence(export['agent_id'], export['generation'], 'hermes', authorize)
    item, identities = _validate(db, export)
    cutover = export['cutover']
    key = 'migration:' + _digest([export['agent_id'], export['generation']])
    # Preflight before writing history; repeats are allowed after live intake starts.
    intake.check_migration(key, cutover)
    sid = export['session_id']

    def write(conn):
        new = []
        for msg, (identity, digest, source, room) in zip(item['messages'], identities):
            receipt = 'migration-source:' + identity
            old = conn.execute('SELECT value FROM state_meta WHERE key=?', (receipt,)).fetchone()
            if old:
                if json.loads(old[0]) != digest:
                    raise ValueError('source identity content conflict')
                continue
            new.append(msg)
            conn.execute('INSERT INTO state_meta(key,value) VALUES (?,?)', (receipt, json.dumps(digest)))
        exists = conn.execute('SELECT source FROM sessions WHERE id=?', (sid,)).fetchone()
        binding = 'migration-session:' + sid
        owner = conn.execute('SELECT value FROM state_meta WHERE key=?', (binding,)).fetchone()
        if exists and (not owner or json.loads(owner[0]) != export['agent_id']):
            raise ValueError('session belongs to another source')
        if not exists:
            db._import_session_row(conn, item['session'], new, sid)
            conn.execute('INSERT INTO state_meta(key,value) VALUES (?,?)',
                         (binding, json.dumps(export['agent_id'])))
        elif new:
            count, tools = db._insert_message_rows(conn, sid, new)
            conn.execute('UPDATE sessions SET message_count=message_count+?, '
                         'tool_call_count=tool_call_count+? WHERE id=?', (count, tools, sid))
        return len(new)

    imported = db._execute_write(write)
    intake.seed_migration(key, cutover, [(source, room) for _, _, source, room in identities])
    return {'session_id': sid, 'imported': imported}


def reverse_handover(db, intake, *, agent_id, generation, session_id, authorize):
    """Snapshot after confirmed stop, BEFORE reverse finish; private consumer owns replay/sends.

    generation is the outgoing Hermes epoch (retained during reverse drain).
    The coordinator attaches this snapshot to finish, then the private consumer
    must verify the new controller epoch before replaying any work.
    Admissions and frozen obligations
    remain native records, including unknown/in-flight states; never mint new
    request IDs or treat handed-off inputs as finished. Keep mounts quiescent
    through this call, exactly as for the existing native backup path.
    """
    _fence(agent_id, generation, 'hermes', authorize)
    history = db.export_session(session_id, include_inactive=True, include_compacted=True)
    if history is None:
        raise ValueError('missing session')
    with db._read_ctx() as conn:
        admissions = [dict(r) for r in conn.execute(
            'SELECT * FROM session_admissions WHERE target_session_id=?', (session_id,))]
        # The delivery ledger is lazily created; do not create it merely to export.
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_obligations'").fetchone()
        rooms = list(intake.get('frontier', {}))
        obligations = [dict(r) for r in conn.execute(
            'SELECT * FROM delivery_obligations WHERE chat_id IN (' + ','.join('?' for _ in rooms) + ')',
            rooms)] if exists and rooms else []
    return {'version': VERSION, 'agent_id': agent_id, 'generation': generation,
            'history': history, 'admissions': admissions, 'delivery_obligations': obligations,
            'journal': {'next_batch': intake.get('next_batch'), 'frontier': intake.get('frontier', {}),
                        'pending': intake.get('pending'),
                        'receipts': [dict(zip(('event_id','state','receipt','room_id'), r)) for r in
                                     intake.db.execute('SELECT event_id,state,receipt,room_id FROM intake_events')]}}
