"""Opt-in Atum presentation on the native Matrix adapter; no model-facing surface.

The SQLite outbox records intent BEFORE network I/O. Replaying a pending operation
uses the same Matrix transaction, including edits and redactions. It is separate
from the inbound journal: it never claims, acknowledges or requeues owner input.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import os
import re
from pathlib import Path
import sqlite3
import time
import unicodedata
import uuid

_final_delivery = ContextVar("matrix_presentation_final", default=False)
_active = {}
logger = logging.getLogger(__name__)
_current = ContextVar("matrix_presentation_turn", default=None)


def transaction(source, kind, sequence=0):
    digest = hashlib.sha256(f"{source}\0{kind}\0{sequence}".encode()).hexdigest()
    return f"atum-{'ci' if kind == 'interim' else 'cp'}-{digest}"


def event_suffix(event):
    return ''.join(c if re.fullmatch(r'[A-Za-z0-9_-]', c) else f'.{ord(c):04x}' for c in event[1:])


def redaction_transaction(event):
    return 'atum-cr-' + event_suffix(event)


def source_turn_marker(content):
    if not isinstance(content, dict):
        return None
    for key in ('io.atum.turn', 'io.atum.handoff'):
        value = content.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value):
            return value
    return None


def turn_id(room, source):
    return str(uuid.UUID(bytes=hashlib.sha256(f"{room}\0{source}".encode()).digest()[:16], version=4))


def interim_decision(private, redacted, first, sinceLastMs, duplicatesAnswer):
    if not private or not redacted or duplicatesAnswer:
        return 'drop'
    return 'publish' if first or sinceLastMs >= 20000 else 'hold'


def repeats(remark, answer):
    def words(text):
        return ' '.join(''.join(' ' if unicodedata.category(c).startswith('P') else c
                                for c in unicodedata.normalize('NFC', text).lower()).split())
    a, b = words(remark), words(answer)
    return bool(a and b and (a == b or (len(a) >= 12 and a in b)))


class Outbox:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS effects (txn TEXT PRIMARY KEY, room TEXT, content TEXT, target TEXT, event TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS roots (room TEXT, source TEXT, event TEXT, PRIMARY KEY(room, source))')
        if 'created' not in {row[1] for row in self.db.execute('PRAGMA table_info(effects)')}:
            self.db.execute('ALTER TABLE effects ADD COLUMN created REAL NOT NULL DEFAULT 0')
            self.db.execute('UPDATE effects SET created=?', (time.time(),))
        for column in ('lookup_boots', 'abandoned'):
            if column not in {row[1] for row in self.db.execute('PRAGMA table_info(effects)')}:
                self.db.execute(f'ALTER TABLE effects ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0')
        self.db.execute('CREATE INDEX IF NOT EXISTS effects_target ON effects(target)')
        self.db.execute('CREATE TABLE IF NOT EXISTS stops (room TEXT, source TEXT, sender TEXT, PRIMARY KEY(room, source, sender))')
        self.db.commit()

    def cancel(self, room, source, sender):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO stops VALUES (?,?,?)', (room, source, sender))

    def cancelled(self, room, source, sender):
        return self.db.execute('SELECT 1 FROM stops WHERE room=? AND source=? AND sender=?',
                               (room, source, sender)).fetchone() is not None

    def collect(self, now=None):
        # Keep unresolved effects and live originals indefinitely. Completed receipts
        # expire after seven days. Unresolved writes retain their original transactions.
        cutoff = (time.time() if now is None else now) - 7 * 86400
        rows = self.db.execute('''SELECT txn,content,target,event FROM effects
            WHERE event IS NOT NULL AND created < ?''', (cutoff,)).fetchall()
        completed = {row[0] for row in self.db.execute(
            'SELECT target FROM effects WHERE target IS NOT NULL AND event IS NOT NULL')}
        expired = []
        for txn, content, target, event in rows:
            body = json.loads(content)
            original = 'io.atum.progress' in body and 'm.new_content' not in body
            if original and event not in completed:
                continue
            if self.db.execute('SELECT 1 FROM roots WHERE event=?', (event,)).fetchone():
                continue
            expired.append((txn,))
        self.db.executemany('DELETE FROM effects WHERE txn=?', expired)
        self.db.commit()

    async def effect(self, port, room, content, txn, target=None):
        self.db.execute('INSERT OR IGNORE INTO effects (txn,room,content,target,event,created) VALUES (?,?,?,?,NULL,?)',
                        (txn, room, json.dumps(content), target, time.time()))
        self.db.commit()
        row = self.db.execute('SELECT room,content,target,event FROM effects WHERE txn=?', (txn,)).fetchone()
        if row[3]:
            return row[3]
        event = str(await port(row[0], json.loads(row[1]), txn, row[2]))
        self.db.execute('UPDATE effects SET event=? WHERE txn=?', (event, txn))
        self.db.commit()
        return event

    def snapshot(self):
        return ({r[0] for r in self.db.execute("SELECT txn FROM effects")},
                self.db.execute("SELECT room,source,event FROM roots").fetchall())

    async def recover(self, port, snapshot=None, resolve=None):
        txns, roots = self.snapshot() if snapshot is None else snapshot
        # Boot cleanup must never publish stale messages/edits. A lost original
        # receipt can be resolved by reading Matrix's transaction metadata.
        for txn, room, content, target in self.db.execute('SELECT txn,room,content,target FROM effects WHERE event IS NULL').fetchall():
            if txn not in txns:
                continue
            body = json.loads(content)
            if target:
                await self.effect(port, room, body, txn, target)
            elif resolve is not None and 'io.atum.progress' in body and 'm.new_content' not in body:
                created, boots, abandoned = self.db.execute(
                    'SELECT created,lookup_boots,abandoned FROM effects WHERE txn=?', (txn,)).fetchone()
                if abandoned:
                    continue
                if time.time() - created >= 86400 or boots >= 3:
                    self.db.execute('UPDATE effects SET abandoned=1 WHERE txn=?', (txn,))
                    self.db.commit()
                    logger.warning('Matrix presentation receipt lookup abandoned for %s', txn)
                    continue
                self.db.execute('UPDATE effects SET lookup_boots=lookup_boots+1 WHERE txn=?', (txn,))
                self.db.commit()
                try:
                    event = await asyncio.wait_for(resolve(room, txn), timeout=45)
                except Exception:
                    logger.warning('Matrix presentation receipt lookup deferred', exc_info=True)
                    continue
                if event:
                    self.db.execute('UPDATE effects SET event=? WHERE txn=?', (event, txn))
                    self.db.commit()
        for room, source, event in roots:
            await self.remove(port, room, source, event)
        # Roots not yet recorded at the crash boundary are reconstructed from sent intents.
        for txn, room, content, event in self.db.execute('''SELECT e.txn,e.room,e.content,e.event FROM effects e WHERE e.target IS NULL
                AND e.event IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM effects r WHERE r.target=e.event AND r.event IS NOT NULL)''').fetchall():
            body = json.loads(content)
            if txn in txns and 'io.atum.progress' in body and 'm.new_content' not in body:
                await self.remove(port, room, body['m.relates_to']['m.in_reply_to']['event_id'], event)
        self.collect()

    async def remove(self, port, room, source, event):
        await self.effect(port, room, {'reason': 'Turn ended'}, redaction_transaction(event), event)
        self.db.execute('DELETE FROM roots WHERE room=? AND source=? AND event=?', (room, source, event))
        self.db.commit()


class Turn:
    def __init__(self, box, port, room, source, sender, clock=time.monotonic):
        self.box, self.port, self.room, self.source, self.sender = box, port, room, source, sender
        self.clock = clock
        self.loop = asyncio.get_running_loop()
        self.lock = asyncio.Lock()
        self.delivery_lock = asyncio.Lock()
        self.attempt = str(uuid.uuid4())
        self.stopped = False
        self.execution_finished = False
        self.admission_id = None
        self.held_interim = None
        self.root = None
        self.root_txn = None
        self.root_content = None
        self.answer = ''
        self.revision = -1
        self.last_progress = self.last_interim = float('-inf')
        self.interims = []
        self.ended = False
        self.frame = None
        self.pending = None
        self.progress_timer = self.interim_timer = self.heartbeat_task = None
        self.marker = turn_id(room, source)

    async def progress(self, text, *, kind='todo', phase='working'):
        try:
            await self._progress(text, kind=kind, phase=phase)
        finally:
            if self.ended:
                await self.end()

    async def _progress(self, text, *, kind='todo', phase='working'):
        async with self.lock:
            if self.ended or self.revision >= 47:
                return
            if self.clock() - self.last_progress < 3:
                self.pending = (text, kind, phase)
                if self.progress_timer is None:
                    async def flush():
                        await asyncio.sleep(max(0, 3 - (self.clock() - self.last_progress)))
                        self.progress_timer = None
                        pending, self.pending = self.pending, None
                        if pending:
                            await self.progress(pending[0], kind=pending[1], phase=pending[2])
                    self.progress_timer = asyncio.create_task(flush())
                return
            self.revision += 1
            marker = dict(profile='atum.agent-turns/1.3', scope='owner_private',
                          phase=phase, kind=kind, revision=self.revision)
            if kind == 'heartbeat':
                marker['heartbeat'] = True
            text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '',
                          unicodedata.normalize('NFC', text)).strip()[:1000]
            body = {'msgtype': 'm.notice', 'body': text, 'io.atum.progress': marker,
                    'm.relates_to': {'m.in_reply_to': {'event_id': self.source}}}
            if self.root:
                body = {'msgtype': 'm.notice', 'body': ('* ' + text)[:1000],
                        'io.atum.progress': marker, 'm.new_content': body,
                        'm.relates_to': {'rel_type': 'm.replace', 'event_id': self.root}}
            txn = f'atum-ne-{self.revision}-{event_suffix(self.root)}' if self.root else transaction(f'{self.room}\0{self.source}\0{self.attempt}', 'progress')
            if not self.root:
                self.root_txn = txn
                self.root_content = body
            event = await self.box.effect(self.port, self.room, body, txn)
            if not self.root:
                self.root = event
                self.box.db.execute('INSERT OR REPLACE INTO roots VALUES (?,?,?)', (self.room, self.source, event))
                self.box.db.commit()
            self.last_progress = self.clock()
            self.frame = (text, kind, phase)
            if not self.ended and self.heartbeat_task is None:
                async def heartbeat():
                    while not self.ended:
                        await asyncio.sleep(max(1, 180 - (self.clock() - self.last_progress)))
                        if not self.ended and self.frame and self.clock() - self.last_progress >= 180:
                            await self.heartbeat()
                self.heartbeat_task = asyncio.create_task(heartbeat())

    async def heartbeat(self):
        if self.frame and self.clock() - self.last_progress >= 180:
            text, kind, phase = self.frame
            if phase == 'working':
                minutes = max(1, int((self.clock() - self.last_progress) / 60))
                from agent.i18n import owner_text
                await self.progress(owner_text(f'Still working · {minutes} min', f'Vẫn đang làm · {minutes} phút'),
                                    kind='heartbeat')
            else:
                await self.progress(text, kind=kind, phase=phase)

    async def interim(self, text, *, redacted=False):
        try:
            await self._interim(text, redacted=redacted)
        finally:
            if self.ended:
                await self.end()

    async def _interim(self, text, *, redacted=False):
        text = text.strip()[:1000]
        async with self.lock:
            if self.ended or text == self.held_interim or not redacted or not text.strip() or any(t == text for _, t in self.interims):
                return
            if interim_decision(True, redacted, not self.interims, (self.clock() - self.last_interim) * 1000, False) == 'hold':
                self.held_interim = text
                if self.interim_timer:
                    return
                async def flush():
                    await asyncio.sleep(max(0, 20 - (self.clock() - self.last_interim)))
                    self.interim_timer = None
                    held, self.held_interim = self.held_interim, None
                    if held:
                        await self.interim(held, redacted=True)
                self.interim_timer = asyncio.create_task(flush())
                return
            self.held_interim = None
            if self.interim_timer:
                self.interim_timer.cancel()
                self.interim_timer = None
            body = {'msgtype': 'm.text', 'body': text[:1000], 'io.atum.interim': True,
                    'm.relates_to': {'m.in_reply_to': {'event_id': self.source}}}
            event = await self.box.effect(self.port, self.room, body, transaction(f'{self.room}\0{self.source}\0{self.attempt}', 'interim', len(self.interims)))
            self.interims.append((event, text[:1000]))
            self.last_interim = self.clock()

    async def end(self, answer=''):
        # Record settlement before waiting for an in-flight presentation receipt.
        # Its publisher owns the lock and applies cleanup when the event id arrives,
        # even if the final-delivery waiter has already been cancelled or returned.
        self.ended = True
        self.answer = answer or self.answer
        for task in (self.progress_timer, self.interim_timer, self.heartbeat_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        self.pending = self.held_interim = None
        if self.lock.locked():
            return
        async with self.lock:
            targets = ([self.root] if self.root else []) + [
                event for event, text in self.interims if repeats(text, self.answer)]
            for event in targets:
                try:
                    await self.box.remove(self.port, self.room, self.source, event)
                except Exception:
                    # Outbox retains the stable intent for reconnect recovery.
                    logger.warning('Matrix presentation cleanup deferred', exc_info=True)
            try:
                self.box.collect()
            except Exception:
                logger.warning('Matrix presentation collection deferred', exc_info=True)


def adapter_class(base):
    class PresentationMatrixAdapter(base):
        async def connect(self, **kwargs):
            from hermes_constants import get_hermes_home
            self._presentation_ready = asyncio.Event()
            self._presentation_box = Outbox(Path(get_hermes_home()) / 'matrix' / 'presentation.sqlite3')
            self._presentation_turns = {}
            recovery = self._presentation_box.snapshot()
            self._presentation_ready.set()
            try:
                result = await super().connect(**kwargs)
                if result:
                    self._presentation_recovery_task = asyncio.create_task(self._recover_presentation(recovery))
                return result
            finally:
                self._presentation_ready.set()

        async def disconnect(self):
            task = getattr(self, '_presentation_recovery_task', None)
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            return await super().disconnect()

        async def _recover_presentation(self, recovery):
            try:
                await self._presentation_box.recover(self._presentation_send, recovery, self._presentation_resolve)
            except Exception:
                logger.warning('Matrix presentation recovery deferred', exc_info=True)

        async def _presentation_resolve(self, room, txn):
            """Read a lost send receipt; never PUT a historical message at boot."""
            from mautrix.api import Method, Path as APIPath
            row = self._presentation_box.db.execute(
                'SELECT created FROM effects WHERE txn=?', (txn,)).fetchone()
            since = row[0] * 1000 if row else 0
            cursor = None
            for _ in range(10):
                query = {'dir': 'b', 'limit': 100}
                if cursor:
                    query['from'] = cursor
                response = await asyncio.wait_for(self._client.api.request(
                    Method.GET, APIPath.v3.rooms[room].messages, query_params=query), timeout=45)
                events = response.get('chunk', [])
                for event in events:
                    if (event.get('sender') == str(self._client.mxid)
                            and event.get('unsigned', {}).get('transaction_id') == txn):
                        return event['event_id']
                next_cursor = response.get('end')
                if (not events or not next_cursor or next_cursor == cursor
                        or all(event.get('origin_server_ts', float('inf')) < since for event in events)):
                    return None
                cursor = next_cursor

        async def _presentation_send(self, room, content, txn, target):
            from mautrix.types import RoomID, EventType
            if target:
                from mautrix.api import Method, Path as APIPath
                from mautrix.errors import MatrixResponseError
                # mautrix 0.21 EventMethods.redact uses this exact native path,
                # but generates its own txn and forwards unknown kwargs to HTTPAPI.
                # https://github.com/mautrix/python/blob/v0.21.0/mautrix/client/api/events.py
                response = await asyncio.wait_for(self._client.api.request(
                    Method.PUT, APIPath.v3.rooms[room].redact[target][txn],
                    content={'reason': content['reason']}, metrics_method='redact'), timeout=45)
                if 'event_id' not in response:
                    raise MatrixResponseError('`event_id` not in response.')
                return response['event_id']
            # Use the native encrypted send path, including G1's stable-txn seam when assembled.
            import inspect
            if 'txn_id' in inspect.signature(super()._send_room_message).parameters:
                return await super()._send_room_message(room, content, txn_id=txn)
            return str(await self._client.send_message_event(RoomID(room), EventType.ROOM_MESSAGE, content, txn_id=txn))

        async def _process_message_background(self, event, session_key):
            await self._presentation_ready.wait()
            token = _current.set(None)
            try:
                return await super()._process_message_background(event, session_key)
            finally:
                _current.reset(token)

        def _cancelled_before_execution(self, event):
            if not self._presentation_box.cancelled(event.source.chat_id, event.message_id, event.source.user_id):
                return False
            from gateway.session_results import execution_result
            captured = execution_result.get()
            if captured is not None:
                captured['result'] = {'interrupted': True, 'final_response': '', 'messages': []}
            return True

        async def run_admission_presentation(self, event, session_key, admission_id, execute):
            ready = getattr(self, '_presentation_ready', None)
            if ready is not None:
                await ready.wait()
            if self._cancelled_before_execution(event):
                return None
            response = None
            async with self.admission_presentation_scope(event, session_key, admission_id):
                try:
                    # Root publication can yield while waking. Stop must win that gap too.
                    if self._cancelled_before_execution(event):
                        return None
                    response = await execute(event)
                    return response
                finally:
                    if not response and _current.get():
                        turn = _current.get()
                        await turn.end()
                        self._presentation_turns.pop((turn.room, turn.source), None)

        @asynccontextmanager
        async def admission_presentation_scope(self, event, session_key, admission_id):
            # The native FIFO, including crash recovery, owns this lifetime.
            turn = None
            if event.source.chat_type == 'dm' and event.message_id and not event.get_command():
                turn = Turn(self._presentation_box, self._presentation_send, event.source.chat_id,
                            event.message_id, event.source.user_id)
                turn.admission_id = admission_id
                turn.marker = source_turn_marker(event.raw_message) or turn.marker
                event._presentation_admission_id = admission_id
                self._presentation_turns[(turn.room, turn.source)] = (turn, session_key, event.source)
                _active[session_key] = turn
            token = _current.set(turn)
            try:
                if turn:
                    try:
                        from agent.i18n import owner_text
                        await turn.progress(owner_text('Working…', 'Đang làm…'))
                    except Exception:
                        logger.warning('Matrix presentation root deferred', exc_info=True)
                yield
            finally:
                if turn:
                    turn.execution_finished = True
                    if _active.get(session_key) is turn:
                        _active.pop(session_key, None)
                _current.reset(token)

        async def send_final_ledgered(self, *args, **kwargs):
            event = args[0] if args else kwargs.get('event')
            entry = self._presentation_turns.get((event.source.chat_id, event.message_id)) if (
                event is not None and hasattr(self, '_presentation_turns')) else None
            turn = entry[0] if entry else _current.get()
            token = _current.set(turn)
            final_token = _final_delivery.set(True)
            try:
                return await super().send_final_ledgered(*args, **kwargs)
            finally:
                try:
                    if turn:
                        await turn.end()
                        if entry and self._presentation_turns.get((turn.room, turn.source)) is entry:
                            self._presentation_turns.pop((turn.room, turn.source), None)
                finally:
                    _final_delivery.reset(final_token)
                    _current.reset(token)

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            turn = _current.get()
            if turn and chat_id == turn.room:
                from gateway.platforms.base import SendResult
                if (metadata or {}).get('_interim_send'):
                    from agent.redact import redact_for_egress
                    await turn.interim(redact_for_egress(content), redacted=True)
                    return SendResult(success=True)
                if _final_delivery.get() or (metadata or {}).get('delivery_obligation_id'):
                    async with turn.delivery_lock:
                        if turn.stopped:
                            # Intentional suppression completes the native obligation so
                            # reconnect cannot redeliver an answer cancelled by Stop.
                            return SendResult(success=True)
                        result = await super().send(chat_id, content, reply_to=reply_to, metadata=metadata)
                    await turn.end(content)
                    return result
            return await super().send(chat_id, content, reply_to=reply_to, metadata=metadata)

        async def send_or_update_status(self, chat_id, status_key, content, metadata=None):
            # Native status callbacks have their own lane: compression/retry activity
            # must never settle a turn or acquire the final-answer marker.
            turn = _current.get()
            if turn and not turn.ended and chat_id == turn.room:
                from agent.redact import redact_for_egress
                from gateway.platforms.base import SendResult
                try:
                    await turn.progress(redact_for_egress(content))
                except Exception:
                    logger.warning('Matrix presentation status could not be published', exc_info=True)
                return SendResult(success=True, message_id=turn.root)
            return await super().send(chat_id, content, metadata=metadata)

        async def _send_room_message(self, chat_id, msg_content, **kwargs):
            turn = _current.get()
            if (turn and chat_id == turn.room and not turn.stopped
                    and _final_delivery.get()
                    and msg_content.get('msgtype') == 'm.text' and 'm.new_content' not in msg_content):
                msg_content = {**msg_content, 'io.atum.turn': turn.marker}
            return await super()._send_room_message(chat_id, msg_content, **kwargs)

        async def stop_presentation_turn(self, room, source, sender, *, authenticated=False):
            """Host/Matrix control integration: caller must independently authenticate sender.

            Pass authenticated=True only after authenticating the transport principal,
            never from a caller-supplied request field. The default rejects the call.
            Dispatch and Stop serialize on delivery_lock. A transport write already
            dispatched may complete before Stop acquires that boundary.
            Source and owner must match the currently executing turn; stale Stop cannot
            interrupt a later turn. G14/Shell context closure remains host-owned.
            """
            if authenticated is not True:
                return False
            entry = self._presentation_turns.get((room, source))
            if entry and entry[0].sender != sender:
                return False
            box = getattr(self, '_presentation_box', None) or (entry[0].box if entry else None)
            if box is None:
                return False
            box.cancel(room, source, sender)
            if not entry:
                return True
            turn, key, origin = entry
            async with turn.delivery_lock:
                if turn.stopped:
                    return True
                turn.stopped = True
            runner = self.gateway_runner
            state = runner._peek_session_state(key) if hasattr(runner, '_peek_session_state') else None
            running = state.turn.event if state else None
            matches = (running is not None and running.message_id == turn.source
                       and running.source.chat_id == turn.room
                       and getattr(running, '_presentation_admission_id', None) == turn.admission_id)
            if matches or (not hasattr(runner, '_peek_session_state') and not turn.execution_finished
                           and _active.get(key, turn) is turn):
                await runner._interrupt_and_clear_session(key, origin, interrupt_reason='User requested stop',
                                                         invalidation_reason='stop')
            await turn.end()
            return True

    return PresentationMatrixAdapter


def register_hooks(ctx):
    def tool_activity(tool_name='', **_):
        turn = _current.get()
        if turn and not turn.ended:
            # Names only, never arguments/results. Schedule on the owning event loop.
            # Same words as the desktop's own activity line (matrix-status-line-copy.ts).
            from agent.i18n import owner_text
            text = owner_text(*{'terminal': ('Running a task…', 'Đang chạy tác vụ…'),
                                'read_file': ('Reading…', 'Đang đọc…'),
                                'web_search': ('Looking it up on the web…', 'Đang tra cứu trên web…'),
                                'todo': ('Planning the next steps…', 'Đang lên các bước tiếp theo…'),
                                }.get(tool_name, ('Working on it…', 'Đang xử lý…')))
            ack = owner_text("I'll take a look.", 'Mình xem ngay nhé.')
            def done(future):
                try:
                    future.result()
                except Exception:
                    logger.warning('Matrix presentation activity could not be published')
            async def publish():
                if not turn.interims:
                    await turn.interim(ack, redacted=True)
                await turn.progress(text)
            asyncio.run_coroutine_threadsafe(publish(), turn.loop).add_done_callback(done)
    def stopped(session_key='', platform='', source_event_id=None, admission_id=None, **_):
        turn = _active.get(session_key) if platform == 'matrix' else None
        if turn and source_event_id == turn.source and admission_id == turn.admission_id:
            turn.stopped = True
            asyncio.run_coroutine_threadsafe(turn.end(), turn.loop)
    def todos(tool_name='', args=None, status=None, **_):
        turn = _current.get()
        if turn and tool_name == 'todo' and status not in ('cancelled', 'error', 'blocked') and isinstance(args, dict):
            from agent.redact import redact_for_egress
            items = args.get('todos')
            if isinstance(items, list):
                lines = []
                for item in items[:12]:
                    if isinstance(item, dict) and item.get('status') in ('pending', 'in_progress', 'completed'):
                        mark = '✓' if item['status'] == 'completed' else '•'
                        lines.append(mark + ' ' + redact_for_egress(str(item.get('content', '')))[:160])
                if lines:
                    asyncio.run_coroutine_threadsafe(turn.progress('\n'.join(lines)), turn.loop)
    def waiting(**_):
        turn = _current.get()
        if turn:
            from agent.i18n import owner_text
            asyncio.run_coroutine_threadsafe(turn.progress(owner_text('Waiting for your OK…', 'Đang chờ bạn đồng ý…'),
                                                           kind='device', phase='waiting'), turn.loop)
    def resumed(**_):
        turn = _current.get()
        if turn:
            from agent.i18n import owner_text
            asyncio.run_coroutine_threadsafe(turn.progress(owner_text('Continuing…', 'Đang làm tiếp…')), turn.loop)
    ctx.register_hook('pre_tool_call', tool_activity)
    ctx.register_hook('post_tool_call', todos)
    ctx.register_hook('pre_approval_request', waiting)
    ctx.register_hook('post_approval_response', resumed)
    ctx.register_hook('agent_loop_stopped', stopped)
