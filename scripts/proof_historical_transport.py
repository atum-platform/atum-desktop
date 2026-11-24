"""Synthetic live Unix transport -> v2 cloud-first provider proof. No inference."""
import json
import sys
import threading
import tempfile
from agent.atum_awareness import AtumAwarenessProvider, AwarenessRunBinding
from agent.cloud_first_awareness import CloudFirstAwareness
from agent.historical_awareness import HistoricalAwareness, UnixHistoricalTransport

with open(sys.argv[1]) as file:
    config = json.load(file)
b = config['binding']
state = {'current': True}
local = (None if '--cloud-only' in sys.argv else
         HistoricalAwareness(b, UnixHistoricalTransport(config['local']), lambda: state['current']))
# The synthetic cloud endpoint also uses private socket custody; HTTPX maps
# an absent/refused cloud connection to the same production transport error.
def cloud_transport(request, cancelled):
    import httpx
    with httpx.Client(transport=httpx.HTTPTransport(uds=config['cloud']), timeout=0.65) as client:
        reply = client.post('http://localhost/retrieve', json=request)
        reply.raise_for_status()
        return reply.json()
cloud = HistoricalAwareness(b, cloud_transport, lambda: True)
port = CloudFirstAwareness(cloud, local, version=2, fallback_current=lambda: state['current'])
with tempfile.TemporaryDirectory(prefix='historical-proof-') as home:
    provider = AtumAwarenessProvider(
        AwarenessRunBinding(b['sessionId'], home, b['agentPrincipal'], {'class':'private_owner'}, False, 'managed'),
        cloud_binding=b, retrieve=port, is_current=lambda: True,
        record_provenance=lambda _: None, mark_google_derived=lambda: False, invalidate_run=lambda: None)
    provider.initialize(b['sessionId'], hermes_home=home)
    answer = json.loads(provider.handle_tool_call('atum_recall', {'query':'Livefixture lantern'}))
    if '--cloud-only' in sys.argv:
        assert answer['status'] == 'unavailable' and answer['retrievalOrigin'] == 'cloud', answer
        assert answer['items'] == [] and answer['errors'] == ['service_unavailable'], answer
        provider.shutdown()
        print('cloud-only outage reported; historical store not opened')
        sys.exit(0)
    expected = 'local_historical_fallback' if '--outage' in sys.argv else 'cloud'
    assert answer.get('retrievalOrigin') == expected and answer.get('items'), answer
    expected_room = '!HistoricalFixture:example.org' if '--outage' in sys.argv else '!TransportFixture:example.org'
    assert any(item['citation'].get('roomId') == expected_room for item in answer['items'])
    if '--outage' in sys.argv:
        state['current'] = False
        answer = json.loads(provider.handle_tool_call('atum_recall', {'query':'Livefixture lantern'}))
        assert not answer['items'] and answer['retrievalOrigin'] == 'cloud'
    provider.shutdown()
print('authenticated live transport tool proof passed')
