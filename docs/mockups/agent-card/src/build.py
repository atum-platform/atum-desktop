#!/usr/bin/env python3
"""Agent card revamp mockups (docs/plans/2026-11-28-agent-card-revamp.md).

Builds one static HTML page per state and theme on the real Atum Kit CSS
(packages/atum-kit/dist/atum-kit.css) and its pinned Phosphor Light paths
(dist/phosphor-icons.json), then screenshots each with headless Google Chrome
into docs/mockups/agent-card/*.png.

    python3 docs/mockups/agent-card/src/build.py            # HTML + PNGs
    python3 docs/mockups/agent-card/src/build.py --html-only

The example agent is generic ("Nova", @nova); no real people, paths or devices.
"""

from __future__ import annotations

import html
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
ROOT = HERE.parents[3]
KIT_CSS = ROOT / "packages/atum-kit/dist/atum-kit.css"
ICONS = json.loads((ROOT / "packages/atum-kit/dist/phosphor-icons.json").read_text())
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PANEL_W = 420  # desktop side panel at a 1440 px window
NAME = "Nova"


def icon(name: str, cls: str = "ak-icon") -> str:
    paths = "".join(f'<path d="{d}"/>' for d in ICONS["light"][name])
    return f'<svg class="{cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">{paths}</svg>'


ATOM = (
    '<svg class="ak-icon ak-icon--sm atom" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">'
    '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>'
    '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>'
)

CSS = """
html, body { margin: 0; }
body { background: var(--ak-chrome); padding: 8px; box-sizing: border-box; min-height: 100vh; }
.panel { width: %(w)spx; box-sizing: border-box; min-height: calc(100vh - 16px); position: relative; overflow: hidden; }
.tabs { display: flex; gap: 6px; padding: 8px 8px 0; }
.tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 6px; border-radius: var(--ak-r-sm);
       background: var(--ak-fill-selected); font: var(--ak-t-body-strong); color: var(--ak-ink); }
.tab .ak-avatar { width: 18px; height: 18px; font-size: 9px; }
.tab-plus { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; color: var(--ak-ink-3); }
.body { padding: 24px 24px 32px; display: flex; flex-direction: column; gap: 24px; }
.head { display: flex; flex-direction: column; align-items: center; text-align: center; position: relative; padding-top: 8px; }
.head .more { position: absolute; top: 0; right: -8px; }
.face { width: 64px; height: 64px; font-size: 24px; }
.name { font: var(--ak-t-title); color: var(--ak-ink); margin: 12px 0 0; display: inline-flex; align-items: center; gap: 6px; }
.badge-main { font: var(--ak-t-caption); font-weight: 600; color: var(--ak-ink-2); background: var(--ak-fill-quiet); border-radius: var(--ak-r-full); padding: 2px 7px; }
.handle { font: var(--ak-t-body); color: var(--ak-ink-3); margin-top: 2px; }
.sec { display: flex; flex-direction: column; }
.sec .ak-section { padding: 0 10px 6px; display: flex; align-items: center; }
.sec .ak-section .act { margin-left: auto; font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); }
.foot { font: var(--ak-t-callout); color: var(--ak-ink-3); padding: 6px 10px 0; }
.value { color: var(--ak-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%%; }
.caret { width: 14px; height: 14px; color: var(--ak-ink-4); flex: none; }
.ak-row .ak-icon { width: 18px; height: 18px; flex: none; }
.ak-row .title { flex: 1; min-width: 0; }
.bio { padding: 10px 10px 8px; color: var(--ak-ink); font: var(--ak-t-body); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.bio-row { position: relative; }
.now { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: var(--ak-r-lg); background: var(--ak-fill-quiet); }
.now-head { display: flex; align-items: center; gap: 6px; font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-3); }
.now-head .atom { color: var(--ak-ink-3); }
.now-line { font: var(--ak-t-body-strong); color: var(--ak-ink); }
.steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; font: var(--ak-t-body); color: var(--ak-ink-2); }
.steps li { display: flex; align-items: center; gap: 8px; }
.steps .ak-icon { width: 16px; height: 16px; color: var(--ak-ink-3); }
.steps .on { color: var(--ak-ink); }
.quiet { font: var(--ak-t-body); color: var(--ak-ink-3); padding: 2px 10px; }
.inline-state { display: flex; align-items: center; gap: 10px; padding: 12px 10px; }
.inline-state .msg { flex: 1; color: var(--ak-ink-2); }
.inline-state .ak-icon { color: var(--ak-danger); width: 18px; height: 18px; }
.menu { position: absolute; top: 96px; right: 16px; z-index: 5; }
.menu-scrim, .sheet-scrim { position: absolute; inset: 0; z-index: 4; }
.sheet-scrim { background: var(--ak-scrim); display: flex; align-items: center; justify-content: center; padding: 16px; }
.sheet-scrim .ak-sheet { width: 100%%; }
.ak-field.tall { height: auto; padding: 10px; align-items: flex-start; }
.ak-field.tall textarea { display: block; width: 100%%; min-height: 96px; white-space: pre-wrap; }
.atom ellipse { fill: none; }
.dim { opacity: .55; }
/* "Today" reproduction */
.old-name { font: 600 20px/36px var(--ak-font); color: var(--ak-ink); margin-top: 12px; }
.old-privacy { font: var(--ak-t-callout); color: var(--ak-ink-3); margin-top: 4px; }
.old-label { font: var(--ak-t-body-strong); color: var(--ak-ink); padding: 0 4px 4px; }
.old-help { font: var(--ak-t-callout); color: var(--ak-ink-3); padding: 0 4px 6px; }
.old-area { font: 13px/19px ui-monospace, Menlo, monospace; white-space: pre-wrap; color: var(--ak-ink-2); padding: 10px 12px; height: 168px; overflow: hidden; }
.callout { position: absolute; z-index: 6; font: var(--ak-t-caption); font-weight: 600; background: var(--ak-danger); color: #fff; border-radius: 9px; padding: 1px 7px; }
"""


def row(icon_name: str | None, title: str, value: str = "", trail: str = "caret", cls: str = "") -> str:
    lead = icon(icon_name) if icon_name else ""
    end = {
        "caret": icon("caret-right", "caret"),
        "on": '<span class="ak-switch is-on"></span>',
        "off": '<span class="ak-switch"></span>',
        "dl": icon("download-simple", "ak-icon ak-icon--sm caret"),
        "": "",
    }[trail]
    val = f'<span class="value">{html.escape(value)}</span>' if value else ""
    return f'<div class="ak-row {cls}">{lead}<span class="title">{html.escape(title)}</span>{val}{end}</div>'


def file_row(icon_name: str, name: str, meta: str, trail: str = "") -> str:
    end = icon("caret-right", "caret") if trail == "caret" else ""
    return (
        f'<div class="ak-row">{icon(icon_name)}<span class="ak-row-main"><span>{html.escape(name)}</span>'
        f'<span class="ak-row-meta">{html.escape(meta)}</span></span>{end}</div>'
    )


def section(label: str, inner: str, foot: str = "", act: str = "") -> str:
    a = f'<span class="act">{html.escape(act)}</span>' if act else ""
    f = f'<div class="foot">{html.escape(foot)}</div>' if foot else ""
    return f'<div class="sec"><div class="ak-section">{html.escape(label)}{a}</div>{inner}{f}</div>'


def group(*rows: str) -> str:
    return f'<div class="ak-group">{"".join(rows)}</div>'


def header() -> str:
    return (
        '<div class="head">'
        f'<span class="ak-iconbtn more" title="More">{icon("dots-three")}</span>'
        f'<span class="ak-avatar face">N</span>'
        f'<h2 class="name">{NAME}</h2>'
        '<div class="handle">@nova</div>'
        "</div>"
    )


BIO = "Keeps my calendar tidy, drafts replies to work email and reminds me before meetings."


def about(error: bool = False) -> str:
    if error:
        inner = group(
            '<div class="inline-state">'
            f'{icon("warning-circle")}<span class="msg">Couldn’t load {NAME}’s info.</span>'
            '<button class="ak-btn ak-btn--sm">Try again</button></div>'
        )
        return section("About", inner)
    inner = group(
        f'<div class="bio">{html.escape(BIO)}</div>',
        row(None, "Personality", "Calm, keeps it short"),
    )
    return section("About", inner, act="Edit")


def on_its_own(paused: bool = False, empty: bool = False) -> str:
    count = "None yet" if empty else ("3 · paused" if paused else "3 routines")
    return section(
        "On its own",
        group(
            row("calendar-check", "Routines", count),
            row("pause", "Pause", trail="on" if paused else "off"),
        ),
    )


def chat(pet: bool = True) -> str:
    rows = [row("sparkle", "Answers with", "GPT-6 Luna"), row("bell", "Notifications", trail="on")]
    if pet:
        rows.append(row("paw-print", "Pet", "Pip"))
    return section("In this chat", group(*rows), foot=f"In groups, {NAME} answers only you.")


def can_use() -> str:
    return section(
        "Can use",
        group(row("laptop", "Your devices", "MacBook Air"), row("puzzle-piece", "Skills", "121")),
    )


def files(state: str = "some") -> str:
    if state == "empty":
        return section("Files", '<div class="quiet">No files yet.</div>')
    if state == "failed":
        return section(
            "Files",
            group(
                '<div class="inline-state">'
                f'{icon("warning-circle")}<span class="msg">Couldn’t load its files.</span>'
                '<button class="ak-btn ak-btn--sm">Try again</button></div>'
            ),
        )
    return section(
        "Files",
        group(
            file_row("file-doc", "Weekly plan.docx", "Sent here · 2 h ago"),
            file_row("file-pdf", "Meeting notes.pdf", "Sent here · yesterday"),
            file_row("folder-simple", "Reports", "On its computer · 4 items", "caret"),
            row(None, "Show all files", "12"),
        ),
    )


def paused_notice() -> str:
    return (
        f'<div class="ak-notice">{icon("pause")}<div class="ak-notice-main">'
        '<div class="ak-notice-title">Paused</div>'
        '<div class="ak-notice-body">Still answers you. Starts nothing on its own.</div></div>'
        '<div class="ak-notice-actions"><button class="ak-btn ak-btn--sm">Resume</button></div></div>'
    )


def now_block() -> str:
    return (
        '<div class="now">'
        f'<div class="now-head">{ATOM}<span>Working · 3 min</span></div>'
        '<div class="now-line">Drafting replies to 4 work emails</div>'
        '<ul class="steps">'
        f'<li>{icon("check-circle")}Read the new mail</li>'
        f'<li>{icon("check-circle")}Checked your calendar</li>'
        f'<li class="on">{icon("circle-dashed")}Writing the replies</li>'
        "</ul>"
        f'<div><button class="ak-btn ak-btn--sm">{icon("stop")}Stop</button></div>'
        "</div>"
    )


def menu() -> str:
    def item(name: str, label: str, danger: bool = False) -> str:
        cls = "ak-menu-item ak-menu-item--danger" if danger else "ak-menu-item"
        return f'<div class="{cls}">{icon(name)}<span>{html.escape(label)}</span></div>'

    return (
        '<div class="menu-scrim"></div><div class="ak-menu ak-glass menu">'
        + item("camera", "Change photo")
        + item("pencil-simple", "Rename")
        + item("copy", "Copy @nova")
        + item("at", "Change @handle…")
        + item("paw-print", "Change pet…")
        + '<div class="ak-menu-sep"></div>'
        + item("trash", f"Delete {NAME}…", danger=True)
        + "</div>"
    )


def edit_sheet() -> str:
    return (
        '<div class="sheet-scrim"><div class="ak-sheet">'
        f'<div class="ak-sheet-head"><h3 class="ak-sheet-title">About {NAME}</h3></div>'
        '<div class="ak-sheet-body">'
        f'<label class="ak-field-wrap"><div class="ak-field-label">What {NAME} helps with</div>'
        f'<div class="ak-field tall"><textarea>{html.escape(BIO)}</textarea></div></label>'
        '<label class="ak-field-wrap"><div class="ak-field-label">Personality</div>'
        '<div class="ak-field"><input value="Calm, keeps it short"></div></label>'
        '<div class="foot" style="padding:0">Changes apply from your next message.</div>'
        "</div>"
        '<div class="ak-sheet-foot"><button class="ak-btn ak-btn--primary">Done</button></div>'
        "</div></div>"
    )


def panel(body: str, overlay: str = "") -> str:
    return (
        '<div class="panel ak-content">'
        f'<div class="tabs"><span class="tab"><span class="ak-avatar">N</span>{NAME}</span>'
        f'<span class="tab-plus">{icon("plus", "ak-icon ak-icon--sm")}</span></div>'
        f'<div class="body">{body}</div>{overlay}</div>'
    )


def card(*, paused=False, error=False, files_state="some", working=False, empty=False, pet=True) -> str:
    parts = [header()]
    if working:
        parts.append(now_block())
    if paused:
        parts.append(paused_notice())
    parts += [about(error), on_its_own(paused, empty), chat(pet), can_use(), files(files_state)]
    return "".join(parts)


def today() -> str:
    """A faithful sketch of the current card's panel placement, for the before/after."""
    raw = (
        "# Nova\n\n## What you do\nKeep the calendar tidy and draft work replies.\n"
        "Save drafts in /workspace/notes/drafts and read\n/workspace/notes/people.md first.\n\n"
        "## Rules\n- Always check the calendar\n- Use `calendar-sync` before\n  any change\n- ..."
    )
    rows = [
        row(None, "Model", "GPT-6 Luna"),
        row(None, "Notifications", trail="on"),
        row(None, "Your devices", "1"),
        '<div class="ak-row"><span class="ak-row-main"><span>Pause</span><span class="ak-row-meta">'
        "Nothing scheduled yet.</span></span><span class=\"ak-switch\"></span></div>",
        row(None, "Pet", "Choose"),
        row(None, "Skills", "121"),
        row(None, "Background follow-ups", trail="on"),
        row(None, "Routines", "3 routines"),
    ]
    body = (
        '<div class="head" style="padding-top:0"><span class="ak-avatar face">N</span>'
        f'<div class="old-name">{NAME}</div><div class="old-privacy">In groups, {NAME} answers only you.</div></div>'
        '<div class="sec"><div class="old-label">Bot handle</div>'
        '<div class="old-help">Others type this @name to find and mention the assistant.</div>'
        '<div class="ak-field"><input value="nova"></div></div>'
        f'<div class="sec"><div class="old-label">What does {NAME} help you with?</div>'
        f'<div class="ak-group"><div class="old-area">{html.escape(raw)}</div>'
        + row(None, "Personality", "Not set")
        + '</div><div class="foot">Changes apply from your next message.</div></div>'
        + f'<div class="sec">{group(*rows)}</div>'
        + '<div class="sec"><div class="old-label">Files</div>'
        + group(file_row("file-doc", "Weekly plan.docx", "Sent in this chat"))
        + '<div class="old-label" style="margin-top:12px">On its computer</div>'
        + group(file_row("folder-simple", "Reports", ""), file_row("file", "notes.md", "2 KB · yesterday"))
        + "</div>"
        + group(f'<div class="ak-row" style="color:var(--ak-danger)">Delete {NAME}…</div>')
    )
    return body


STATES = {
    # name: (body builder, overlay builder, window height)
    "normal": (lambda: card(), lambda: "", 1130),
    "paused": (lambda: card(paused=True), lambda: "", 1240),
    "files-empty": (lambda: card(files_state="empty", empty=True, pet=False), lambda: "", 1000),
    "error": (lambda: card(error=True), lambda: "", 1090),
    "working": (lambda: card(working=True), lambda: "", 1390),
    "menu": (lambda: card(), menu, 1130),
    "edit-about": (lambda: card(), edit_sheet, 1130),
}


def page(theme: str, body: str, overlay: str) -> str:
    return (
        f'<!doctype html><html class="ak-{theme}"><head><meta charset="utf-8">'
        f'<link rel="stylesheet" href="{KIT_CSS.as_uri()}">'
        f"<style>{CSS % {'w': PANEL_W}}</style></head>"
        f"<body class=\"ak-{theme}\">{panel(body, overlay)}</body></html>"
    )


def shoot(src: Path, png: Path, height: int) -> None:
    profile = tempfile.mkdtemp(prefix="agent-card-chrome-")
    try:
        subprocess.run(
            [
                CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                f"--user-data-dir={profile}", f"--window-size={PANEL_W + 16},{height}",
                f"--screenshot={png}", "--default-background-color=00000000", src.as_uri(),
            ],
            check=True, capture_output=True, timeout=60,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    html_only = "--html-only" in sys.argv
    work = Path(tempfile.mkdtemp(prefix="agent-card-html-"))
    jobs = [(f"{n}-{t}", page(t, b(), o()), h) for n, (b, o, h) in STATES.items() for t in ("light", "dark")]
    jobs.append(("today-light", page("light", today(), ""), 1380))
    for name, doc, height in jobs:
        src = work / f"{name}.html"
        src.write_text(doc)
        if not html_only:
            shoot(src, OUT / f"{name}.png", height)
            print("wrote", (OUT / f"{name}.png").relative_to(ROOT))
    print("html in", work)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
