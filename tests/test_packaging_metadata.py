import re
import tomllib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


def _distribution_name(requirement: str) -> str:
    """Extract the PEP 508 distribution name from a requirement string.

    Robust to markers (``; python_version < '3.12'``), direct references
    (``name @ https://...``), extras (``name[extra]``) and every version
    operator (``==``, ``>=``, ``<=``, ``~=``, ``!=``, ``<``, ``>``), so a
    future dep declared with any valid specifier shape doesn't silently
    mis-parse here.
    """
    spec = requirement.split(";", 1)[0]  # drop environment markers
    spec = spec.split("@", 1)[0]  # drop direct-reference URLs
    spec = spec.split("[", 1)[0]  # drop extras
    spec = re.split(r"[=<>!~]", spec, maxsplit=1)[0]  # drop any version operator
    return spec.strip().lower()


def test_packaging_declared_as_core_dependency():
    """Regression for #40503.

    ``packaging`` is imported directly on three production paths
    (plugins/memory/hindsight/__init__.py, tools/lazy_deps.py,
    hermes_cli/main.py) yet was undeclared, so it only reached users
    transitively. The slim Docker image shipped without it, silently
    disabling Hindsight append-mode and version-constraint checks. It must
    be a declared core dependency so it installs everywhere and the
    update-repair step (``_verify_core_dependencies_installed``) guards it.
    """
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    core = data["project"]["dependencies"]
    names = {_distribution_name(dep) for dep in core}
    assert "packaging" in names, (
        "packaging is imported on production paths (hindsight version compare, "
        "lazy_deps version constraints, requirement parsing) and must be a "
        "declared core dependency, not a transitive — see #40503"
    )


def test_faster_whisper_is_not_a_base_dependency():
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    deps = data["project"]["dependencies"]

    assert not any(dep.startswith("faster-whisper") for dep in deps)

    voice_extra = data["project"]["optional-dependencies"]["voice"]
    assert any(dep.startswith("faster-whisper") for dep in voice_extra)


# Minimum non-vulnerable Starlette: CVE-2026-48710 ("BadHost") was fixed in
# 1.0.1. Anything below that lets a malformed Host header desync
# ``request.url.path`` from the dispatched ASGI path, bypassing path-based
# authz in middleware/endpoints that gate on ``request.url``. 1.3.1 is the
# first release that also fixes GHSA-82w8-qh3p-5jfq (``request.form()`` limits
# silently ignored for urlencoded bodies) and the 1.1.0/1.3.0 advisories.
# Starlette is a transitive dep (fastapi in [web]; sse-starlette/mcp in [mcp]/
# [computer-use]/[dev]) so we pin it directly in every extra that exposes a
# server surface and enforce the floor in both pyproject and the committed
# lockfile.
_STARLETTE_CVE_FLOOR = (1, 3, 1)


def _version_tuple(spec: str) -> tuple[int, ...]:
    # "1.0.1" -> (1, 0, 1); tolerant of pre/post suffixes by truncating.
    head = spec.split("+", 1)[0]
    parts = []
    for chunk in head.split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def test_starlette_pinned_above_cve_2026_48710_floor_in_pyproject():
    """Every extra that declares Starlette must pin a patched (>=1.0.1) version.

    Regression guard for #35067 / CVE-2026-48710. A future edit that drops the
    pin (re-exposing the unbounded transitive ``starlette>=0.27`` from mcp /
    ``>=0.40.0`` from fastapi) or pins a pre-1.0.1 version fails here instead of
    shipping a Host-header auth-bypass to dashboard / MCP-HTTP users.
    """
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    extras = dict(data["project"]["optional-dependencies"])
    extras["dev"] = data["dependency-groups"]["dev"]

    found = {}
    for extra, specs in extras.items():
        for spec in specs:
            name = spec.split("==", 1)[0].split(">", 1)[0].split("<", 1)[0].split("[", 1)[0].strip()
            if name.lower() == "starlette":
                assert "==" in spec, f"[{extra}] must exact-pin starlette, got {spec!r}"
                ver = spec.split("==", 1)[1].split(";", 1)[0].strip()
                found[extra] = ver

    # The four server-surface extras must each carry the direct pin.
    for extra in ("web", "mcp", "computer-use", "dev"):
        assert extra in found, (
            f"[{extra}] no longer pins starlette directly — CVE-2026-48710 "
            f"regression risk (mcp/fastapi pull it transitively with no upper bound)"
        )

    for extra, ver in found.items():
        assert _version_tuple(ver) >= _STARLETTE_CVE_FLOOR, (
            f"[{extra}] pins starlette=={ver}, below the CVE-2026-48710 fix "
            f"floor {'.'.join(map(str, _STARLETTE_CVE_FLOOR))}"
        )


def test_locked_starlette_is_not_vulnerable_to_cve_2026_48710():
    """The committed uv.lock must resolve starlette to a patched version.

    pyproject pins protect the declared extras, but the lockfile is what
    hash-verified installs (``uv sync --locked``) actually pull. Assert the
    resolved version is >= the CVE-2026-48710 fix floor so a stale-lock
    regression can't ship a vulnerable Starlette to users.
    """
    lock = (REPO_ROOT / "uv.lock").read_text(encoding="utf-8")
    versions = []
    in_starlette = False
    for line in lock.splitlines():
        if line.startswith("[[package]]"):
            in_starlette = False
        elif line.strip() == 'name = "starlette"':
            in_starlette = True
        elif in_starlette and line.startswith("version = "):
            versions.append(line.split("=", 1)[1].strip().strip('"'))
            in_starlette = False

    assert versions, "starlette not found in uv.lock"
    for ver in versions:
        assert _version_tuple(ver) >= _STARLETTE_CVE_FLOOR, (
            f"uv.lock resolves starlette=={ver}, below the CVE-2026-48710 fix "
            f"floor {'.'.join(map(str, _STARLETTE_CVE_FLOOR))} — regenerate the "
            f"lockfile after bumping the pin"
        )


# Lowest release of each package that fixes every OSV/GHSA advisory published
# against it as of 2026-10-17 . Most of these are transitive, so
# a direct pin would not protect them; the committed lock is what hash-verified
# installs (the Mac bundle's ``uv export``, the sandbox image's
# ``uv sync --frozen``) actually pull. The floors only ever rise: when a new
# advisory lands, raise the floor, the [tool.uv] constraint and the pin
# together.
_LOCK_ADVISORY_FLOORS = {
    "aiohttp": (3, 14, 3),
    "anyio": (4, 14, 2),  # GHSA-82r6-8w77-94w6: TLSStream IDNA certificate spoofing
    "cbor2": (5, 9, 0),
    "cryptography": (50, 0, 0),
    "fsspec": (2026, 6, 0),  # GHSA-27vj-qcqg-25rc: RCE via ReferenceFileSystem
    "h2": (4, 4, 1),
    "hpack": (4, 2, 0),
    "httplib2": (0, 32, 0),
    "mcp": (1, 30, 0),
    "msgpack": (1, 2, 1),
    "multidict": (6, 9, 1),
    "oauthlib": (4, 0, 0),
    "pillow": (12, 3, 0),
    "pyasn1": (0, 6, 4),
    "pydantic-settings": (2, 14, 2),
    "pygments": (2, 20, 0),
    "pyjwt": (2, 15, 0),
    "pynacl": (1, 6, 2),
    "pytest": (9, 0, 3),
    "python-multipart": (0, 0, 31),
    "setuptools": (83, 0, 0),
    "starlette": (1, 3, 1),
    "tornado": (6, 5, 9),
    "urllib3": (2, 8, 0),
}


def test_locked_versions_meet_advisory_floors():
    """No package in uv.lock may resolve below its advisory-fixed release.

    Regression guard for the 2026-10-17 Python dependency security bump, where
    22 of 235 locked packages carried advisories. A hand edit or an
    ``uv lock --upgrade`` that lets a transitive slide back (for example after
    a vendor loosens a cap) fails here instead of shipping into the Mac bundle
    or the cloud sandbox image.
    """
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    locked: dict[str, list[str]] = {}
    for package in lock["package"]:
        locked.setdefault(_canonical(package["name"]), []).append(package["version"])

    below = []
    for name, floor in sorted(_LOCK_ADVISORY_FLOORS.items()):
        for version in locked.get(name, []):
            if _version_tuple(version) < floor:
                below.append(f"{name}=={version} < {'.'.join(map(str, floor))}")
    assert not below, (
        "uv.lock resolves packages below their advisory-fixed release; raise "
        "the pin or [tool.uv] constraint-dependencies and re-run `uv lock`:\n  "
        + "\n  ".join(below)
    )
    # The guard must keep seeing the packages it protects.
    assert {"anyio", "cryptography", "pillow", "starlette"} <= locked.keys()


# ---------------------------------------------------------------------------
# Dependency-pin consistency: pyproject extras <-> tools/lazy_deps.py
#
# The same package is exact-pinned in two hand-maintained places: the
# [project.optional-dependencies] extras in pyproject.toml and the LAZY_DEPS
# allowlist in tools/lazy_deps.py (the lazy-install path deliberately mirrors
# the extras — see the comments on LAZY_DEPS: "match the corresponding extra
# in pyproject.toml ... update both this map AND the corresponding extra").
#
# They have silently drifted more than once: the aiohttp Slack pin (3.13.3 in
# the extras vs 3.13.4 in lazy_deps) and the anthropic pin (0.86.0 vs 0.87.0).
# The version a user ends up with then depends on whether the backend was
# installed eagerly (extra) or lazily (lazy_deps) — and for a CVE bump applied
# to only one side, that divergence is a latent security regression. These two
# tests assert the documented contract: the two sources agree, in lockstep.
# ---------------------------------------------------------------------------

# Matches "name==version" and "name[extra]==version", ignoring any trailing
# environment marker / comment. Only exact pins are collected; ranged specs
# (">=", "<") can't be compared for equality and are skipped.
_PIN_RE = re.compile(
    r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;,#]+)"
)


def _canonical(name: str) -> str:
    # PEP 503 normalization so e.g. discord.py / discord-py compare equal.
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins_from_specs(specs):
    """Map canonical package name -> set of exact-pinned versions seen."""
    pins: dict[str, set[str]] = {}
    for spec in specs:
        m = _PIN_RE.match(spec)
        if not m:
            continue
        pins.setdefault(_canonical(m.group(1)), set()).add(m.group(2))
    return pins


def _pyproject_pinned_specs():
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    specs = list(data["project"].get("dependencies", []))
    for extra in data["project"].get("optional-dependencies", {}).values():
        specs.extend(extra)
    return specs


def _lazy_deps_pinned_specs():
    """Read the public lazy-dependency registry through its runtime module."""
    from tools.lazy_deps import LAZY_DEPS

    specs = [spec for feature_specs in LAZY_DEPS.values() for spec in feature_specs]
    assert specs, "LAZY_DEPS must contain dependency specs"
    return specs


def test_pyproject_pins_are_internally_consistent():
    """No package may be exact-pinned to two different versions in pyproject.

    A package legitimately appearing in several extras (e.g. aiohttp in
    messaging/slack/homeassistant/sms) must use the SAME version everywhere.
    """
    pins = _pins_from_specs(_pyproject_pinned_specs())
    conflicts = {name: sorted(v) for name, v in pins.items() if len(v) > 1}
    assert not conflicts, (
        "pyproject.toml exact-pins the same package to different versions "
        "across [project.dependencies] / extras: " + str(conflicts)
    )


@pytest.mark.skip(reason="v0.22.5 PM owns dependency preparation; the removed lazy map is not shipped")
def test_pyproject_and_lazy_deps_pins_agree():
    """Every package pinned in BOTH places must use the same version.

    Regression guard for the aiohttp / anthropic extras-vs-lazy drift:
    tools/lazy_deps.py mirrors the pyproject extras, so a CVE bump applied to
    one and not the other leaves users on a vulnerable version depending on
    the install path. Bump both in lockstep.
    """
    py = _pins_from_specs(_pyproject_pinned_specs())
    lazy = _pins_from_specs(_lazy_deps_pinned_specs())

    mismatches = [
        f"{name}: pyproject={sorted(py[name])} lazy_deps={sorted(lazy[name])}"
        for name in sorted(set(py) & set(lazy))
        if py[name] != lazy[name]
    ]
    assert not mismatches, (
        "pyproject.toml extras and tools/lazy_deps.py disagree on the pinned "
        "version of the same package — bump both in lockstep:\n  "
        + "\n  ".join(mismatches)
    )


def _lazy_deps_by_feature():
    """Return the public lazy-dependency registry grouped by feature."""
    from tools.lazy_deps import LAZY_DEPS

    return {name: list(specs) for name, specs in LAZY_DEPS.items()}


# Security-critical packages whose patched floor must be enforced on EVERY
# install path, eager and lazy. test_pyproject_and_lazy_deps_pins_agree only
# fires when a package is pinned in BOTH sources, so it cannot catch a lazy
# feature that omits the pin entirely — the exact gap that left platform.slack
# carrying aiohttp==3.14.0 while platform.discord (whose discord.py dep pulls
# aiohttp transitively as its HTTP backbone) shipped without it, so the lazy
# Discord path could keep an already-installed vulnerable aiohttp. A fully
# general "no mirrored feature drops a pin" check is impossible statically
# (it can't see transitive deps), so this is the explicit coverage contract:
# each security package -> the lazy features that bundle an SDK pulling it and
# must therefore carry the same pin as the pyproject extra.
_REQUIRED_SECURITY_PINS = {
    # Every lazy messaging feature whose SDK pulls aiohttp transitively must
    # carry the patched floor directly: discord.py (aiohttp<4), slack-bolt,
    # mautrix/aiohttp-socks (aiohttp<4 / >=3.10), and microsoft-teams-apps —
    # none of those upper/lower bounds excludes a vulnerable already-installed
    # aiohttp, so the lazy path would not upgrade it without an explicit pin.
    "aiohttp": {
        "platform.discord",
        "platform.slack",
        "platform.matrix",
        "platform.teams",
    },
}


@pytest.mark.skip(reason="v0.22.5 PM owns dependency preparation; the removed lazy map is not shipped")
def test_security_pins_present_in_mirrored_lazy_features():
    """Curated security pins must be present (not just version-consistent) in
    every lazy feature that bundles an SDK pulling that package transitively.
    """
    py = _pins_from_specs(_pyproject_pinned_specs())
    by_feature = _lazy_deps_by_feature()

    problems = []
    for pkg, features in _REQUIRED_SECURITY_PINS.items():
        canon = _canonical(pkg)
        expected = py.get(canon)
        assert expected, (
            f"{pkg} is listed in _REQUIRED_SECURITY_PINS but is not exact-pinned "
            f"in pyproject.toml — update the map or the pin."
        )
        for feature in sorted(features):
            specs = by_feature.get(feature)
            assert specs is not None, (
                f"lazy feature {feature!r} named in _REQUIRED_SECURITY_PINS no "
                f"longer exists in LAZY_DEPS — update the map."
            )
            got = _pins_from_specs(specs).get(canon)
            if got != expected:
                problems.append(
                    f"{feature}: {pkg}="
                    f"{sorted(got) if got else 'MISSING'}, expected {sorted(expected)}"
                )
    assert not problems, (
        "a lazy feature is missing a security pin it must mirror from the "
        "pyproject extras — the lazy install path would not enforce the "
        "CVE-patched floor:\n  " + "\n  ".join(problems)
    )


def _spec_floor(spec: str):
    """(canonical name, lowest allowed version tuple) of a ``name>=X,<Y`` spec."""
    m = re.match(r"^([A-Za-z0-9_.\-]+)>=([0-9][0-9.]*)", spec)
    assert m, f"spec has no >= floor: {spec!r}"
    return _canonical(m.group(1)), _version_tuple(m.group(2))


def _lazy_deps_tuple(name: str):
    """Read a module-level dependency tuple from the runtime module."""
    from tools import lazy_deps

    return tuple(getattr(lazy_deps, name))


@pytest.mark.skip(reason="v0.22.5 PM owns dependency preparation; the removed lazy map is not shipped")
def test_lazy_install_specs_meet_advisory_floors():
    """Lazy installs must enforce the same advisory floors as the lock.

    ``[tool.uv]`` constraint/override tables only govern ``uv lock`` and
    ``uv sync``; a lazy install runs ``uv pip install`` from the backend's
    working directory (the user's workspace in the Mac app) and resolves from
    PyPI. tools/lazy_deps.py therefore carries its own copies, which must
    (a) equal the pyproject tables and (b) never sit below the advisory-fixed
    release in ``_LOCK_ADVISORY_FLOORS``. Covers fsspec, h2, hpack, msgpack
    and cbor2, which only arrive through lazily installed features, and the
    pynacl override that lifts discord.py's ``PyNaCl<1.6`` cap.
    """
    uv_cfg = tomllib.loads(
        (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )["tool"]["uv"]

    constraints = _lazy_deps_tuple("_LAZY_FLOOR_CONSTRAINTS")
    overrides = _lazy_deps_tuple("_LAZY_OVERRIDES")
    assert sorted(constraints) == sorted(uv_cfg["constraint-dependencies"]), (
        "tools/lazy_deps.py _LAZY_FLOOR_CONSTRAINTS drifted from pyproject.toml"
    )
    assert sorted(overrides) == sorted(uv_cfg["override-dependencies"]), (
        "tools/lazy_deps.py _LAZY_OVERRIDES drifted from pyproject.toml"
    )

    below = []
    covered = set()
    for spec in (*constraints, *overrides):
        name, floor = _spec_floor(spec)
        covered.add(name)
        advisory = _LOCK_ADVISORY_FLOORS.get(name)
        if advisory is not None and floor < advisory:
            below.append(f"{spec} < {'.'.join(map(str, advisory))}")
    assert not below, "lazy install floors below the advisory fix:\n  " + "\n  ".join(below)

    # Every package that is lazily reachable but not in the Mac bundle.
    assert {"fsspec", "h2", "hpack", "msgpack", "cbor2", "pynacl"} <= covered
"""Independent core/optional dependency and reviewed CVE policies."""
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_test_dependencies_are_group_only_in_manifest_and_lock():
    manifest = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    hermes = next(package for package in lock["package"] if package["name"] == manifest["project"]["name"])
    assert manifest["tool"]["uv"]["default-groups"] == []
    assert "dev" in manifest["dependency-groups"]
    assert "dev" not in manifest["project"]["optional-dependencies"]
    assert "dev" in hermes["dev-dependencies"]
    assert "dev" not in hermes.get("optional-dependencies", {})


def test_core_and_optional_speech_dependencies():
    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    core = {Requirement(dep).name for dep in project["dependencies"]}
    assert "packaging" in core  # Runtime code imports it directly, not transitively.
    assert "faster-whisper" not in core
    assert "faster-whisper" in {
        Requirement(dep).name for dep in project["optional-dependencies"]["stt-whisper"]
    }


def test_starlette_server_pins_and_lock_exclude_cve_2026_48710():
    # BadHost's reviewed fixed boundary is independent of today's exact pin.
    floor = Version("1.0.1")
    metadata = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    found = set()
    for extra, specs in metadata["project"]["optional-dependencies"].items():
        for requirement in map(Requirement, specs):
            if requirement.name != "starlette":
                continue
            pins = list(requirement.specifier)
            assert len(pins) == 1 and pins[0].operator == "==", (extra, requirement)
            assert Version(pins[0].version) >= floor, (extra, requirement)
            found.add(extra)
    assert {"web", "mcp", "computer-use"} <= found
    dev = [req for req in map(Requirement, metadata["dependency-groups"]["dev"])
           if req.name == "starlette"]
    assert len(dev) == 1
    pins = list(dev[0].specifier)
    assert len(pins) == 1 and pins[0].operator == "==" and Version(pins[0].version) >= floor
    versions = [Version(row["version"]) for row in lock["package"] if row["name"] == "starlette"]
    assert versions and all(version >= floor for version in versions)


CA_TRUST_PACKAGES = {"certifi"}


def test_every_dependency_is_held_to_one_three_day_release_age():
    """Hermes's deps must be >= 3 days old when locked, exact pins included (Teknium ruling).

    A per-package exemption or date would quietly let a fresh release into the lock; the
    check runs at lock time only, so users never need a mirror that serves upload times.
    The sole exception is CA trust stores: a CA revocation must ship the day it is released.
    """
    manifest = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    uv = manifest["tool"]["uv"]
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    assert uv["exclude-newer"] == "3 days"
    exempt = uv.get("exclude-newer-package", {})
    assert set(exempt) <= CA_TRUST_PACKAGES, exempt
    assert all(value is False for value in exempt.values()), exempt
    assert lock["options"].get("exclude-newer-span") == "P3D"
    assert lock["options"].get("exclude-newer-package", {}) == exempt


def test_httpx2_pins_and_lock_exclude_ghsa_7mj9_2mp8_4m2p_family():
    # 2.12.0 is the first httpx2/httpcore2 release clear of GHSA-7mj9-2mp8-4m2p,
    # GHSA-f2fp-rgf2-35cp, GHSA-h4x7-gw46-3wm6, GHSA-pf96-p4fj-6566 and
    # GHSA-8xx6-hgc6-gc2m; the boundary is independent of today's exact pin.
    floor = Version("2.12.0")
    metadata = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    declared = dict(metadata["project"]["optional-dependencies"])
    declared["group:dev"] = metadata["dependency-groups"]["dev"]
    found = set()
    for where, specs in declared.items():
        for requirement in map(Requirement, specs):
            if requirement.name != "httpx2":
                continue
            pins = list(requirement.specifier)
            assert len(pins) == 1 and pins[0].operator == "==", (where, requirement)
            assert Version(pins[0].version) >= floor, (where, requirement)
            found.add(where)
    assert {"mcp", "computer-use", "group:dev"} <= found
    for name in ("httpx2", "httpcore2"):
        versions = [Version(row["version"]) for row in lock["package"] if row["name"] == name]
        assert versions and all(version >= floor for version in versions), (name, versions)
