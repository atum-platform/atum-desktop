#!/usr/bin/env python3
"""Work mode, Cowork-style (owner 2026-11-28): mockups on the real Atum Kit CSS.

Renders each frame as static HTML on packages/atum-kit/dist/atum-kit.css and its pinned Phosphor Light
paths, then screenshots it with headless Google Chrome into docs/mockups/work-cowork/*.png.

    python3 docs/mockups/work-cowork/src/build.py            # HTML + PNGs
    python3 docs/mockups/work-cowork/src/build.py --html-only

Names are generic: the assistant is "Nova", the owner is unnamed.
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
CANVAS_W = 1180
E = html.escape


def icon(name: str, cls: str = "ak-icon") -> str:
    paths = "".join(f'<path d="{d}"/>' for d in ICONS["light"][name])
    return f'<svg class="{cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">{paths}</svg>'


def sm(name: str) -> str:
    return icon(name, "ak-icon ak-icon--sm")


def atum_mark(size: int = 40) -> str:
    return (
        f'<svg class="atum-mark" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1">'
        '<circle cx="12" cy="12" r="10.5" stroke-opacity=".45"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>'
        '<circle cx="12" cy="1.9" r="2.2" fill="currentColor" stroke="none"/></svg>'
    )


# ---------------------------------------------------------------- the window


def band(*, plus: bool = False, title: str = "Work", note: str = "") -> str:
    """The desktop title band over Work: lights, list toggle, history arrows, [old plus], title; mode + panel."""
    p = f'<span class="bbtn{" is-flag" if note else ""}">{sm("plus")}</span>' if plus else ""
    flag = f'<span class="flag">{E(note)}</span>' if note else ""
    return (
        '<div class="band"><span class="lights"><i></i><i></i><i></i></span>'
        f'<span class="bbtn">{sm("sidebar-simple")}</span><span class="bbtn">{sm("arrow-left")}</span>'
        f'<span class="bbtn is-dim">{sm("arrow-right")}</span>{p}{flag}<span class="btitle">{E(title)}</span>'
        '<span class="bgap"></span><span class="ak-seg seg"><span class="is-on">Work</span><span>Code</span></span>'
        f'<span class="bbtn">{sm("sidebar-simple")}</span></div>'
    )


def rail() -> str:
    items = [("chat-circle", ""), ("users", ""), ("folder-simple", ""), ("briefcase", "is-on"), ("squares-four", "")]
    btns = "".join(f'<span class="ak-iconbtn {c}">{icon(n)}</span>' for n, c in items)
    return f'<div class="rail">{btns}<span class="rail-gap"></span><span class="ak-iconbtn">{icon("gear")}</span></div>'


def list_head(menu: bool = False) -> str:
    pop = ""
    if menu:
        pop = (
            '<div class="ak-menu ak-glass newmenu">'
            f'<div class="ak-menu-item">{sm("note-pencil")}<span>New session</span><span class="ak-menu-key">⌘N</span></div>'
            '<div class="ak-menu-sep"></div>'
            f'<div class="ak-menu-item">{sm("folder-simple-plus")}<span>Add project…</span></div></div>'
        )
    return (
        '<div class="lhead"><div class="ak-field ak-field--search">'
        f'{sm("magnifying-glass")}<span class="ak-placeholder">Search</span></div>'
        f'<span class="hbtn">{sm("funnel-simple")}</span><span class="hbtn{" is-open" if menu else ""}">{sm("plus")}</span>{pop}</div>'
    )


def group(name: str, rows: list[tuple[str, str, str]], *, lead: str, collapsed: int = 0, auto: bool = False) -> str:
    caret = sm("caret-right") if collapsed else sm("caret-down")
    count = f'<span class="gcount">{collapsed}</span>' if collapsed else ""
    tag = '<span class="gtag">Assistant</span>' if auto else ""
    head = f'<div class="ghead">{lead}<span class="gname">{E(name)}</span>{tag}<span class="ggap"></span>{count}{caret}</div>'
    body = "".join(
        f'<div class="srow {cls}"><span class="stitle">{E(t)}</span><span class="swhen">{E(w)}</span></div>' for t, w, cls in rows
    )
    return f'<div class="grp">{head}{"" if collapsed else body}</div>'


def face(letter: str) -> str:
    return f'<span class="gface">{E(letter)}</span>'


def folder() -> str:
    return f'<span class="gfold">{sm("folder-simple")}</span>'


def session_list(menu: bool = False, open_row: str = "") -> str:
    def r(t: str, w: str) -> tuple[str, str, str]:
        return (t, w, "is-on" if t == open_row else "")

    groups = [
        group("Nova", [r("Q4 board deck", "2h"), r("Reply to the venue", "Yesterday"), r("Team offsite budget", "Mon")], lead=face("N"), auto=True),
        group("Q4 planning", [r("Hiring plan draft", "Tue"), r("Revenue forecast", "Nov 20")], lead=folder()),
        group("Website copy", [], lead=folder(), collapsed=3),
        group("No project", [r("Quick question about VAT", "Nov 18")], lead=folder()),
    ]
    return f'<div class="list ak-panel">{list_head(menu)}<div class="groups">{"".join(groups)}</div></div>'


def window(main: str, *, menu: bool = False, open_row: str = "", plus: bool = False, overlay: str = "") -> str:
    return (
        f'<div class="win">{band(plus=plus)}<div class="wbody">{rail()}{session_list(menu, open_row)}'
        f'<div class="main ak-panel">{main}</div>{overlay}</div></div>'
    )


# ---------------------------------------------------------------- the home


def composer(project_open: bool = False) -> str:
    return (
        '<div class="comp"><div class="comp-ph">How can I help today?</div>'
        f'<div class="comp-row"><span class="ccreate">{sm("plus")}Create{sm("caret-down")}</span>'
        f'<span class="cgap"></span><span class="mchip">Claude Sonnet 5.5<span class="eff">High</span>{sm("caret-down")}</span>'
        f'<span class="send">{sm("arrow-up")}</span></div></div>'
        '<div class="under">'
        f'<span class="pchip{" is-open" if project_open else ""}">{sm("folder-simple")}Project or folder{sm("caret-down")}</span>'
        '<span class="ugap"></span></div>'
    )


def chips() -> str:
    return (
        '<div class="schips">'
        f'<span class="schip">{sm("file-text")}Write</span><span class="schip">{sm("presentation")}Design</span>'
        f'<span class="schip">{sm("file-xls")}Analyze numbers</span></div>'
    )


def recent() -> str:
    cards = [
        ("file-ppt", "Q4 board deck.pptx", "Nova · 2h ago", "t-slides"),
        ("file-xls", "Offsite budget.xlsx", "Nova · Mon", "t-sheet"),
        ("file-doc", "Venue reply.docx", "Nova · Yesterday", "t-doc"),
    ]
    out = "".join(
        f'<div class="rcard"><div class="thumb {t}">{icon(ic, "ak-icon ak-icon--xl")}</div>'
        f'<div class="rname">{E(n)}</div><div class="rmeta">{E(m)}</div></div>'
        for ic, n, m, t in cards
    )
    return (
        '<div class="recent"><div class="rhead"><span>Recent files</span><span class="rall">View all</span></div>'
        f'<div class="rgrid">{out}</div></div>'
    )


def home(project_open: bool = False) -> str:
    return (
        '<div class="home">'
        f'<div class="hero">{atum_mark(36)}<h1 class="greet">Good evening</h1></div>'
        f'{composer(project_open)}{chips()}{recent()}</div>'
    )


def picker_popover() -> str:
    def item(lead: str, name: str, sub: str = "", on: bool = False) -> str:
        chk = f'<span class="pchk">{sm("check")}</span>' if on else ""
        s = f'<span class="psub">{E(sub)}</span>' if sub else ""
        return f'<div class="ak-menu-item pitem">{lead}<span class="pmain"><span>{E(name)}</span>{s}</span>{chk}</div>'

    return (
        '<div class="ak-menu ak-glass picker">'
        f'<div class="ak-field ak-field--search pfind">{sm("magnifying-glass")}<span class="ak-placeholder">Find a project</span></div>'
        '<div class="ak-menu-label">Projects</div>'
        + item(face("N"), "Nova")
        + item(face("O"), "Orion")
        + item(folder(), "Q4 planning")
        + item(folder(), "Website copy")
        + '<div class="ak-menu-sep"></div>'
        + f'<div class="ak-menu-item pitem">{sm("folder-open")}<span class="pmain"><span>Choose a folder…</span>'
        '<span class="psub">On this Mac or in Drive</span></span></div></div>'
    )


# ---------------------------------------------------------------- an open session


def session_main() -> str:
    return (
        '<div class="shead"><span class="stitle-h">Q4 board deck</span><span class="sproj">Nova</span></div>'
        '<div class="tx">'
        '<div class="own">Make a 10-slide board deck from the Q4 numbers in my Drive.</div>'
        '<div class="agent"><p>Done. Ten slides: highlights, revenue, costs, hiring, and the asks for Q1. '
        'The revenue chart uses the November close.</p>'
        f'<div class="fcard"><span class="ficon">{icon("file-ppt")}</span><span class="fmain"><span class="fname">Q4 board deck.pptx</span>'
        '<span class="fmeta">Slides · saved to Nova’s Drive</span></span><span class="ak-btn ak-btn--sm ak-btn--plain">Open</span></div></div>'
        '</div>'
        '<div class="comp comp-low"><div class="comp-ph">Ask for changes</div>'
        f'<div class="comp-row"><span class="cicon">{sm("plus")}</span><span class="cgap"></span>'
        f'<span class="mchip">Claude Sonnet 5.5<span class="eff">High</span>{sm("caret-down")}</span><span class="send">{sm("arrow-up")}</span></div></div>'
    )


# ---------------------------------------------------------------- title band before / after


def bands_frame() -> str:
    return (
        '<div class="bands">'
        '<div class="bcap">Before: two plus buttons, one menu.</div>'
        f'<div class="bstrip">{band(plus=True, note="New… (same menu as the list’s +)")}</div>'
        f'<div class="bstrip under-list">{list_head()}</div>'
        '<div class="bcap">After: the band keeps history and the title; New lives on the list.</div>'
        f'<div class="bstrip">{band()}</div>'
        f'<div class="bstrip under-list">{list_head(menu=True)}</div>'
        '</div>'
    )


# ---------------------------------------------------------------- frames

FRAMES = [
    ("01-work-home", "Work home", "A greeting, one composer, Project or folder under it, three starters. Recent files is slice 2.",
     lambda: window(home()), ("light", "dark"), 860),
    ("02-project-picker", "Project or folder", "The project chip lists every project (each assistant has one) and Choose a folder… for any Mac or Drive folder.",
     lambda: window(home(project_open=True), overlay=picker_popover()), ("light", "dark"), 860),
    ("03-sessions-by-project", "Sessions by project", "The list groups sessions under their project, newest first; a closed project shows its count. The list’s + is the one New.",
     lambda: window(session_main(), menu=True, open_row="Q4 board deck"), ("light", "dark"), 860),
    ("04-title-band", "The title band’s plus", "The band’s + opened the same menu as the list’s +. It goes; Work keeps one New, on the list.",
     bands_frame, ("light",), 560),
]

CSS = r"""
html, body { margin: 0; }
body { width: %(w)spx; background: var(--ak-ground); font: var(--ak-t-body); color: var(--ak-ink); }
.frame { padding: 26px 34px 34px; box-sizing: border-box; }
.f-head { display: flex; align-items: baseline; gap: 14px; }
.f-no { font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-3); }
.f-title { font: var(--ak-t-title); margin: 0; }
.f-cap { color: var(--ak-ink-2); margin: 6px 0 18px; }
.stage { display: flex; justify-content: center; }

.win { width: 1100px; height: 740px; border-radius: 12px; overflow: hidden; background: var(--ak-chrome); box-shadow: var(--ak-shadow-3), inset 0 0 0 .5px var(--ak-line-2); display: flex; flex-direction: column; }
.band { height: 44px; display: flex; align-items: center; gap: 2px; padding: 0 10px 0 14px; flex: none; position: relative; }
.lights { display: inline-flex; gap: 8px; margin-right: 14px; } .lights i { width: 12px; height: 12px; border-radius: 50%%; background: var(--ak-line-2); display: block; }
.bbtn { width: 28px; height: 28px; border-radius: var(--ak-r-md); display: inline-flex; align-items: center; justify-content: center; color: var(--ak-ink-2); }
.bbtn.is-dim { color: var(--ak-ink-4); }
.bbtn.is-flag { box-shadow: 0 0 0 2px var(--ak-danger); color: var(--ak-danger); }
.flag { font: var(--ak-t-caption); font-weight: 600; color: var(--ak-danger); margin: 0 10px 0 6px; }
.btitle { font: var(--ak-t-headline); margin-left: 10px; }
.bgap { flex: 1; }
.seg { margin-right: 6px; } .seg span { padding: 0 12px; } .seg .is-on { font-weight: 600; }
.wbody { flex: 1; min-height: 0; display: flex; gap: 8px; padding: 0 8px 8px 0; position: relative; }
.rail { width: 52px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.rail .is-on { background: var(--ak-fill-selected); color: var(--ak-ink); }
.rail-gap { flex: 1; }
.list { width: 272px; flex: none; display: flex; flex-direction: column; border-radius: var(--ak-r-lg); padding: 10px 8px; box-sizing: border-box; gap: 10px; }
.main { flex: 1; min-width: 0; border-radius: var(--ak-r-lg); display: flex; flex-direction: column; position: relative; overflow: hidden; }

.lhead { display: flex; align-items: center; gap: 6px; position: relative; }
.lhead .ak-field--search { flex: 1; min-width: 0; }
.hbtn { width: 28px; height: 28px; flex: none; border-radius: var(--ak-r-md); display: inline-flex; align-items: center; justify-content: center; color: var(--ak-ink-2); }
.hbtn.is-open { background: var(--ak-fill-press); color: var(--ak-ink); }
.newmenu { position: absolute; top: 34px; right: 0; width: 220px; z-index: 3; }
.groups { display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.ghead { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; color: var(--ak-ink-2); font: var(--ak-t-callout); font-weight: 600; }
.gname { color: var(--ak-ink); }
.gtag { font: var(--ak-t-caption); color: var(--ak-ink-3); font-weight: 500; }
.ggap { flex: 1; }
.gcount { font: var(--ak-t-caption); color: var(--ak-ink-3); font-weight: 500; }
.gface { width: 20px; height: 20px; border-radius: 50%%; background: var(--ak-monogram); color: var(--ak-on-ink); display: inline-flex; align-items: center; justify-content: center; font: 700 10px/1 var(--ak-font); flex: none; }
.gfold { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; color: var(--ak-ink-3); flex: none; }
.srow { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 36px; border-radius: var(--ak-r-md); }
.srow.is-on { background: var(--ak-fill-selected); }
.stitle { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.swhen { font: var(--ak-t-caption); color: var(--ak-ink-3); }

.home { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 48px 28px; gap: 0; }
.hero { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-bottom: 26px; }
.greet { font: var(--ak-t-display); letter-spacing: -.01em; margin: 0; }
.comp { width: 620px; border-radius: var(--ak-r-xl); background: var(--ak-surface); box-shadow: var(--ak-shadow-1), inset 0 0 0 1px var(--ak-line-2); padding: 14px 12px 10px 16px; box-sizing: border-box; display: flex; flex-direction: column; gap: 22px; }
.comp-ph { color: var(--ak-ink-3); font: var(--ak-t-chat); }
.comp-row { display: flex; align-items: center; gap: 6px; }
.cicon { width: 28px; height: 28px; border-radius: 50%%; display: inline-flex; align-items: center; justify-content: center; color: var(--ak-ink-2); box-shadow: inset 0 0 0 1px var(--ak-line-2); }
.ccreate { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: var(--ak-r-full); color: var(--ak-ink-2); font: var(--ak-t-callout); font-weight: 600; }
.cgap, .ugap { flex: 1; }
.mchip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: var(--ak-r-full); color: var(--ak-ink-2); font: var(--ak-t-callout); font-weight: 600; }
.eff { color: var(--ak-ink-3); font-weight: 500; }
.send { width: 30px; height: 30px; border-radius: 50%%; background: var(--ak-ink); color: var(--ak-on-ink); display: inline-flex; align-items: center; justify-content: center; }
.under { width: 620px; display: flex; align-items: center; padding: 10px 6px 0; box-sizing: border-box; }
.pchip { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 10px 0 6px; border-radius: var(--ak-r-full); font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); }
.pchip.is-open { background: var(--ak-fill-press); color: var(--ak-ink); }
.schips { display: flex; gap: 8px; margin-top: 18px; }
.schip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--ak-r-full); background: var(--ak-fill-quiet); font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); }
.recent { width: 620px; margin-top: 40px; }
.rhead { display: flex; justify-content: space-between; font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); margin-bottom: 10px; }
.rall { color: var(--ak-ink-3); font-weight: 500; }
.rgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.rcard { display: flex; flex-direction: column; gap: 2px; }
.thumb { height: 104px; border-radius: var(--ak-r-lg); display: flex; align-items: center; justify-content: center; background: var(--ak-sunk); box-shadow: inset 0 0 0 1px var(--ak-line); color: var(--ak-ink-3); margin-bottom: 6px; }
.rname { font: var(--ak-t-callout); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rmeta { font: var(--ak-t-caption); color: var(--ak-ink-3); }

.picker { position: absolute; left: 418px; top: 330px; width: 300px; z-index: 4; }
.pfind { margin: 4px 4px 6px; }
.pitem { gap: 10px; height: auto; min-height: 40px; padding-top: 4px; padding-bottom: 4px; }
.pmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.psub { font: var(--ak-t-caption); color: var(--ak-ink-3); }
.pchk { color: var(--ak-ink-2); display: inline-flex; }

.shead { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 20px; border-bottom: 1px solid var(--ak-line); flex: none; }
.stitle-h { font: var(--ak-t-headline); }
.sproj { font: var(--ak-t-callout); color: var(--ak-ink-3); }
.tx { flex: 1; display: flex; flex-direction: column; gap: 18px; padding: 26px 48px; width: 720px; box-sizing: border-box; align-self: center; }
.own { align-self: flex-end; max-width: 460px; background: var(--ak-bubble-own); color: var(--ak-on-bubble-own); border-radius: var(--ak-r-xl); padding: 9px 14px; font: var(--ak-t-chat); }
.agent p { margin: 0 0 12px; font: var(--ak-t-chat); }
.fcard { display: flex; align-items: center; gap: 12px; max-width: 420px; border-radius: 24px; padding: 10px 12px; box-shadow: inset 0 0 0 1px var(--ak-line-2); }
.ficon { width: 40px; height: 40px; border-radius: 12px; background: var(--ak-fill-quiet); display: inline-flex; align-items: center; justify-content: center; }
.fmain { flex: 1; display: flex; flex-direction: column; } .fname { font-weight: 600; } .fmeta { font: var(--ak-t-caption); color: var(--ak-ink-3); }
.comp-low { align-self: center; margin-bottom: 20px; gap: 14px; }

.bands { width: 1100px; display: flex; flex-direction: column; gap: 10px; }
.bcap { font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); margin-top: 8px; }
.bstrip { border-radius: 10px; background: var(--ak-chrome); box-shadow: inset 0 0 0 .5px var(--ak-line-2); }
.bstrip.under-list { width: 272px; padding: 10px 8px; background: var(--ak-surface); margin-left: 60px; position: relative; height: 32px; }
.bstrip.under-list .newmenu { top: 44px; }
"""


def page(theme: str, n: int, title: str, caption: str, body: str) -> str:
    return (
        f'<!doctype html><html class="ak-{theme}"><head><meta charset="utf-8">'
        f'<link rel="stylesheet" href="{KIT_CSS.as_uri()}"><style>{CSS % {"w": CANVAS_W}}</style></head>'
        f'<body class="ak-{theme}"><div class="frame"><div class="f-head"><span class="f-no">{n:02d}</span>'
        f'<h1 class="f-title">{E(title)}</h1></div><p class="f-cap">{E(caption)}</p><div class="stage">{body}</div></div></body></html>'
    )


def shoot(src: Path, png: Path, height: int) -> None:
    profile = tempfile.mkdtemp(prefix="work-cowork-chrome-")
    png.unlink(missing_ok=True)
    try:
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5",
             f"--user-data-dir={profile}", f"--window-size={CANVAS_W},{height}", f"--screenshot={png}", src.as_uri()],
            check=False, capture_output=True, timeout=90,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    if not png.exists() or png.stat().st_size < 10_000:
        raise RuntimeError(f"Chrome did not write {png}")


BUILT = (
    '<section class="card no-dark" id="built"><header><span class="n">↳</span><h2>Built: the real Work view</h2></header>'
    "<p>Screenshots from atum-work’s browser tests (branch feat/work-cowork-projects) on T3’s test harness, so "
    "without the Atum theme or the desktop band. Recent files is not built yet.</p>"
    + "".join(
        f'<p>{E(cap)}</p><img class="t-light" src="built/{name}" alt="{E(cap)}" loading="lazy">'
        for name, cap in [
            ("work-no-project-home-light.png", "No-project home: greeting, composer, Project or folder, starters."),
            ("work-project-picker-light.png", "The chip open on a project draft: projects and Choose a folder…"),
            ("work-project-picker-dark.png", "The same, dark."),
            ("work-list-by-project-light.png", "The list grouped by project; the list’s + offers New session and Add project."),
        ]
    )
    + "</section>"
)


def index_page() -> str:
    cards = []
    for n, (fid, title, caption, _b, themes, _h) in enumerate(FRAMES, start=1):
        imgs = "".join(f'<img class="t-{t}" src="{fid}-{t}.png" alt="{E(title)} ({t})" loading="lazy">' for t in themes)
        dark = "" if "dark" in themes else " no-dark"
        cards.append(f'<section class="card{dark}" id="{fid}"><header><span class="n">{n:02d}</span><h2>{E(title)}</h2></header><p>{E(caption)}</p>{imgs}</section>')
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>Work, Cowork style</title><style>"
        ":root{--bg:#f4f5f7;--ink:#1b1d22;--ink3:#5f646d;--line:rgba(23,25,31,.12)}"
        "@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#17181c;--ink:#ecedf0;--ink3:#9da2ab;--line:rgba(255,255,255,.12)}}"
        "body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}"
        "main{max-width:1180px;margin:0 auto;padding:32px 16px 80px}h1{font-size:26px;margin:0 0 4px}.lede{color:var(--ink3);margin:0 0 20px;max-width:72ch}"
        ".bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);z-index:1;display:flex;gap:12px;align-items:center}"
        "button{font:inherit;border:0;border-radius:8px;padding:6px 12px;background:var(--line);color:var(--ink)}"
        ".card{padding:28px 0;border-bottom:1px solid var(--line)}header{display:flex;gap:12px;align-items:baseline}h2{font-size:20px;margin:0}"
        ".n{color:var(--ink3);font-size:13px}.card p{margin:4px 0 12px;color:var(--ink3)}img{width:100%;height:auto;border-radius:10px;display:block}"
        "body:not(.dark) img.t-dark{display:none}body.dark img.t-light{display:none}body.dark .no-dark img.t-light{display:block}"
        "</style></head><body><main><h1>Work, Cowork style</h1>"
        '<p class="lede">Owner 2026-11-28: Work should choose its project or folder, organize sessions by project, drop T3’s '
        "threads and worktrees language, and lose the band’s redundant plus. Decisions and what ships first: README.md.</p>"
        '<div class="bar"><button onclick="document.body.classList.toggle(\'dark\')">Light / dark</button></div>'
        + "".join(cards) + BUILT + "</main></body></html>\n"
    )


def main() -> int:
    html_only = "--html-only" in sys.argv
    work = Path(tempfile.mkdtemp(prefix="work-cowork-html-"))
    for n, (fid, title, caption, build, themes, height) in enumerate(FRAMES, start=1):
        body = build()
        for theme in themes:
            src = work / f"{fid}-{theme}.html"
            src.write_text(page(theme, n, title, caption, body))
            if not html_only:
                shoot(src, OUT / f"{fid}-{theme}.png", height)
                print("wrote", (OUT / f"{fid}-{theme}.png").relative_to(ROOT))
    (OUT / "index.html").write_text(index_page())
    print("html in", work)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
