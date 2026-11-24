import json
import pytest
from tests.agent.test_atum_awareness import provider, response


def test_cloud_first_is_runtime_default_with_bound_cloud(tmp_path):
    calls = []
    p = provider(tmp_path, read=lambda req, stop: calls.append('local') or response(req),
                 managed_retrieve=lambda req, stop: calls.append('cloud') or response(req),
                 fallback_current=lambda: True)
    assert p.recall({'query': 'meeting'})['items']
    assert calls == ['cloud']


@pytest.mark.parametrize('failed', ['network', 'unavailable'])
def test_outage_uses_current_readonly_fallback_and_labels_it(tmp_path, failed):
    def cloud(req, stop):
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
