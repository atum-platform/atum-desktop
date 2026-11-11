"""Controller-owned memory bridge, fixed before agent construction.

Only the isolated Matrix stdio controller can install a binding. The controller
answers events during a submitted turn, so construction checks the native ledger
and admission shape, then every inference/recall checkpoint checks live authority.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

from agent.atum_awareness import AwarenessSessionError
from agent.atum_awareness_v2 import validate_binding
from agent.memory_run_lifecycle import MemoryRunLifecycle, bind_cloud_memory


def admission(params, transport, stdio):
    value = params.get('managed_memory')
    if value is None:
        return None
    if (transport is not stdio or params.get('source') != 'matrix'
            or params.get('async_delivery') is not False
            or any(params.get(k) for k in ('shared_room', 'reply_only', 'first_learning', 'parent_session_id'))
            or not isinstance(value, dict) or set(value) != {'binding'}):
        raise ValueError('memory_binding_invalid')
    try:
        return validate_binding(value['binding'])
    except Exception:
        raise ValueError('memory_binding_invalid') from None


def echo(session):
    binding = session.get('_managed_memory_binding')
    return ({'managed_memory': {'run_id': binding['runId'], 'session_id': binding['sessionId']}}
            if binding else {})


class ControllerMemoryBridge:
    def __init__(self, session, sid):
        self.session = session
        self.sid = sid
        self.lock = threading.Lock()
        self.pending = {}
        self.constructing = True

    def live(self):
        from tui_gateway import server
        with server._sessions_lock:
            return (server._sessions.get(self.sid) is self.session
                    and not self.session.get('_closing')
                    and not self.session.get('_turn_cancel_requested'))

    def request(self, kind, request=None, cancelled=None):
        from tui_gateway import server
        if not self.live() or (cancelled is not None and cancelled.is_set()):
            raise AwarenessSessionError()
        request_id = 'memory-' + str(uuid.uuid4())
        event = threading.Event()
        slot = {'event': event, 'kind': kind, 'result': None}
        with self.lock:
            self.pending[request_id] = slot
        try:
            payload = {'request_id': request_id, 'request': request}
            if kind == 'retrieve':
                server._emit("atum.memory.retrieve.request", self.sid, payload)
            elif kind == 'current':
                server._emit("atum.memory.current.request", self.sid, payload)
            else:
                server._emit("atum.memory.invalidate.request", self.sid, payload)
            deadline = time.monotonic() + (0.75 if kind == 'retrieve' else 2.0)
            while not event.wait(0.02):
                if (time.monotonic() >= deadline or not self.live()
                        or (cancelled is not None and cancelled.is_set())):
                    raise AwarenessSessionError()
            result = slot['result']
            if not isinstance(result, dict) or result.get('ok') is not True:
                raise AwarenessSessionError()
            return result
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def respond(self, kind, request_id, raw):
        if (not isinstance(request_id, str) or not isinstance(raw, str)
                or len(raw.encode('utf-8')) > 65536):
            return False
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            return False
        if not isinstance(value, dict):
            return False
        valid = (value.get('ok') is False and set(value) == {'ok', 'error'}
                 and value.get('error') in ('fresh_session_required', 'unavailable'))
        if value.get('ok') is True:
            valid = ((kind == 'current' and set(value) == {'ok', 'current'} and type(value['current']) is bool)
                     or (kind == 'invalidate' and set(value) == {'ok'})
                     or (kind == 'retrieve' and set(value) == {'ok', 'response'} and isinstance(value['response'], dict)))
        if not valid:
            return False
        with self.lock:
            slot = self.pending.get(request_id)
            if slot is None or slot['kind'] != kind or slot['event'].is_set():
                return False
            slot['result'] = value
            slot['event'].set()
        return True

    def current(self):
        if not self.live():
            return False
        if self.constructing:
            return True
        return self.request('current')['current'] is True

    def retrieve(self, request, cancelled):
        return self.request('retrieve', request, cancelled)['response']

    def invalidate(self):
        try:
            self.request('invalidate')
        finally:
            self.session['_turn_cancel_requested'] = True
            agent = self.session.get('agent')
            if agent is not None:
                agent.interrupt('memory_fresh_session_required')


def build_cloud_memory(session, sid, session_id, db):
    from hermes_constants import get_hermes_home
    binding = session['_managed_memory_binding']
    if session_id != binding['sessionId'] or session.get('_managed_memory_bridge') is not None:
        raise AwarenessSessionError()
    bridge = ControllerMemoryBridge(session, sid)
    session['_managed_memory_bridge'] = bridge
    try:
        return bind_cloud_memory(
            binding=binding, hermes_home=str(Path(session.get('profile_home') or get_hermes_home())),
            lifecycle=MemoryRunLifecycle(db), retrieve=bridge.retrieve,
            is_current=bridge.current, invalidate_run=bridge.invalidate, enabled=True)
    finally:
        bridge.constructing = False
