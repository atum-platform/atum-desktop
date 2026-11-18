"""Opt-in Atum presentation on the native Matrix adapter; no model-facing surface.

The SQLite outbox records intent BEFORE network I/O. Replaying a pending operation
uses the same Matrix transaction, including edits and redactions. It is separate
from the inbound journal: it never claims, acknowledges or requeues owner input.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from contextlib import asynccontextmanager
from functools import partial
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
    return f"atum-cp-{digest}"


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


# A started tool's category (agent-turns/1.5 A13 `tool_activity`), from its name alone,
# never its arguments or results. The line carries the code, never words: the reader's
# app says it in its own language. A tool outside these categories adds no line; typing
# keeps saying the agent is working.
_TOOL_ACTIVITY = (
    (r'(web_|browser_).*', 'web'),
    (r'read_file|search_files|session_search', 'read'),
    (r'write_file|patch', 'write'),
    (r'terminal|execute_code', 'run'),
    (r'delegate_task', 'delegate'),
    (r'vision_analyze', 'look'),
    (r'image_generate', 'draw'),
)


def tool_activity(name):
    """The started tool's activity category, or None when it has none."""
    return next((activity for pattern, activity in _TOOL_ACTIVITY
                 if isinstance(name, str) and re.fullmatch(pattern, name)), None)


def video_consent_required(tool_name, result):
    """Whether a finished `video_generate` call was refused for want of the owner's video consent:
    the host's selection or key refusal surfaces as the tool's `error_type` (docs/video-generation-consent.md).
    Only that closed code is read, never the error text, prompt or anything else of the result."""
    if tool_name != 'video_generate':
        return False
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return False
    return isinstance(result, dict) and result.get('success') is False and result.get('error_type') == 'video_consent_required'


def descriptor(code, **args):
    """A closed `io.atum.presentation` descriptor: a code and bounded arguments, never prose."""
    return {'version': 1, 'code': code, 'args': args}


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
        if 'identity' not in {row[1] for row in self.db.execute('PRAGMA table_info(effects)')}:
            self.db.execute('ALTER TABLE effects ADD COLUMN identity TEXT')
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

    async def effect(self, port, room, content, txn, target=None, *, identity=None, before_send=None):
        self.db.execute('INSERT OR IGNORE INTO effects (txn,room,content,target,event,created,identity) VALUES (?,?,?,?,NULL,?,?)',
                        (txn, room, json.dumps(content), target, time.time(), identity))
        self.db.commit()
        row = self.db.execute('SELECT room,content,target,event,identity FROM effects WHERE txn=?', (txn,)).fetchone()
        if identity is not None and (row[0] != room or json.loads(row[1]) != content
                                    or row[2] != target or row[4] != identity):
            raise ValueError('Delivery identity/content changed; reconcile the existing receipt')
        if row[3]:
            return row[3]
        if before_send is not None and await before_send() is not True:
            raise ValueError('Delivery is no longer authorized')
        event = str(await port(row[0], json.loads(row[1]), txn, row[2]))
        if identity is not None and not event.startswith('$'):
            raise ValueError('Delivery returned no observed Matrix event ID')
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
            if body.get('io.atum.presentation', {}).get('code') == 'subscription_fallback':
                await self.effect(port, room, body, txn)
            elif target:
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
                source = body.get('m.relates_to', {}).get('m.in_reply_to', {}).get('event_id')
                await self.remove(port, room, source, event)
        self.collect()

    async def remove(self, port, room, source, event):
        await self.effect(port, room, {'reason': 'Turn ended'}, redaction_transaction(event), event)
        self.db.execute('DELETE FROM roots WHERE room=? AND source=? AND event=?', (room, source, event))
        self.db.commit()


class Turn:
    def __init__(self, box, port, room, source, sender, clock=time.monotonic, *,
                 occurrence=None, authorize=None):
        self.box, self.port, self.room, self.source, self.sender = box, port, room, source, sender
        self.clock = clock
        self.loop = asyncio.get_running_loop()
        self.lock = asyncio.Lock()
        self.delivery_lock = asyncio.Lock()
        self.attempt = str(uuid.uuid4())
        self.stopped = False
        self.execution_finished = False
        self.admission_id = None
        self.root = None
        self.root_txn = None
        self.root_content = None
        self.revision = -1
        self.last_progress = float('-inf')
        self.subscription_fallback = None
        self.ended = False
        self.frame = None
        # The last step before a wait: an answered wait returns the line to it (A8).
        self.step = None
        self.last_step = float('-inf')
        self.pending = None
        self.progress_timer = self.heartbeat_task = None
        self.marker = turn_id(room, source)
        from tui_gateway.pet_intents import PetIntentBuffer
        self.pet_buffer = PetIntentBuffer()
        self.pet_callback = None
        self.pet_turn_id = None
        self.pet_intents = []
        self.pet_eligible = False
        from cron.execution_identity import current_cron_execution
        self.trigger = 'cron' if current_cron_execution() is not None else None
        self.occurrence = occurrence
        self.authorize = authorize

    def queue_pet(self, command):
        from agent.delegation_context import is_delegated_child_context
        if not self.pet_callback or self.stopped or self.ended or is_delegated_child_context():
            return {'ok': False, 'reason': 'no_active_pet_turn'}
        return self.pet_callback(command)


    async def progress(self, text='', *, kind='todo', phase='working', presentation=None):
        """Publish the turn's one transient line.

        `text` is only ever the agent's own words (its redacted todo items). What the
        extension itself knows about the step travels as `presentation`, a closed
        descriptor the reader's app words in its own language; the body stays empty.
        """
        try:
            await self._progress(text, kind=kind, phase=phase, presentation=presentation)
        finally:
            if self.ended:
                await self.end()

    async def _progress(self, text, *, kind='todo', phase='working', presentation=None):
        async with self.lock:
            if self.ended or self.revision >= 47:
                return
            if self.clock() - self.last_progress < 3:
                self.pending = (text, kind, phase, presentation)
                if self.progress_timer is None:
                    async def flush():
                        await asyncio.sleep(max(0, 3 - (self.clock() - self.last_progress)))
                        self.progress_timer = None
                        pending, self.pending = self.pending, None
                        if pending:
                            await self.progress(pending[0], kind=pending[1], phase=pending[2],
                                                presentation=pending[3])
                    self.progress_timer = asyncio.create_task(flush())
                return
            if self.authorize is not None and not await self.authorize():
                self.ended = True
            if self.ended:  # The run can also end during the room-state check.
                return
            self.revision += 1
            marker = dict(profile='atum.agent-turns/1.3', scope='owner_private',
                          phase=phase, kind=kind, revision=self.revision)
            if self.trigger:
                marker['trigger'] = self.trigger
            if self.occurrence is not None:
                marker['schedule'] = dict(job=self.occurrence.job_id,
                                          execution=self.occurrence.execution_id)
            if kind == 'heartbeat':
                marker['heartbeat'] = True
            text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '',
                          unicodedata.normalize('NFC', text)).strip()[:1000]
            body = {'msgtype': 'm.notice', 'body': text, 'io.atum.progress': marker}
            if self.occurrence is None:
                body['m.relates_to'] = {'m.in_reply_to': {'event_id': self.source}}
            if presentation:
                body['io.atum.presentation'] = presentation
            if self.root:
                # An empty line stays empty in the edit fallback too: never a bare "* ".
                body = {'msgtype': 'm.notice', 'body': ('* ' + text)[:1000] if text else '',
                        'io.atum.progress': marker, 'm.new_content': body,
                        'm.relates_to': {'rel_type': 'm.replace', 'event_id': self.root}}
                if presentation:
                    body['io.atum.presentation'] = presentation
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
            self.frame = (text, kind, phase, presentation)
            if phase == 'working' and kind != 'heartbeat':
                self.step = self.frame
                self.last_step = self.last_progress
            if not self.ended and self.heartbeat_task is None:
                async def heartbeat():
                    while not self.ended:
                        await asyncio.sleep(max(1, 180 - (self.clock() - self.last_progress)))
                        if not self.ended and self.frame and self.clock() - self.last_progress >= 180:
                            await self.heartbeat()
                self.heartbeat_task = asyncio.create_task(heartbeat())

    async def heartbeat(self):
        if self.frame and self.clock() - self.last_progress >= 180:
            text, kind, phase, presentation = self.frame
            if phase == 'working':
                # Minutes since the last real step, as a number the reader's app words.
                minutes = min(1440, max(1, int((self.clock() - self.last_step) / 60)))
                await self.progress(kind='heartbeat',
                                    presentation=descriptor('heartbeat', elapsed_minutes=minutes))
            else:
                await self.progress(text, kind=kind, phase=phase, presentation=presentation)

    async def wait_for_approval(self):
        """The turn waits on the owner's approval card: a code on the line, no words."""
        await self.progress(kind='device', phase='waiting', presentation=descriptor('approval_wait'))

    async def resume(self):
        """An answered wait returns the line to the step before it (A8), never "continuing"."""
        if self.frame and self.frame[2] == 'waiting':
            text, kind, phase, presentation = self.step or ('', 'todo', 'working', None)
            await self.progress(text, kind=kind, phase=phase, presentation=presentation)

    async def end(self, answer=''):
        # Record settlement before waiting for an in-flight presentation receipt.
        # Its publisher owns the lock and applies cleanup when the event id arrives,
        # even if the final-delivery waiter has already been cancelled or returned.
        self.ended = True
        for task in (self.progress_timer, self.heartbeat_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        self.pending = None
        if self.lock.locked():
            return
        async with self.lock:
            targets = [self.root] if self.root else []
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

        async def _scheduled_room_is_private(self, room, owner):
            from mautrix.types import EventType, RoomID

            client = self._client
            if client is None:
                return False
            try:
                async with asyncio.timeout(5):
                    members, join_rule, history = await asyncio.gather(
                        client.get_joined_members(RoomID(room)),
                        self._get_room_state_value(room, EventType.ROOM_JOIN_RULES, 'join_rule'),
                        self._get_room_state_value(room, EventType.ROOM_HISTORY_VISIBILITY,
                                                   'history_visibility'),
                    )
                peers = set(members) - {str(client.mxid)}
                if len(members) != 2 or len(peers) != 1:
                    return False
                peer = next(iter(peers))
                return (client is self._client and join_rule == 'invite'
                        and history in {'invited', 'joined', 'shared'}
                        and (peer == owner if owner else peer in self._allowed_user_ids)
                        and self._is_authorized_user(peer, room))
            except Exception:
                logger.debug('Could not verify private Matrix schedule progress destination', exc_info=True)
                return False

        @asynccontextmanager
        async def scheduled_presentation_scope(self, job, cancel_event):
            from cron.execution_identity import current_cron_execution
            from cron.scheduler_delivery import _resolve_delivery_targets, _resolve_origin
            from hermes_state_keys import cron_request_id

            occurrence = current_cron_execution()
            box = getattr(self, '_presentation_box', None)
            room = None
            if (box is not None and occurrence is not None and occurrence.scheduled_instant
                    and (occurrence.job_id, occurrence.execution_id) == (job['id'], job['execution_id'])):
                try:
                    targets = await asyncio.to_thread(_resolve_delivery_targets, job)
                    matrix = [target for target in targets if target['platform'].lower() == 'matrix']
                    if len(matrix) == 1 and not matrix[0].get('thread_id'):
                        room = matrix[0]['chat_id']
                except Exception:
                    logger.debug('Could not resolve Matrix schedule progress destination', exc_info=True)
            if not room or cancel_event.is_set():
                yield
                return

            home = self.config.home_channel
            origin = _resolve_origin(job) or {}
            owner = home.user_id if home and home.chat_id == room else None
            if not owner and origin.get('platform') == 'matrix' and origin.get('chat_id') == room:
                owner = origin.get('user_id')
            turn = Turn(box, self._presentation_send, room,
                        cron_request_id(occurrence.job_id, occurrence.execution_id), owner,
                        occurrence=occurrence, authorize=partial(self._scheduled_room_is_private, room, owner))
            token = _current.set(turn)
            try:
                # The source-less notice makes Stop available even during the first model call.
                # Use the adapter loop while the scheduler proceeds to its worker thread.
                asyncio.create_task(turn.progress()).add_done_callback(_progress_sent)
                yield
            finally:
                try:
                    await turn.end()
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
                    # Entering the scope can yield while waking. Stop must win that gap too.
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
                turn.pet_eligible = (not getattr(event, 'internal', False) and not event.inherit_channel_pin
                    and os.environ.get('ATUM_PET_INTENTS') == 'reply'
                    and event.allow_gateway_control and not any(event.metadata.get(key) for key in (
                        'notification_origin', 'automation_identities', 'cron_job_id', 'job_id')))
                turn.marker = source_turn_marker(event.raw_message) or turn.marker
                event._presentation_admission_id = admission_id
                self._presentation_turns[(turn.room, turn.source)] = (turn, session_key, event.source)
                _active[session_key] = turn
            token = _current.set(turn)
            # Hook callbacks run on bounded workers: ContextVar writes inside a
            # pre_llm_call hook cannot bind the agent/tool execution context.
            # Bind here; hooks only update the shared, turn-bound collector.
            from tools.pet_tool import bind_turn_callback, reset_turn_callback
            pet_token = bind_turn_callback(turn.queue_pet if turn and turn.pet_eligible else None)
            try:
                # No status line at admission: the native read receipt and the typing
                # indicator (BasePlatformAdapter._keep_typing, m.typing) say the agent is
                # working. The transient line appears only for a real step: a tool
                # category, the todo list or a wait.
                yield
            finally:
                if turn:
                    turn.execution_finished = True
                    if turn.pet_callback:
                        turn.pet_buffer.finish(turn.pet_callback, success=False)
                        turn.pet_callback = None
                    if _active.get(session_key) is turn:
                        _active.pop(session_key, None)
                reset_turn_callback(pet_token)
                _current.reset(token)

        async def send_final_ledgered(self, *args, **kwargs):
            event = args[0] if args else kwargs.get('event')
            entry = self._presentation_turns.get((event.source.chat_id, event.message_id)) if (
                event is not None and hasattr(self, '_presentation_turns')) else None
            turn = entry[0] if entry else _current.get()
            token = _current.set(turn)
            final_token = _final_delivery.set(True)
            try:
                result, delivery_adapter = await super().send_final_ledgered(*args, **kwargs)
                if turn and turn.subscription_fallback and not turn.stopped and result.success and result.message_id:
                    content = {
                        'msgtype': 'm.notice', 'body': '',
                        'm.relates_to': {'m.in_reply_to': {'event_id': result.message_id}},
                        'io.atum.presentation': {'version': 1, 'code': 'subscription_fallback',
                                                 'args': turn.subscription_fallback},
                    }
                    try:
                        await turn.box.effect(turn.port, turn.room, content,
                                              transaction(turn.source, 'subscription-fallback-' + result.message_id))
                    except Exception:
                        # Durable intent survives for native outbox recovery. The
                        # final answer's acknowledged delivery remains successful.
                        logger.warning('Matrix fallback notice delivery deferred')
                return result, delivery_adapter
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
                    # Native commentary owns timing, formatting and delivery receipts.
                    # Keep remote egress redaction and the shared Stop boundary.
                    async with turn.delivery_lock:
                        if turn.stopped or turn.ended:
                            return SendResult(success=True)
                        return await super().send(chat_id, redact_for_egress(content),
                                                  reply_to=reply_to, metadata=metadata)
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

        async def send_structured_delivery(self, room, content, transaction_id, *, revalidate, acknowledge):
            """Trusted plugin delivery, e.g. a script-only cron with deliver=local.

            The caller owns work discovery and domain metadata validation. Revalidate
            live authority immediately before EVERY unsent/retried write. ACK is
            awaited only after the native outbox commits the observed event ID;
            lost ACKs can retry this call without another send. Boot recovery never
            publishes these originals. Account/device/token rotation requires explicit
            receipt reconciliation, not a blind retry under a new Matrix session.
            """
            if (not isinstance(transaction_id, str) or not transaction_id
                    or len(transaction_id) > 255 or not isinstance(content, dict)
                    or content.get('msgtype') != 'm.text' or not isinstance(content.get('body'), str)
                    or not content['body'] or len(content['body']) > self.max_message_length
                    or any(key in content for key in ('io.atum.pet', 'io.atum.progress',
                                                     'io.atum.interim', 'm.new_content'))):
                raise ValueError('Expected one exact structured text delivery')
            # A JSON copy freezes caller-owned objects before the first await.
            content = json.loads(json.dumps(content, allow_nan=False))
            def sender_binding():
                return json.dumps([self._homeserver, str(self._client.mxid),
                    str(getattr(self._client, 'device_id', '') or ''), self._sender_identity(),
                    hashlib.sha256(str(self._client.api.token).encode()).hexdigest()])
            identity = sender_binding()
            async def authorized():
                if await revalidate() is not True:
                    return False
                if sender_binding() != identity:
                    raise ValueError('Delivery identity changed; reconcile the existing receipt')
                return True
            event = await self._presentation_box.effect(self._presentation_send, room, content,
                transaction_id, identity=identity, before_send=authorized)
            await acknowledge(event)
            from gateway.platforms.base import SendResult
            return SendResult(success=True, message_id=event)

        def _prepare_final_content(self, chat_id, chunks, metadata):
            chunks = super()._prepare_final_content(chat_id, chunks, metadata)
            turn = _current.get()
            if (turn and chat_id == turn.room and not turn.stopped and _final_delivery.get()):
                chunks = [{**chunk, 'io.atum.turn': turn.marker} for chunk in chunks]
                if (chunks and turn.pet_eligible and not (metadata or {}).get('job_id')
                        and not (metadata or {}).get('execution_id')
                        and os.environ.get('ATUM_PET_INTENTS') == 'reply'):
                    from tui_gateway.pet_intents import pet_intent_envelope
                    pet = pet_intent_envelope(turn.pet_intents)
                    if pet:
                        chunks[-1]['io.atum.pet'] = pet
            return chunks

        async def send_or_update_status(self, chat_id, status_key, content, metadata=None):
            # Native status callbacks have their own lane: compression/retry activity
            # must never settle a turn or acquire the final-answer marker.
            turn = _current.get()
            if turn and not turn.ended and chat_id == turn.room:
                # The gateway's own status text (compression, retry and allowance waits)
                # never enters the conversation: the line carries only codes and the agent's
                # words, and typing keeps saying the agent is working.
                from gateway.platforms.base import SendResult
                return SendResult(success=True, message_id=turn.root)
            return await super().send(chat_id, content, metadata=metadata)

        async def _send_room_message(self, chat_id, msg_content, **kwargs):
            turn = _current.get()
            if (turn and chat_id == turn.room and not turn.stopped
                    and _final_delivery.get()
                    and msg_content.get('msgtype') == 'm.text' and 'm.new_content' not in msg_content):
                msg_content = {'io.atum.turn': turn.marker, **msg_content}
                if turn.trigger:
                    msg_content['io.atum.trigger'] = turn.trigger
            elif ((turn is None or turn.occurrence is not None) and msg_content.get('msgtype') == 'm.text'
                    and 'm.new_content' not in msg_content):
                # Cron's scheduler owns result delivery separately from owner-message
                # admissions. Its native execution context spans that delivery too.
                from cron.execution_identity import current_cron_execution
                occurrence = current_cron_execution()
                if occurrence is not None:
                    msg_content = {**msg_content, 'io.atum.trigger': 'cron',
                                   'io.atum.turn': turn_id(chat_id, occurrence.execution_id)}

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


def _progress_sent(future):
    if not future.cancelled() and future.exception() is not None:
        logger.warning('Matrix presentation activity could not be published')


def _progress_turn():
    turn = _current.get()
    if turn is not None and turn.occurrence is not None:
        from cron.execution_identity import current_cron_execution
        if current_cron_execution() != turn.occurrence:
            return None
    return turn


def register_hooks(ctx):
    def model_response(platform='', response=None, provider=None, model=None, **_):
        turn = _current.get()
        if not turn or turn.ended or platform != 'matrix' or not isinstance(response, dict):
            return
        # Only the final main-agent completion owns the notice. Tool iterations
        # and helpers must not leave fallback state on a later native answer.
        if response.get('finish_reason') != 'stop' or response.get('assistant_message', {}).get('tool_calls'):
            return
        metadata = response.get('metadata')
        value = metadata.get('subscription_fallback') if isinstance(metadata, dict) else None
        # The API worker's copied ContextVars do not flow back to this hook.
        # Read the staged selection and Hermes's actual completed route here.
        if value is None and provider == 'openrouter' and model == 'openai/gpt-6-luna':
            try:
                from agent.atum_google_fence import native_selection
                selected = native_selection()
            except (ValueError, TypeError, RuntimeError):
                selected = {}
            if (selected.get('provider') in {'openai-codex', 'opencode-go'}
                    and not selected.get('google_latched') and not selected.get('native_protected')):
                value = dict(plan='chatgpt' if selected['provider'] == 'openai-codex' else 'opencode_go',
                             reason='offline', servedBy='nguyet-thuc')
        valid = (isinstance(value, dict) and set(value) == {'plan', 'reason', 'servedBy'}
                 and value['plan'] in {'chatgpt', 'opencode_go'}
                 and value['reason'] == 'offline' and value['servedBy'] == 'nguyet-thuc')
        turn.subscription_fallback = dict(value) if valid else None
    ctx.register_hook('post_api_request', model_response)

    def begin_pet(platform='', turn_id='', parent_session_id='', **_):
        turn = _current.get()
        if (turn and turn.pet_eligible and not turn.stopped and not turn.ended and platform == 'matrix'
                and not parent_session_id and os.environ.get('ATUM_PET_INTENTS') == 'reply'):
            turn.pet_intents = []
            turn.pet_turn_id = turn_id
            turn.pet_callback = turn.pet_buffer.begin(turn_id)

    def finish_pet(turn_id='', completed=False, failed=False, **_):
        turn = _current.get()
        if turn and turn.pet_callback and turn_id == turn.pet_turn_id:
            turn.pet_intents = turn.pet_buffer.finish(turn.pet_callback,
                success=completed is True and not failed and not turn.stopped)
            turn.pet_callback = None

    def started_tool(tool_name='', **_):
        turn = _progress_turn()
        activity = tool_activity(tool_name)
        if turn and not turn.ended and activity:
            # Names only, never arguments/results. Schedule on the owning event loop.
            # The plugin never speaks in the agent's place: only a category code.
            asyncio.run_coroutine_threadsafe(
                turn.progress(presentation=descriptor('tool_activity', activity=activity)),
                turn.loop).add_done_callback(_progress_sent)
    def stopped(session_key='', platform='', source_event_id=None, admission_id=None, **_):
        turn = _active.get(session_key) if platform == 'matrix' else None
        if turn and source_event_id == turn.source and admission_id == turn.admission_id:
            turn.stopped = True
            asyncio.run_coroutine_threadsafe(turn.end(), turn.loop)
    def finished_tool(tool_name='', args=None, status=None, result=None, **_):
        turn = _progress_turn()
        if turn and not turn.ended and video_consent_required(tool_name, result):
            # The host refused the video step for want of the owner's one-time consent. A code on
            # the line, never words: the owner's app shows its consent card (presentation only).
            asyncio.run_coroutine_threadsafe(
                turn.progress(kind='device', phase='waiting', presentation=descriptor('video_consent_required')),
                turn.loop)
            return
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
        turn = _progress_turn()
        if turn:
            asyncio.run_coroutine_threadsafe(turn.wait_for_approval(), turn.loop)
    def resumed(**_):
        turn = _progress_turn()
        if turn:
            asyncio.run_coroutine_threadsafe(turn.resume(), turn.loop)
    ctx.register_hook('pre_tool_call', started_tool)
    ctx.register_hook('post_tool_call', finished_tool)
    ctx.register_hook('pre_approval_request', waiting)
    ctx.register_hook('post_approval_response', resumed)
    ctx.register_hook('agent_loop_stopped', stopped)
    ctx.register_hook('pre_llm_call', begin_pet)
    ctx.register_hook('post_llm_call', finish_pet)
