"""Matrix SyncStore with a crash-safe, single-batch handoff journal.

The journal owns transport acceptance only. SessionAuthority owns execution and
DeliveryLedger owns replies. Never interpret a cursor or a handoff as an effect ACK.
"""
import json
import os
import sqlite3


class IntakeGapError(RuntimeError):
    """The saved event frontier is unavailable; operator recovery is required."""


class MatrixIntakeStore:
    # Implements mautrix's SyncStore get/put_next_batch interface. An ordinary
    # MemorySyncStore/FileStateStore cannot atomically retain a batch with its token.
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS intake_events (
                event_id TEXT PRIMARY KEY, state TEXT NOT NULL, receipt TEXT);
        ''')

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

    def state(self, event_id):
        row = self.db.execute('SELECT state FROM intake_events WHERE event_id=?', (event_id,)).fetchone()
        return row[0] if row else None

    def mark(self, event_id, state, receipt=None):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO intake_events VALUES (?,?,?)',
                            (event_id, state, receipt))

    def finish(self, batch):
        with self.db:
            frontier = self.get('frontier', {})
            for room, data in batch.get('rooms', {}).get('join', {}).items():
                events = data.get('timeline', {}).get('events', [])
                if events:
                    frontier[room] = events[-1]['event_id']
            self._put('frontier', frontier)
            self._put('pending', None)

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
            if found:
                break
            token = page.end
        if not found:
            raise IntakeGapError('Matrix room frontier unavailable; history recovery required')
        timeline['events'] = list(reversed(older)) + events
        timeline['limited'] = False
