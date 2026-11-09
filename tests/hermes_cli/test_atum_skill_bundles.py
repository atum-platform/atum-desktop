"""Filesystem coverage for owner-private Atum skill content bundles."""

import base64
import os

import pytest

from hermes_cli import atum_portability
from hermes_cli.atum_skill_bundles import (
    SkillBundleError,
    export_skill_bundle,
    install_skill_bundle,
    validate_skill_bundle,
)


def _skill(tmp_path):
    skill = tmp_path / "source"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Café skill\n", encoding="utf-8")
    (skill / "references" / "ảnh.bin").write_bytes(b"\x00\xffbinary\n")
    return skill


def test_export_and_install_round_trip_utf8_binary_and_existing_hash(tmp_path):
    source = _skill(tmp_path)
    expected = atum_portability._skill_tree_hash(source)

    bundle = export_skill_bundle(source, expected)

    assert bundle["sha256"] == expected
    assert [file["path"] for file in bundle["files"]] == ["SKILL.md", "references/ảnh.bin"]
    installed = install_skill_bundle(tmp_path / "cache", bundle)
    assert installed == tmp_path / "cache" / expected / "skill"
    assert (installed / "SKILL.md").read_text(encoding="utf-8") == "# Café skill\n"
    assert (installed / "references" / "ảnh.bin").read_bytes() == b"\x00\xffbinary\n"
    assert atum_portability._skill_tree_hash(installed) == expected
    assert (installed / "references" / "ảnh.bin").stat().st_mode & 0o777 == 0o644


@pytest.mark.parametrize("unsafe_path", [
    "../SKILL.md", "nested/../../SKILL.md", ".env", ".env.production",
    "nested/auth.json", "credentials.json", "secrets/private.key", ".git/config", ".ssh/id_rsa",
])
def test_validation_rejects_unsafe_paths_before_install(tmp_path, unsafe_path):
    source = _skill(tmp_path)
    bundle = export_skill_bundle(source)
    bundle["files"][0]["path"] = unsafe_path

    with pytest.raises(SkillBundleError):
        install_skill_bundle(tmp_path / "cache", bundle)


def test_export_rejects_symlink_and_secret_source_without_stripping(tmp_path):
    source = _skill(tmp_path)
    (source / "references" / "linked").symlink_to(source / "SKILL.md")
    with pytest.raises(atum_portability.UnsupportedLocalDefinition, match="symlink"):
        export_skill_bundle(source)

    (source / "references" / "linked").unlink()
    (source / ".env").write_text("TOKEN=nope", encoding="utf-8")
    with pytest.raises(atum_portability.UnsupportedLocalDefinition, match="unsafe"):
        export_skill_bundle(source)


def test_validation_rejects_noncanonical_base64_hash_and_path_order(tmp_path):
    bundle = export_skill_bundle(_skill(tmp_path))
    malformed = {**bundle, "files": [dict(item) for item in bundle["files"]]}
    malformed["files"][0]["content_base64"] += "\n"
    with pytest.raises(SkillBundleError, match="base64"):
        validate_skill_bundle(malformed)

    malformed = {**bundle, "sha256": "0" * 64}
    with pytest.raises(SkillBundleError, match="sha256"):
        validate_skill_bundle(malformed)

    malformed = {**bundle, "files": list(reversed(bundle["files"]))}
    with pytest.raises(SkillBundleError, match="order"):
        validate_skill_bundle(malformed)


def test_install_reuses_exact_cache_entry_and_rejects_a_corrupt_one(tmp_path):
    bundle = export_skill_bundle(_skill(tmp_path))
    cache = tmp_path / "cache"
    first = install_skill_bundle(cache, bundle)
    assert install_skill_bundle(cache, bundle) == first

    corrupt_bundle = dict(bundle)
    corrupt_bundle["sha256"] = "f" * 64
    corrupt = cache / corrupt_bundle["sha256"] / "skill"
    corrupt.mkdir(parents=True)
    (corrupt / "SKILL.md").write_text("wrong", encoding="utf-8")
    # Use a syntactically valid bundle which names this digest; validation
    # reaches the existing tree only after a real digest is supplied.
    corrupt_bundle["files"] = [{
        "path": "SKILL.md",
        "content_base64": base64.b64encode(b"wrong").decode("ascii"),
    }]
    corrupt_bundle["sha256"] = atum_portability._skill_tree_hash(corrupt)
    # Move the valid-looking cache tree to the digest that its bytes claim.
    target = cache / corrupt_bundle["sha256"] / "skill"
    if target != corrupt:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(corrupt, target)
    (target / "SKILL.md").write_text("tampered", encoding="utf-8")
    with pytest.raises(SkillBundleError, match="corrupt"):
        install_skill_bundle(cache, corrupt_bundle)


@pytest.mark.parametrize('name', ['C:escape', 'folder/.. /outside', 'AUX.txt', 'path/trailing.', 'x\u0085y', 'é' * 100 + '/' + 'é' * 60])
def test_bundle_paths_reject_host_aliases_and_use_utf8_byte_budget(name):
    from hermes_cli.atum_skill_bundles import _validate_path
    with pytest.raises(SkillBundleError):
        _validate_path(name)


def test_utf8_path_boundary_matches_platform_and_json_budget(monkeypatch, tmp_path):
    from hermes_cli import atum_skill_bundles as bundles
    accepted = 'é' * 100 + '/' + 'é' * 49 + 'a'
    assert len(accepted.encode('utf-8')) == 300
    assert bundles._validate_path(accepted) == accepted
    with pytest.raises(SkillBundleError):
        bundles._validate_path(accepted + 'a')
    # The explicit serialized cap remains enforced if other limits change.
    monkeypatch.setattr(bundles, 'MAX_JSON_BYTES', 1)
    with pytest.raises(atum_portability.UnsupportedLocalDefinition, match='JSON'):
        export_skill_bundle(_skill(tmp_path))
