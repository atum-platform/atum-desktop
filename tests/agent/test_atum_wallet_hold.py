"""Real cron store wallet hold/recovery; isolated home, no model or network."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import UTC


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
                now = datetime(2030, 1, 3, tzinfo=UTC)
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

    def test_listener_402_is_silent_even_when_hold_update_fails(self):
        from agent.atum_wallet import refused
        from types import SimpleNamespace
        route = 'http://127.0.0.1:18793/v1'
        with patch.dict(os.environ, ATUM_MODEL_BASE_URL=route), patch('agent.atum_wallet.enabled', return_value=True), patch('agent.atum_wallet.set_funded', side_effect=RuntimeError('offline')):
            self.assertTrue(refused(SimpleNamespace(provider='custom', base_url=route), 402))
            self.assertFalse(refused(SimpleNamespace(provider='custom', base_url='https://foreign.invalid/v1'), 402))

    def test_recovery_continues_after_bad_job_and_removes_marker(self):
        from agent.atum_wallet import set_funded, REASON
        from cron import jobs
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, HERMES_HOME=temp), patch('agent.atum_wallet.enabled', return_value=True):
            marker = Path(temp, 'cron', REASON)
            marker.parent.mkdir(); marker.touch()
            rows = [dict(id='bad', paused_reason=REASON), dict(id='good', paused_reason=REASON)]
            with patch.object(jobs, 'load_jobs', return_value=rows), patch.object(jobs, 'resume_job', side_effect=[ValueError('terminal'), None]) as resume:
                set_funded(True)
                self.assertEqual(resume.call_count, 2)
                self.assertFalse(marker.exists())

    def test_held_claim_is_terminal_and_not_recovered_as_crash(self):
        from cron import jobs, scheduler, executions
        from agent.atum_wallet import set_funded
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, HERMES_HOME=temp), patch('agent.atum_wallet.enabled', return_value=True):
            with jobs.use_cron_store(Path(temp)):
                job = jobs.create_job('brief', 'every 1h', deliver='origin')
                set_funded(False)
                execution = executions.create_execution(job['id'], source='direct')
                job['execution_id'] = execution['id']
                self.assertTrue(scheduler._run_one_job_body(job))
                self.assertEqual(executions.get_execution(execution['id'])['error'], 'wallet_hold')
                self.assertEqual(executions.recover_interrupted_executions(), 0)

    def test_wallet_marker_survives_session_db_reload(self):
        from hermes_state import SessionDB
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, 'state.db')
            db = SessionDB(db_path=path)
            db.create_session('wallet', source='cli')
            db.append_message('wallet', 'assistant', '[SILENT]', display_kind='wallet_empty', display_metadata={'wallet_empty': True})
            db.close()
            reopened = SessionDB(db_path=path)
            try:
                last = reopened.get_messages('wallet')[-1]
                self.assertEqual(last['display_kind'], 'wallet_empty')
                self.assertTrue(last['display_metadata']['wallet_empty'])
            finally:
                reopened.close()
