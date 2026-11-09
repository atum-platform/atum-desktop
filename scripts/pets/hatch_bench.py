"""Measure hatch candidates: one command per model, a table at the end.

The hatch pipeline is fixed (``agent.pet.generate``); the model is config. This
runs the real pipeline — four base drafts, then a hatch from draft 0 — against
each model you name, through the provider the desktop uses, and reports what the
Pet Store cares about: how many rows came out usable, how many rolls it took,
how long it ran, how many images that cost, and the list price of those images.

    OPENROUTER_API_KEY=… python -m scripts.pets.hatch_bench \\
        --model google/gemini-3.1-flash-image --model bytedance-seed/seedream-4.5 \\
        --concept "a chubby orange tabby kitten" --out build/hatch-bench

Each run writes ``<out>/<model>/<concept>/`` with the drafts, the sheet, and a
``run.json``; the bench prints one row per (model, concept) and a JSON summary.

Runs happen in their own ``HERMES_HOME`` (``<out>/home``), never the active
profile, so a bench cannot leave a pet behind or read your config by accident;
credentials therefore come from the shell (``OPENROUTER_API_KEY``), not from
``~/.hermes/.env``. ``--use-active-home`` opts into the real home. Either way,
each bench pet gets a unique ``bench-…`` slug so the pipeline's real save path
is exercised, and is removed the moment its run ends — success, failure, or
Ctrl-C — unless ``--keep``.

Cost is *list price × images*, from :data:`LIST_PRICE_USD` (per image at the
tier the pipeline asks for). The chat-completions path the OpenRouter plugin
uses does not return a per-request cost, so this is the estimate the Proton
price must be reasoned from; update the table when prices move.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Per-image list price in USD at the resolution the pipeline uses (1K-class
# canvas). Sources are in 
LIST_PRICE_USD: dict[str, float] = {
    "google/gemini-3.1-flash-image": 0.067,
    "google/gemini-3.1-flash-lite-image": 0.0336,
    "google/gemini-2.5-flash-image": 0.039,
    "google/gemini-3-pro-image": 0.134,
    "bytedance-seed/seedream-4.5": 0.04,
    "black-forest-labs/flux.2-pro": 0.06,
    "openai/gpt-5.4-image-2": 0.032,
    "openai/gpt-image-2": 0.032,
    "openai/gpt-5-image-mini": 0.0084,
    "x-ai/grok-imagine-image-2.0": 0.04,
    "x-ai/grok-imagine-image-quality": 0.05,
}

# Env var per provider that pins the image model (see plugins/image_gen/*).
MODEL_ENV: dict[str, str] = {
    "openrouter": "OPENROUTER_IMAGE_MODEL",
    "nous": "NOUS_IMAGE_MODEL",
    "openai": "OPENAI_IMAGE_MODEL",
}

_ROW_READY = re.compile(
    r"row '(?P<state>[\w-]+)' ready in (?P<secs>[\d.]+)s \(attempt (?P<attempt>\d+)\)"
)
_ROW_FAILED = re.compile(
    r"row '(?P<state>[\w-]+)' attempt (?P<attempt>\d+)/(?P<of>\d+) failed"
)
_ROW_GAVE_UP = re.compile(r"row '(?P<state>[\w-]+)' gave up")


@dataclass
class RunReport:
    model: str
    concept: str
    provider: str
    drafts_ok: int = 0
    drafts_requested: int = 4
    draft_seconds: float = 0.0
    rows_usable: list[str] = field(default_factory=list)
    rows_generated: int = 0
    row_attempts: int = 0
    row_retries: int = 0
    rows_gave_up: list[str] = field(default_factory=list)
    row_seconds: dict[str, float] = field(default_factory=dict)
    hatch_seconds: float = 0.0
    images: int = 0
    list_price_usd: float | None = None
    cost_usd: float | None = None
    error: str = ""
    sheet: str = ""

    def finish(self) -> None:
        self.images = self.drafts_requested + self.row_attempts
        price = LIST_PRICE_USD.get(self.model)
        self.list_price_usd = price
        self.cost_usd = round(price * self.images, 3) if price is not None else None


class _RowLog(logging.Handler):
    """Count row rolls from the pipeline's own log lines — no pipeline hooks."""

    def __init__(self, report: RunReport) -> None:
        super().__init__(level=logging.INFO)
        self.report = report

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if m := _ROW_READY.search(msg):
            self.report.row_attempts += 1
            self.report.row_seconds[m["state"]] = float(m["secs"])
        elif _ROW_FAILED.search(msg):
            self.report.row_attempts += 1
            self.report.row_retries += 1
        elif m := _ROW_GAVE_UP.search(msg):
            self.report.rows_gave_up.append(m["state"])


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "x"


def run_one(
    model: str,
    concept: str,
    *,
    provider: str,
    out: Path,
    drafts: int = 4,
    style: str = "auto",
    sprite=None,
    keep: bool = False,
) -> RunReport:
    """Drafts, then a hatch from draft 0, for one model and one concept.

    *sprite* (a :class:`agent.pet.generate.imagegen.SpriteProvider`) bypasses
    provider resolution — tests pass a stub; real runs resolve through the env.
    The bench pet is removed when the run ends unless *keep*.
    """
    from agent.pet.generate import generate_base_drafts, hatch_pet
    from agent.pet.generate.imagegen import GenerationError

    from agent.pet import store

    report = RunReport(
        model=model, concept=concept, provider=provider, drafts_requested=drafts
    )
    run_dir = out / slugify(model) / slugify(concept)
    run_dir.mkdir(parents=True, exist_ok=True)
    handler = _RowLog(report)
    pipeline_log = logging.getLogger("agent.pet.generate.orchestrate")
    pipeline_log.addHandler(handler)
    prior_level = pipeline_log.level
    if pipeline_log.getEffectiveLevel() > logging.INFO:
        pipeline_log.setLevel(logging.INFO)
    # Named before anything is hatched, so the cleanup below always knows what
    # to remove — a pet registered by a run that then fails is still removed.
    slug = f"bench-{slugify(model)[:24]}-{slugify(concept)[:20]}-{uuid.uuid4().hex[:8]}"
    try:
        t0 = time.monotonic()
        try:
            paths = generate_base_drafts(
                concept, n=drafts, style=style, provider=sprite
            )
        except GenerationError as exc:
            report.error = f"drafts: {exc}"
            return report
        report.draft_seconds = round(time.monotonic() - t0, 1)
        report.drafts_ok = len(paths)
        for i, p in enumerate(paths):
            shutil.copy(p, run_dir / f"draft-{i}{p.suffix}")

        t1 = time.monotonic()
        try:
            result = hatch_pet(
                base_image=paths[0],
                slug=slug,
                display_name=slug,
                concept=concept,
                style=style,
                provider=sprite,
            )
        except GenerationError as exc:
            report.error = f"hatch: {exc}"
            return report
        finally:
            report.hatch_seconds = round(time.monotonic() - t1, 1)
        report.rows_usable = list(result.states)
        report.rows_generated = len([s for s in result.states if s != "running-left"])
        shutil.copy(result.spritesheet, run_dir / "sheet.png")
        report.sheet = str(run_dir / "sheet.png")
        return report
    except BaseException as exc:  # noqa: BLE001 - Ctrl-C and crashes still get reported
        report.error = report.error or f"{type(exc).__name__}: {exc}"
        raise
    finally:
        if not keep:
            store.remove_pet(slug)
        pipeline_log.removeHandler(handler)
        pipeline_log.setLevel(prior_level)
        report.finish()
        (run_dir / "run.json").write_text(
            json.dumps(asdict(report), indent=2), encoding="utf-8"
        )


def table(reports: list[RunReport]) -> str:
    head = f"{'model':38} {'concept':24} {'drafts':>6} {'rows':>5} {'rolls':>5} {'draft s':>7} {'hatch s':>7} {'imgs':>4} {'$ list':>7}  note"
    lines = [head, "-" * len(head)]
    for r in reports:
        cost = f"{r.cost_usd:.2f}" if r.cost_usd is not None else "?"
        note = r.error or (
            f"gave up: {','.join(r.rows_gave_up)}" if r.rows_gave_up else ""
        )
        lines.append(
            f"{r.model[:38]:38} {r.concept[:24]:24} {r.drafts_ok:>3}/{r.drafts_requested:<2} "
            f"{len(r.rows_usable):>2}/9 {r.row_attempts:>5} {r.draft_seconds:>7.1f} {r.hatch_seconds:>7.1f} {r.images:>4} {cost:>7}  {note}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--model", action="append", required=True, help="Image model id (repeatable)"
    )
    ap.add_argument(
        "--concept", action="append", required=True, help="What to hatch (repeatable)"
    )
    ap.add_argument("--provider", default="openrouter", choices=sorted(MODEL_ENV))
    ap.add_argument("--out", default="build/hatch-bench", type=Path)
    ap.add_argument("--drafts", default=4, type=int)
    ap.add_argument("--style", default="auto")
    ap.add_argument("--keep", action="store_true", help="Leave bench pets installed")
    ap.add_argument(
        "--use-active-home",
        action="store_true",
        help="Run in the active HERMES_HOME instead of an isolated one under --out",
    )
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s"
    )
    args.out.mkdir(parents=True, exist_ok=True)
    if not args.use_active_home:
        home = args.out / "home"
        home.mkdir(parents=True, exist_ok=True)
        os.environ["HERMES_HOME"] = str(home)
        print(
            f"HERMES_HOME={home} (isolated; --use-active-home to opt out)",
            file=sys.stderr,
        )
    os.environ["HERMES_PET_IMAGE_PROVIDER"] = args.provider

    reports: list[RunReport] = []
    for model in args.model:
        os.environ[MODEL_ENV[args.provider]] = model
        for concept in args.concept:
            print(f"→ {model} · {concept}", file=sys.stderr, flush=True)
            r = run_one(
                model,
                concept,
                provider=args.provider,
                out=args.out,
                drafts=args.drafts,
                style=args.style,
                keep=args.keep,
            )
            reports.append(r)
            print(table([r]).splitlines()[-1], file=sys.stderr, flush=True)

    print(table(reports))
    (args.out / "summary.json").write_text(
        json.dumps([asdict(r) for r in reports], indent=2)
    )
    print(f"\nsummary: {args.out / 'summary.json'}")
    return 0 if all(not r.error for r in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
