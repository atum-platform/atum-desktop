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


class MatrixIntakeStore:
    # Implements mautrix's SyncStore get/put_next_batch interface. An ordinary
    # MemorySyncStore/FileStateStore cannot atomically retain a batch with its token.
    def __init__(self, path):
        self.path = str(path)
        self.db = sqlite3.connect(path)
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
        self.db.commit()

    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM sync_state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def _put(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO sync_state VALUES (?,?)', (key, json.dumps(value)))

    async def get_next_batch(self):
        return self.get('next_batch')

    async def put_next_batch(self, token):
        # mautrix must not advance a token outside our batch transaction.
        if token != self.get('next_batch'):
            raise RuntimeError('Matrix cursor requires durable batch acceptance')

    def accept(self, batch):
        with self.db:
            if self.get('pending') is not None:
                raise RuntimeError('Previous Matrix batch has not finished handoff')
            self._put('pending', batch)
            self._put('next_batch', batch['next_batch'])

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

    def mark(self, event_id, state, receipt=None):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO intake_events VALUES (?,?,?,?)',
                            (event_id, state, receipt, time.time()))

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

    def park(self, raw, room):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO encrypted_pending VALUES (?,?,?,0,?)',
                            (raw['event_id'], room, json.dumps(raw), time.time()))

    def parked(self):
        return [(eid, room, json.loads(raw), tries, created) for eid, room, raw, tries, created
                in self.db.execute('SELECT * FROM encrypted_pending')]

    def unpark(self, eid):
        with self.db:
            self.db.execute('DELETE FROM encrypted_pending WHERE event_id=?', (eid,))

    def retry_parked(self, eid):
        with self.db:
            self.db.execute('UPDATE encrypted_pending SET attempts=attempts+1 WHERE event_id=?', (eid,))

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
                               'owner_action_required': tries >= 100 or time.time()-created > 86400}
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
                        raise IntakeGapError('Matrix history recovery exceeds 10000 events/16MiB; reconcile history offline; cursor unchanged')
            if found:
                break
            token = page.end
        if not found:
            raise IntakeGapError('Matrix room frontier unavailable; history recovery required')
        timeline['events'] = list(reversed(older)) + events
        timeline['limited'] = False
