"""Cloud v2 validation at the existing managed provider seam.

Wire: atum.awareness/2 (awareness 2.1). No transport or credential discovery.
The native controller supplies the binding and validates current authority.
"""
import copy

from agent.atum_awareness_contract import (
    _exact_keys, _fail, _integer, _sha256, _uuid, validate_retrieval_response,
)


def validate_binding(value):
    p = _exact_keys(value, {'profile', 'runId', 'agentPrincipal', 'sessionId',
                           'capabilityVersion', 'capabilityDigest', 'control', 'embedding',
                           'owner', 'audience'})
    if p['profile'] != 'atum.awareness-run/2' or p['capabilityVersion'] != 'atum.awareness/2':
        _fail()
    for key in ('runId', 'agentPrincipal', 'sessionId'):
        _uuid(p[key])
    _sha256(p['capabilityDigest'])
    control = _exact_keys(p['control'], {'state', 'revision', 'policyGeneration', 'keyGeneration', 'serviceGeneration'})
    if control['state'] != 'on':
        _fail()
    for key in ('revision', 'policyGeneration', 'keyGeneration', 'serviceGeneration'):
        _integer(control[key], minimum=1)
    # Company admission requires the project-brain authority adapter, not this personal port.
    owner = _exact_keys(p['owner'], {'kind', 'ownerPrincipal'})
    audience = _exact_keys(p['audience'], {'class', 'ownerPrincipal'})
    if (owner['kind'] != 'personal' or audience['class'] not in {'private_owner', 'background_private'}
            or _uuid(owner['ownerPrincipal']) != _uuid(audience['ownerPrincipal'])):
        _fail()
    embedding = p['embedding']
    if type(embedding) is not dict:
        _fail()
    if embedding.get('mode') == 'keyword':
        _exact_keys(embedding, {'mode', 'billable', 'fallback'})
        if embedding['billable'] is not False or embedding['fallback'] != 'keyword':
            _fail()
    else:
        _exact_keys(embedding, {'mode', 'billable', 'meterContract', 'providerRoute', 'dimensions',
                                'payerClass', 'approvedCeilingMicroProtons', 'noticeRevision', 'fallback'})
        if (embedding['mode'] != 'metered' or embedding['billable'] is not True
                or embedding['meterContract'] != 'atum.brain-embedding-meter/2'
                or embedding['providerRoute'] != 'openrouter:baai/bge-m3'
                or type(embedding['dimensions']) is not int or embedding['dimensions'] != 1024
                or embedding['payerClass'] != 'account' or embedding['fallback'] != 'keyword'):
            _fail()
        _integer(embedding['approvedCeilingMicroProtons'], minimum=1, maximum=500_000_000)
        _integer(embedding['noticeRevision'], minimum=1)
    return copy.deepcopy(p)


def unavailable(request, error='service_unavailable'):
    return dict(requestId=request['requestId'], runId=request['binding']['runId'],
                capabilityVersion='atum.awareness/2', status='unavailable', items=[],
                coverage=[], contentBytes=0, errors=[error])


def validate_response(value, request):
    p = _exact_keys(value, {'requestId', 'runId', 'capabilityVersion', 'status', 'items', 'coverage', 'contentBytes'},
                    {'errors'} if type(value) is dict and value.get('status') == 'unavailable' else set())
    binding = request['binding']
    if p['runId'] != binding['runId'] or p['capabilityVersion'] != binding['capabilityVersion']:
        _fail()
    if type(p['items']) is not list:
        _fail()
    # Reuse the v1 evidence/citation/coverage parser, then retain the validated v2 lineage.
    items, lineages = [], []
    for raw in p['items']:
        if type(raw) is not dict or 'lineage' not in raw:
            _fail()
        lineage = _exact_keys(raw['lineage'], {'kind', 'ownerPrincipal', 'sourcePolicyGeneration'})
        if (lineage['kind'] != 'personal' or lineage['ownerPrincipal'] != binding['owner']['ownerPrincipal']
                or _integer(lineage['sourcePolicyGeneration'], minimum=1) != binding['control']['policyGeneration']):
            _fail()
        row = {k: v for k, v in raw.items() if k != 'lineage'}
        items.append(row)
        lineages.append(copy.deepcopy(lineage))
    audience = {'class': binding['audience']['class']}
    legacy_request = {k: copy.deepcopy(v) for k, v in request.items() if k != 'binding'}
    legacy_request.update(audience=audience, agentPrincipal=binding['agentPrincipal'])
    legacy = {k: copy.deepcopy(v) for k, v in p.items() if k not in {'runId', 'capabilityVersion'}}
    legacy.update(audience=audience, items=items)
    parsed = validate_retrieval_response(legacy, legacy_request)
    parsed.pop('audience')
    parsed.update(runId=binding['runId'], capabilityVersion=binding['capabilityVersion'])
    for item, lineage in zip(parsed['items'], lineages):
        if item['source']['kind'] == 'native_memory' and (
                item['source'].get('agentPrincipal') != binding['agentPrincipal']
                or item['citation'].get('agentPrincipal') != binding['agentPrincipal']):
            _fail()
        item['lineage'] = lineage
    return parsed
