"""Rolling key allowances wait on the native retry lane without changing routes."""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.error_classifier import classify_api_error

pytestmark = pytest.mark.real_retry_backoff


def refusal(status=402, *, marked=True, nested=False, body_only=False):
    error = Exception('insufficient credits')
    body = {'code': status, 'message': 'insufficient credits'}
    if marked:
        body['metadata'] = {'limit_source': 'openrouter_key_limit'}
    error.body = {'error': body} if nested else body
    if not body_only:
        error.status_code = status
    return error


@pytest.mark.parametrize('status', [402, 403])
@pytest.mark.parametrize('nested', [False, True])
@pytest.mark.parametrize('body_only', [False, True])
def test_classification(status, nested, body_only):
    result = classify_api_error(refusal(status, nested=nested, body_only=body_only), provider='openrouter')
    assert result.reason.value == 'allowance_exhausted'
    assert result.retryable
    assert not result.should_compress
    assert not result.should_rotate_credential
    assert not result.should_fallback


@pytest.mark.parametrize('status,reason', [(402, 'billing'), (403, 'billing')])
def test_unmarked_unchanged(status, reason):
    result = classify_api_error(refusal(status, marked=False), provider='openrouter')
    assert result.reason.value == reason
    assert not result.retryable


def make_agent():
    from run_agent import AIAgent
    with patch('model_tools.get_tool_definitions', return_value=[]), \
         patch('model_tools.check_toolset_requirements', return_value={}), \
         patch('agent.process_bootstrap.OpenAI'), \
         patch('agent.agent_init.fetch_model_metadata', return_value=None):
        agent = AIAgent(api_key='test-key', provider='openrouter', model='test/model',
                        base_url='https://openrouter.ai/api/v1', api_mode='chat_completions',
                        quiet_mode=True, skip_context_files=True, skip_memory=True,
                        enabled_toolsets=[])
    agent._cached_system_prompt = 'You are helpful.'
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent._use_prompt_caching = False
    agent._emit_status = MagicMock()
    agent._recover_with_credential_pool = MagicMock(side_effect=AssertionError('rotation'))
    agent._try_activate_fallback = MagicMock(side_effect=AssertionError('fallback'))
    agent._allowance_wait = (2.0, 30.0, 180.0)
    return agent


class Clock:
    now = 0.0
    def monotonic(self):
        return self.now
    def sleep(self, seconds):
        self.now += seconds


def ok():
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content='Done', tool_calls=None, reasoning=None,
                                reasoning_content=None), finish_reason='stop')],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12),
        model='test/model', id='test-completion')


@pytest.mark.parametrize('mode', ['chat_completions', 'codex_responses', 'responses_soft_failure'])
@pytest.mark.parametrize('status', [402, 403])
def test_topup_second_retry_same_request_billed_once(status, mode):
    agent = make_agent()
    agent.api_mode = "chat_completions" if mode == "chat_completions" else "codex_responses"
    clock = Clock()
    requests = []
    def call(request):
        requests.append(request)
        if len(requests) < 3:
            if mode == 'responses_soft_failure':
                return SimpleNamespace(status='failed', output=[], output_text='',
                    error=SimpleNamespace(**refusal(status).body))
            raise refusal(status)
        if mode != 'chat_completions':
            return SimpleNamespace(status='completed', output=[], output_text='Done',
                error=None, id='test-completion', model='test/model',
                usage=SimpleNamespace(input_tokens=10, output_tokens=2, total_tokens=12))
        return ok()
    with patch.object(agent, '_interruptible_api_call', side_effect=call), \
         patch('agent.turn_api_call._should_stream', return_value=False), \
         patch('agent.turn_api_error.time', SimpleNamespace(monotonic=clock.monotonic)), \
         patch('agent.turn_recovery.time', SimpleNamespace(time=clock.monotonic, sleep=clock.sleep)):
        result = agent.run_conversation('hello')
    assert result['completed'] and result['final_response'] == 'Done'
    assert result['api_calls'] == 1
    assert agent.session_prompt_tokens == 10
    assert agent.session_completion_tokens == 2
    assert 6 <= clock.now <= 9.01
    assert len(requests) == 3 and requests[0] == requests[1] == requests[2]
    agent._emit_status.assert_any_call('Waiting for usage top-up')
    assert sum(c.args == ('Waiting for usage top-up',) for c in agent._emit_status.call_args_list) == 1
    agent._recover_with_credential_pool.assert_not_called()
    agent._try_activate_fallback.assert_not_called()


@pytest.mark.parametrize('mode', ['chat_completions', 'codex_responses'])
def test_persistent_and_stop_on_shared_handler(mode):
    from agent.turn_api_error import handle_api_error
    from agent.turn_retry_state import TurnRetryState
    agent = make_agent()
    agent.api_mode = mode
    clock = Clock()
    retry = TurnRetryState()
    messages = [{'role': 'user', 'content': 'hello'}]
    def attempt():
        return handle_api_error(agent, api_error=refusal(403), _retry=retry,
            thinking_spinner=None, messages=messages, api_messages=messages,
            api_kwargs={}, system_message='', active_system_prompt='', conversation_history=[],
            approx_tokens=10, retry_count=0, max_retries=3, compression_attempts=0,
            max_compression_attempts=2, api_call_count=1, api_request_id='test',
            api_start_time=0, effective_task_id='test', turn_id='test')
    with patch('agent.turn_api_error.time', SimpleNamespace(monotonic=clock.monotonic)), \
         patch('agent.turn_recovery.time', SimpleNamespace(time=clock.monotonic, sleep=clock.sleep)):
        for _ in range(100):
            verdict = attempt()
            if verdict.action == 'return':
                break
        else:
            pytest.fail('unbounded retry')
    assert clock.now <= 180.01
    assert verdict.result['failure_reason'] == 'allowance_exhausted'
    assert verdict.result['failure_retryable'] is True
    assert 'balance' not in verdict.result['final_response'].lower()
    assert [(m['role'], m['content']) for m in messages] == [('user', 'hello')]
    agent._emit_status.assert_called_once_with('Waiting for usage top-up')
    agent._recover_with_credential_pool.assert_not_called()
    agent._try_activate_fallback.assert_not_called()

    retry = TurnRetryState()
    def stop(seconds):
        clock.sleep(seconds)
        agent._interrupt_requested = True
    with patch('agent.turn_api_error.time', SimpleNamespace(monotonic=clock.monotonic)), \
         patch('agent.turn_recovery.time', SimpleNamespace(time=clock.monotonic, sleep=stop)):
        verdict = attempt()
    assert verdict.result['interrupted']


@pytest.mark.parametrize('status', [402, 403])
def test_sse_error_normalization_preserves_marker(status):
    from agent.chat_completion_helpers import ProviderStreamError, _provider_error_body
    payload = refusal(status).body
    error = ProviderStreamError(status_code=status, body=_provider_error_body(payload, status), raw_text='')
    assert classify_api_error(error, provider='openrouter').reason.value == 'allowance_exhausted'


def test_config_policy_is_finite_and_bounded():
    from agent.retry_utils import allowance_wait_policy
    assert allowance_wait_policy(None) == (2, 30, 180)
    assert allowance_wait_policy({'initial_delay': 1, 'max_delay': 5, 'max_wait': 20}) == (1, 5, 20)
    initial, cap, window = allowance_wait_policy({'initial_delay': float('nan'),
        'max_delay': 10000, 'max_wait': float('inf')})
    assert (initial, cap, window) == (2, 30, 180)
