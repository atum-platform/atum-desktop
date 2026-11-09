"""Atum's pet adapters on the split TUI gateway: the voxel spec lane, Store holds, and the
portable bundle the paid Store hatch publishes.

Hermes owns the illustrated (image-model) pet path in ``methods_session``. This module adds only
what Atum ships beside it and delegates to the native handler for everything else:

- ``pet.generate`` / ``pet.hatch`` with ``style: "voxel"``: a model writes a PetSpec and the voxel
  renderer draws it. Same RPCs, same token, a different stage: ``spec-<i>.json`` beside a preview
  ``draft-<i>.png``; ``pet.hatch`` sees the spec and renders instead of generating. Phases, not
  rows, on the wire (the render is sub-second and deterministic).
- ``pet.generate.status``: the ``voxel`` lane reported beside the illustrated one.
- ``pet.export_bundle``: one hatch operation's canonical files for the Matrix paid hatch.
- ``pet.info`` / ``pet.info.meta`` / ``pet.gallery``: the Store hold (``held``) and the pet's own
  ``size``.

Bodies are rebound onto server.py's globals (method_ctx.py) like every split module; the native
handlers they wrap are captured at :func:`register` time.
"""

from __future__ import annotations

import re

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped

# Draft tokens are minted here (uuid hex); a wire token that is anything else never names a path.
_PET_TOKEN = re.compile(r"[A-Za-z0-9_-]{1,64}")
_PET_WRAPPED = ("pet.generate.status", "pet.generate", "pet.hatch", "pet.info", "pet.gallery")


_PET_VOXEL_ERROR_CODES = {
    "cancelled": (5031, "generation cancelled"),
    "timeout": (5032, "the model took too long — try again"),
    "provider_unavailable": (5033, "the model could not be reached"),
    "billing_unavailable": (4402, "no credit for a hatch right now — top up, or use your own key"),
    "invalid_spec": (5034, "the model did not produce a usable pet — try again"),
    "unsupported_body_plan": (4405, "that kind of animal cannot be hatched yet — dogs, cats, foxes, rabbits, pigs and bears can"),
    "unsupported_input": (4004, "that reference image cannot be used"),
}


def _pet_voxel_error(rid, exc) -> dict:
    code, message = _PET_VOXEL_ERROR_CODES.get(getattr(exc, "kind", ""), (5031, "pet.generate failed"))
    if getattr(exc, "kind", "") == "unsupported_body_plan" and getattr(exc, "plan", ""):
        message = f"{message} (asked for: {exc.plan})"
    return _err(rid, code, message)


def _pet_voxel_summary(spec) -> str:
    """One line for a draft card: what the model made of the request."""
    from scripts.pets.plans import plan_for

    card = plan_for(spec.plan).vocabulary.card  # the knobs this plan's card mentions
    bits = [spec.plan, spec.build, *(f"{spec.knobs[k]} {k.replace('_', ' ')}" for k in card if spec.knobs.get(k) not in (None, "none"))]
    if spec.pattern.kind != "none":
        bits.append(spec.pattern.kind)
    if spec.markings:
        bits.append(", ".join(sorted({m.where for m in spec.markings})))
    return f"{spec.name}: " + ", ".join(bits)


def _pet_image_data_uri(img, *, max_px: int = 160) -> str:
    import base64
    import io

    from PIL import Image

    small = img.convert("RGBA")
    small.thumbnail((max_px, max_px), Image.LANCZOS)
    buf = io.BytesIO()
    small.save(buf, format="PNG")
    return "data:image/png;base64," + base64.standard_b64encode(buf.getvalue()).decode("ascii")


def _pet_generate_voxel(rid, params: dict, *, prompt: str, ref_raw: str, count: int) -> dict:
    """`pet.generate` for `style: "voxel"`: design, then preview, then stage."""
    import json as _json
    import uuid

    from agent.pet.generate import voxel
    from scripts.pets import spec as petspec

    import shutil

    root = _pet_gen_root()
    _pet_gen_sweep(root)
    token = uuid.uuid4().hex[:12]
    # The desktop mints an operation id before it asks; every event of this
    # round echoes it, so a late event from an earlier round cannot be
    # mistaken for this one. Absent from older clients, and then omitted.
    op_id = str(params.get("opId") or "").strip()[:64]
    tag = {"opId": op_id} if op_id else {}
    _pet_cancel_arm(token)
    stage = root / token
    stage.mkdir(parents=True, exist_ok=True)

    def fail(resp: dict) -> dict:
        # Nothing usable came of this round: the stage (and any photo in it)
        # goes now, not at the next sweep.
        _pet_cancel_release(token)
        shutil.rmtree(stage, ignore_errors=True)
        return resp

    reference: bytes | None = None
    if ref_raw:
        try:
            # Voxel designs keep the normalized image in memory only.  The
            # stage retains a marker for provenance, never the original or a
            # normalized copy of somebody's photo.
            reference = _pet_voxel_reference_from_data_url(ref_raw)
            (stage / ".reference-used").touch()
        except ValueError as exc:
            return fail(_err(rid, 4004, str(exc)))

    # Remix: the chosen draft's spec, plus a note, goes back to the model.
    base_spec = None
    remix_token = str(params.get("remixToken") or "").strip()
    remix_draft = str(params.get("remixDraftId") or "").strip()
    note = str(params.get("note") or "")
    if remix_token and remix_draft:
        base_path = _pet_gen_root() / remix_token / f"spec-{remix_draft}.json"
        if not base_path.is_file():
            return fail(_err(rid, 4004, "draft expired — generate again"))
        try:
            base_spec = petspec.PetSpec.from_dict(_json.loads(base_path.read_text(encoding="utf-8")))
        except (ValueError, OSError) as exc:
            return fail(_err(rid, 5031, f"remix base unreadable: {exc}"))

    try:
        managed = _pet_managed_hatch(params)
    except ValueError as exc:
        return fail(_err(rid, 4004, str(exc)))
    try:
        _emit("pet.generate.progress", "", {"token": token, "count": count, "kind": "voxel", "phase": "designing", **tag})
    except Exception as exc:
        logger.debug("pet.generate init emit failed: %s", exc)

    started = time.monotonic()
    try:
        design = voxel.design_pets(
            prompt,
            count=count,
            reference_image=reference,
            base_spec=base_spec,
            note=note,
            is_cancelled=lambda: _pet_is_cancelled(token),
            **managed,
        )
    except voxel.VoxelDesignError as exc:
        logger.info(
            "pet.generate voxel: token=%s outcome=%s model=%s repairs=%d calls=%d prompt_tokens=%d completion_tokens=%d latency_ms=%d reference=%s",
            token, exc.kind, exc.model, exc.repairs, exc.usage.get("calls", 0), exc.usage.get("prompt_tokens", 0),
            exc.usage.get("completion_tokens", 0), int((time.monotonic() - started) * 1000), bool(reference),
        )
        return fail(_pet_voxel_error(rid, exc))
    except Exception as exc:
        logger.debug("pet.generate voxel failed: %s", exc)
        return fail(_err(rid, 5031, "pet.generate failed"))

    if _pet_is_cancelled(token):
        return fail(_err(rid, 5031, "generation cancelled"))
    try:
        _emit("pet.generate.progress", "", {"token": token, "count": count, "kind": "voxel", "phase": "rendering_previews", **tag})
    except Exception as exc:
        logger.debug("pet.generate phase emit failed: %s", exc)

    out: list[dict] = []
    for index, spec in enumerate(design.specs):
        if _pet_is_cancelled(token):
            break
        try:
            preview = petspec.render_preview(spec)
            preview.save(stage / f"draft-{index}.png", format="PNG")
            (stage / f"spec-{index}.json").write_text(_json.dumps(spec.to_dict(), indent=2), encoding="utf-8")
            data_uri = _pet_image_data_uri(preview)
        except Exception as exc:
            logger.info("pet.generate voxel: draft %d could not render: %s", index, exc)
            continue
        draft = {"index": index, "draftId": str(index), "dataUri": data_uri, "kind": "voxel", "summary": _pet_voxel_summary(spec)}
        out.append(draft)
        try:
            _emit("pet.generate.progress", "", {"token": token, "count": count, **draft, **tag})
        except Exception as exc:
            logger.debug("pet.generate progress emit failed: %s", exc)

    cancelled = _pet_is_cancelled(token)
    logger.info(
        "pet.generate voxel: token=%s outcome=%s model=%s repairs=%d calls=%d prompt_tokens=%d completion_tokens=%d latency_ms=%d reference=%s drafts=%d",
        token, "cancelled" if cancelled else "ok", design.model, design.repairs, design.usage["calls"],
        design.usage["prompt_tokens"], design.usage["completion_tokens"], int((time.monotonic() - started) * 1000), bool(reference), len(out),
    )
    if cancelled:
        return fail(_err(rid, 5031, "generation cancelled"))
    if not out:
        return fail(_err(rid, 5034, "the model did not produce a usable pet — try again"))
    _pet_cancel_release(token)
    try:
        _emit("pet.generate.progress", "", {"token": token, "count": count, "kind": "voxel", "phase": "ready", **tag})
    except Exception as exc:
        logger.debug("pet.generate ready emit failed: %s", exc)
    return _ok(rid, {"ok": True, "token": token, "kind": "voxel", "drafts": out, **tag})


def _pet_managed_hatch(params: dict) -> dict:
    """Validate the short-lived Matrix main-process hatch proxy credentials.

    The renderer never receives this object. It exists only for a single voxel
    round, is not written to profile configuration, and is constrained to a
    loopback OpenAI-compatible proxy with the fixed ``hatch`` alias.
    """
    raw = params.get("managedHatch")
    if raw is None:
        return {}
    if not isinstance(raw, dict) or set(raw) != {"baseUrl", "apiKey", "operationId"}:
        raise ValueError("invalid managed hatch")
    from urllib.parse import urlsplit

    base_url = raw.get("baseUrl")
    api_key = raw.get("apiKey")
    operation = raw.get("operationId")
    if not isinstance(base_url, str) or not isinstance(api_key, str) or not isinstance(operation, str):
        raise ValueError("invalid managed hatch")
    parsed = urlsplit(base_url)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or parsed.port is None or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") not in {"", "/v1"}
            or not 16 <= len(api_key) <= 512 or api_key.strip() != api_key or any(char in api_key for char in "\r\n\0")):
        raise ValueError("invalid managed hatch")
    try:
        if str(uuid.UUID(operation)) != operation:
            raise ValueError
    except ValueError:
        raise ValueError("invalid managed hatch") from None
    if str(params.get("opId") or "") != operation:
        raise ValueError("invalid managed hatch")
    return {"provider": "custom", "model": "hatch", "base_url": base_url.rstrip("/"), "api_key": api_key,
            "extra_headers": {"X-Atum-Pet-Operation": operation}}


def _pet_hatch_voxel(rid, params: dict, *, token: str, cancel_token: str, index: int, name: str, spec_path) -> dict:
    """`pet.hatch` for a voxel draft: render the sheet, stage, publish once."""
    import json as _json
    import shutil
    import time as _time

    from agent.pet import store
    from scripts.pets import spec as petspec

    try:
        spec = petspec.PetSpec.from_dict(_json.loads(spec_path.read_text(encoding="utf-8")))
    except (ValueError, OSError) as exc:
        return _err(rid, 5031, f"draft unreadable: {exc}")

    _pet_cancel_arm(cancel_token)

    def phase(name_: str) -> None:
        # The cancel token the desktop minted rides every phase, so a late
        # phase from an earlier hatch is never taken for this one.
        try:
            _emit("pet.hatch.progress", "", {"event": "phase", "phase": name_, "kind": "voxel", "cancelToken": cancel_token})
        except Exception as exc:
            logger.debug("pet.hatch phase emit failed: %s", exc)

    started = _time.monotonic()
    # The gateway names the pet: the user's name, else the model's, slugified
    # and made unique here — never a slug from the wire — and *reserved*, so
    # two hatches of "Snow" at once are snow and snow-2, not one replacing
    # the other.
    display_name = name or spec.name
    slug = store.reserve_unique_slug(display_name)
    staging = store._staging_dir(slug)
    try:
        if _pet_is_cancelled(cancel_token):
            return _err(rid, 5031, "generation cancelled")
        phase("rendering")
        sheet = petspec.render_sheet(spec, slug=slug)

        phase("validating")
        problems = _pet_validate_voxel_sheet(sheet, extra_rows=len(petspec.extra_rows_for(spec)))
        if problems:
            logger.info("pet.hatch voxel: slug=%s invalid sheet: %s", slug, "; ".join(problems))
            return _err(rid, 5034, "the rendered pet failed its checks — try again")
        if _pet_is_cancelled(cancel_token):
            return _err(rid, 5031, "generation cancelled")

        phase("publishing")
        staging.mkdir(parents=True, exist_ok=True)
        sheet.save(staging / "spritesheet.webp", "WEBP", lossless=True, quality=100, method=6)
        from scripts.pets.sheet import LOOK_ORIGIN, PITCH_STEPS, YAW_STEPS

        meta = {
            "id": slug,
            "displayName": display_name,
            "description": str(params.get("description") or spec.description or ""),
            "spritesheetPath": "spritesheet.webp",
            "spriteVersionNumber": 3,
            "lookOrigin": LOOK_ORIGIN,
            "lookYawSteps": YAW_STEPS,
            "lookPitchSteps": PITCH_STEPS,
            "size": petspec.size_for(spec),  # each plan's own meaning of `build`
            "extraRows": list(petspec.extra_rows_for(spec)),  # v4 optional rows, in sheet order
            "createdBy": "generator",
            "generator": "voxel-spec",
        }
        provenance = {
            "spec": spec.to_dict(),
            "specVersion": petspec.SPEC_VERSION,
            "rendererVersion": petspec.RENDERER_VERSION,
            "task": "pet_hatch",
            "operationId": str(params.get("opId") or token).strip()[:128],
            "draftId": str(index),
            "createdAt": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
            "referenceUsed": (spec_path.parent / ".reference-used").is_file(),
        }
        (staging / "pet.json").write_text(_json.dumps(meta, indent=2), encoding="utf-8")
        (staging / "spec.json").write_text(_json.dumps(provenance, indent=2), encoding="utf-8")
        if not store._staged_pet_ok(slug, staging):
            return _err(rid, 5034, "the staged pet is incomplete")
        if _pet_is_cancelled(cancel_token):
            return _err(rid, 5031, "generation cancelled")
        # A hatch owns a new slug, never replaces: if another process sharing
        # this home published the same slug meanwhile, take the next one and
        # move the staged files under it.
        for _attempt in range(8):
            try:
                store.stamp_pet_staging(staging, source="personal", identifier=slug)
                store._publish_pet_dir(staging, store.pets_dir() / slug, replace=False)
                break
            except store.SlugTakenError:
                logger.info("pet.hatch voxel: slug %s taken meanwhile; choosing the next", slug)
                store.release_slug(slug)
                slug = store.reserve_unique_slug(display_name)
                meta["id"] = slug
                (staging / "pet.json").write_text(_json.dumps(meta, indent=2), encoding="utf-8")
        else:
            return _err(rid, 5031, "could not find a free name for the pet")
    except Exception as exc:
        logger.debug("pet.hatch voxel failed: %s", exc)
        return _err(rid, 5031, "hatch failed")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        store.release_slug(slug)
        _pet_cancel_release(cancel_token)

    pet = store.load_pet(slug)
    if pet is None or not pet.exists:
        return _err(rid, 5031, "hatch produced no pet")
    logger.info("pet.hatch voxel: slug=%s token=%s latency_ms=%d", slug, token, int((_time.monotonic() - started) * 1000))
    payload = _pet_sprite_payload(pet, scale=_pet_config_scale())
    phase("complete")
    op_id = str(params.get("opId") or "").strip()[:128]
    return _ok(rid, {"ok": True, "slug": slug, "displayName": display_name, "warnings": [], "kind": "voxel", "pet": payload,
                     **({"opId": op_id} if op_id else {})})


def _pet_validate_voxel_sheet(sheet, *, extra_rows: int = 0) -> list[str]:
    """The atlas invariants: the right size (v3's twelve rows plus the plan's
    declared v4 extras), every row drawn, edges clear."""
    from scripts.pets.sheet import COLS, FRAME_H, FRAME_W, ROWS

    rows = ROWS + int(extra_rows)
    problems: list[str] = []
    if sheet.size != (COLS * FRAME_W, rows * FRAME_H):
        return [f"size {sheet.size}, expected {(COLS * FRAME_W, rows * FRAME_H)}"]
    alpha = sheet.getchannel("A")
    for row in range(rows):
        cell = alpha.crop((0, row * FRAME_H, FRAME_W, (row + 1) * FRAME_H))
        if cell.getbbox() is None:
            problems.append(f"row {row} is empty")
    return problems


def _pet_voxel_reference_from_data_url(ref_raw: str) -> bytes:
    """Return one bounded, EXIF-free voxel reference without touching disk."""
    import base64
    import binascii
    import io
    import re as _re

    match = _re.match(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$", ref_raw, _re.DOTALL)
    if not match or match.group(1).lower() not in _PET_REFERENCE_MIME_EXT:
        raise ValueError("unsupported reference image type")
    payload = "".join(match.group(2).split())
    if (len(payload) * 3) // 4 > _PET_REFERENCE_MAX_BYTES:
        raise ValueError("reference image too large")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid reference image data") from exc
    if len(raw) > _PET_REFERENCE_MAX_BYTES:
        raise ValueError("reference image too large")
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as image:
            if (image.format or "").upper() not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("unsupported reference image type")
            if not (0 < image.width <= 4096 and 0 < image.height <= 4096):
                raise ValueError("reference image too large")
            normalized = image.convert("RGB")
            normalized.thumbnail((768, 768), Image.LANCZOS)
            out = io.BytesIO()
            normalized.save(out, format="JPEG", quality=85)
            return out.getvalue()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("invalid reference image data") from exc




def _pet_hold_payload() -> dict | None:
    """``{slug, displayName, reason}`` when the configured pet is held by the Store."""
    from agent.pet import store

    try:
        held = store.active_pet_hold(str(_pet_cfg().get("slug", "") or ""))
    except Exception as exc:
        logger.debug("pet hold lookup failed: %s", exc)
        return None
    return {"slug": held.slug, "displayName": held.display_name, "reason": held.held} if held else None


def _pet_display_enabled() -> bool:
    return is_truthy_value(_pet_cfg().get("enabled"), default=False)


def _pet_native(name: str, rid, params: dict) -> dict:
    """The Hermes handler this module wraps (captured at register time)."""
    return _atum_pet_native_methods[name](rid, params)


# ── pet.generate.status / generate / hatch / export_bundle ──────────


@method("pet.generate.status")
def _atum_pet_generate_status(rid, params: dict) -> dict:
    """The native illustrated-lane answer plus the voxel lane: the spec path needs a text model
    (managed lane or the user's own key), the illustrated path an image provider."""
    resp = _pet_native("pet.generate.status", rid, params)
    result = resp.get("result") if isinstance(resp, dict) else None
    if not isinstance(result, dict):
        return resp
    try:
        from agent.pet.generate.voxel import voxel_availability

        voxel = voxel_availability()
    except Exception as exc:
        logger.debug("voxel availability failed: %s", exc)
        voxel = {"available": False, "mode": None, "reason": str(exc)[:160]}
    illustrated = {"available": bool(result.get("available")), "providers": list(result.get("providers") or [])}
    return _ok(rid, {**result, "voxel": voxel, "illustrated": illustrated})


@method("pet.generate")
def _atum_pet_generate(rid, params: dict) -> dict:
    """``style: "voxel"`` designs specs and renders previews; any other style is the native path."""
    if str(params.get("style") or "").strip() != "voxel":
        return _pet_native("pet.generate", rid, params)
    prompt = str(params.get("prompt") or "").strip()
    ref_raw = str(params.get("referenceImage") or "").strip()
    if not prompt and not ref_raw:
        return _err(rid, 4004, "missing prompt")
    try:
        count = max(1, min(4, int(params.get("count") or 4)))
    except (TypeError, ValueError):
        count = 4
    return _pet_generate_voxel(rid, params, prompt=prompt, ref_raw=ref_raw, count=count)


@method("pet.hatch")
def _atum_pet_hatch(rid, params: dict) -> dict:
    """A draft with a staged spec hatches through the voxel renderer; an image draft is native."""
    token = str(params.get("token") or "").strip()
    name = str(params.get("name") or "").strip()
    if token and name and _PET_TOKEN.fullmatch(token):
        try:
            index = int(params.get("index", 0) or 0)
        except (TypeError, ValueError):
            index = 0
        spec_path = _pet_gen_root() / token / f"spec-{index}.json"
        if spec_path.is_file():
            # Hatch cancellation rides its own key: pet.generate may still be releasing `token`.
            cancel_token = str(params.get("cancelToken") or "").strip() or token
            return _pet_hatch_voxel(rid, params, token=token, cancel_token=cancel_token, index=index,
                                    name=name, spec_path=spec_path)
    return _pet_native("pet.hatch", rid, params)


@method("pet.export_bundle")
@_profile_scoped
def _atum_pet_export_bundle(rid, params: dict) -> dict:
    """Export only a hatching operation's canonical, portable pet files."""
    import json as _json

    slug = str(params.get("slug") or "").strip()
    operation = str(params.get("operationId") or "").strip()
    if not slug or not operation or len(operation) > 128:
        return _err(rid, 4004, "missing pet bundle operation")
    try:
        from agent.pet import store
        from hermes_cli.atum_pet_bundles import PetBundleError, export_pet_bundle

        pet = store.load_pet(slug)
        if pet is None or not pet.exists:
            return _err(rid, 4004, "pet bundle unavailable")
        provenance = _json.loads((pet.directory / "spec.json").read_text(encoding="utf-8"))
        if not isinstance(provenance, dict) or provenance.get("operationId") != operation:
            return _err(rid, 4004, "pet bundle unavailable")
        return _ok(rid, {"ok": True, "bundle": export_pet_bundle(pet.directory)})
    except (OSError, ValueError, PetBundleError) as exc:
        logger.debug("pet.export_bundle failed: %s", type(exc).__name__)
        return _err(rid, 5031, "pet bundle unavailable")


# ── pet.info / pet.info.meta / pet.gallery: the Store hold and the pet's size ──


@method("pet.info")
@_profile_scoped
def _atum_pet_info(rid, params: dict) -> dict:
    """The native payload; a configured pet the Store holds answers enabled, named and explained —
    never a sheet, and never a different pet."""
    resp = _pet_native("pet.info", rid, params)
    result = resp.get("result") if isinstance(resp, dict) else None
    if isinstance(result, dict) and not result.get("enabled") and _pet_display_enabled():
        if (held := _pet_hold_payload()) is not None:
            return _ok(rid, {"enabled": True, "held": held})
    return resp


@method("pet.info.meta")
@_profile_scoped
def _atum_pet_info_meta(rid, params: dict) -> dict:
    """Cheap active-pet metadata. Carries the pet's own ``size``: the desktop compares it with the
    held payload's to decide whether the multi-MB sheet must be refetched."""
    try:
        enabled, pet, scale = _pet_active_selection()
        if enabled and pet is None and (held := _pet_hold_payload()) is not None:
            return _ok(rid, {"enabled": True, "held": held})
        if not enabled or pet is None or not pet.exists:
            return _ok(rid, {"enabled": False})
        return _ok(rid, {"enabled": True, "slug": pet.slug, "displayName": pet.display_name, "scale": scale,
                         "size": pet.size, "spritesheetRevision": _pet_sheet_revision(pet.spritesheet)})
    except Exception as exc:
        logger.debug("pet.info.meta failed: %s", exc)
        return _ok(rid, {"enabled": False})


@method("pet.gallery")
@_profile_scoped
def _atum_pet_gallery(rid, params: dict) -> dict:
    """The native gallery plus each installed pet's Store hold, so the picker shows the reason
    instead of a pet that silently is not there."""
    resp = _pet_native("pet.gallery", rid, params)
    result = resp.get("result") if isinstance(resp, dict) else None
    if not isinstance(result, dict) or not isinstance(result.get("pets"), list):
        return resp
    try:
        from agent.pet import store

        held = {p.slug: p.held for p in store.installed_pets()}
    except Exception as exc:
        logger.debug("pet.gallery hold lookup failed: %s", exc)
        return resp
    pets = [{**entry, "held": held.get(entry.get("slug"))} if isinstance(entry, dict) else entry
            for entry in result["pets"]]
    return _ok(rid, {**result, "pets": pets})


def register(server):
    """Capture the native pet handlers this module wraps, then publish and register ours."""
    if missing := [name for name in _PET_WRAPPED if name not in server._methods]:
        raise RuntimeError(f"methods_atum_pets: native pet handlers missing: {missing}")
    server._atum_pet_native_methods = {name: server._methods[name] for name in _PET_WRAPPED}
    bind_module(globals(), server)
    server._LONG_HANDLERS = server._LONG_HANDLERS | {"pet.export_bundle"}
