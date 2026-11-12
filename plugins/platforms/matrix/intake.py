"""Matrix SyncStore with a crash-safe, single-batch handoff journal.

The journal owns transport acceptance only. SessionAuthority owns execution and
DeliveryLedger owns replies. Never interpret a cursor or a handoff as an effect ACK.
"""
import json
import os
import sqlite3
import time


class IntakeGapError(RuntimeError):
    """The saved event frontier is unavailable; operator recovery is required."""


class IntakeAmbiguousError(RuntimeError):
    """An admitted control may already have executed; freeze rather than repeat it."""


class IntakeJournalError(OSError):
    """A failure at the local journal boundary, distinct from network OSError."""


def _journal_boundary(method):
    from functools import wraps
    @wraps(method)
    def guarded(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except OSError as exc:
            raise IntakeJournalError(str(exc)) from exc
    return guarded


class MatrixIntakeStore:
    # Implements mautrix's SyncStore get/put_next_batch interface. An ordinary
    # MemorySyncStore/FileStateStore cannot atomically retain a batch with its token.
    def __init__(self, path):
        self.path = str(path)
        self.db = sqlite3.connect(path)
        version = self.db.execute('PRAGMA user_version').fetchone()[0]
        if version > 1:
            self.db.close()
            raise RuntimeError('Matrix intake journal is newer than this runtime')
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS intake_events (
                event_id TEXT PRIMARY KEY, state TEXT NOT NULL, receipt TEXT);
        ''')
        if 'updated_at' not in {r[1] for r in self.db.execute('PRAGMA table_info(intake_events)')}:
            self.db.execute('ALTER TABLE intake_events ADD COLUMN updated_at REAL NOT NULL DEFAULT 0')
        self.db.execute('''CREATE TABLE IF NOT EXISTS encrypted_pending (
            event_id TEXT PRIMARY KEY, room TEXT NOT NULL, payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL)''')
        if 'notified' not in {r[1] for r in self.db.execute('PRAGMA table_info(encrypted_pending)')}:
            self.db.execute('ALTER TABLE encrypted_pending ADD COLUMN notified INTEGER NOT NULL DEFAULT 0')
        if 'failure_reason' not in {r[1] for r in self.db.execute('PRAGMA table_info(encrypted_pending)')}:
            self.db.execute('ALTER TABLE encrypted_pending ADD COLUMN failure_reason TEXT')
        self.db.commit()
        # Version 0 is the previously shipped additive schema. Migrate in one
        # transaction; never reset tokens, pending payloads or admission receipts.
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if version > 1:
                raise RuntimeError('Matrix intake journal is newer than this runtime')
            if version < 1:
                if 'room_id' not in {r[1] for r in self.db.execute('PRAGMA table_info(intake_events)')}:
                    self.db.execute('ALTER TABLE intake_events ADD COLUMN room_id TEXT')
                rooms = {eid: room for eid, room in self.db.execute('SELECT event_id,room FROM encrypted_pending')}
                rooms.update({eid: room for room, eid in self.get('frontier', {}).items()})
                for room, data in (self.get('pending') or {}).get('rooms', {}).get('join', {}).items():
                    rooms.update({e['event_id']: room for e in data.get('timeline', {}).get('events', [])})
                for eid, room in rooms.items():
                    self.db.execute('UPDATE intake_events SET room_id=? WHERE event_id=? AND room_id IS NULL', (room, eid))
                # Old completed receipts may have no surviving room evidence.
                # NULL explicitly means unknown legacy room; never invent one.
                self.db.execute('PRAGMA user_version=1')

    @_journal_boundary
    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM sync_state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @_journal_boundary
    def _put(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO sync_state VALUES (?,?)', (key, json.dumps(value)))

    async def get_next_batch(self):
        return self.get('next_batch')

    async def put_next_batch(self, token):
        # mautrix must not advance a token outside our batch transaction.
        if token != self.get('next_batch'):
            raise RuntimeError('Matrix cursor requires durable batch acceptance')

    @_journal_boundary
    def accept(self, batch):
        from gateway.fault_injection import hit
        hit("H1")
        with self.db:
            if self.get('pending') is not None:
                raise RuntimeError('Previous Matrix batch has not finished handoff')
            self._put('pending', batch)
            self._put('next_batch', batch['next_batch'])
        hit("H2")

    @_journal_boundary
    def baseline(self, batch):
        """First installation skips history atomically, including a crash mid-baseline."""
        with self.db:
            self._put('frontier', {room: data['timeline']['events'][-1]['event_id']
                                  for room, data in batch.get('rooms', {}).get('join', {}).items()
                                  if data.get('timeline', {}).get('events')})
            self._put('next_batch', batch['next_batch'])
            self._put('pending', None)

    def state(self, event_id):
        row = self.db.execute('SELECT state FROM intake_events WHERE event_id=?', (event_id,)).fetchone()
        return row[0] if row else None

    @_journal_boundary
    def mark(self, event_id, state, receipt=None, *, room_id=None):
        with self.db:
            self.db.execute('''INSERT INTO intake_events (event_id,state,receipt,updated_at,room_id)
                VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET
                state=excluded.state,receipt=excluded.receipt,updated_at=excluded.updated_at,
                room_id=COALESCE(excluded.room_id,intake_events.room_id)''',
                (event_id, state, receipt, time.time(), room_id))

    @_journal_boundary
    def finish(self, batch):
        with self.db:
            frontier = self.get('frontier', {})
            for room, data in batch.get('rooms', {}).get('join', {}).items():
                events = data.get('timeline', {}).get('events', [])
                if events:
                    frontier[room] = events[-1]['event_id']
            self._put('frontier', frontier)
            self._put('pending', None)
        self.compact()

    @_journal_boundary
    def park(self, raw, room):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO encrypted_pending (event_id,room,payload,attempts,created) VALUES (?,?,?,0,?)',
                            (raw['event_id'], room, json.dumps(raw), time.time()))

    def parked(self):
        return [(eid, room, json.loads(raw), tries, created) for eid, room, raw, tries, created
                in self.db.execute('SELECT event_id,room,payload,attempts,created FROM encrypted_pending')]

    @_journal_boundary
    def unpark(self, eid):
        with self.db:
            self.db.execute('DELETE FROM encrypted_pending WHERE event_id=?', (eid,))

    @_journal_boundary
    def retry_parked(self, eid):
        with self.db:
            self.db.execute('UPDATE encrypted_pending SET attempts=attempts+1 WHERE event_id=?', (eid,))

    @_journal_boundary
    def undecryptable(self, eid, reason):
        """Retain poison payload and diagnosis atomically, outside key retries."""
        with self.db:
            self.db.execute('UPDATE encrypted_pending SET failure_reason=? WHERE event_id=?', (reason, eid))
            self.db.execute('''INSERT INTO intake_events (event_id,state,receipt,updated_at,room_id)
                VALUES (?,?,?,?,(SELECT room FROM encrypted_pending WHERE event_id=?))
                ON CONFLICT(event_id) DO UPDATE SET state=excluded.state,
                receipt=excluded.receipt,updated_at=excluded.updated_at,
                room_id=COALESCE(excluded.room_id,intake_events.room_id)''',
                (eid, 'undecryptable', reason, time.time(), eid))

    @_journal_boundary
    def compact(self, now=None):
        # Native execution/delivery ownership stays in the native ledgers. Keep
        # transport receipts seven days AND through every outstanding replay batch.
        pending = self.get('pending') or {}
        protected = {e['event_id'] for d in pending.get('rooms', {}).get('join', {}).values()
                     for e in d.get('timeline', {}).get('events', [])}
        protected.update(row[0] for row in self.db.execute('SELECT event_id FROM encrypted_pending'))
        cutoff = (time.time() if now is None else now) - 7 * 86400
        with self.db:
            for eid, in self.db.execute("SELECT event_id FROM intake_events WHERE state IN ('done','native') AND updated_at < ?", (cutoff,)).fetchall():
                if eid not in protected:
                    self.db.execute('DELETE FROM intake_events WHERE event_id=?', (eid,))

    def status(self):
        return {'pending_batch': self.get('pending') is not None,
                'frontier': self.get('frontier', {}),
                'last_error': self.get('last_error'),
                'states': dict(self.db.execute('SELECT state,count(*) FROM intake_events GROUP BY state')),
                'encrypted': [{'event_id': eid, 'room': room, 'attempts': tries,
                               'age_seconds': max(0, time.time()-created),
                               'failure_reason': self.db.execute(
                                   'SELECT failure_reason FROM encrypted_pending WHERE event_id=?', (eid,)).fetchone()[0],
                               'owner_action_required': self.state(eid) == 'undecryptable' or tries >= 100 or time.time()-created > 86400}
                              for eid, room, raw, tries, created in self.parked()]}

    def close(self):
        self.db.close()


async def fill_gaps(client, batch, frontier, *, reset=False):
    """Walk Matrix /messages backwards to the exact saved event, then dispatch oldest first.

    Tokens remain opaque. Missing/redacted/retention-pruned frontiers fail closed;
    an unknown sync token never silently establishes a new history baseline.
    """
    for room, data in batch.get('rooms', {}).get('join', {}).items():
        timeline = data.get('timeline', {})
        boundary = frontier.get(room)
        if not boundary or not (timeline.get('limited') or reset):
            continue
        events = timeline.get('events', [])
        ids = {event['event_id'] for event in events}
        if boundary in ids:
            timeline['events'] = events[next(i for i, e in enumerate(events)
                                             if e['event_id'] == boundary) + 1:]
            timeline['limited'] = False
            continue
        from mautrix.types import PaginationDirection
        token = timeline.get('prev_batch')
        seen_tokens = set()
        older = []
        older_bytes = 0
        found = False
        while token and token not in seen_tokens:
            seen_tokens.add(token)
            page = await client.get_messages(room, from_token=token,
                                             direction=PaginationDirection.BACKWARD, limit=100)
            for event in page.events:
                raw = event if isinstance(event, dict) else event.serialize()
                if raw['event_id'] == boundary:
                    found = True
                    break
                if raw['event_id'] not in ids:
                    ids.add(raw['event_id'])
                    older.append(raw)
                    older_bytes += len(json.dumps(raw))
                    if len(older) + len(events) > 10000 or older_bytes > 16 * 1024 * 1024:
                        from gateway.fault_injection import hit
                        hit("H14")
                        raise IntakeGapError('Matrix history recovery exceeds 10000 events/16MiB; reconcile history offline; cursor unchanged')
            if found:
                break
            token = page.end
        if not found:
            from gateway.fault_injection import hit
            hit("H14")
            raise IntakeGapError('Matrix room frontier unavailable; history recovery required')
        timeline['events'] = list(reversed(older)) + events
        timeline['limited'] = False
