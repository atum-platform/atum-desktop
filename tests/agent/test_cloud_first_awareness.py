import json
import pytest
from tests.agent.test_atum_awareness import provider, response


def test_bound_managed_port_precedes_local_recall(tmp_path):
    calls = []
    p = provider(tmp_path, read=lambda req, stop: calls.append('local') or response(req),
                 managed_retrieve=lambda req, stop: calls.append('cloud') or response(req),
                 fallback_current=lambda: True)
    assert p.recall({'query': 'meeting'})['items']
    assert calls == ['cloud']


@pytest.mark.parametrize('failed', ['network', 'httpx', 'unavailable'])
def test_outage_uses_current_readonly_fallback_and_labels_it(tmp_path, failed):
    def cloud(req, stop):
        if failed == 'httpx':
            import httpx
            raise httpx.ConnectError('fixture')
        if failed == 'network':
            raise ConnectionError()
        return response(req, [], status='unavailable')
    p = provider(tmp_path, managed_retrieve=cloud, fallback_current=lambda: True)
    result = json.loads(p.handle_tool_call('atum_recall', {'query': 'meeting'}))
    assert result['items']
    assert result['retrievalOrigin'] == 'local_historical_fallback'


@pytest.mark.parametrize('mode', ['empty', 'denied', 'malformed', 'stale_privacy'])
def test_no_fallback_after_denial_empty_invalid_or_stale_privacy(tmp_path, mode):
    calls = []
    def cloud(req, stop):
        if mode == 'denied':
            raise PermissionError()
        if mode == 'malformed':
            return {}
        return response(req, [], status='unavailable' if mode == 'stale_privacy' else 'ok')
    p = provider(tmp_path, read=lambda req, stop: calls.append('local') or response(req),
                 managed_retrieve=cloud, fallback_current=lambda: mode != 'stale_privacy')
    result = p.recall({'query': 'meeting'})
    assert not result['items']
    assert calls == []


def test_origin_is_attached_to_each_response_not_shared_state(tmp_path):
    cloud_up = False
    def cloud(req, stop):
        if not cloud_up:
            raise ConnectionError()
        return response(req)
    p = provider(tmp_path, managed_retrieve=cloud, fallback_current=lambda: True)
    first = p.recall({'query': 'meeting'})
    cloud_up = True
    second = p.recall({'query': 'meeting'})
    assert first['retrievalOrigin'] == 'local_historical_fallback'
    assert second['retrievalOrigin'] == 'cloud'
    assert first['retrievalOrigin'] == 'local_historical_fallback'


def test_privacy_change_during_fallback_discards_result(tmp_path):
    state = {'current': True}
    def local(req, stop):
        state['current'] = False
        return response(req)
    def down(req, stop):
        raise ConnectionError()
    p = provider(tmp_path, read=local, managed_retrieve=down,
                 fallback_current=lambda: state['current'])
    result = p.recall({'query': 'meeting'})
    assert result['items'] == []


def test_v2_cloud_and_bound_historical_fallback(tmp_path):
    from agent.cloud_first_awareness import CloudFirstAwareness
    from tests.agent.test_atum_awareness_v2 import provider as v2provider, response as v2response
    state = {'up': True, 'current': True}
    calls = []
    def cloud(req, stop):
        if not state['up']:
            raise ConnectionError()
        return v2response(req, stop)
    def local(req, stop):
        calls.append('local')
        return v2response(req, stop)
    port = CloudFirstAwareness(cloud, local, version=2,
                               fallback_current=lambda: state['current'])
    p = v2provider(tmp_path, read=port)
    result = p.recall({'query': 'meeting'})
    assert result['retrievalOrigin'] == 'cloud' and result['items']
    assert calls == []
    state['up'] = False
    result = p.recall({'query': 'meeting'})
    assert result['retrievalOrigin'] == 'local_historical_fallback' and result['items']
    state['current'] = False
    assert p.recall({'query': 'meeting'})['items'] == []
    assert calls == ['local']


@pytest.mark.parametrize('failure', ['connection', 'timeout', 'transport', 'unavailable'])
def test_v2_release_without_native_authority_reports_cloud_outage_without_local_reads(tmp_path, failure):
    from agent.cloud_first_awareness import CloudFirstAwareness
    from agent.atum_awareness_v2 import unavailable
    from tests.agent.test_atum_awareness_v2 import provider as v2provider
    calls = []

    def cloud(req, stop):
        calls.append('cloud')
        if failure == 'connection':
            raise ConnectionError()
        if failure == 'timeout':
            raise TimeoutError()
        if failure == 'transport':
            import httpx
            raise httpx.ConnectError('synthetic outage')
        return unavailable(req)

    def local(req, stop):
        pytest.fail('Unreconciled Mac store must never be read')

    # No native capability/current-privacy authority: the release default is off,
    # even if a historical transport is available to the composing host.
    port = CloudFirstAwareness(cloud, local, version=2)
    p = v2provider(tmp_path, read=port)
    prompt = p.system_prompt_block()
    result = json.loads(p.handle_tool_call('atum_recall', {'query': 'meeting'}))
    assert result['status'] == 'unavailable'
    assert result['retrievalOrigin'] == 'cloud'
    assert result['errors'] == ['service_unavailable']
    assert result['items'] == [] and result['contentBytes'] == 0
    assert calls == ['cloud']
    assert p.system_prompt_block() == prompt
    p.shutdown()
