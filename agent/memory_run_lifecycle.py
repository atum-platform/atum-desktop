"""Native provenance and sticky session retirement for externally bound providers.

This is a library port for a trusted controller, never a model/renderer API.
Retirement suppresses replay; it does not claim physical deletion of mixed notes,
transcripts, immutable homes or SQLite WAL/backups.
"""
import json

from agent.atum_awareness import AwarenessSessionError

RETIRED = 'memory.retired.v2.'
PROVENANCE = 'memory.provenance.v2.'


def assert_session_current(db, session_id):
    # Transcript reads must retain SessionDB's pooled-reader and close-race
    # recovery contracts. get_meta uses the writer for transaction-local FTS state.
    if db._read_one('SELECT value FROM state_meta WHERE key=?', (RETIRED + session_id,)) is not None:
        raise AwarenessSessionError()


class MemoryRunLifecycle:
    """Uses SessionDB's serialized writes and state_meta; no parallel database."""

    def __init__(self, db):
        self.db = db
        # Enforce the fence even on legacy writers, imports, reseeds and copied
        # sessions which don't call a Python preflight. Deletes remain possible.
        def install(conn):
            for table, expr in [('messages', 'NEW.session_id'), ('sessions', 'NEW.id')]:
                conn.execute(f"""CREATE TRIGGER IF NOT EXISTS memory_retired_{table}_insert
                    BEFORE INSERT ON {table} WHEN EXISTS
                    (SELECT 1 FROM state_meta WHERE key='{RETIRED}' || {expr})
                    BEGIN SELECT RAISE(ABORT, 'memory_session_retired'); END""")
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS memory_retired_parent_insert
                BEFORE INSERT ON sessions WHEN EXISTS
                (SELECT 1 FROM state_meta WHERE key='{RETIRED}' || NEW.parent_session_id)
                BEGIN SELECT RAISE(ABORT, 'memory_session_retired'); END""")
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS memory_retired_parent_update
                BEFORE UPDATE OF parent_session_id ON sessions WHEN NEW.parent_session_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM state_meta WHERE key='{RETIRED}' || NEW.parent_session_id)
                BEGIN SELECT RAISE(ABORT, 'memory_session_retired'); END""")
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS memory_retired_messages_update
                BEFORE UPDATE ON messages WHEN EXISTS
                (SELECT 1 FROM state_meta WHERE key='{RETIRED}' || NEW.session_id)
                BEGIN SELECT RAISE(ABORT, 'memory_session_retired'); END""")
        db._execute_write(install)

    def assert_current(self, session_id):
        assert_session_current(self.db, session_id)

    def record(self, provenance):
        from agent.atum_awareness_v2 import validate_binding
        binding = validate_binding(provenance['binding'])
        sid = binding['sessionId']
        # No text, token, path or native fact ID in this native receipt.
        value = json.dumps(provenance, sort_keys=True, separators=(',', ':'))
        def write(conn):
            if conn.execute('SELECT 1 FROM state_meta WHERE key=?', (RETIRED + sid,)).fetchone():
                raise AwarenessSessionError()
            key = PROVENANCE + sid + '.' + binding['runId']
            saved = conn.execute('SELECT value FROM state_meta WHERE key=?', (key,)).fetchone()
            merged = json.loads(value)
            if saved:
                previous = json.loads(saved[0])
                if previous['binding'] != binding:
                    raise AwarenessSessionError()
                by_id = {row['evidenceId']: row for row in previous['items']}
                by_id.update({row['evidenceId']: row for row in merged['items']})
                merged['items'] = list(by_id.values())
            conn.execute('INSERT OR REPLACE INTO state_meta(key,value) VALUES(?,?)',
                         (key, json.dumps(merged, sort_keys=True, separators=(',', ':'))))
        self.db._execute_write(write)

    def retire(self, session_id):
        """Fence compression peers, branches and descendants in one native write.

        The controller MUST durably retire external lineage first, and stop active
        executors/publication. This ledger alone is not backup-restore authority.
        """
        from hermes_state_mutation_guards import delete_targets
        def write(conn):
            targets = set(delete_targets(conn, session_id))
            pending = list(targets)
            while pending:
                sid = pending.pop()
                for row in conn.execute('SELECT id FROM sessions WHERE parent_session_id=?', (sid,)):
                    if row[0] not in targets:
                        targets.add(row[0])
                        pending.append(row[0])
            for sid in targets:
                conn.execute('INSERT OR IGNORE INTO state_meta(key,value) VALUES(?,?)', (RETIRED + sid, 'true'))
            return sorted(targets)
        targets = self.db._execute_write(write)
        return {'recallBlocked': True, 'retiredSessions': targets,
                'nativeSessionReplay': 'blocked', 'activeStorage': 'pending',
                'recoverableCopies': 'not_proven', 'physicalPurge': 'not_proven',
                'complete': False, 'blocker': 'mixed_content_inventory_required'}


def compose_managed_memory(existing_manager=None, *, provider=None, enabled=False,
                           child=False, session_id='', hermes_home='', agent_context='primary'):
    """Fix composition before AIAgent construction; preserve the external slot.

    Returns AIAgent kwargs. Unbound children skip memory. No config discovery,
    local fallback, late tool registration or runtime toolset mutation.
    """
    if child and provider is None:
        return {'skip_memory': True}
    if not enabled or provider is None:
        return {'memory_manager': existing_manager} if existing_manager else {'skip_memory': True}
    if existing_manager and any(p.name != 'builtin' for p in existing_manager.providers):
        return {'memory_manager': existing_manager}
    from agent.memory_manager import MemoryManager
    manager = existing_manager or MemoryManager()
    manager.add_provider(provider)
    if provider not in manager.providers:
        raise AwarenessSessionError()
    manager.initialize_all(session_id=session_id, hermes_home=hermes_home,
                           agent_context=agent_context, platform=agent_context)
    if provider not in manager.providers:
        raise AwarenessSessionError()
    manager.assert_run_authority()
    return {'memory_manager': manager}


def cleanup_native_entries(store, inventory):
    """Remove exact generated native entries from a trusted provenance inventory.

    Each record carries target, full generated entry and its digest. MemoryStore's
    pinned-entry compare happens under its native lock; user edits and mixed notes
    are retained. The controller supplies this inventory, never model arguments.
    """
    import hashlib
    receipts = []
    for record in inventory:
        target, text = record.get('target'), record.get('entry')
        exact = (target in {'memory', 'user'} and isinstance(text, str) and bool(text.strip())
                 and record.get('generatedOnly') is True
                 and hashlib.sha256(text.encode('utf-8')).hexdigest() == record.get('digest'))
        if exact:
            result = store.remove(target, text, matched_entry=text)
            removed = result.get('success') is True
        else:
            removed = False
        receipts.append({'artifactId': record['artifactId'], 'activeStorage': 'purged' if removed else 'pending',
                         'recoverableCopies': 'not_proven', 'physicalPurge': 'not_proven', 'complete': False})
    return receipts


def bind_cloud_memory(*, binding, hermes_home, lifecycle, retrieve, is_current, invalidate_run,
                      enabled=False, existing_manager=None, agent_context='primary'):
    """Native construction port; activation requires explicit enablement.

    The controller owns external retirement before home restoration, authority and publication
    cancellation. This port adds the native ledger check before inference/recall.
    """
    if not enabled:
        return compose_managed_memory(existing_manager)
    from agent.atum_awareness import AtumAwarenessProvider, AwarenessRunBinding
    from agent.atum_awareness_v2 import validate_binding
    frozen = validate_binding(binding)
    sid = frozen['sessionId']

    def current():
        lifecycle.assert_current(sid)
        return is_current() is True

    def invalidate():
        try:
            invalidate_run()
        finally:
            lifecycle.retire(sid)

    provider = AtumAwarenessProvider(
        AwarenessRunBinding(sid, hermes_home, frozen['agentPrincipal'],
                            {'class': frozen['audience']['class']}, False, 'managed'),
        cloud_binding=frozen, retrieve=retrieve, is_current=current,
        invalidate_run=invalidate, mark_google_derived=lambda: False, record_provenance=lifecycle.record)
    return compose_managed_memory(existing_manager, provider=provider, enabled=True,
                                  session_id=sid, hermes_home=hermes_home, agent_context=agent_context)


def bind_cloud_memory_from_config(config, *, agent_context='primary', **trusted_run):
    """Select managed recall before native agent construction, including cron.

    Config selects capability, never authority or credentials. The trusted host
    supplies bind_cloud_memory's binding/lifecycle/callables for this execution,
    and passes the returned kwargs to AIAgent. No desktop or plugin installation
    is involved. Missing authority fails rather than falling back to another brain.
    """
    memory = config.get('memory', {})
    selected = memory.get('provider') == 'atum_awareness'
    settings = memory.get('atum_awareness', {})
    enabled = selected and settings.get('enabled') is True
    return bind_cloud_memory(enabled=enabled, agent_context=agent_context, **trusted_run)
