"""Real selected-home graph reads: topology, Unicode and read-only custody."""
import json

import pytest


@pytest.fixture
def starmap_client(monkeypatch, _isolate_hermes_home):
    from hermes_cli import profiles, web_server
    from hermes_constants import get_hermes_home
    from starlette.testclient import TestClient

    home = get_hermes_home()
    other = home / "profiles" / "worker_beta"
    for root, marker in [(home, "selected"), (other, "other")]:
        root.mkdir(parents=True, exist_ok=True)
        (root / "config.yaml").write_text("memory:\n  enabled: true\n", encoding="utf-8")
        (root / ".env").write_text("FIXTURE_TOKEN=fixture\n", encoding="utf-8")
        skills = root / "skills"
        for name, related in [(f"{marker}-writing", f"{marker}-research"), (f"{marker}-research", f"{marker}-writing")]:
            skill = skills / name
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(f"---\nname: {name}\ncategory: work\nrelated_skills: [{related}]\n---\nFixture skill body", encoding="utf-8")
        (skills / ".usage.json").write_text(json.dumps({f"{marker}-writing": {"created_by": "agent", "use_count": 2}, f"{marker}-research": {"created_by": "agent", "use_count": 1}}), encoding="utf-8")
        memories = root / "memories"
        memories.mkdir(exist_ok=True)
        (memories / "MEMORY.md").write_text("🧠" * 1300 + f"\n{marker} research\n§\n{marker} writing", encoding="utf-8")
        (memories / "USER.md").write_text(f"{marker} owner writing", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: home / "profiles")
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, home, other


@pytest.mark.parametrize("profile,marker", [("default", "selected"), ("worker_beta", "other")])
def test_graph_real_reads_preserve_topology_global_memory_indices_and_both_homes(starmap_client, profile, marker):
    client, home, other = starmap_client
    tracked = [
        path
        for root in (home, other)
        for path in root.rglob("*")
        if path.is_file() and "logs" not in path.relative_to(root).parts
    ]
    before = {p: p.read_bytes() for p in tracked}
    response = client.get(f"/api/learning/graph?profile={profile}")
    assert response.status_code == 200
    graph = response.json()
    nodes = {n["id"]: n for n in graph["nodes"]}
    skills = {n["id"] for n in graph["nodes"] if n["kind"] == "skill"}
    assert skills == {f"{marker}-writing", f"{marker}-research"}
    assert len(graph["memory"]) == 3
    assert graph["memory"][0]["body"] == "🧠" * 1200
    assert graph["memory"][0]["title"] == "🧠" * 80 + "…"
    memory_ids = []
    for i, card in enumerate(graph["memory"]):
        node_id, node = next(
            (key, value)
            for key, value in nodes.items()
            if key.startswith(f"memory:{card['source']}:{i}:")
        )
        memory_ids.append(node_id)
        assert node["memorySource"] == card["source"]
    assert all(edge["source"] in nodes and edge["target"] in nodes for edge in graph["edges"])
    assert {
        (memory_ids[1], f"{marker}-writing"),
        (memory_ids[2], f"{marker}-writing"),
    } <= {(edge["source"], edge["target"]) for edge in graph["edges"]}
    assert {p: p.read_bytes() for p in tracked} == before
    assert graph["stats"]["learned_skills"] == len(skills)
