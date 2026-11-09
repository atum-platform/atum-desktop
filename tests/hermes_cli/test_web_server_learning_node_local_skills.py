"""Contract tests for the native learned-skill node API boundary."""

import json

import pytest


SKILL_MD = """---
name: {name}
description: a local test skill
---

# {name}

Do the thing.
"""


def _write_skill(skills_dir, name, content=None):
    skill_dir = skills_dir / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        content or SKILL_MD.format(name=name), encoding="utf-8"
    )
    return skill_dir


@pytest.fixture
def learned_skill_homes(tmp_path, monkeypatch, _isolate_hermes_home):
    """Two profile homes plus all non-local resolver targets."""
    from agent import skill_utils
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    worker_home = default_home / "profiles" / "worker_alpha"
    external_home = tmp_path / "external-skills"
    for home in (default_home, worker_home):
        (home / "skills").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")

    _write_skill(default_home / "skills", "default-local")
    _write_skill(worker_home / "skills", "worker-local")
    _write_skill(worker_home / "skills", "bundled-skill")
    _write_skill(worker_home / "skills", "hub-skill")
    external_skill = _write_skill(external_home, "external-skill")
    direct_folder_target = _write_skill(external_home, "folder-symlink-skill")
    (worker_home / "skills" / "folder-symlink-skill").symlink_to(
        direct_folder_target, target_is_directory=True
    )
    linked_skill = _write_skill(worker_home / "skills", "symlink-skill")
    (linked_skill / "SKILL.md").unlink()
    (linked_skill / "SKILL.md").symlink_to(external_skill / "SKILL.md")

    (worker_home / "skills" / ".bundled_manifest").write_text(
        "bundled-skill:fixture\n", encoding="utf-8"
    )
    hub_dir = worker_home / "skills" / ".hub"
    hub_dir.mkdir()
    (hub_dir / "lock.json").write_text(
        json.dumps({"installed": {"hub-skill": {}}}), encoding="utf-8"
    )
    (worker_home / "config.yaml").write_text(
        "skills:\n  external_dirs:\n    - " + str(external_home) + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: default_home / "profiles")
    skill_utils._external_dirs_cache_clear()
    return {"default": default_home, "worker": worker_home, "external": external_home}


@pytest.fixture
def client(monkeypatch, learned_skill_homes):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    result = TestClient(app)
    result.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return result


def test_local_skill_get_and_put_use_requested_profile_only(client, learned_skill_homes):
    get_response = client.get(
        "/api/learning/node",
        params={"id": "worker-local", "profile": "worker_alpha", "local_skill_only": True},
    )
    assert get_response.status_code == 200
    assert get_response.json()["content"] == SKILL_MD.format(name="worker-local")

    updated = SKILL_MD.format(name="worker-local").replace("Do the thing.", "Worker changed.")
    put_response = client.put(
        "/api/learning/node",
        params={"profile": "worker_alpha", "local_skill_only": True},
        json={"id": "worker-local", "content": updated},
    )
    assert put_response.status_code == 200
    assert "Worker changed." in (
        learned_skill_homes["worker"] / "skills" / "worker-local" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "Worker changed." not in (
        learned_skill_homes["default"] / "skills" / "default-local" / "SKILL.md"
    ).read_text(encoding="utf-8")


def test_unflagged_learning_node_keeps_legacy_external_read(client):
    response = client.get(
        "/api/learning/node",
        params={"id": "external-skill", "profile": "worker_alpha"},
    )
    assert response.status_code == 200
    assert response.json()["id"] == "external-skill"


def test_body_profile_takes_precedence_over_profile_query(client, learned_skill_homes):
    updated = SKILL_MD.format(name="worker-local").replace("Do the thing.", "Body profile wins.")
    response = client.put(
        "/api/learning/node",
        params={"profile": "default", "local_skill_only": True},
        json={"id": "worker-local", "content": updated, "profile": "worker_alpha"},
    )
    assert response.status_code == 200
    assert "Body profile wins." in (
        learned_skill_homes["worker"] / "skills" / "worker-local" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "Body profile wins." not in (
        learned_skill_homes["default"] / "skills" / "default-local" / "SKILL.md"
    ).read_text(encoding="utf-8")


def test_local_skill_delete_honors_profile_query(client, learned_skill_homes):
    response = client.request(
        "DELETE",
        "/api/learning/node",
        params={"profile": "worker_alpha", "local_skill_only": True},
        json={"id": "worker-local"},
    )
    assert response.status_code == 200
    assert not (learned_skill_homes["worker"] / "skills" / "worker-local").exists()
    assert (learned_skill_homes["default"] / "skills" / "default-local").exists()


def test_local_skill_only_rejects_symlinked_skills_root(client, learned_skill_homes):
    worker = learned_skill_homes["worker"]
    original_skills = worker / "skills"
    original_skills.rename(worker / "skills-original")
    original_skills.symlink_to(learned_skill_homes["external"], target_is_directory=True)

    response = client.get(
        "/api/learning/node",
        params={"id": "external-skill", "profile": "worker_alpha", "local_skill_only": True},
    )
    assert response.status_code == 404
    assert "only local skills" in response.json()["detail"]


def test_local_skill_only_rejects_direct_folder_symlink(client, learned_skill_homes):
    symlinked_skill = learned_skill_homes["worker"] / "skills" / "folder-symlink-skill"
    assert symlinked_skill.is_symlink()

    response = client.get(
        "/api/learning/node",
        params={"id": "folder-symlink-skill", "profile": "worker_alpha", "local_skill_only": True},
    )
    assert response.status_code == 404
    assert "only local skills" in response.json()["detail"]


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
def test_local_skill_only_rejects_store_held_access(client, monkeypatch, learned_skill_homes, method):
    from agent import skill_utils

    path = learned_skill_homes["worker"] / "skills" / "worker-local" / "SKILL.md"
    before = path.read_bytes()
    monkeypatch.setattr(skill_utils, "skill_hold", lambda _path: "not-acquired")
    kwargs = {"params": {"profile": "worker_alpha", "local_skill_only": True}}
    if method == "GET":
        kwargs["params"]["id"] = "worker-local"
    else:
        kwargs["json"] = {"id": "worker-local"}
        if method == "PUT":
            kwargs["json"]["content"] = SKILL_MD.format(name="worker-local")
    response = client.request(
        method,
        "/api/learning/node",
        **kwargs,
    )
    assert response.status_code == 403
    assert "Store item" in response.json()["detail"]
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "node_id",
    [
        "memory:memory:0",
        "missing-skill",
        "external-skill",
        "bundled-skill",
        "hub-skill",
        "symlink-skill",
        "folder-symlink-skill",
    ],
)
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_local_skill_only_rejects_non_local_targets(client, node_id, method):
    kwargs = {
        "params": {"profile": "worker_alpha", "local_skill_only": True},
    }
    if method == "get":
        kwargs["params"]["id"] = node_id
    elif method == "put":
        kwargs["json"] = {"id": node_id, "content": SKILL_MD.format(name="worker-local")}
    else:
        kwargs["json"] = {"id": node_id}

    request = client.request if method == "delete" else getattr(client, method)
    if method == "delete":
        response = request("DELETE", "/api/learning/node", **kwargs)
    else:
        response = request("/api/learning/node", **kwargs)
    assert response.status_code in {400, 404}
    assert "only local skills" in response.json()["detail"]
