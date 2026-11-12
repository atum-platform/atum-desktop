"""Opt-in Atum presentation on the native Matrix adapter; no model-facing surface.

The SQLite outbox records intent BEFORE network I/O. Replaying a pending operation
uses the same Matrix transaction, including edits and redactions. It is separate
from the inbound journal: it never claims, acknowledges or requeues owner input.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
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
        self.db.commit()

    async def effect(self, port, room, content, txn, target=None):
        self.db.execute('INSERT OR IGNORE INTO effects VALUES (?,?,?,?,NULL)',
                        (txn, room, json.dumps(content), target))
        self.db.commit()
        row = self.db.execute('SELECT room,content,target,event FROM effects WHERE txn=?', (txn,)).fetchone()
        if row[3]:
            return row[3]
        event = str(await port(row[0], json.loads(row[1]), txn, row[2]))
        self.db.execute('UPDATE effects SET event=? WHERE txn=?', (event, txn))
        self.db.commit()
        return event

    async def recover(self, port):
        # A progress send may have reached Matrix before the process stored its event id.
        for txn, room, content, target in self.db.execute('SELECT txn,room,content,target FROM effects WHERE event IS NULL').fetchall():
            await self.effect(port, room, json.loads(content), txn, target)
        for room, source, event in self.db.execute('SELECT room,source,event FROM roots').fetchall():
            await self.remove(port, room, source, event)
        # Roots not yet recorded at the crash boundary are reconstructed from sent intents.
        for txn, room, content, event in self.db.execute('SELECT txn,room,content,event FROM effects WHERE target IS NULL').fetchall():
            body = json.loads(content)
            if 'io.atum.progress' in body and 'm.new_content' not in body:
                await self.remove(port, room, body['m.relates_to']['m.in_reply_to']['event_id'], event)

    async def remove(self, port, room, source, event):
        await self.effect(port, room, {'reason': 'Turn ended'}, redaction_transaction(event), event)
        self.db.execute('DELETE FROM roots WHERE room=? AND source=?', (room, source))
        self.db.commit()


class Turn:
    def __init__(self, box, port, room, source, sender, clock=time.monotonic):
        self.box, self.port, self.room, self.source, self.sender = box, port, room, source, sender
        self.clock = clock
        self.loop = asyncio.get_running_loop()
        self.lock = asyncio.Lock()
        self.root = None
        self.revision = -1
        self.last_progress = self.last_interim = float('-inf')
        self.interims = []
        self.ended = False
        self.pending = None
        self.progress_timer = self.interim_timer = self.heartbeat_task = None
        self.marker = turn_id(room, source)

    async def progress(self, text, *, kind='todo', phase='working'):
        async with self.lock:
            if self.ended or self.revision >= 48:
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
            body = {'msgtype': 'm.notice', 'body': text[:1000], 'io.atum.progress': marker,
                    'm.relates_to': {'m.in_reply_to': {'event_id': self.source}}}
            if self.root:
                body = {'msgtype': 'm.notice', 'body': '* ' + text[:1000],
                        'io.atum.progress': marker, 'm.new_content': body,
                        'm.relates_to': {'rel_type': 'm.replace', 'event_id': self.root}}
            txn = f'atum-ne-{self.revision}-{event_suffix(self.root)}' if self.root else transaction(self.source, 'progress')
            event = await self.box.effect(self.port, self.room, body, txn)
            if not self.root:
                self.root = event
                self.box.db.execute('INSERT OR REPLACE INTO roots VALUES (?,?,?)', (self.room, self.source, event))
                self.box.db.commit()
            self.last_progress = self.clock()
            if self.heartbeat_task is None:
                async def heartbeat():
                    while not self.ended:
                        await asyncio.sleep(180)
                        await self.progress('Still working', kind='heartbeat')
                self.heartbeat_task = asyncio.create_task(heartbeat())

    async def interim(self, text, *, redacted=False):
        async with self.lock:
            if self.ended or not redacted or not text.strip() or any(t == text for _, t in self.interims):
                return
            if interim_decision(True, redacted, not self.interims, (self.clock() - self.last_interim) * 1000, False) == 'hold':
                if self.interim_timer:
                    self.interim_timer.cancel()
                async def flush():
                    await asyncio.sleep(max(0, 20 - (self.clock() - self.last_interim)))
                    self.interim_timer = None
                    await self.interim(text, redacted=True)
                self.interim_timer = asyncio.create_task(flush())
                return
            body = {'msgtype': 'm.text', 'body': text[:1000], 'io.atum.interim': True,
                    'm.relates_to': {'m.in_reply_to': {'event_id': self.source}}}
            event = await self.box.effect(self.port, self.room, body, transaction(self.source, 'interim', len(self.interims)))
            self.interims.append((event, text[:1000]))
            self.last_interim = self.clock()

    async def end(self, answer=''):
        async with self.lock:
            self.ended = True
            for task in (self.progress_timer, self.interim_timer, self.heartbeat_task):
                if task:
                    task.cancel()
            self.pending = None
            if self.root:
                await self.box.remove(self.port, self.room, self.source, self.root)
            for event, text in self.interims:
                if repeats(text, answer):
                    await self.box.remove(self.port, self.room, self.source, event)


def adapter_class(base):
    class PresentationMatrixAdapter(base):
        async def connect(self, **kwargs):
            from hermes_constants import get_hermes_home
            self._presentation_ready = asyncio.Event()
            self._presentation_box = Outbox(Path(get_hermes_home()) / 'matrix' / 'presentation.sqlite3')
            self._presentation_turns = {}
            result = await super().connect(**kwargs)
            if result:
                await self._presentation_box.recover(self._presentation_send)
                self._presentation_ready.set()
            return result

        async def _presentation_send(self, room, content, txn, target):
            from mautrix.types import RoomID, EventID, EventType
            if target:
                return await self._client.redact(RoomID(room), EventID(target), reason=content['reason'], txn_id=txn)
            # Use the native encrypted send path, including G1's stable-txn seam when assembled.
            import inspect
            if 'txn_id' in inspect.signature(super()._send_room_message).parameters:
                return await super()._send_room_message(room, content, txn_id=txn)
            return str(await self._client.send_message_event(RoomID(room), EventType.ROOM_MESSAGE, content, txn_id=txn))

        async def _process_message_background(self, event, session_key):
            await self._presentation_ready.wait()
            turn = None
            if event.source.chat_type == 'dm' and event.message_id and not event.get_command():
                turn = Turn(self._presentation_box, self._presentation_send, event.source.chat_id,
                            event.message_id, event.source.user_id)
                self._presentation_turns[(turn.room, turn.source)] = (turn, session_key, event.source)
            if turn:
                _active[session_key] = turn
            token = _current.set(turn)
            try:
                await super()._process_message_background(event, session_key)
            finally:
                try:
                    if turn:
                        await turn.end()
                finally:
                    if turn:
                        self._presentation_turns.pop((turn.room, turn.source), None)
                        if _active.get(session_key) is turn:
                            _active.pop(session_key, None)
                    _current.reset(token)

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            turn = _current.get()
            if turn and chat_id == turn.room:
                from gateway.platforms.base import SendResult
                if (metadata or {}).get('_interim_send'):
                    from agent.redact import redact_for_egress
                    await turn.interim(redact_for_egress(content), redacted=True)
                    return SendResult(success=True)
                await turn.end(content)
                if turn.ended and getattr(turn, 'stopped', False):
                    return SendResult(success=True)
            return await super().send(chat_id, content, reply_to=reply_to, metadata=metadata)

        async def _send_room_message(self, chat_id, msg_content, **kwargs):
            turn = _current.get()
            if (turn and chat_id == turn.room and not getattr(turn, 'stopped', False)
                    and msg_content.get('msgtype') == 'm.text' and 'm.new_content' not in msg_content):
                msg_content = {**msg_content, 'io.atum.turn': turn.marker}
            return await super()._send_room_message(chat_id, msg_content, **kwargs)

        async def stop_presentation_turn(self, room, source, sender):
            """Host/Matrix control integration: caller must independently authenticate sender.

            Source and owner must match the currently executing turn; stale Stop cannot
            interrupt a later turn. G14/Shell context closure remains host-owned.
            """
            entry = self._presentation_turns.get((room, source))
            if not entry or entry[0].sender != sender:
                return False
            turn, key, origin = entry
            turn.stopped = True
            runner = self.gateway_runner
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
            text = {'terminal': 'Running a command', 'read_file': 'Reading a file',
                    'web_search': 'Searching the web', 'todo': 'Updating the plan'}.get(tool_name, 'Using a tool')
            def done(future):
                try:
                    future.result()
                except Exception:
                    logger.warning('Matrix presentation activity could not be published')
            async def publish():
                if not turn.interims:
                    await turn.interim("I'll take a look.", redacted=True)
                await turn.progress(text)
            asyncio.run_coroutine_threadsafe(publish(), turn.loop).add_done_callback(done)
    def stopped(session_key='', platform='', **_):
        turn = _active.get(session_key) if platform == 'matrix' else None
        if turn:
            turn.stopped = True
            asyncio.run_coroutine_threadsafe(turn.end(), turn.loop)
    def todos(tool_name='', args=None, status=None, **_):
        turn = _current.get()
        if turn and tool_name == 'todo' and status not in ('cancelled', 'error') and isinstance(args, dict):
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
            asyncio.run_coroutine_threadsafe(turn.progress('Waiting for your approval', kind='device', phase='waiting'), turn.loop)
    def resumed(**_):
        turn = _current.get()
        if turn:
            asyncio.run_coroutine_threadsafe(turn.progress('Continuing'), turn.loop)
    ctx.register_hook('pre_tool_call', tool_activity)
    ctx.register_hook('post_tool_call', todos)
    ctx.register_hook('pre_approval_request', waiting)
    ctx.register_hook('post_approval_response', resumed)
    ctx.register_hook('agent_loop_stopped', stopped)
