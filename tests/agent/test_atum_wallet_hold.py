"""Real cron store wallet hold/recovery; isolated home, no model or network."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class WalletHoldTests(unittest.TestCase):
    def test_zero_pauses_visible_jobs_and_success_resumes_only_wallet_jobs(self):
        from agent.atum_wallet import held, refused, succeeded, REASON
        from cron import jobs, scheduler
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, HERMES_HOME=temp):
            Path(temp,'config.yaml').write_text(json.dumps({'atum_cloud':{'model_key':True}}))
            with jobs.use_cron_store(Path(temp)):
                visible = jobs.create_job('brief','every 1h',deliver='origin',origin={'platform':'matrix','chat_id':'!dm:x'})
                local = jobs.create_job('local','every 1h',deliver='local')
                manual = jobs.create_job('owner paused','every 1h',deliver='origin',paused=True,paused_reason='owner')
                agent=SimpleNamespace(provider='openrouter')
                self.assertTrue(refused(agent,402))
                self.assertTrue(held())
                by_id={j['id']:j for j in jobs.load_jobs()}
                self.assertEqual(by_id[visible['id']]['paused_reason'],REASON)
                self.assertTrue(by_id[local['id']]['enabled'])
                # Real shared dispatch body returns before claim/model/delivery.
                self.assertTrue(scheduler._run_one_job_body(visible))
                succeeded(SimpleNamespace(provider='openai-codex'))
                self.assertTrue(held())
                succeeded(agent)
                self.assertTrue(held(), 'an old in-flight success cannot prove refill')
                agent._atum_wallet_held_at_request = True
                succeeded(agent)
                self.assertFalse(held())
                by_id={j['id']:j for j in jobs.load_jobs()}
                self.assertTrue(by_id[visible['id']]['enabled'])
                self.assertFalse(by_id[manual['id']]['enabled'])

    def test_unseeded_profile_keeps_native_402(self):
        from agent.atum_wallet import refused
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,HERMES_HOME=temp):
            Path(temp,'config.yaml').write_text('{}')
            self.assertFalse(refused(SimpleNamespace(provider='openrouter'),402))

    def test_supervisor_funding_resumes_once_and_discards_elapsed_slots(self):
        from agent.atum_wallet import set_funded, held
        from cron import jobs
        from datetime import datetime, timezone, timedelta
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, HERMES_HOME=temp):
            Path(temp, 'config.yaml').write_text(json.dumps({'atum_cloud': {'model_key': True}}))
            with jobs.use_cron_store(Path(temp)):
                visible = jobs.create_job('brief', 'every 1h', deliver='origin')
                expired = jobs.create_job('one-shot', '2030-01-01T00:00:00+00:00', deliver='origin')
                owner = jobs.create_job('owner', 'every 1h', deliver='origin', paused=True, paused_reason='owner')
                set_funded(False)
                now = datetime(2030, 1, 3, tzinfo=timezone.utc)
                jobs.update_job(visible['id'], {'next_run_at': (now-timedelta(days=2)).isoformat()})
                with patch.object(jobs, '_hermes_now', lambda: now):
                    set_funded(True)  # no AIAgent, user turn or provider request
                    self.assertFalse(held())
                    self.assertEqual(jobs.get_due_jobs(), [])
                    before = jobs.load_jobs()
                    set_funded(True)
                    self.assertEqual(jobs.load_jobs(), before)
                    by_id = {j['id']: j for j in before}
                    self.assertGreater(datetime.fromisoformat(by_id[visible['id']]['next_run_at']), now)
                    self.assertFalse(by_id[expired['id']]['enabled'])
                    self.assertFalse(by_id[owner['id']]['enabled'])
