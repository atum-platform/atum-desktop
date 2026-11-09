"""Real existing tool -> desktop bridge -> live Matrix gateway projection."""
import json

import pytest

from tools import desktop_ui, open_preview_tool
from tui_gateway import desktop_ui_bridge, server


@pytest.mark.parametrize('source', ['desktop', 'matrix'])
def test_existing_preview_tool_receives_runtime_turn_binding(monkeypatch, tmp_path, source):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_UI_SESSION_ID', 'selected-session')
    monkeypatch.setattr(desktop_ui, '_emit', None)
    monkeypatch.setattr(desktop_ui_bridge, '_wired', False)
    monkeypatch.setattr(server, '_sessions', {
        'selected-session': {'source': source, 'running': True, 'active_turn_id': 'actual-turn'},
    })
    events = []
    monkeypatch.setattr(server, '_emit', lambda *args: events.append(args))
    desktop_ui_bridge.wire()
    result = json.loads(open_preview_tool.open_preview_tool('http://127.0.0.1:12345/preview', 'Fixture'))
    assert result['success'] is True
    assert events == [('preview.open', 'selected-session', {
        'url': 'http://127.0.0.1:12345/preview', 'label': 'Fixture', 'turn_id': 'actual-turn',
    })]


@pytest.mark.parametrize('session', [None, {'source': 'matrix', 'running': False, 'active_turn_id': 'old'},
                                     {'source': 'matrix', 'running': True},
                                     {'source': 'cli', 'running': True, 'active_turn_id': 'other'}])
def test_unbound_preview_has_no_native_turn_authority(monkeypatch, session):
    monkeypatch.setattr(server, '_sessions', {'selected': session} if session else {})
    events = []
    monkeypatch.setattr(server, '_emit', lambda *args: events.append(args))
    desktop_ui_bridge._desktop_ui_emit('selected', 'preview.open', {
        'url': 'https://example.invalid', 'label': 'Fixture', 'turn_id': 'forged',
        'home': '/private/foreign', 'bearer': 'must-not-forward',
    })
    assert events == [('preview.open', 'selected', {'url': 'https://example.invalid', 'label': 'Fixture'})]
