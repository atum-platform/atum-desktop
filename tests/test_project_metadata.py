"""Regression tests for packaging metadata in pyproject.toml."""

from pathlib import Path
import tomllib

from packaging.requirements import Requirement

REPO_ROOT = Path(__file__).resolve().parents[1]

def _load_optional_dependencies():
    pyproject_path = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with pyproject_path.open("rb") as handle:
        project = tomllib.load(handle)["project"]
    return project["optional-dependencies"]


def test_wake_dependencies_and_runtime_gate_agree_on_supported_targets():
    from packaging.markers import Marker, default_environment
    from packaging.requirements import Requirement

    root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8-sig"))
    optional = metadata["project"]["optional-dependencies"]
    gates = metadata["tool"]["hermes"]["extras-platforms"]
    targets = [
        ("darwin", "Darwin", "x86_64", False),
        ("darwin", "Darwin", "arm64", True),
        ("linux", "Linux", "x86_64", True),
        ("linux", "Linux", "aarch64", True),
        ("win32", "Windows", "AMD64", True),
        ("win32", "Windows", "ARM64", False),
    ]
    for system, platform_system, machine, supported in targets:
        environment = {**default_environment(), "sys_platform": system,
                       "platform_system": platform_system, "platform_machine": machine}
        for extra in ("wake", "wake-openwakeword"):
            requirement = next(req for spec in optional[extra]
                               if (req := Requirement(spec)).name == "pyopen-wakeword")
            assert requirement.marker.evaluate(environment) is supported, (extra, system, machine)
        assert Marker(gates["wake-openwakeword"]).evaluate(environment) is supported
        selected = {req.name for spec in optional["wake"]
                    if (req := Requirement(spec)).marker is None or req.marker.evaluate(environment)}
        assert {"sherpa-onnx", "pvporcupine", "sentencepiece", "pypinyin"} <= selected
        sherpa_deps = {req.name for spec in optional["wake-sherpa"]
                       if (req := Requirement(spec)).marker is None or req.marker.evaluate(environment)}
        assert {"sherpa-onnx", "sentencepiece", "pypinyin"} <= sherpa_deps
        for extra in ("wake-sherpa", "wake-porcupine"):
            assert all(req.marker is None or req.marker.evaluate(environment)
                       for req in map(Requirement, optional[extra]))
            gate = gates.get(extra)
            assert gate is None or Marker(gate).evaluate(environment)


def test_direct_overrides_preserve_the_declared_exact_version():
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name

    root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8-sig"))
    locked = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8-sig"))
    # uv.lock records normalized names; pyproject keeps the declared spelling (Pillow).
    direct = {canonicalize_name(req.name): req for spec in metadata["project"]["dependencies"]
              if (req := Requirement(spec)).specifier}
    for spec in metadata["tool"]["uv"].get("override-dependencies", []):
        override = Requirement(spec)
        name = canonicalize_name(override.name)
        requirement = direct.get(name)
        if requirement is None or not any(s.operator == "==" for s in requirement.specifier):
            continue
        assert override.specifier == requirement.specifier, (
            f"{override.name}: override {override.specifier} contradicts exact requirement {requirement.specifier}"
        )
        versions = {row["version"] for row in locked["package"] if canonicalize_name(row["name"]) == name}
        assert versions and all(version in requirement.specifier for version in versions)


def test_matrix_extra_not_in_all():
    """The [matrix] extra pulls `mautrix[encryption]` -> `python-olm`,
    which has Linux-only wheels and no native build path on Windows or
    modern macOS (archived libolm, C++ errors with Clang 21+).

    With matrix in [all], `uv sync --locked` on Windows tried to build
    python-olm from sdist and failed on `make`. As of 2026-05-12 the
    [matrix] extra is excluded from [all] entirely and installs on first
    use (pm.ensure_import("matrix")), where the user is expected to have
    a toolchain.
    """
    optional_dependencies = _load_optional_dependencies()

    assert "matrix" in optional_dependencies, "[matrix] extra must still exist for `uv sync --extra matrix`"
    # Must NOT appear in [all] in any form — neither unconditional nor
    # platform-gated. Lazy-install handles it.
    matrix_in_all = [
        dep for dep in optional_dependencies["all"]
        if "matrix" in dep
    ]
    assert not matrix_in_all, (
        "matrix must not appear in [all] — it installs on first use via "
        f"pm.ensure_import('matrix'). Found: {matrix_in_all}"
    )


def test_lazy_installable_extras_excluded_from_all():
    """Policy (2026-05-12): opt-in backends stay out of [all].

    On-demand install exists so one quarantined PyPI release
    (e.g. mistralai 2.4.6) can't break every fresh install. Putting a
    backend in [all] defeats that — fresh installs eager-install it and
    inherit whatever's broken upstream. Opt-in backends are extras that
    install at first use via pm.ensure_import(extra).
    """
    optional_dependencies = _load_optional_dependencies()

    # The on-demand backends as of 2026-05-12. Deliberately a literal
    # list so the test stays a contract — adding a new opt-in backend
    # means updating this list AND verifying [all] doesn't contain it.
    lazy_covered_extras = {
        "anthropic", "bedrock",
        "exa", "firecrawl", "parallel-web",
        "fal",
        "edge-tts", "tts-premium",
        "voice",  # faster-whisper / sounddevice / numpy (composes stt-whisper + audio-io)
        "stt-whisper",
        "modal", "daytona", "vercel",
        "messaging", "slack", "matrix", "dingtalk", "feishu",
        "telegram", "discord",
        "wake", "wake-openwakeword", "wake-sherpa", "wake-porcupine",
        "google-chat",
        "mistral",  # mistralai — Voxtral STT/TTS, lazy-installed (stt.mistral / tts.mistral)
    }
    all_extra_specs = optional_dependencies["all"]
    for extra in lazy_covered_extras:
        offending = [
            spec for spec in all_extra_specs
            if f"hermes-agent[{extra}]" in spec
        ]
        assert not offending, (
            f"[{extra}] is in [all] but also in LAZY_DEPS. "
            f"Remove it from [all] in pyproject.toml — it lazy-installs "
            f"at first use. Found in [all]: {offending}"
        )


def _exact_pins(specs):
    pins = {}
    for spec in specs:
        requirement = spec.split(";", 1)[0].strip()
        if "==" not in requirement:
            continue
        package, version = requirement.split("==", 1)
        package = package.split("[", 1)[0].lower().replace("_", "-")
        pins[package] = version
    return pins




def test_extras_pin_each_package_at_one_version():
    """One package, one version, across every extra.

    tools/lazy_deps.py is gone — pyproject.toml is the single authority for
    optional-dependency pins (pm syncs the venv from uv.lock, which resolves
    from here). The drift class that killed us before (#31817: two documents
    pinning the same package differently, update ping-ponging the version)
    is now only possible BETWEEN extras — so pin consistency across extras
    is the whole remaining contract.
    """
    optional_dependencies = _load_optional_dependencies()

    pins: dict[str, dict[str, set[str]]] = {}
    for extra, specs in optional_dependencies.items():
        for package, version in _exact_pins(specs).items():
            pins.setdefault(package, {}).setdefault(version, set()).add(extra)

    drift = {
        package: {v: sorted(extras) for v, extras in versions.items()}
        for package, versions in pins.items()
        if len(versions) > 1
    }
    assert not drift, (
        "extras pin the same package at different versions — uv sync would "
        f"resolve whichever wins and silently downgrade the other: {drift}"
    )






def test_dingtalk_extra_includes_qrcode_for_qr_auth():
    """DingTalk's QR-code device-flow auth (hermes_cli/dingtalk_auth.py)
    needs the qrcode package."""
    optional_dependencies = _load_optional_dependencies()

    dingtalk_extra = optional_dependencies["dingtalk"]
    assert any(dep.startswith("qrcode") for dep in dingtalk_extra)


def test_feishu_extra_includes_qrcode_for_qr_login():
    """Feishu's QR login flow (gateway/platforms/feishu.py) needs the
    qrcode package."""
    optional_dependencies = _load_optional_dependencies()

    feishu_extra = optional_dependencies["feishu"]
    assert any(dep.startswith("qrcode") for dep in feishu_extra)


def test_docx_skill_extra_ships_defusedxml_and_lxml_in_all():
    """skills/productivity/docx SKILL.md requires `defusedxml` AND `lxml`.

    The packaged desktop runtime installs `uv export --extra all` (see
    apps/desktop/scripts/stage-bundled-runtime.mjs -> installLockedDependencies),
    and the packaged app has no pip, so anything absent from that export is
    absent forever. defusedxml resolved transitively; lxml did not, so the
    docx skill's validation scripts died with ModuleNotFoundError inside
    Atum.app. Both are now declared explicitly by the [docx] extra, which is
    in [all] alongside the other skill extras (google, youtube).
    """
    optional_dependencies = _load_optional_dependencies()

    assert "docx" in optional_dependencies, "[docx] extra must exist for skills/productivity/docx"
    pins = _exact_pins(optional_dependencies["docx"])
    assert "lxml" in pins, "[docx] must pin lxml — the docx skill imports it directly"
    assert "defusedxml" in pins, "[docx] must pin defusedxml — SKILL.md's OOXML transforms use it"

    assert any(
        spec == "hermes-agent[docx]"
        for spec in optional_dependencies["all"]
    ), "[docx] must be in [all] or the staged desktop runtime omits lxml again"


def test_docx_skill_dependencies_are_locked_for_the_staged_runtime():
    """`uv export --extra all` can only emit what uv.lock already resolved.

    Guards the other half of the packaging bug: declaring [docx] in
    pyproject.toml without relocking leaves the staged runtime unchanged.
    Reads the lock file directly so the check needs no network.
    """
    lock_path = Path(__file__).resolve().parents[1] / "uv.lock"
    with lock_path.open("rb") as handle:
        locked = tomllib.load(handle)

    names = {package["name"] for package in locked["package"]}
    assert "lxml" in names, "uv.lock is stale — run `uv lock` after editing the [docx] extra"
    assert "defusedxml" in names


def test_free_web_search_ships_in_all_for_the_staged_runtime():
    """Atum turns web search on for everyone with DuckDuckGo (plugins/web/ddgs).

    ddgs has no LAZY_DEPS entry and the packaged desktop runtime has no pip, so
    the staged runtime (`uv export --extra all`) must carry it, or web_search
    stays unavailable. The extra follows the repo pin policy (a ceiling below
    the next major) and must be resolved in uv.lock, or the export omits it.
    """
    optional_dependencies = _load_optional_dependencies()

    assert "ddgs" in optional_dependencies, "[ddgs] extra must exist for plugins/web/ddgs"
    (spec,) = optional_dependencies["ddgs"]
    assert Requirement(spec).name == "ddgs" and Requirement(spec).specifier, (
        "[ddgs] must keep an explicit reviewed version constraint"
    )
    assert "hermes-agent[ddgs]" in optional_dependencies["all"], (
        "[ddgs] must be in [all] or the staged desktop runtime has no web search"
    )

    lock_path = Path(__file__).resolve().parents[1] / "uv.lock"
    with lock_path.open("rb") as handle:
        locked = tomllib.load(handle)
    names = {package["name"] for package in locked["package"]}
    assert "ddgs" in names, "uv.lock is stale — run `uv lock` after editing the [ddgs] extra"


def test_nemo_relay_extra_uses_supported_official_distribution_range():
    manifest = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    requirements = [Requirement(spec) for spec in manifest["project"]["dependencies"]]
    nemo = next(req for req in requirements if req.name == "nemo-relay")

    assert str(nemo.specifier), "nemo-relay must keep an explicit supported range"
    optional_dependencies = manifest["project"]["optional-dependencies"]
    assert optional_dependencies["nemo-relay"] == []
    assert not any(
        spec == "hermes-agent[nemo-relay]"
        for spec in optional_dependencies["all"]
    )
