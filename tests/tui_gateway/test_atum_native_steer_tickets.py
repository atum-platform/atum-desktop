"""Managed steer receipts use Hermes's native tickets, not a second input queue."""
import threading

from agent.interrupt_control import InterruptControlMixin
from tui_gateway import server


class NativeAgent(InterruptControlMixin):
    pass


def test_reserved_steer_is_idempotent_and_reports_only_unread_tickets(monkeypatch):
    actor = NativeAgent()
    session = {'agent': actor, 'session_key': 'synthetic-steer', 'history': [],
               'history_lock': threading.Lock(), 'running': True}
    monkeypatch.setitem(server._sessions, 'synthetic-steer', session)
    first = '00000000-0000-4000-8000-676a3a34ff0f'
    second = '00000000-0000-4000-8000-47942475323f'

    def steer(ticket, text):
        return server.handle_request({'id': ticket, 'method': 'session.steer',
                                      'params': {'session_id': 'synthetic-steer', 'text': text, 'steer_id': ticket}})

    assert steer(first, 'Inspect audit')['result']['steer_id'] == first
    assert steer(first, 'Inspect audit')['result']['status'] == 'queued'
    assert actor._drain_pending_steer() == 'Inspect audit'
    assert steer(first, 'Changed text')['error']['code'] == 4002
    assert steer(second, 'Inspect receipts')['result']['status'] == 'queued'
    assert server._settle_atum_steer_tickets(session, actor) == [second]
    assert actor._drain_pending_steer() is None
    assert steer(second, 'Inspect receipts')['result']['status'] == 'rejected'
    assert actor._drain_pending_steer() is None
    server._sessions.pop('synthetic-steer', None)
