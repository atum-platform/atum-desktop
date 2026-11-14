import unittest
from dataclasses import replace
from gateway.sleep_wake import Facts, Policy, decide, next_native_schedule
from contextlib import nullcontext
from types import ModuleType
from unittest.mock import patch


class SleepPolicyTests(unittest.TestCase):
    def setUp(self):
        self.facts = Facts(1000, 0, 0, False, 0, False, None, wake_coverage=True)
        self.policy = Policy()

    def test_idle_and_schedule_deadline(self):
        self.assertTrue(decide(self.policy, self.facts).sleep)
        early = replace(self.facts, next_due=1200)
        self.assertEqual(decide(self.policy, early).wake_at, 1080)
        self.assertTrue(decide(self.policy, early).sleep)
        self.assertEqual(decide(self.policy, replace(early, now=1080)).reason, 'schedule')

    def test_every_work_source_blocks_sleep(self):
        for changes in ({'active_work': 1}, {'background_work': True},
                        {'open_operations': 1}, {'pending_intake': True},
                        {'last_activity': 999}, {'probes_complete': False},
                        {'wake_coverage': False}, {'next_due': float('nan')},
                        {'active_work': -1}, {'last_activity': float('nan')}):
            with self.subTest(changes=changes):
                self.assertFalse(decide(self.policy, replace(self.facts, **changes)).sleep)

    def test_clock_rollback_and_invalid_config(self):
        self.assertFalse(decide(self.policy, replace(self.facts, last_activity=1100)).sleep)
        for value in (0, -1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                Policy(idle_seconds=value)


class NativeDeadlineTests(unittest.TestCase):
    def read(self, jobs):
        # Stub only native storage import; check the host/native schedule boundary.
        native = ModuleType('cron.jobs')
        native.load_jobs = lambda: jobs
        native.use_cron_store = lambda home: nullcontext()
        native.is_job_runnable = lambda job: job.get('enabled', True)
        native.is_terminal_job = lambda job: job.get('state') == 'completed'
        package = ModuleType('cron')
        with patch.dict('sys.modules', {'cron': package, 'cron.jobs': native}):
            return next_native_schedule('/temporary/home')

    def test_earliest_absolute_deadline_and_disabled_jobs(self):
        self.assertEqual(self.read([
            {'next_run_at': '2026-11-12T07:00:00+07:00'},
            {'next_run_at': '2026-11-12T01:00:00+00:00'},
            {'enabled': False}, {'state': 'completed'}]), 1794441600)
        self.assertIsNone(self.read([]))

    def test_unresolved_occurrences_fail_awake(self):
        for job in ({'pending_slot': {'instant': 'old'}, 'next_run_at': '2099-01-01T00:00:00Z'},
                    {'state': 'error'}, {}, {'next_run_at': '2026-11-12T00:00:00'}):
            with self.subTest(job=job), self.assertRaises((ValueError, KeyError)):
                self.read([job])


if __name__ == '__main__':
    unittest.main()
