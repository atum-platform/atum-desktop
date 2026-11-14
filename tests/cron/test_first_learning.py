"""First-learning progress and target isolation contracts."""
import unittest
from unittest.mock import patch
from cron import scheduler
from tools import memory_tool


class FirstLearningTests(unittest.TestCase):
    def test_user_target_scope_does_not_escape_run(self):
        scope = scheduler._CronRunScope({'seed_key': 'first-learning'}, 'fixture', None)
        try:
            scope.enter()
            self.assertFalse(memory_tool._memory_target_error(None, 'memory')['success'])
            self.assertFalse(memory_tool._memory_target_error(None, None)['success'])
            class Store:
                def target_enabled(self, target):
                    return True
            self.assertIsNone(memory_tool._memory_target_error(Store(), 'user'))
            self.assertFalse(memory_tool._memory_target_error(Store(), 'user', [{'target': 'memory'}])['success'])
        finally:
            scope.exit()
        self.assertFalse(memory_tool._user_target_only.get())

    def test_progress_is_short_bounded_and_distinct_from_final(self):
        job = {'seed_key': 'first-learning', 'id': 'fixture', 'enabled_toolsets': []}
        setup = scheduler._CronAgentSetup(model='fixture', runtime={})
        with patch.object(scheduler, '_deliver_result', return_value=None) as deliver:
            args = scheduler._construct_cron_agent(lambda **kw: kw, job, {}, setup,
                workdir=None, session_id='fixture', session_db=None)
            for _ in range(8):
                args['interim_assistant_callback']('  A discovery\n' * 40)
        self.assertEqual(deliver.call_count, 3)
        for i, call in enumerate(deliver.call_args_list, 1):
            self.assertLessEqual(len(call.args[1]), 180)
            self.assertNotIn('\n', call.args[1])
            self.assertEqual(call.args[0]['_delivery_part'], f'progress-{i}')
        self.assertNotIn('_delivery_part', job)

    def test_ordinary_cron_does_not_gain_progress(self):
        args = scheduler._construct_cron_agent(lambda **kw: kw, {'enabled_toolsets': []}, {},
            scheduler._CronAgentSetup(model='fixture', runtime={}), workdir=None, session_id='fixture', session_db=None)
        self.assertIsNone(args['interim_assistant_callback'])
