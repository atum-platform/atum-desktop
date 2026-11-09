#!/usr/bin/env python3
"""Bounded real-provider proof. Credentials come only from process environment.

This tests K3 design/parser/rendering; it does not establish hosted subsidy,
wallet or native purchase acceptance. Receipt omits source photos and prompts.
"""
from __future__ import annotations

import io
import json
import os
import statistics
import time
import urllib.request
from types import SimpleNamespace

from agent.pet.generate import voxel
from scripts.pets import spec as petspec


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("provider credential is required in environment")
    costs: list[float] = []

    def call(**kwargs):
        body = json.dumps({"model": "moonshotai/kimi-k3", "messages": kwargs["messages"],
                           "temperature": kwargs["temperature"], "max_tokens": kwargs["max_tokens"],
                           "usage": {"include": True}}).encode()
        request = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=kwargs["timeout"]) as response:
            value = json.load(response)
        usage = value.get("usage", {})
        costs.append(float(usage.get("cost", 0)))
        return SimpleNamespace(model=value.get("model", ""), usage=SimpleNamespace(**usage),
            choices=[SimpleNamespace(message=SimpleNamespace(content=value["choices"][0]["message"].get("content")))])

    from PIL import Image, ImageDraw
    # Synthetic reference exercises the exact photo wire without anybody's photo.
    photo = Image.new("RGB", (200, 200), "#dbece9")
    ImageDraw.Draw(photo).ellipse((45, 35, 155, 165), fill="#97603a")
    buf = io.BytesIO(); photo.save(buf, format="PNG")
    cases = [("description", "A cheerful small cream dog with floppy ears and a red accent", None),
             ("photo", "A friendly round brown pet inspired by this photo", buf.getvalue())]
    rounds = []
    for kind, prompt, reference in cases:
        started = time.monotonic()
        try:
            design = voxel.design_pets(prompt, count=4, reference_image=reference, call=call)
            previews = [petspec.render_preview(pet) for pet in design.specs]
            sheet = petspec.render_sheet(design.specs[0], slug="proof")
            sprite = io.BytesIO(); sheet.save(sprite, format="WEBP")
            rounds.append({"kind": kind, "ok": True, "drafts": len(previews), "repairs": design.repairs,
                "model": design.model, "usage": design.usage, "sheetBytes": len(sprite.getvalue()),
                "latencyMs": round((time.monotonic() - started) * 1000)})
        except Exception as exc:
            rounds.append({"kind": kind, "ok": False, "failure": getattr(exc, "kind", type(exc).__name__),
                "usage": getattr(exc, "usage", {}), "latencyMs": round((time.monotonic() - started) * 1000)})
    print(json.dumps({"plane": "provider-only", "rounds": rounds, "providerCostUsd": sum(costs),
        "medianMs": statistics.median(r["latencyMs"] for r in rounds), "maxMs": max(r["latencyMs"] for r in rounds)}, sort_keys=True))
    return 0 if all(r["ok"] for r in rounds) else 1


if __name__ == "__main__":
    raise SystemExit(main())
