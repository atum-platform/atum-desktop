'Kimi designs the dog; the renderer draws it.\n\nThe spec path of "Hatch your own": one chat call asks the model for a few\ndistinct :class:`~scripts.pets.spec.PetSpec`s — enums, hex colours, markings\nfrom a menu — and :mod:`scripts.pets.spec` turns each into a sprite sheet\nthat fits by construction. The model never draws and never emits a voxel.\n\nThe call goes through :func:`agent.auxiliary_client.call_llm` as the\npet_hatch task, so provider and model are config (auxiliary.pet_hatch):\ndevelopment pins OpenRouter and moonshotai/kimi-k3; a packaged app pins\nthe managed lane and its hatch alias once the hosted plane has one. No\nresponse_format is sent — the metered proxy refuses it — so the reply is\nparsed here, and a bad reply is sent back once with the parser\'s message as\nthe repair instruction. The contract (bounds, one repair, no transport retry,\ncancellation checkpoints, typed failures) is in\n, decision 10.\n'

from __future__ import annotations

import base64
import concurrent.futures
import io
import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable

from scripts.pets.plans import kinds, plans
from scripts.pets.spec import BUILDS, DENSITIES, EXAMPLES, PATTERNS, PET_SPEC_SCHEMA, SPEC_VERSION, PetSpec, SpecError, UnsupportedPlanError

logger = logging.getLogger(__name__)

TASK = "pet_hatch"
MAX_CONCEPT_CHARS = 300
MAX_NOTE_CHARS = 300
MAX_REFERENCE_BYTES = 4 * 1024 * 1024
MAX_REFERENCE_SIDE = 4096
REFERENCE_SEND_SIDE = 768
TEMPERATURE = 0.8
MAX_TOKENS = 2500
# A wall-clock deadline per call. The client's own `timeout` is a transport
# setting and let a 196 s reply through (measured 2026-09-13); this one is
# enforced here, and a reply that arrives after it is dropped — the same
# rule as a cancel in flight (plan decision 16). 120 s, not 60: the first
# bench run (2026-09-13) showed a four-draft reply of ~900 tokens taking
# 20-36 s when the provider is quick and past 60 s when it is not — 5 of 13
# concepts were cut off with nothing to show. The deadline bounds the wait;
# "instant" is a provider and model question the bench answers.
TIMEOUT_SECONDS = 120.0
MAX_COUNT = 4

FailureKind = str  # cancelled | timeout | provider_unavailable | billing_unavailable | invalid_spec | unsupported_body_plan | unsupported_input

# Money words, not throughput words: "quota" and "rate limit" are a provider
# pacing us, not a bill. A 402 is always a bill.
_BILLING_WORDS = re.compile(r"payment required|insufficient[_ ](credits?|funds|balance)|can only afford|billing|out of credits|no credits", re.IGNORECASE)


class VoxelDesignError(RuntimeError):
    """A typed failure. ``kind`` is the contract; the message is for the log.
    ``usage``/``repairs``/``model`` carry what was spent before it failed."""

    def __init__(self, kind: FailureKind, message: str = "", *, plan: str = "") -> None:
        super().__init__(message or kind)
        self.kind = kind
        self.plan = plan
        self.usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "calls": 0}
        self.repairs = 0
        self.model = ""


@dataclass
class Design:
    specs: list[PetSpec]
    model: str = ""
    repairs: int = 0
    usage: dict[str, int] = field(default_factory=lambda: {"prompt_tokens": 0, "completion_tokens": 0, "calls": 0})


# ── Input bounds ───────────────────────────────────────────────────────────────


def bounded_text(text: str, limit: int) -> str:
    value = unicodedata.normalize("NFC", str(text or "")).strip()
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    return value[:limit]


def reference_data_url(data: bytes) -> str:
    """A photo the model may look at: checked, shrunk, re-encoded, EXIF gone."""
    if not data:
        raise VoxelDesignError("unsupported_input", "reference image is empty")
    if len(data) > MAX_REFERENCE_BYTES:
        raise VoxelDesignError("unsupported_input", f"reference image over {MAX_REFERENCE_BYTES // (1024 * 1024)} MB")
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - Pillow is a core dep
        raise VoxelDesignError("provider_unavailable", "Pillow is required") from exc
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = (im.format or "").upper()
            width, height = im.size
            if fmt not in ("PNG", "JPEG", "WEBP"):
                raise VoxelDesignError("unsupported_input", f"reference image must be PNG, JPEG or WebP, not {fmt or 'unknown'}")
            if width > MAX_REFERENCE_SIDE or height > MAX_REFERENCE_SIDE or width < 1 or height < 1:
                raise VoxelDesignError("unsupported_input", f"reference image must be at most {MAX_REFERENCE_SIDE}px a side")
            small = im.convert("RGB")
            small.thumbnail((REFERENCE_SEND_SIDE, REFERENCE_SEND_SIDE))
            out = io.BytesIO()
            small.save(out, format="JPEG", quality=85)  # a fresh file: no EXIF, no oddities
    except VoxelDesignError:
        raise
    except Exception as exc:  # noqa: BLE001 - any decode failure is a bad input
        raise VoxelDesignError("unsupported_input", f"reference image could not be read: {exc}") from exc
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii")


# ── The prompt ────────────────────────────────────────────────────────────────


def _options(values) -> str:
    return " | ".join(json.dumps(v) for v in values)


def _schema_prose() -> str:
    # Every enum comes from the spec module and the plan registry, so the
    # prompt can never name an option the parser refuses, or miss one it
    # accepts — per plan, since a chick has no ears and a slime no beak.
    lines = [
        "Each pet is a JSON object with these common fields:",
        f'  "spec_version": {SPEC_VERSION}',
        f'  "plan": the kind of animal, in lowercase — one of {", ".join(sorted(kinds()))}; if the user asked for something else, still write that word',
        '  "name": a short name (1–40 characters)',
        '  "description": one sentence (≤ 200 characters)',
        f'  "build": {_options(BUILDS)} — how big it is drawn on the desk',
        '  "palette": {"coat", "coat_deep", "muzzle" required as "#rrggbb"; "accent", "accent_deep", "ear", "eyes", "nose", "tongue" optional or null}',
        f'  "pattern": {{"kind": {_options(PATTERNS)}, "color": a palette slot name, "density": {_options(DENSITIES)}, "seed": 0–9999}}',
        '  "markings": up to 8 of {"where": a region of the pet\'s plan (listed below), "color": one of coat, coat_deep, muzzle, accent, accent_deep}, painted in order after the pattern',
        "A marking or pattern that names accent or accent_deep requires that colour in the palette.",
        "",
        "Then, beside those, only the knobs of the plan the kind belongs to. Each kind has sensible defaults for what you leave out (a cat gets pointed ears and a long tail), so set only what the request calls for.",
    ]
    for plan in plans().values():
        lines.append(f"- {', '.join(plan.kinds)} — {plan.vocabulary.palette}.")
        for knob, options in plan.vocabulary.knobs.items():
            note = plan.vocabulary.notes.get(knob)
            lines.append(f'    "{knob}": {_options(options)}' + (f" — {note}" if note else ""))
        lines.append(f"    marking regions: {', '.join(plan.vocabulary.regions)}")
    return "\n".join(lines)


def _examples_prose() -> str:
    lines = [f"{len(EXAMPLES)} pets that ship with the app, as specs:"]
    for slug, spec in EXAMPLES.items():
        lines.append(f"{slug}: {json.dumps(spec.to_dict(), separators=(',', ':'))}")
    return "\n".join(lines)


def system_prompt(count: int) -> str:
    return (
        "You design small voxel animals for a desktop pet store. The renderer draws them; you only choose knobs, colours and markings.\n\n"
        + _schema_prose()
        + "\n\n"
        + _examples_prose()
        + "\n\n"
        f"Reply with ONLY a JSON object of the form {{\"pets\": [ … ]}} containing exactly {count} pets — no prose, no code fences. "
        # Measured 2026-09-13: "clearly different (colour, …)" produced an orange, a
        # black and a spotted "white samoyed". Variety is in the shape and the
        # markings; the colour is the user's.
        # Bench, 2026-09-13: asked for a samoyed, one set came back as a dog, a
        # fox, a bear and a rabbit — variety applied to the kind itself.
        f"All {count} pets must be the same kind of animal — the one the user asked for, with the same \"plan\" word; never a different animal for variety. "
        "Every pet must match the request — the animal, its coat colour and its markings are the user's; do not invent a different colour. "
        "Make the pets clearly different from each other in build, body, head, legs, ears, tail and the arrangement of markings, each a good-looking, recognisable animal. "
        "Prefer warm, harmonious palettes; keep eyes and nose dark unless asked. "
        "If the user gives a photo, take the coat colours and markings from it. "
        # An original in the spirit of a request, never a copy of a character someone owns.
        "If the request names a character from a film, game, brand or franchise, design an original animal in that spirit — its colours and mood — not a copy of that character."
    )


def _user_content(concept: str, reference: str | None, base_spec: PetSpec | None, note: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    if base_spec is not None:
        text = (
            "Start from this pet and change only what the note asks for; keep everything else the same:\n"
            + json.dumps(base_spec.to_dict(), separators=(",", ":"))
            + ("\n\nNote: " + note if note else "")
        )
        if concept:
            text += "\n\nThe original request was: " + concept
    else:
        text = "Design pets for this request: " + (concept or "the pet in the photo")
    parts.append({"type": "text", "text": text})
    if reference:
        parts.append({"type": "image_url", "image_url": {"url": reference}})
    return parts


# ── Parsing ───────────────────────────────────────────────────────────────────


def _text_of(response: Any) -> str:
    try:
        content = response.choices[0].message.content
    except Exception:  # noqa: BLE001 - any shape we don't know is no text
        return ""
    if isinstance(content, list):  # some providers return content parts
        content = "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content)
    return str(content or "")


def _usage_of(response: Any) -> tuple[int, int]:
    usage = getattr(response, "usage", None)
    if not usage:
        return 0, 0
    prompt = getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", 0) or 0
    completion = getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", 0) or 0
    return int(prompt), int(completion)


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse_reply(text: str, *, count: int) -> tuple[list[PetSpec], list[str]]:
    """(valid specs, problems). Raises :class:`UnsupportedPlanError` at once —
    that is an answer for the user, not a repair for the model."""
    body = _FENCE.sub("", text or "").strip()
    start, end = body.find("{"), body.rfind("}")
    if start == -1 or end == -1:
        return [], ["the reply contained no JSON object"]
    try:
        data = json.loads(body[start : end + 1])
    except ValueError as exc:
        return [], [f"the JSON did not parse: {exc}"]
    pets = data.get("pets") if isinstance(data, dict) else data
    if isinstance(data, dict) and pets is None and "name" in data:
        pets = [data]  # a single pet, not wrapped
    if not isinstance(pets, list) or not pets:
        return [], ['the reply must be {"pets": [ … ]} with at least one pet']
    specs: list[PetSpec] = []
    problems: list[str] = []
    for i, raw in enumerate(pets[:count]):
        try:
            specs.append(PetSpec.from_dict(raw))
        except UnsupportedPlanError:
            raise
        except SpecError as exc:
            problems.append(f"pet {i + 1}: {exc}")
    if len(pets) < count:
        problems.append(f"only {len(pets)} pets were given; {count} were asked for")
    return specs, problems


# ── The call ──────────────────────────────────────────────────────────────────


def _with_deadline(call: Callable[[], Any], seconds: float) -> Any:
    """Run *call* and return its result, or raise a typed ``timeout`` after
    *seconds* of wall-clock time.

    The provider call cannot be interrupted, so it finishes on its own
    thread and its reply is dropped — the same contract as a cancel in
    flight: the user waits no longer than the deadline, and a late reply
    may still have cost *us* a call.
    """
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="pet-hatch")
    try:
        future = pool.submit(call)
        try:
            return future.result(timeout=seconds)
        except concurrent.futures.TimeoutError:
            logger.info("pet_hatch call exceeded its %.0fs deadline; the reply, if any, is dropped", seconds)
            raise VoxelDesignError("timeout", f"no reply within {seconds:.0f}s") from None
    finally:
        pool.shutdown(wait=False)


def _classify(exc: BaseException) -> FailureKind:
    """What kind of failure a provider exception is — never a retry decision."""
    name = type(exc).__name__
    status = getattr(exc, "status_code", None)
    if status == 402 or "Payment" in name:
        return "billing_unavailable"
    if isinstance(exc, TimeoutError) or "Timeout" in name:
        return "timeout"
    if status in (403, 429, None) and "Connection" not in name and _BILLING_WORDS.search(str(exc)):
        return "billing_unavailable"
    return "provider_unavailable"


def design_pets(
    concept: str,
    *,
    count: int = MAX_COUNT,
    reference_image: bytes | None = None,
    base_spec: PetSpec | None = None,
    note: str = "",
    is_cancelled: Callable[[], bool] | None = None,
    call: Callable[..., Any] | None = None,
    provider: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Design:
    """Ask the model for *count* distinct specs (or an edit of *base_spec*).

    Exactly one call, plus at most one repair call when the reply does not
    parse. Returns at least one valid spec or raises :class:`VoxelDesignError`.
    *call* replaces ``call_llm`` in tests.
    """
    count = max(1, min(MAX_COUNT, int(count)))
    concept = bounded_text(concept, MAX_CONCEPT_CHARS)
    note = bounded_text(note, MAX_NOTE_CHARS)
    cancelled = is_cancelled or (lambda: False)
    if not concept and reference_image is None and base_spec is None:
        raise VoxelDesignError("unsupported_input", "nothing to design from")

    reference = reference_data_url(reference_image) if reference_image is not None else None
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(count)},
        {"role": "user", "content": _user_content(concept, reference, base_spec, note)},
    ]
    design = Design(specs=[])

    started = time.monotonic()
    calls_started = 0

    def ask(msgs: list[dict[str, Any]]) -> str:
        nonlocal calls_started
        if cancelled():
            raise VoxelDesignError("cancelled")
        if call is not None:
            invoke = call
        else:
            from agent.auxiliary_client import call_llm

            invoke = call_llm
        remaining = TIMEOUT_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            raise VoxelDesignError("timeout", "pet_hatch deadline exceeded")
        # Preserve the exact first-call configuration for existing managed
        # profiles; any repair receives only what remains of this round.
        deadline = TIMEOUT_SECONDS if calls_started == 0 else remaining
        calls_started += 1
        try:
            response = _with_deadline(
                lambda: invoke(
                    task=TASK,
                    messages=msgs,
                    temperature=TEMPERATURE,
                    max_tokens=MAX_TOKENS,
                    timeout=deadline,
                    provider=provider,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    extra_headers=extra_headers,
                    # One request, one bill: no same-provider retry and no silent
                    # switch to another provider on an ambiguous failure.
                    retry_policy="none",
                ),
                deadline,
            )
        except VoxelDesignError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified, never retried
            kind = _classify(exc)
            logger.info("pet_hatch call failed (%s): %s", kind, type(exc).__name__)
            raise VoxelDesignError(kind, f"{type(exc).__name__}") from exc
        design.usage["calls"] += 1
        prompt_tokens, completion_tokens = _usage_of(response)
        design.usage["prompt_tokens"] += prompt_tokens
        design.usage["completion_tokens"] += completion_tokens
        design.model = str(getattr(response, "model", "") or design.model)
        if cancelled():
            raise VoxelDesignError("cancelled")
        return _text_of(response)

    try:
        return _design(messages, count, cancelled, ask, design)
    except VoxelDesignError as exc:
        exc.usage = dict(design.usage)
        exc.repairs = design.repairs
        exc.model = design.model
        raise


def _design(messages: list[dict[str, Any]], count: int, cancelled: Callable[[], bool], ask: Callable[[list[dict[str, Any]]], str], design: Design) -> Design:
    text = ask(messages)
    try:
        specs, problems = parse_reply(text, count=count)
    except UnsupportedPlanError as exc:
        raise VoxelDesignError("unsupported_body_plan", str(exc), plan=exc.plan) from exc

    if problems and len(specs) < count:
        # One repair: the parser's words go back as the instruction. The
        # model's own text is quoted to it, never to the user or the log.
        logger.info("pet_hatch reply needs repair: %s", "; ".join(problems)[:300])
        if cancelled():
            raise VoxelDesignError("cancelled")
        repair = [
            *messages,
            {"role": "assistant", "content": text},
            {"role": "user", "content": "That reply was not valid: " + "; ".join(problems) + ". Reply again with only the corrected JSON object."},
        ]
        design.repairs = 1
        text = ask(repair)
        try:
            specs, problems = parse_reply(text, count=count)
        except UnsupportedPlanError as exc:
            raise VoxelDesignError("unsupported_body_plan", str(exc), plan=exc.plan) from exc

    if not specs:
        raise VoxelDesignError("invalid_spec", "; ".join(problems)[:300] or "no usable pet in the reply")
    design.specs = specs[:count]
    return design


# ── Availability ──────────────────────────────────────────────────────────────


def voxel_availability() -> dict[str, Any]:
    """``{available, mode, reason}`` for ``pet.generate.status``.

    ``mode`` is ``"managed"`` when the hatch task points at the metered lane
    with an alias configured, ``"byok"`` when it points at a provider the
    user holds a key for, ``None`` otherwise. Best-effort, never raises.
    """
    try:
        from agent.auxiliary_client import _get_auxiliary_task_config

        cfg = _get_auxiliary_task_config(TASK) or {}
    except Exception as exc:  # noqa: BLE001 - config trouble is "not available"
        return {"available": False, "mode": None, "reason": f"config: {exc}"}
    provider = str(cfg.get("provider") or "auto").strip().lower()
    model = str(cfg.get("model") or "").strip()
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider

        runtime = resolve_runtime_provider(requested=None if provider == "auto" else provider)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "mode": None, "reason": str(exc)[:160]}
    resolved = str(runtime.get("provider") or provider).lower()
    if resolved == "atum-managed":
        if model:
            return {"available": True, "mode": "managed", "reason": ""}
        return {"available": False, "mode": None, "reason": "no hatch alias configured for the managed lane"}
    if str(runtime.get("api_key") or "").strip():
        return {"available": True, "mode": "byok", "reason": ""}
    return {"available": False, "mode": None, "reason": f"no credentials for {resolved}"}


__all__ = ["Design", "VoxelDesignError", "design_pets", "parse_reply", "reference_data_url", "system_prompt", "voxel_availability", "PET_SPEC_SCHEMA"]
