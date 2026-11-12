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
        self.assertEqual({k: published[k] for k in interim}, interim)

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
        self.assertEqual(len(self.server.effects), 49)
        self.assertEqual(self.turn.revision, 48)

    async def test_idempotent_redaction_after_ambiguous_reply(self):
        await self.turn.progress('Working')
        self.server.lose_reply = True
        with self.assertRaises(ConnectionError):
            await self.turn.end()
        await self.turn.end()
        self.assertEqual(len(self.server.effects), 2)

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
        self.assertFalse(await adapter.stop_presentation_turn(self.turn.room, '$stale', self.turn.sender))
        self.assertFalse(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, '@stranger:example.org'))
        await self.turn.progress('Working')
        self.assertTrue(await adapter.stop_presentation_turn(self.turn.room, self.turn.source, self.turn.sender))
        self.assertEqual(calls[0][0], 'matrix:dm:owner')
        self.assertEqual(calls[0][2]['invalidation_reason'], 'stop')
        self.assertTrue(self.turn.ended)
        self.assertTrue(self.turn.stopped)
        self.assertEqual(self.server.requests[-1][3], '$0')


if __name__ == '__main__':
    unittest.main()

@unittest.skipUnless(os.environ.get('HERMES_NATIVE_TESTS'), 'run with Hermes dependency interpreter')
class NativeMatrixIntegration(unittest.IsolatedAsyncioTestCase):
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
                result = await adapter.send(turn.room, 'Here is the answer.', reply_to=turn.source)
                self.assertTrue(result.success)
                final = server.requests[-1][1]
                self.assertEqual(final['io.atum.turn'], turn.marker)
                self.assertEqual(final['m.relates_to']['m.in_reply_to']['event_id'], turn.source)
                self.assertEqual(server.requests[-2][3], '$0')
                self.assertNotIn('io.atum.interim', final)
            finally:
                p._current.reset(token)
                await turn.end()
                box.db.close()
