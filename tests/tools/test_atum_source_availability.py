"""Host tool advertisement is process-scoped, not execution-context-scoped."""
import json

import pytest


@pytest.mark.parametrize('bound_first', [False, True])
def test_host_tool_catalog_stays_fixed_without_an_active_binding(monkeypatch, bound_first):
    import model_tools
    from tools import atum_source_transport as host, atum_google_tool as google, atum_chats_tool as chats
    # Simulate the trusted plugin's startup, before the first catalog is built.
    monkeypatch.setattr(host, '_host_transport_enabled', False, raising=False)
    monkeypatch.delenv(google.URL_ENV, raising=False)
    monkeypatch.delenv(google.TOKEN_ENV, raising=False)
    monkeypatch.setattr(chats.desktop_ui, 'available', lambda: False)
    monkeypatch.setattr(chats.desktop_ui, 'request', lambda *a, **k: pytest.fail('unbound host fell back to desktop'))
    host.enable_source_transport()
    def catalog():
        return model_tools.get_tool_definitions(enabled_toolsets=['atum_google', 'atum_chats'],
            quiet_mode=True, skip_tool_search_assembly=True)
    if bound_first:
        with host.bind_source_transport(lambda *a: {'ok': True}):
            first = catalog()
    else:
        first = catalog()
    assert {t['function']['name'] for t in first} >= {'atum_google', 'atum_chats'}
    with host.bind_source_transport(lambda *a: {'ok': True}):
        assert catalog() == first
        assert model_tools.get_tool_definitions(enabled_toolsets=['atum_google', 'atum_chats'],
            quiet_mode=False, skip_tool_search_assembly=True) == first
    assert catalog() == first
    assert google.available() and chats.available()
    assert 'available' in json.loads(google.atum_google({'action': 'agenda'}))['error']
    assert json.loads(chats.atum_chats('list'))['error'] == 'Owner chats are unavailable for this run.'
