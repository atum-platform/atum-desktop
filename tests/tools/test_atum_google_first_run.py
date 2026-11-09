import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tools.atum_google_tool import atum_google_readonly

CAPABILITY = 'c' * 43


@pytest.fixture
def cloud(tmp_path, monkeypatch):
    """The first-run routine's home: its config marker, no Google credential file, a task broker."""
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr('tools.desktop_ui.available', lambda: True)
    from tui_gateway import server
    monkeypatch.setattr(server, '_hermes_home', tmp_path)
    (tmp_path / 'config.yaml').write_text('atum_first_learning: true\ntimezone: Asia/Ho_Chi_Minh\n')
    seen = []

    class Broker(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            seen.append((self.path, self.headers.get('authorization'), body))
            payload = json.dumps({'events': [{'title': 'Review'}]} if body['action'] == 'agenda' else {'threads': []}).encode()
            self.send_response(200)
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    httpd = HTTPServer(('127.0.0.1', 0), Broker)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setenv('ATUM_GOOGLE_TOOLS_URL', f'http://127.0.0.1:{httpd.server_port}')
    monkeypatch.setenv('ATUM_GOOGLE_TOOLS_TOKEN', CAPABILITY)
    try:
        yield tmp_path, seen
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_exact_read_tool_fence_uses_the_task_broker_not_a_credential_file(cloud):
    from tui_gateway.server import _load_enabled_toolsets
    from model_tools import get_tool_definitions
    from tools.registry import invalidate_check_fn_cache
    invalidate_check_fn_cache()
    assert _load_enabled_toolsets() == ['atum_first_learning']
    # The raw catalog, as the first-learning fence reads it (tui_gateway/agent_factory.py); the
    # model-facing list collapses deferred tools behind tool_search.
    schemas = get_tool_definitions(enabled_toolsets=['atum_first_learning'], quiet_mode=True,
                                   skip_tool_search_assembly=True)
    names = {schema['function']['name'] for schema in schemas}
    assert {'read_file', 'search_files', 'memory', 'atum_chats', 'atum_mac', 'atum_google_readonly'} <= names
    google = next(schema for schema in schemas if schema['function']['name'] == 'atum_google_readonly')
    assert google['function']['parameters']['properties']['action']['enum'] == [
        'status', 'agenda', 'waiting', 'search_mail', 'read_thread', 'search_drive', 'read_file']
    assert {'next_7d', 'past_30d', 'past_365d'} <= set(
        google['function']['parameters']['properties']['when']['enum'])
    assert {'sort', 'modifiedAfter'} <= set(google['function']['parameters']['properties'])
    assert 'first sheet only' in google['function']['description']


def test_without_a_task_broker_the_readonly_tool_is_absent(cloud, monkeypatch):
    from model_tools import get_tool_definitions
    from tools.registry import invalidate_check_fn_cache
    monkeypatch.delenv('ATUM_GOOGLE_TOOLS_TOKEN')
    invalidate_check_fn_cache()
    # The controller then refuses before any prompt (tools.show total 0): an honest failure, never a stale token read.
    names = {
        schema['function']['name']
        for schema in get_tool_definitions(enabled_toolsets=['atum_first_learning'], quiet_mode=True,
                                           skip_tool_search_assembly=True)
    }
    assert 'atum_google_readonly' not in names
    assert {'read_file', 'search_files', 'memory', 'atum_chats', 'atum_mac'} <= names
    invalidate_check_fn_cache()


def test_reads_forward_only_closed_requests_and_writes_never_leave(cloud):
    home, seen = cloud
    for action in ['send_email', 'create_event', 'update_event', 'terminal']:
        assert 'error' in json.loads(atum_google_readonly({'action': action}))
    assert seen == []
    agenda = json.loads(atum_google_readonly({'action': 'agenda', 'when': 'today', 'to': ['x@example.test']}))
    assert agenda == {'events': [{'title': 'Review'}]}
    json.loads(atum_google_readonly({'action': 'search_mail', 'query': 'in:inbox is:unread'}))
    json.loads(atum_google_readonly({
        'action': 'search_drive', 'query': 'recent project', 'sort': 'viewed', 'modifiedAfter': '2026-01-01'}))
    assert seen == [
        ('/v1/google', f'Bearer {CAPABILITY}', {'action': 'agenda', 'when': 'today'}),
        ('/v1/google', f'Bearer {CAPABILITY}', {'action': 'search_mail', 'query': 'in:inbox is:unread'}),
        ('/v1/google', f'Bearer {CAPABILITY}', {
            'action': 'search_drive', 'query': 'recent project', 'sort': 'viewed',
            'modifiedAfter': '2026-01-01'}),
    ]
    assert not [p for p in home.iterdir() if p.name.startswith('google_')]


@pytest.mark.parametrize('tool_search', ['on', 'auto'])
def test_first_learning_tools_reach_the_model_directly_under_tool_search(cloud, tool_search):
    """Agents must know their access: the model-facing list carries the three Atum source tools
    themselves, never only behind tool_search/tool_call, and the list is byte-stable across builds
    (prompt caching)."""
    home, _seen = cloud
    (home / 'config.yaml').write_text(
        'atum_first_learning: true\ntimezone: Asia/Ho_Chi_Minh\n'
        f'tools:\n  tool_search:\n    enabled: {tool_search}\n    threshold_pct: 0\n')
    from model_tools import get_tool_definitions
    from tools.registry import invalidate_check_fn_cache
    from tools.tool_search import is_deferrable_tool_name
    invalidate_check_fn_cache()

    first = get_tool_definitions(enabled_toolsets=['atum_first_learning'], quiet_mode=True)
    names = [schema['function']['name'] for schema in first]
    assert {'atum_chats', 'atum_mac', 'atum_google_readonly'} <= set(names)
    for name in ('atum_chats', 'atum_mac', 'atum_google_readonly'):
        assert not is_deferrable_tool_name(name)
    again = get_tool_definitions(enabled_toolsets=['atum_first_learning'], quiet_mode=True)
    assert json.dumps(again, sort_keys=False) == json.dumps(first, sort_keys=False)

    # The pet companion is an Atum core feature too: same never-defer rule, decided by
    # name so the model-facing list stays byte-stable, and still present only when its
    # process handshake offers it. An explicit user defer list naming it still wins.
    pet_first = get_tool_definitions(enabled_toolsets=['pet'], quiet_mode=True)
    pet_names = [schema['function']['name'] for schema in pet_first]
    assert 'pet' in pet_names
    assert not is_deferrable_tool_name('pet')
    assert is_deferrable_tool_name('pet', frozenset({'pet'}))
    pet_again = get_tool_definitions(enabled_toolsets=['pet'], quiet_mode=True)
    assert json.dumps(pet_again, sort_keys=False) == json.dumps(pet_first, sort_keys=False)
    invalidate_check_fn_cache()
