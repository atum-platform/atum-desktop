import copy
import threading
import pytest
from agent.atum_awareness import AwarenessSessionError
from agent.historical_awareness import HistoricalAwareness
from tests.agent.test_atum_awareness_v2 import binding
from tests.agent.test_atum_awareness import response


def test_maps_only_attested_same_account_current_evidence():
    b = binding()
    # Use the contract's actual bounded request shape.
    from tests.agent.test_cloud_first_awareness import provider
    import tempfile
    with tempfile.TemporaryDirectory() as home:
        p = provider(home)
        captured = []
        p._retrieve = lambda req, stop: captured.append(req) or response(req)
        p.handle_tool_call('atum_recall', {'query':'launch'})
        request = {k:v for k,v in captured[0].items() if k not in ('audience','agentPrincipal')}
        request['binding'] = b
        p.shutdown()
    state = {'current':True, 'binding':b}
    calls = []
    def read(req, stop):
        calls.append(req)
        return {'binding':state['binding'], 'response':response(req)}
    port = HistoricalAwareness(b, read, lambda:state['current'])
    result = port(request, threading.Event())
    assert result['items'][0]['lineage']['ownerPrincipal'] == b['owner']['ownerPrincipal']
    assert calls[0]['agentPrincipal'] == b['agentPrincipal']
    state['binding'] = copy.deepcopy(b)
    state['binding']['control']['revision'] += 1
    with pytest.raises(AwarenessSessionError): port(request, threading.Event())
    state['current'] = False
    before = len(calls)
    with pytest.raises(AwarenessSessionError): port(request, threading.Event())
    assert len(calls) == before
