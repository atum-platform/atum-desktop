"""Offline contract and restart vectors; never opens a homeserver connection."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('presentation', ROOT / 'plugins/platforms/matrix/presentation.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Server:
    def __init__(self):
        self.effects = {}
        self.requests = []
        self.lose_reply = False

    async def __call__(self, room, content, txn, target):
        self.requests.append((room, content, txn, target))
        self.effects.setdefault(txn, (room, content, target, '$' + str(len(self.effects))))
        if self.lose_reply:
            self.lose_reply = False
            raise ConnectionError('response lost after accepted write')
        return self.effects[txn][3]


class Contracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'home/matrix/presentation.sqlite3'
        self.box = p.Outbox(self.path)
        self.server = Server()
        self.now = 0
        self.turn = p.Turn(self.box, self.server, '!room:example.org', '$question', '@owner:example.org', lambda: self.now)

    async def asyncTearDown(self):
        await self.turn.end()
        self.box.db.close()
        self.tmp.cleanup()

    def test_frozen_interim_policy_vectors(self):
        vectors = json.loads((Path(__file__).parent / 'fixtures/interim-policy.vectors.json').read_text())['vectors']
        for vector in vectors:
            args = {k: v for k, v in vector.items() if k not in ('name', 'decision')}
            self.assertEqual(p.interim_decision(**args), vector['decision'], vector['name'])

    async def test_frozen_content_vectors(self):
        fixtures = Path(__file__).parent / 'fixtures'
        original = json.loads((fixtures / 'progress-original.content.json').read_text())
        self.turn.source = original['m.relates_to']['m.in_reply_to']['event_id']
        await self.turn.progress(original['body'], kind=original['io.atum.progress']['kind'])
        self.assertEqual(self.server.requests[0][1], original)
        interim = json.loads((fixtures / 'interim-message.content.json').read_text())
        await self.turn.interim(interim['body'], redacted=True)
        published = self.server.requests[1][1]
        self.assertEqual(published, {**interim, 'm.relates_to': {'m.in_reply_to': {'event_id': self.turn.source}}})

    async def test_readmitted_source_gets_fresh_root_after_recovery(self):
        await self.turn.progress('Before crash')
        old_root = self.turn.root
        await self.box.recover(self.server)
        resumed = p.Turn(self.box, self.server, self.turn.room, self.turn.source, self.turn.sender)
        try:
            await resumed.progress('Resumed')
            self.assertNotEqual(resumed.root, old_root)
            self.assertNotEqual(self.server.requests[0][2], self.server.requests[-1][2])
            self.assertEqual(resumed.marker, self.turn.marker)
        finally:
            await resumed.end()

    async def test_identical_held_interim_keeps_one_timer(self):
        await self.turn.interim('First', redacted=True)
        await self.turn.interim('Next', redacted=True)
        timer = self.turn.interim_timer
        await self.turn.interim('Next', redacted=True)
        self.assertIs(self.turn.interim_timer, timer)
        self.assertFalse(timer.cancelling())

    async def test_heartbeat_wire_shape_and_wait_preservation(self):
        await self.turn.progress('Reading')
        self.now = 180
        await self.turn.heartbeat()
        edit = self.server.requests[-1][1]
        self.assertEqual(edit['m.new_content']['body'], 'Still working · 3 min')
        self.assertEqual(edit['io.atum.progress']['kind'], 'heartbeat')
        self.assertIs(edit['io.atum.progress']['heartbeat'], True)
        self.now = 183
        await self.turn.progress('Waiting for your approval', kind='device', phase='waiting')
        self.now = 363
        await self.turn.heartbeat()
        marker = self.server.requests[-1][1]['io.atum.progress']
        self.assertEqual(marker['phase'], 'waiting')
        self.assertNotIn('heartbeat', marker)

    async def test_edit_body_bounded_and_sanitized(self):
        await self.turn.progress('Start')
        self.now = 3
        await self.turn.progress('e\u0301\x00' + 'x' * 1100)
        edit = self.server.requests[-1][1]
        self.assertEqual(len(edit['body']), 1000)
        self.assertEqual(len(edit['m.new_content']['body']), 1000)
        self.assertTrue(edit['body'].startswith('* é'))
        self.assertNotIn('\x00', edit['body'])
        self.now = 6
        await self.turn.progress('👩\u200d💻 Reading')
        self.assertEqual(self.server.requests[-1][1]['m.new_content']['body'], '👩\u200d💻 Reading')

    async def test_completed_effects_expire_but_pending_and_live_roots_survive(self):
        await self.turn.progress('Working')
        await self.turn.end()
        await self.box.effect(self.server, '!room', {'msgtype': 'm.text', 'body': 'Remark'}, 'interim-old')
        self.box.db.execute("INSERT INTO effects (txn,room,content,created) VALUES ('pending','!room','{}',0)")
        self.box.db.execute('UPDATE effects SET created=0')
        self.box.db.commit()
        self.box.collect(now=8 * 86400)
        self.assertEqual(self.box.db.execute('SELECT txn FROM effects').fetchall(), [('pending',)])
        live = p.Turn(self.box, self.server, '!room', '$live', '@owner')
        try:
            await live.progress('Live')
            self.box.db.execute('UPDATE effects SET created=0')
            self.box.db.commit()
            self.box.collect(now=8 * 86400)
            self.assertEqual(self.box.db.execute('SELECT count(*) FROM effects').fetchone()[0], 2)
        finally:
            await live.end()

    async def test_legacy_outbox_migrates_without_losing_pending_intent(self):
        import sqlite3
        path = Path(self.tmp.name) / 'legacy.sqlite3'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE effects (txn TEXT PRIMARY KEY, room TEXT, content TEXT, target TEXT, event TEXT)')
        db.execute("INSERT INTO effects VALUES ('legacy', '!room', '{}', NULL, NULL)")
        db.commit()
        db.close()
        migrated = p.Outbox(path)
        try:
            migrated.collect()
            await migrated.recover(self.server)
            self.assertEqual(self.server.requests[-1][2], 'legacy')
            self.assertIsNotNone(migrated.db.execute(
                "SELECT event FROM effects WHERE txn='legacy'").fetchone()[0])
        finally:
            migrated.db.close()

    async def test_unredacted_interim_dropped(self):
        await self.turn.interim('private secret')
        self.assertEqual(self.server.requests, [])

    async def test_original_edit_and_redaction_contract(self):
        await self.turn.progress('Reading a file')
        original = self.server.requests[0][1]
        self.assertEqual(original, {'msgtype': 'm.notice', 'body': 'Reading a file',
            'io.atum.progress': {'profile': 'atum.agent-turns/1.3', 'scope': 'owner_private', 'phase': 'working', 'kind': 'todo', 'revision': 0},
            'm.relates_to': {'m.in_reply_to': {'event_id': '$question'}}})
        self.now = 3
        await self.turn.progress('Running a command')
        edit = self.server.requests[1][1]
        self.assertEqual(edit['m.relates_to'], {'rel_type': 'm.replace', 'event_id': '$0'})
        self.assertEqual(edit['io.atum.progress'], edit['m.new_content']['io.atum.progress'])
        await self.turn.end()
        await self.turn.end()
        self.assertEqual(len(self.server.effects), 3)
        self.assertEqual(self.server.requests[-1][3], '$0')
        self.assertEqual(self.server.requests[-1][2], 'atum-cr-0')

    async def test_interim_is_not_answer_and_repetition_removed(self):
        await self.turn.interim('I will check the calendar.', redacted=True)
        content = self.server.requests[0][1]
        self.assertEqual(content['io.atum.interim'], True)
        self.assertEqual(content['msgtype'], 'm.text')
        self.assertNotIn('io.atum.turn', content)
        await self.turn.end('I will check the calendar. Here are the results.')
        self.assertEqual(self.server.requests[-1][3], '$0')

    async def test_end_drops_held_activity_and_late_events(self):
        await self.turn.progress('First')
        await self.turn.progress('Held')
        await self.turn.interim('One', redacted=True)
        await self.turn.interim('Held remark', redacted=True)
        await self.turn.end()
        count = len(self.server.requests)
        await self.turn.progress('Too late')
        await self.turn.interim('Too late', redacted=True)
        self.assertEqual(count, len(self.server.requests))
        self.assertTrue(self.turn.progress_timer.cancelled() or self.turn.progress_timer.cancelling())

    async def test_crash_after_matrix_accepts_before_receipt_no_stuck_progress(self):
        self.server.lose_reply = True
        with self.assertRaises(ConnectionError):
            await self.turn.progress('Reading a file')
        self.box.db.close()
        self.box = p.Outbox(self.path)
        await self.box.recover(self.server)
        writes = list(self.server.effects.values())
        self.assertEqual(len(writes), 2)  # one original, one redaction, despite lost response
        self.assertEqual(writes[1][2], writes[0][3])
        await self.box.recover(self.server)
        self.assertEqual(len(self.server.effects), 2)
        self.turn.box = self.box

    async def test_crash_with_recorded_root_redacted_after_restart(self):
        await self.turn.progress('Working')
        self.box.db.close()
        self.box = p.Outbox(self.path)
        await self.box.recover(self.server)
        self.assertEqual(self.box.db.execute('SELECT count(*) FROM roots').fetchone()[0], 0)
        self.assertEqual(len(self.server.effects), 2)
        self.turn.box = self.box

    async def test_rate_and_revision_bounds(self):
        for i in range(60):
            self.now = i * 3
            await self.turn.progress('Work')
        self.assertEqual(len(self.server.effects), 48)
        self.assertEqual(self.turn.revision, 47)

    async def test_idempotent_redaction_after_ambiguous_reply(self):
        await self.turn.progress('Working')
        self.server.lose_reply = True
        await self.turn.end()  # cleanup failure is best effort, intent remains durable
        self.assertEqual(self.box.db.execute(
            'SELECT count(*) FROM effects WHERE target IS NOT NULL AND event IS NULL').fetchone()[0], 1)
        first_attempt = self.server.requests[-1]
        await self.turn.end()
        self.assertEqual(self.server.requests[-1], first_attempt)
        self.assertEqual(len(self.server.effects), 2)

    def test_handoff_and_local_questions_keep_their_existing_uuid4(self):
        value = '1c5a2e1e-6c2f-4a57-9d7b-2f0c7b3f1a10'
        self.assertEqual(p.source_turn_marker({'io.atum.handoff': value}), value)
        self.assertEqual(p.source_turn_marker({'io.atum.turn': value}), value)
        self.assertIsNone(p.source_turn_marker({'io.atum.turn': value.upper()}))
        self.assertIsNone(p.source_turn_marker({'io.atum.turn': '$not-a-uuid'}))

    def test_final_marker_is_stable_lowercase_uuid4(self):
        import uuid
        marker = p.turn_id('!room:example.org', '$question')
        self.assertEqual(marker, p.turn_id('!room:example.org', '$question'))
        self.assertEqual(uuid.UUID(marker).version, 4)
        self.assertNotEqual(marker, p.turn_id('!other:example.org', '$question'))

    async def test_stop_targets_owner_and_source_then_native_interrupt(self):
        class Base:
            pass
        adapter = p.adapter_class(Base)()
        calls = []
        class Runner:
            async def _interrupt_and_clear_session(self, key, origin, **kwargs):
                calls.append((key, origin, kwargs))
        adapter.gateway_runner = Runner()
        adapter._presentation_turns = {(self.turn.room, self.turn.source): (self.turn, 'matrix:dm:owner', 'origin')}
        self.assertFalse(await adapter.stop_presentation_turn(self.turn.room, '$stale', self.turn.sender, authenticated=True))
        self.assertFalse(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, '@stranger:example.org', authenticated=True))
        self.assertFalse(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, self.turn.sender))
        await self.turn.progress('Working')
        self.assertTrue(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, self.turn.sender, authenticated=True))
        self.assertTrue(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, self.turn.sender, authenticated=True))
        self.assertEqual(len(calls), 1)  # repeated source Stop cannot interrupt a later run
        self.assertEqual(calls[0][0], 'matrix:dm:owner')
        self.assertEqual(calls[0][2]['invalidation_reason'], 'stop')
        self.assertTrue(self.turn.ended)
        self.assertTrue(self.turn.stopped)
        self.assertEqual(self.server.requests[-1][3], '$0')


if __name__ == '__main__':
    unittest.main()

@unittest.skipUnless(os.environ.get('HERMES_NATIVE_TESTS'), 'run with Hermes dependency interpreter')
class NativeMatrixIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from hermes_constants import set_hermes_home_override
        self.native_home = tempfile.TemporaryDirectory()
        self.home_token = set_hermes_home_override(self.native_home.name)

    async def asyncTearDown(self):
        from hermes_constants import reset_hermes_home_override
        reset_hermes_home_override(self.home_token)
        self.native_home.cleanup()

    async def test_group_event_refuses_presentation(self):
        from types import SimpleNamespace
        observed = []
        class Base:
            async def _process_message_background(self, event, session_key):
                observed.append(p._current.get())
        adapter = p.adapter_class(Base)()
        adapter._presentation_ready = asyncio.Event()
        adapter._presentation_ready.set()
        adapter._presentation_turns = {}
        event = SimpleNamespace(source=SimpleNamespace(chat_type='group'), message_id='$group')
        await adapter._process_message_background(event, 'group')
        self.assertEqual(observed, [None])
        self.assertEqual(adapter._presentation_turns, {})

    async def test_status_network_error_does_not_escape(self):
        class Base:
            pass
        adapter = p.adapter_class(Base)()
        async def offline(*args):
            raise ConnectionError('offline')
        box = p.Outbox(Path(self.native_home.name) / 'status.sqlite3')
        turn = p.Turn(box, offline, '!room', '$source', '@owner')
        token = p._current.set(turn)
        try:
            result = await adapter.send_or_update_status('!room', 'compression', 'Continuing')
            self.assertTrue(result.success)
            self.assertFalse(turn.ended)
        finally:
            p._current.reset(token)
            await turn.end()
            box.db.close()

    async def test_only_final_ledger_bracket_ends_presentation(self):
        class Base:
            async def send(self, *args, **kwargs):
                return 'sent'
            async def send_final_ledgered(self, *args, **kwargs):
                return await self.send('!room', 'Answer')
        adapter = p.adapter_class(Base)()
        box = p.Outbox(Path(self.native_home.name) / 'midturn.sqlite3')
        turn = p.Turn(box, Server(), '!room', '$source', '@owner')
        token = p._current.set(turn)
        try:
            await adapter.send('!room', 'Approval needed')
            self.assertFalse(turn.ended)
            await turn.progress('Still working')
            await adapter.send_final_ledgered()
            self.assertTrue(turn.ended)
            self.assertFalse(p._final_delivery.get())
        finally:
            p._current.reset(token)
            await turn.end()
            box.db.close()

    async def test_connect_false_releases_background_waiters(self):
        class Base:
            async def connect(self):
                return False
        adapter = p.adapter_class(Base)()
        try:
            self.assertFalse(await adapter.connect())
            self.assertTrue(adapter._presentation_ready.is_set())
        finally:
            adapter._presentation_box.db.close()

    async def test_recovery_network_failure_is_best_effort(self):
        class Base:
            async def connect(self):
                return True
        class Adapter(p.adapter_class(Base)):
            async def _presentation_send(self, *args):
                raise ConnectionError('offline cleanup')
        from hermes_constants import get_hermes_home
        box = p.Outbox(Path(get_hermes_home()) / 'matrix/presentation.sqlite3')
        turn = p.Turn(box, Server(), '!room', '$source', '@owner')
        await turn.progress('Orphan')
        await turn.end()
        # Retain a recorded root whose cleanup needs the network again.
        box.db.execute('DELETE FROM effects WHERE target IS NOT NULL')
        box.db.commit()
        box.db.close()
        adapter = Adapter()
        try:
            self.assertTrue(await adapter.connect())
            self.assertTrue(adapter._presentation_ready.is_set())
            self.assertGreater(adapter._presentation_box.db.execute(
                'SELECT count(*) FROM effects WHERE event IS NULL').fetchone()[0], 0)
        finally:
            adapter._presentation_box.db.close()

    async def test_stop_while_final_waits_for_dispatch_suppresses_send(self):
        from types import SimpleNamespace
        class Base:
            async def send(self, *args, **kwargs):
                sent.append(args)
        sent = []
        adapter = p.adapter_class(Base)()
        box = p.Outbox(Path(self.native_home.name) / 'race.sqlite3')
        turn = p.Turn(box, Server(), '!room', '$source', '@owner')
        # Hold the dispatch boundary while a final settles its presentation.
        turn.delivery_lock = asyncio.Lock()
        await turn.delivery_lock.acquire()
        token = p._current.set(turn)
        try:
            task = asyncio.create_task(adapter.send('!room', 'Answer', metadata={'delivery_obligation_id': 'test'}))
            await asyncio.sleep(0)
            turn.stopped = True
            turn.delivery_lock.release()
            await task
            self.assertEqual(sent, [])
        finally:
            p._current.reset(token)
            await turn.end()
            box.db.close()

    async def test_authenticated_stop_wins_queued_final_dispatch(self):
        sent = []
        class Base:
            async def send(self, *args, **kwargs):
                sent.append(args)
        class Runner:
            async def _interrupt_and_clear_session(self, *args, **kwargs):
                pass
        adapter = p.adapter_class(Base)()
        adapter.gateway_runner = Runner()
        box = p.Outbox(Path(self.native_home.name) / 'stop-queue.sqlite3')
        turn = p.Turn(box, Server(), '!room', '$source', '@owner')
        adapter._presentation_turns = {('!room', '$source'): (turn, 'session', 'origin')}
        token = p._current.set(turn)
        await turn.delivery_lock.acquire()
        try:
            stop = asyncio.create_task(adapter.stop_presentation_turn(
                '!room', '$source', '@owner', authenticated=True))
            final = asyncio.create_task(adapter.send(
                '!room', 'Answer', metadata={'delivery_obligation_id': 'test'}))
            await asyncio.sleep(0)
            turn.delivery_lock.release()
            self.assertTrue(await stop)
            result = await final
            self.assertTrue(result.success)  # cancellation must not queue redelivery
            self.assertTrue(turn.stopped)
            self.assertEqual(sent, [])
        finally:
            p._current.reset(token)
            await turn.end()
            box.db.close()

    async def test_native_send_preserves_final_relation_and_turn_marker(self):
        # Real Hermes Matrix constructor, formatter, chunker and relation builder,
        # with an in-process SDK boundary; no homeserver or provider call.
        from gateway.config import PlatformConfig
        from plugins.platforms.matrix.adapter import MatrixAdapter
        with tempfile.TemporaryDirectory() as home:
            box = p.Outbox(Path(home) / 'presentation.sqlite3')
            server = Server()
            class Client:
                async def send_message_event(self, room, kind, content, **kwargs):
                    return await server(str(room), content, kwargs.get('txn_id', 'final'), None)
            from hermes_constants import set_hermes_home_override, reset_hermes_home_override
            home_token = set_hermes_home_override(home)
            try:
                adapter = p.adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='public-test', extra={'homeserver': 'https://matrix.example.org'}))
            finally:
                reset_hermes_home_override(home_token)
            adapter._client = Client()
            turn = p.Turn(box, server, '!room:example.org', '$source', '@owner:example.org')
            token = p._current.set(turn)
            try:
                await turn.progress('Reading a file')
                await adapter.send_or_update_status(turn.room, 'compression', 'Continuing after compression')
                self.assertFalse(turn.ended)
                final_token = p._final_delivery.set(True)
                try:
                    result = await adapter.send(turn.room, 'Here is the answer.', reply_to=turn.source)
                finally:
                    p._final_delivery.reset(final_token)
                self.assertTrue(result.success)
                final = server.requests[-2][1]
                self.assertEqual(final['io.atum.turn'], turn.marker)
                self.assertEqual(final['m.relates_to']['m.in_reply_to']['event_id'], turn.source)
                self.assertEqual(server.requests[-1][3], '$0')
                self.assertNotIn('io.atum.interim', final)
            finally:
                p._current.reset(token)
                await turn.end()
                box.db.close()
