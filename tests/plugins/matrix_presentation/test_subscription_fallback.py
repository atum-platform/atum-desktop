"""Real native presentation final-delivery and durable notice correlation."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('fallback_presentation', ROOT / 'plugins/platforms/matrix/presentation.py')
presentation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(presentation)
FALLBACK = {'plan': 'chatgpt', 'reason': 'offline', 'servedBy': 'nguyet-thuc'}


class PresentationTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_answer_relation_retry_and_no_cost(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = []
            hooks = {}
            presentation.register_hooks(NS(register_hook=lambda name, fn: hooks.update({name: fn})))
            class Base:
                async def send_final_ledgered(self, event):
                    events.append(('answer', {'body': 'final answer'}))
                    return NS(success=True, message_id='$final'), self
            adapter = presentation.adapter_class(Base)()
            box = presentation.Outbox(Path(tmp) / 'outbox.sqlite')
            self.addCleanup(box.db.close)
            async def port(room, content, txn, target):
                events.append((txn, content))
                return '$notice'
            turn = presentation.Turn(box, port, '!room', '$source', '@owner')
            adapter._presentation_turns = {('!room', '$source'): (turn, 'session', None)}
            token = presentation._current.set(turn)
            try:
                hook = hooks['post_api_request']
                response = {'finish_reason': 'stop', 'assistant_message': {'tool_calls': []},
                            'metadata': {'subscription_fallback': FALLBACK}}
                hook(platform='matrix', response=response)
                # Helpers on a different platform cannot overwrite this turn.
                hook(platform='cli', response=dict(response, metadata=None))
                event = NS(source=NS(chat_id='!room'), message_id='$source')
                result, _ = await adapter.send_final_ledgered(event)
                self.assertTrue(result.success)
                notice = events[-1][1]
                self.assertEqual(notice, {'msgtype': 'm.notice', 'body': '',
                    'm.relates_to': {'m.in_reply_to': {'event_id': '$final'}},
                    'io.atum.presentation': {'version': 1, 'code': 'subscription_fallback', 'args': FALLBACK}})
                self.assertEqual(events[0][0], 'answer')
                self.assertNotIn('cost', json.dumps(notice))
                # An acknowledged transaction cannot publish twice.
                await box.effect(port, '!room', notice, events[-1][0])
                self.assertEqual(len(events), 2)
            finally:
                presentation._current.reset(token)

    async def test_nonfallback_final_clears_tool_iteration_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = {}
            presentation.register_hooks(NS(register_hook=lambda name, fn: hooks.update({name: fn})))
            box = presentation.Outbox(Path(tmp) / 'outbox.sqlite')
            self.addCleanup(box.db.close)
            turn = presentation.Turn(box, None, '!room', '$source', '@owner')
            token = presentation._current.set(turn)
            try:
                hook = hooks['post_api_request']
                hook(platform='matrix', response={'finish_reason': 'tool_calls',
                    'metadata': {'subscription_fallback': FALLBACK}})
                self.assertIsNone(turn.subscription_fallback)
                hook(platform='matrix', response={'finish_reason': 'stop', 'metadata': None})
                self.assertIsNone(turn.subscription_fallback)
            finally:
                presentation._current.reset(token)

    async def test_notice_outage_keeps_answer_success_and_recovers_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Base:
                async def send_final_ledgered(self, event):
                    return NS(success=True, message_id='$answer'), self
            adapter = presentation.adapter_class(Base)()
            box = presentation.Outbox(Path(tmp) / 'outbox.sqlite')
            self.addCleanup(box.db.close)
            async def unavailable(*args):
                raise OSError('fixture outage')
            turn = presentation.Turn(box, unavailable, '!room', '$source', '@owner')
            turn.subscription_fallback = FALLBACK
            adapter._presentation_turns = {('!room', '$source'): (turn, 'session', None)}
            event = NS(source=NS(chat_id='!room'), message_id='$source')
            with self.assertLogs(presentation.logger, level='WARNING'):
                result, _ = await adapter.send_final_ledgered(event)
            self.assertTrue(result.success)
            sent = []
            async def recovered(room, content, txn, target):
                sent.append(content)
                return '$notice'
            await box.recover(recovered)
            await box.recover(recovered)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]['m.relates_to']['m.in_reply_to']['event_id'], '$answer')
