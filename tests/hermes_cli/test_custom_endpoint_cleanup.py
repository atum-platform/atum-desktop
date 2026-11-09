"""Offline named-endpoint cleanup, with real isolated profile files."""
import json

import pytest
import yaml

from hermes_cli.credential_lifecycle import remove_custom_endpoint_credentials


@pytest.fixture
def profile(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = {
        "providers": {"matrix-local": {"api_key": "fixture-secret"}, "other": {"api_key": "keep"}},
        "model": {"provider": "matrix-local", "base_url": "https://model.test", "api_key": "fixture-secret", "api": "legacy", "default": "model"},
        "terminal": {"backend": "local"},
    }
    auth = {
        "providers": {"oauth": {"access_token": "keep-oauth"}},
        "credential_pool": {"custom:local-executor-model": [{"access_token": "older-fixture-secret"}], "other": [{"access_token": "keep"}]},
        "suppressed_sources": {"custom:local-executor-model": ["config:Local executor model"], "other": ["keep"]},
    }
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(config))
    (tmp_path / "auth.json").write_text(json.dumps(auth))
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "work.txt").write_text("retained work")
    (tmp_path / "state.db").write_bytes(b"retained history")
    return tmp_path


def clean():
    remove_custom_endpoint_credentials("matrix-local", "Local executor model")


def test_pool_identity_uses_hermes_slug_of_the_setup_display_name(profile):
    from hermes_cli.providers import custom_provider_slug
    name = "A changed model name"
    pool_key = custom_provider_slug(name)
    auth = json.loads((profile / "auth.json").read_text())
    auth["credential_pool"][pool_key] = auth["credential_pool"].pop("custom:local-executor-model")
    auth["suppressed_sources"][pool_key] = auth["suppressed_sources"].pop("custom:local-executor-model")
    (profile / "auth.json").write_text(json.dumps(auth))
    remove_custom_endpoint_credentials("matrix-local", name)
    result = json.loads((profile / "auth.json").read_text())
    assert pool_key not in result["credential_pool"]
    assert pool_key not in result["suppressed_sources"]


def test_removes_config_mirrors_and_exact_pool_without_touching_work_or_other_auth(profile):
    clean()
    clean()
    config = yaml.safe_load((profile / "config.yaml").read_text())
    auth = json.loads((profile / "auth.json").read_text())
    assert config == {"providers": {"other": {"api_key": "keep"}}, "model": {"default": "model"}, "terminal": {"backend": "local"}}
    assert auth["credential_pool"] == {"other": [{"access_token": "keep"}]}
    assert auth["suppressed_sources"] == {"other": ["keep"]}
    assert auth["providers"] == {"oauth": {"access_token": "keep-oauth"}}
    assert (profile / "workspace" / "work.txt").read_text() == "retained work"
    assert (profile / "state.db").read_bytes() == b"retained history"


@pytest.mark.parametrize(("filename", "broken"), [
    ("config.yaml", "providers: ["), ("config.yaml", "null"),
    ("config.yaml", "providers: []"), ("auth.json", "{"),
    ("auth.json", "[]"), ("auth.json", '{"credential_pool": []}'),
])
def test_corruption_fails_closed_without_overwriting_or_quarantining_either_store(profile, filename, broken):
    (profile / filename).write_text(broken)
    before = {p.name: p.read_bytes() for p in profile.iterdir() if p.is_file()}
    with pytest.raises(RuntimeError, match="^custom_endpoint_cleanup_failed$"):
        clean()
    assert {p.name: p.read_bytes() for p in profile.iterdir() if p.is_file() and p.suffix != ".lock"} == before


def test_interrupted_second_write_can_retry_after_endpoint_was_removed(profile, monkeypatch):
    import hermes_cli.auth as auth
    original = auth._save_auth_store
    monkeypatch.setattr(auth, "_save_auth_store", lambda *_: (_ for _ in ()).throw(OSError("private contents")))
    with pytest.raises(RuntimeError, match="^custom_endpoint_cleanup_failed$"):
        clean()
    assert "matrix-local" not in yaml.safe_load((profile / "config.yaml").read_text())["providers"]
    assert "custom:local-executor-model" in json.loads((profile / "auth.json").read_text())["credential_pool"]
    monkeypatch.setattr(auth, "_save_auth_store", original)
    clean()
    assert "custom:local-executor-model" not in json.loads((profile / "auth.json").read_text())["credential_pool"]


def test_missing_files_are_idempotent_and_dangling_model_mirror_is_removed(profile):
    config = yaml.safe_load((profile / "config.yaml").read_text())
    del config["providers"]["matrix-local"]
    (profile / "config.yaml").write_text(yaml.safe_dump(config))
    clean()
    assert yaml.safe_load((profile / "config.yaml").read_text())["model"] == {"default": "model"}
    (profile / "config.yaml").unlink()
    (profile / "auth.json").unlink()
    clean()
    assert not (profile / "config.yaml").exists()
    assert not (profile / "auth.json").exists()
