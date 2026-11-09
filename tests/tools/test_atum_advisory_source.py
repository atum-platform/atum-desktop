import json
from pathlib import Path

from tools import desktop_ui
from tools.session_search_tool import session_search


def test_real_sql_read_and_vietnamese_projection_survive_existing_tool(monkeypatch):
    fixture = json.loads((Path(__file__).resolve().parents[2] /
        'apps/desktop/contracts/atum-advisory-history-v1/sql-0099-capture.json').read_text())
    for raw in fixture['responses'].values():
        monkeypatch.setattr(desktop_ui, '_request', lambda *args: json.dumps(raw, ensure_ascii=False))
        parsed = json.loads(session_search(session_id=raw['results'][0]['session_id']))
        assert parsed['status'] == 'ok'
        assert parsed['results'] == raw['results']
        assert len(json.dumps(parsed, ensure_ascii=False)) <= 6000


def test_cli_local_profile_search_never_adds_remote_source(monkeypatch, tmp_path):
    from hermes_state import SessionDB
    from tools import session_search_tool
    db = SessionDB(db_path=tmp_path / 'state.db')
    monkeypatch.setattr(desktop_ui, '_request', lambda *args: (_ for _ in ()).throw(AssertionError('remote read attempted')))
    monkeypatch.setattr(session_search_tool, '_resolve_profile_db', lambda profile: db)
    try:
        result = json.loads(session_search(profile='private', db=db))
        assert 'advisory' not in result
    finally:
        db.close()
