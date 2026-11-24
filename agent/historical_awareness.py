"""Native historical v1 -> v2 adapter; authority is supplied by the owning host.

The transport is authenticated by the host, never selected by a tool payload.
An attestation is required on every response; raw v1 evidence grants no lineage.
"""
import copy

from agent.atum_awareness import AwarenessSessionError
from agent.atum_awareness_contract import validate_retrieval_response
from agent.atum_awareness_v2 import validate_binding, validate_response


class HistoricalAwareness:
    def __init__(self, binding, transport, current):
        self.binding = validate_binding(binding)
        self.transport = transport
        self.current = current

    def __call__(self, request, cancelled):
        if (request.get('binding') != self.binding or cancelled.is_set()
                or self.current() is not True):
            raise AwarenessSessionError()
        legacy = {k: copy.deepcopy(v) for k, v in request.items() if k != 'binding'}
        legacy.update(agentPrincipal=self.binding['agentPrincipal'],
                      audience={'class': self.binding['audience']['class']})
        reply = self.transport(legacy, cancelled)
        if (cancelled.is_set() or self.current() is not True
                or type(reply) is not dict or set(reply) != {'binding', 'response'}
                or reply['binding'] != self.binding):
            raise AwarenessSessionError()
        parsed = validate_retrieval_response(reply['response'], legacy)
        # The authenticated native host attests that its store belongs to this
        # owner and has reconciled THIS policy generation before answering.
        parsed.pop('audience')
        parsed.update(runId=self.binding['runId'], capabilityVersion='atum.awareness/2')
        for item in parsed['items']:
            item['lineage'] = dict(kind='personal', ownerPrincipal=self.binding['owner']['ownerPrincipal'],
                sourcePolicyGeneration=self.binding['control']['policyGeneration'])
        return validate_response(parsed, request)


class UnixHistoricalTransport:
    """Read-only native socket client; path is installed by the trusted host."""
    def __init__(self, socket_path):
        import os
        import stat
        from pathlib import Path
        self.path = Path(socket_path)
        if not self.path.is_absolute():
            raise AwarenessSessionError()
        for path in (self.path.parent, self.path):
            info = path.lstat()
            if (info.st_uid != os.getuid() or info.st_mode & 0o077
                    or stat.S_ISLNK(info.st_mode)):
                raise AwarenessSessionError()
        if not stat.S_ISDIR(self.path.parent.stat().st_mode) or not stat.S_ISSOCK(self.path.stat().st_mode):
            raise AwarenessSessionError()

    def __call__(self, request, cancelled):
        import http.client
        import json
        import socket
        if cancelled.is_set():
            raise AwarenessSessionError()
        connection = http.client.HTTPConnection('localhost', timeout=0.65)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(0.65)
        try:
            try:
                connection.sock.connect(str(self.path))
            except OSError as error:
                import errno
                if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
                    raise ConnectionError('historical_service_unavailable') from None
                raise
            connection.request('POST', '/retrieve', json.dumps(request), {'Content-Type':'application/json'})
            reply = connection.getresponse()
            body = reply.read(65537)
            if reply.status != 200 or len(body) > 65536 or cancelled.is_set():
                raise AwarenessSessionError()
            return json.loads(body)
        finally:
            connection.close()
