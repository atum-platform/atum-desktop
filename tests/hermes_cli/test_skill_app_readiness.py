"""Readiness is scoped execution evidence, not app or skill-name inference."""
from pathlib import Path
import shutil
import sys

import pytest

from hermes_cli import skill_app_readiness as readiness


def test_alternate_profile_runtime_never_probes_the_host(tmp_path, monkeypatch):
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setattr(readiness, "_local_dependencies", lambda cwd: pytest.fail("host probe for remote runtime"))
    target = readiness.execution_target({"terminal": {"backend": "ssh", "ssh_host": "private-host"}}, tmp_path, "/remote/work")
    assert target["kind"] == "ssh"
    routes = readiness.operation_readiness(target)
    assert all(row["operations"]["read"]["state"] == "unknown" for row in routes.values())
    assert routes["powerpoint"]["operations"]["file-visible"]["state"] == "unknown"
    assert "private-host" not in str(target)


def test_operation_chains_separate_read_edit_create_and_visual_qa(tmp_path, monkeypatch):
    facts = {key: True for key in ("pandoc", "soffice", "pdftoppm", "zip", "unzip", "lxml", "defusedxml", "markitdown", "pptx", "PIL", "openpyxl", "docx")}
    monkeypatch.setattr(readiness, "_local_dependencies", lambda cwd: facts)
    target = {"kind": "local", "cwd": str(tmp_path), "generation": "operations-test", "mismatch": False}
    routes = readiness.operation_readiness(target, vision=True)
    ppt = routes["powerpoint"]["operations"]
    assert ppt["read"]["state"] == ppt["edit"]["state"] == "ready"
    assert ppt["create"] == {"state": "needs-setup", "reasons": ["missing-tool:pptxgenjs"]}
    no_vision = readiness.operation_readiness(target)["powerpoint"]["operations"]
    assert no_vision["read"]["state"] == "ready"
    assert "visual-qa-unverified" in no_vision["edit"]["reasons"]
    assert no_vision["render-qa"]["state"] == "unknown"


def test_xlsx_output_requires_recalculation_even_when_reading_works(tmp_path, monkeypatch):
    monkeypatch.setattr(readiness, "_local_dependencies", lambda cwd: {"openpyxl": True})
    routes = readiness.operation_readiness({"kind": "local", "cwd": str(tmp_path), "generation": "xlsx-test", "mismatch": False})
    xlsx = routes["xlsx"]["operations"]
    assert xlsx["read"]["state"] == "ready"
    assert xlsx["validate"]["state"] == xlsx["edit"]["state"] == "needs-setup"


def test_profile_snapshot_proves_shipped_bytes_and_canonical_command(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    import tools.skills_sync as sync
    bundled = tmp_path / "bundle"
    source = bundled / "productivity" / "powerpoint"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: powerpoint\ndescription: Slides\n---\nRead slides.")
    monkeypatch.setattr(sync, "_get_bundled_dir", lambda: bundled)
    monkeypatch.setattr(readiness, "operation_readiness", lambda target: {
        "docx": {"operations": {}},
        "powerpoint": {"operations": {}},
        "xlsx": {"operations": {}}
    })
    home = tmp_path / "assistant-b"
    installed = home / "skills" / "productivity" / "powerpoint"
    shutil.copytree(source, installed)
    token = set_hermes_home_override(str(home))
    try:
        snapshot = readiness.app_readiness(str(tmp_path))
        assert snapshot["verified_bundled"] == ["powerpoint"]
        assert snapshot["commands"]["powerpoint"] == "/powerpoint"
        assert snapshot["routes"] == {"powerpoint": {"operations": {}}}
        assert str(home) not in str(snapshot)
        duplicate = home / "skills" / "my-slides"
        duplicate.mkdir()
        (duplicate / "SKILL.md").write_text("---\nname: powerpoint\n---\nLocal instructions.")
        assert readiness.app_readiness(str(tmp_path))["verified_bundled"] == []
        shutil.rmtree(duplicate)
        (installed / "SKILL.md").write_text("---\nname: powerpoint\n---\nMy own instructions.")
        assert readiness.app_readiness(str(tmp_path))["verified_bundled"] == []
    finally:
        reset_hermes_home_override(token)


def test_snapshot_omits_office_routes_when_staged_source_has_no_office_skills(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    import tools.skills_sync as sync

    bundled = tmp_path / "bundle"
    (bundled / "productivity" / "nano-pdf").mkdir(parents=True)
    (bundled / "productivity" / "nano-pdf" / "SKILL.md").write_text("---\nname: nano-pdf\n---\n")
    monkeypatch.setattr(sync, "_get_bundled_dir", lambda: bundled)
    monkeypatch.setattr(readiness, "operation_readiness", lambda target: {
        "docx": {"operations": {}},
        "powerpoint": {"operations": {}},
        "xlsx": {"operations": {}}
    })

    token = set_hermes_home_override(str(tmp_path / "assistant"))
    try:
        snapshot = readiness.app_readiness(str(tmp_path))
        assert snapshot["bundled"] == []
        assert snapshot["verified_bundled"] == []
        assert snapshot["routes"] == {}
    finally:
        reset_hermes_home_override(token)


def test_endpoints_scope_add_and_read_to_named_profile(tmp_path, monkeypatch, _isolate_hermes_home):
    from starlette.testclient import TestClient
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles, web_server
    import tools.skills_sync as sync
    home = get_hermes_home()
    other = home / "profiles" / "launcher-test"
    other.mkdir(parents=True)
    (other / "config.yaml").write_text("{}\n")
    (other / ".no-bundled-skills").write_text("keep\n")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: home / "profiles")
    bundle = tmp_path / "bundle"
    source = bundle / "productivity" / "xlsx"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: xlsx\ndescription: Workbooks\n---\nRead spreadsheets.\n")
    monkeypatch.setattr(sync, "_get_bundled_dir", lambda: bundle)
    monkeypatch.setattr(readiness, "operation_readiness", lambda target: {})
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    result = client.post("/api/skills/bundled/add?profile=launcher-test", json={"name": "xlsx"})
    assert result.status_code == 200, result.text
    assert result.json()["ok"]
    assert (other / "skills/productivity/xlsx/SKILL.md").exists()
    assert not (home / "skills/productivity/xlsx/SKILL.md").exists()
    assert (other / ".no-bundled-skills").exists()
    snapshot = client.get("/api/skills/app-readiness?profile=launcher-test").json()
    assert snapshot["commands"]["xlsx"] == "/xlsx"
    assert client.get("/api/skills/app-readiness?profile=missing").status_code == 404
    assert client.post("/api/skills/bundled/add?profile=launcher-test", json={"name": "../xlsx"}).status_code == 404


def test_shipped_skill_verification_ignores_bytecode_but_detects_edits(tmp_path):
    from hermes_cli.skill_app_readiness import _shipped_skill_matches
    source, installed = tmp_path / 'source', tmp_path / 'installed'
    for root in (source, installed):
        root.mkdir()
        (root / 'SKILL.md').write_text('Instructions')
    (installed / '__pycache__').mkdir()
    (installed / '__pycache__' / 'helper.pyc').write_bytes(b'generated by Python')
    assert _shipped_skill_matches(source, installed)
    (installed / 'SKILL.md').write_text('Changed instructions')
    assert not _shipped_skill_matches(source, installed)
    (installed / 'SKILL.md').write_text('Instructions')
    (installed / 'extra.py').write_text('print(1)')
    assert not _shipped_skill_matches(source, installed)


@pytest.mark.parametrize("interpreter", [
    sys.executable,
    pytest.param("/usr/bin/python3", marks=pytest.mark.skipif(not Path("/usr/bin/python3").is_file(), reason="system Python unavailable")),
])
def test_probe_uses_terminal_shell_initialization(tmp_path, monkeypatch, interpreter):
    """Packages exposed by the terminal wrapper must be probed there, not in API Python."""
    import shlex
    from tools.environments import local
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    modules = tmp_path / 'modules'
    modules.mkdir()
    (modules / 'openpyxl.py').write_text('')
    python = bin_dir / 'python'
    python.write_text('#!/bin/sh\nPYTHONPATH=' + shlex.quote(str(modules)) + ' exec ' + shlex.quote(interpreter) + ' "$@"\n')
    python.chmod(0o755)
    init = tmp_path / 'init.sh'
    init.write_text('export PATH=' + shlex.quote(str(bin_dir)) + ':"$PATH"\n')
    monkeypatch.setattr(local, '_resolve_shell_init_files', lambda: [str(init)])
    assert readiness._local_dependencies(str(tmp_path))['openpyxl'] is True


@pytest.mark.parametrize("interpreter", [
    sys.executable,
    pytest.param("/usr/bin/python3", marks=pytest.mark.skipif(not Path("/usr/bin/python3").is_file(), reason="system Python unavailable")),
])
def test_probe_does_not_import_or_discover_python_modules_from_workspace(tmp_path, monkeypatch, interpreter):
    import shlex
    from tools.environments import local
    workspace = tmp_path / 'untrusted-project'
    workspace.mkdir()
    marker = tmp_path / 'executed'
    for name in ('json', 'shutil', 'openpyxl', 'sitecustomize'):
        (workspace / (name + '.py')).write_text(f"from pathlib import Path; Path({str(marker)!r}).touch(); raise RuntimeError('workspace code executed')")
    # Use each real interpreter, including startup, and compare a clean cwd.
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    python = bin_dir / 'python'
    python.write_text('#!/bin/sh\nexec ' + shlex.quote(interpreter) + ' "$@"\n')
    python.chmod(0o755)
    init = tmp_path / 'init.sh'
    init.write_text('unset PYTHONPATH\nexport PATH=' + shlex.quote(str(bin_dir)) + ':"$PATH"\n')
    monkeypatch.setattr(local, '_resolve_shell_init_files', lambda: [str(init)])
    baseline = readiness._local_dependencies(str(tmp_path))
    facts = readiness._local_dependencies(str(workspace))
    assert not marker.exists()
    assert facts['openpyxl'] == baseline['openpyxl']
    assert facts['zip'] == bool(shutil.which('zip'))
