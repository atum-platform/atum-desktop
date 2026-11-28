#!/usr/bin/env python3
"""New-user flow storyboard (docs/plans/2026-11-28-unified-first-run-and-48h.md).

Renders every frame of a brand-new person's first 48 hours as static HTML on the real Atum Kit CSS
(packages/atum-kit/dist/atum-kit.css) and its pinned Phosphor Light paths, then screenshots each frame
with headless Google Chrome into docs/mockups/new-user-flow/*.png. Each PNG carries its own timeline
strip and one-line trigger caption, so it reads on its own; index.html shows them in order.

    python3 docs/mockups/new-user-flow/src/build.py            # HTML + PNGs
    python3 docs/mockups/new-user-flow/src/build.py --html-only

Every name is generic: the assistant is "Nova", the owner is unnamed, and the people in the example
work are roles ("the design team", "the venue"). Agent lines are examples of the agent's own voice;
the product never ships them as fixed text.
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

CANVAS_W = 1280
NAME = "Nova"
E = html.escape


def icon(name: str, cls: str = "ak-icon") -> str:
    paths = "".join(f'<path d="{d}"/>' for d in ICONS["light"][name])
    return f'<svg class="{cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">{paths}</svg>'


# ---------------------------------------------------------------- timeline

# (key, label, clock) — the example person signs up on a Tuesday at 09:40, owner-local.
TIMELINE = [
    ("signup", "Sign-up", "Tue 09:40"),
    ("t0", "T+0", "09:42"),
    ("t6", "T+6 s", "09:42"),
    ("t2m", "+2 min", "09:44"),
    ("t5m", "+5 min", "09:47"),
    ("t15m", "+15 min", "09:57"),
    ("t35m", "+35 min", "10:17"),
    ("t60m", "+60 min", "10:42"),
    ("eve", "Day 1 eve", "18:00"),
    ("brief", "Brief", "Wed 08:00"),
    ("quiet", "Quiet idea", "11:30"),
    ("day2", "Day 2", "from 17:42"),
    ("h48", "48 h", "Thu 09:42"),
]


def strip(at: str) -> str:
    keys = [k for k, _, _ in TIMELINE]
    i = keys.index(at)
    cells = []
    for n, (key, label, clock) in enumerate(TIMELINE):
        cls = "tl-cell" + (" is-now" if n == i else " is-past" if n < i else "")
        cells.append(f'<div class="{cls}"><span class="tl-dot"></span><span class="tl-l">{E(label)}</span><span class="tl-c">{E(clock)}</span></div>')
    return f'<div class="tl">{"".join(cells)}</div>'


# ---------------------------------------------------------------- chat parts

def avatar(letter: str = "N", cls: str = "") -> str:
    return f'<span class="ak-avatar {cls}">{E(letter)}</span>'


def agent_msg(*paras: str, time: str = "", first: bool = True) -> str:
    body = "".join(f"<p>{p}</p>" for p in paras)
    head = f'<div class="who">{NAME}<span class="when">{E(time)}</span></div>' if first else ""
    face = avatar() if first else '<span class="face-gap"></span>'
    return f'<div class="msg">{face}<div class="msg-col">{head}<div class="bubble">{body}</div></div></div>'


def own_msg(text: str) -> str:
    return f'<div class="msg own"><div class="bubble own">{E(text)}</div></div>'


def own_tap(label: str) -> str:
    """Storyboard note: which button of the ask row the person pressed (nothing is sent to the chat)."""
    return f'<div class="tap-note">tapped “{E(label)}”</div>'


def typing(note: str = "") -> str:
    dots = '<span class="dots"><i></i><i></i><i></i></span>'
    n = f'<div class="typing-note">{E(note)}</div>' if note else ""
    return f'<div class="msg">{avatar()}<div class="msg-col"><div class="who">{NAME}</div><div class="bubble typing">{dots}</div>{n}</div></div>'


def quiet_state() -> str:
    return (
        f'<div class="msg">{avatar()}<div class="msg-col"><div class="who">{NAME}</div>'
        f'<div class="quiet-line">{NAME} isn’t answering yet.<button class="ak-btn ak-btn--sm">Try again</button></div></div></div>'
    )


def day_sep(text: str) -> str:
    return f'<div class="day-sep"><span>{E(text)}</span></div>'


def learning_line(text: str, done: bool = False) -> str:
    mark = icon("check-circle", "ak-icon ak-icon--sm") if done else '<span class="ak-spinner"></span>'
    return f'<div class="learn"><span class="face-gap"></span>{mark}<span>{E(text)}</span></div>'


# ---------------------------------------------------------------- the one Connections list

def mark(letter: str, ic: str | None = None) -> str:
    inner = icon(ic, "ak-icon ak-icon--sm") if ic else E(letter)
    return f'<span class="cmark">{inner}</span>'


# state: connect | connecting | connected | ready | skipped
def crow(lead: str, name: str, line: str, state: str, note: str = "", tint: bool = False) -> str:
    sub = note or line
    if state == "connect":
        end = '<button class="ak-btn ak-btn--sm cbtn">Connect</button>'
    elif state == "connecting":
        end = '<span class="cstate"><span class="ak-spinner"></span></span>'
    elif state in ("connected", "ready"):
        word = "Connected" if state == "connected" else "Ready"
        end = f'<span class="cstate ok">{icon("check", "ak-icon ak-icon--sm")}{word}</span>'
    elif state == "skipped":
        end = '<button class="ak-btn ak-btn--sm ak-btn--plain cbtn">Connect</button>'
        sub = "Skipped"
    elif state == "settings":
        end = '<button class="ak-btn ak-btn--sm cbtn">Open Settings</button>'
    else:
        raise ValueError(state)
    if state in ("connect", "skipped") and line.startswith("plan:"):
        sub = "Skipped" if state == "skipped" else ""
    sub = sub.removeprefix("plan:")
    cls = "crow" + (" is-tint" if tint else "") + (" is-skipped" if state == "skipped" else "")
    return (
        f'<div class="{cls}">{lead}<span class="cmain"><span class="cname">{E(name)}</span>'
        + (f'<span class="csub">{E(sub)}</span>' if sub else "") + f'</span>{end}</div>'
    )


def cgroup(label: str, rows: list[str]) -> str:
    return f'<div class="cgrp"><div class="clabel">{E(label)}</div><div class="crows">{"".join(rows)}</div></div>'


def connections(st: dict[str, str], foot: bool = True, tint: tuple[str, ...] = (), notes: dict[str, str] | None = None) -> str:
    """st maps row id -> state. Rows whose state is None are hidden (no empty scaffolding)."""
    notes = notes or {}
    spec = {
        "plans": [
            ("chatgpt", mark("C"), "ChatGPT", "plan:Plus"),
            ("claude", mark("A"), "Claude", "plan:Pro"),
            ("antigravity", mark("G"), "Antigravity", "plan:Free · used for small tasks"),
            ("opencode", mark("O"), "OpenCode", "plan:Go"),
        ],
        "accounts": [
            ("google", mark("G", "google-logo"), "Google", "Shared Gmail, Calendar and Drive."),
        ],
        "mac": [
            ("folders", mark("", "folder-simple"), "Mac folders", "Desktop, Documents, Downloads"),
            ("messages", mark("", "chat-circle"), "Messages", "Who you message, when and recent themes."),
            ("browser", mark("", "globe"), "Browser", "Safari and Chrome titles, domains and visit counts."),
            ("location", mark("", "map-pin"), "Location", "City and time zone; precise location is not enabled."),
            ("reach", mark("", "laptop"), f"Let {NAME} use this Mac", "Apps, files and terminal"),
        ],
    }
    labels = {"plans": "AI plans", "accounts": "Accounts", "mac": "This Mac"}
    groups = []
    for key, rows in spec.items():
        built = []
        ordered = sorted(rows, key=lambda r: 0 if st.get(r[0]) in ("ready", "connected") else 1) if key == "plans" else rows
        for rid, lead, name, line in ordered:
            s = st.get(rid)
            if s is None:
                continue
            built.append(crow(lead, name, line, s, notes.get(rid, ""), rid in tint))
        if built:
            groups.append(cgroup(labels[key], built))
    skip = '<button class="ak-btn ak-btn--sm ak-btn--plain">Skip the rest</button>' if foot else ""
    f = f'<div class="cfoot"><span class="cloud">{NAME} reads these from the cloud.</span>{skip}</div>'
    return f'<section class="conn"><div class="chead">Connections</div>{"".join(groups)}{f}</section>'


def connections_row(st, **kw) -> str:
    return f'<div class="msg"><span class="face-gap"></span><div class="msg-col">{connections(st, **kw)}</div></div>'


def connections_summary(text: str) -> str:
    """Once the ask is answered it stays in the chat as one summary line (the same as the ask row's done state)."""
    return ask_row("done", text)


# ---------------------------------------------------------------- the conversational ask (frames 08a-08i)

def ask_row(state: str = "ask", line: str = "", spin: bool = False, done: bool = False) -> str:
    """The one inline action row under the agent's own ask. UI chrome only: the agent writes the question.

    ask: Sure (confirm all) · Not now · Choose what to connect. running: the row holds one progress line.
    google: one tap for the only manual step. done: one summary line. later: only the quiet way back to the list.
    """
    choose = '<span class="ask-link">Choose what to connect</span>'
    if state == "ask":
        row = '<button class="ak-btn ak-btn--sm ak-btn--primary ask-btn">Sure</button><button class="ak-btn ak-btn--sm ak-btn--plain ask-btn">Not now</button>' + choose
    elif state == "google":
        row = (f'<button class="ak-btn ak-btn--sm ak-btn--primary ask-btn">{icon("google-logo", "ak-icon ak-icon--sm")}Connect Google</button>'
               '<button class="ak-btn ak-btn--sm ak-btn--plain ask-btn">Not now</button>' + choose)
    elif state == "running":
        row = f'<span class="ask-progress"><span class="ak-spinner"></span><span>{E(line)}</span></span>' + choose
        line = ""
    elif state == "done":
        mark_ = icon("check-circle", "ak-icon ak-icon--sm")
        row = f'<span class="ask-progress ok">{mark_}<span>{E(line)}</span></span>' + choose
        line = ""
    elif state == "later":
        row = choose
    else:
        raise ValueError(state)
    sub = f'<div class="ask-line">{E(line)}</div>' if line else ""
    return f'<div class="msg"><span class="face-gap"></span><div class="msg-col"><div class="ask">{row}</div>{sub}</div></div>'


def sys_settings_fda(on: bool = False) -> str:
    """System Settings › Privacy & Security › Full Disk Access: macOS has no prompt for it, only this pane."""
    rows = "".join(
        f'<div class="ss-row">{atum_mark(18) if n == "Atum" else mark(n[0])}<span>{E(n)}</span>'
        f'<span class="ss-toggle{" is-on" if (on and n == "Atum") or n == "Terminal" else ""}"><i></i></span></div>'
        for n in ("Atum", "Terminal")
    )
    return (
        '<div class="ss"><div class="ss-bar"><span class="lights"><i></i><i></i><i></i></span><span>Full Disk Access</span></div>'
        f'<div class="ss-body"><div class="ss-help">Allow the apps below to access data like Mail, Messages and Safari.</div>{rows}</div></div>'
    )


# ---------------------------------------------------------------- desktop window

def window(chat: str, *, chip: str = "Claude Sonnet 5.5", overlay: str = "", unread: bool = False, composer: str = "") -> str:
    rail = "".join(f'<span class="ak-iconbtn">{icon(n)}</span>' for n in ("chat-circle", "users", "squares-four"))
    badge = '<span class="ak-badge">1</span>' if unread else ""
    roster = (
        f'<div class="roster"><div class="ak-field ak-field--search">{icon("magnifying-glass", "ak-icon ak-icon--sm")}<span class="ak-placeholder">Search</span></div>'
        f'<div class="ak-row is-selected r-agent">{avatar()}<span class="ak-row-main"><span>{NAME}</span></span>{badge}</div></div>'
    )
    comp = composer or "Message Nova"
    return (
        '<div class="win ak-frame">'
        '<div class="titlebar"><span class="lights"><i></i><i></i><i></i></span></div>'
        f'<div class="win-body"><div class="rail">{rail}<span class="rail-gap"></span><span class="ak-iconbtn">{icon("gear")}</span></div>'
        f'{roster}'
        '<div class="chat ak-content">'
        f'<div class="chat-head">{avatar("N", "ak-avatar--sm")}<span class="chat-title">{NAME}</span></div>'
        f'<div class="transcript">{chat}</div>'
        f'<div class="composer"><div class="comp-box"><span class="comp-ph">{E(comp)}</span>'
        f'<div class="comp-row"><span class="chip">{icon("sparkle", "ak-icon ak-icon--sm")}{E(chip)}</span>'
        f'<span class="send">{icon("arrow-up", "ak-icon ak-icon--sm")}</span></div></div></div>'
        f'</div>{overlay}</div></div>'
    )


def center_window(inner: str) -> str:
    return (
        '<div class="win ak-frame"><div class="titlebar"><span class="lights"><i></i><i></i><i></i></span></div>'
        f'<div class="win-center">{inner}</div></div>'
    )


def atum_mark(size: int = 56) -> str:
    return (
        f'<svg class="atum-mark" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1">'
        '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>'
        '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>'
    )


def browser(url: str, inner: str, w: int = 560, h: int = 520) -> str:
    return (
        f'<div class="browser" style="width:{w}px;height:{h}px"><div class="b-bar"><span class="lights"><i></i><i></i><i></i></span>'
        f'<span class="b-url">{icon("lock-simple", "ak-icon ak-icon--sm")}{E(url)}</span></div><div class="b-page">{inner}</div></div>'
    )


def mac_alert(title: str, body: str, buttons: list[tuple[str, bool]], ic: str = "folder-simple", field: bool = False) -> str:
    btns = "".join(f'<span class="ma-btn{" is-def" if d else ""}">{E(b)}</span>' for b, d in buttons)
    pw = '<div class="ak-field ma-field"><span class="ak-placeholder">Password</span></div>' if field else ""
    return (
        f'<div class="mac-alert"><div class="ma-icon">{atum_mark(40)}<span class="ma-badge">{icon(ic, "ak-icon ak-icon--sm")}</span></div>'
        f'<div class="ma-title">{E(title)}</div><div class="ma-body">{E(body)}</div>{pw}<div class="ma-btns">{btns}</div></div>'
    )


# ---------------------------------------------------------------- phone

def phone(inner: str, lock: bool = False, clock: str = "9:41") -> str:
    cls = "phone lock" if lock else "phone"
    return f'<div class="{cls}"><div class="p-notch"></div><div class="p-status"><span>{E(clock)}</span></div>{inner}</div>'


def phone_chat(chat: str, comp: str = "Message Nova") -> str:
    return (
        f'<div class="p-head">{icon("caret-left", "ak-icon")}{avatar("N", "ak-avatar--sm")}<span>{NAME}</span></div>'
        f'<div class="p-transcript">{chat}</div>'
        f'<div class="p-comp"><span>{E(comp)}</span><span class="send">{icon("arrow-up", "ak-icon ak-icon--sm")}</span></div>'
    )


def push(title: str, body: str, when: str = "now") -> str:
    return (
        f'<div class="push ak-glass"><span class="push-icon">{atum_mark(20)}</span><div class="push-main">'
        f'<div class="push-top"><b>{E(title)}</b><span>{E(when)}</span></div><div class="push-body">{E(body)}</div></div></div>'
    )


# ---------------------------------------------------------------- frames

PLANS_LAUNCH = {"chatgpt": "ready", "claude": "connect", "antigravity": "connect", "opencode": "connect"}
SOURCES_FRESH = {"google": "connect", "folders": "connect", "messages": "connect", "browser": "connect", "location": "ready", "reach": "connect"}

WELCOME = agent_msg(
    f"Hi, I’m {NAME} (call me something else anytime). I’m running on the ChatGPT Plus plan from this Mac, and I’ve already started with your chats and your city.",
    "To get to know your work, I’d like to read your Documents and Desktop, your Messages and your Google mail and calendar. Shall I connect them?",
    time="09:42",
)

# The ask row's states for the "Sure" path, in order. Each step is the native macOS prompt only; Google is last.
CLOUD = f"{NAME} reads these from the cloud."
P_FOLDERS = "Reading Documents and Desktop… · Messages next"
P_FDA = "Allow Full Disk Access in System Settings · this Mac next"
P_REACH = "Enter your Mac password · Google next"
SO_FAR = "Connected Documents, Desktop, Messages and this Mac"
DONE_LINE = "Connected Google, Documents, Desktop, Messages and this Mac"

LEARN_1 = agent_msg(
    "First look at your Documents and recent chats: you’re getting a product launch ready for mid-December, and most of your messages go to the design team.",
    "I’ll keep learning in the background.",
    time="09:44",
)

LEARN_2 = agent_msg(
    "Your calendar fills in the picture: the launch review is Thursday at 2 pm, and Friday mornings are blocked for writing. I’ll keep those quiet.",
    time="09:46",
)

NUDGE_1 = agent_msg(
    "Thursday’s launch review has no agenda yet. Want me to draft one from the launch plan in your Drive?",
    time="09:47",
)

NUDGE_3 = agent_msg(
    "Three emails from this morning still need you. The venue wants a yes by Friday. Shall I draft short replies?",
    time="10:17",
)

ALL_DONE = {"chatgpt": "ready", "claude": "connected", "antigravity": "skipped", "opencode": "skipped",
            "google": "connected", "folders": "connected", "messages": "connected", "browser": "skipped",
            "location": "ready", "reach": "connected"}

SUMMARY = DONE_LINE


def f_story() -> str:
    return center_window(
        f'<div class="story">{atum_mark(72)}<div class="story-line">Speak, and it becomes.</div></div>'
    )


def f_signin() -> str:
    return center_window(
        f'<div class="signin">{atum_mark(56)}<h1>Welcome to Atum</h1><p>Your own assistant, in the cloud and on your Mac.</p>'
        f'<button class="ak-btn ak-btn--lg ak-btn--primary wide">{icon("google-logo")}Continue with Google</button>'
        f'<button class="ak-btn ak-btn--lg wide">{icon("envelope-simple")}Continue with email</button>'
        '<div class="fine">Terms · Privacy · Help</div></div>'
    )


def f_signup() -> str:
    page = (
        f'<div class="su">{atum_mark(36)}<h2>Create your account</h2>'
        '<label class="ak-field-label">Email</label><div class="ak-field"><input value="hello@example.com"></div>'
        '<label class="ak-field-label">Password</label><div class="ak-field"><input value="••••••••••••"></div>'
        f'<div class="turnstile"><span class="ts-check">{icon("check", "ak-icon ak-icon--sm")}</span><span>Success!</span><span class="ts-brand">CAPTCHA<br><small>Turnstile</small></span></div>'
        '<button class="ak-btn ak-btn--primary wide">Create account</button>'
        '<div class="fine">We’ll send a 6-digit code to confirm your email.</div></div>'
    )
    left = center_window(f'<div class="wait">{atum_mark(40)}<div class="wait-line">Finish in your browser</div><button class="ak-btn ak-btn--sm ak-btn--plain">Cancel</button></div>')
    return f'<div class="duo">{left}{browser("account.atum.app/register", page, 520, 600)}</div>'


def f_launch() -> str:
    return center_window(
        f'<div class="launch">{atum_mark(64)}<div class="launch-line">Getting Atum ready</div><div class="bar"><i></i></div></div>'
    )


def f_writing() -> str:
    return window(typing(), chip="GPT-6.2 Sol")


def f_retrying() -> str:
    return window(typing("Taking a little longer…"), chip="GPT-6.2 Sol")


def f_quiet() -> str:
    return window(quiet_state() + connections_row({**PLANS_LAUNCH, **SOURCES_FRESH}), chip="GPT-6.2 Sol")


def f_welcome() -> str:
    """08a: the automatic pass already ran (the plan Atum picked, chats, city); the agent's own welcome asks for the rest."""
    return window(WELCOME + ask_row("ask", CLOUD), chip="GPT-6.2 Sol")


def f_sure_folders() -> str:
    alert = mac_alert(
        "“Atum” would like to access files in your Documents folder.",
        f"{NAME} reads files you keep here to learn about your work.",
        [("Don’t Allow", False), ("Allow", True)],
    )
    return window(WELCOME + own_tap("Sure") + ask_row("running", P_FOLDERS), chip="GPT-6.2 Sol", overlay=f'<div class="sys-scrim">{alert}</div>')


def f_sure_fda() -> str:
    overlay = f'<div class="sys-scrim right">{sys_settings_fda()}</div>'
    return window(WELCOME + own_tap("Sure") + ask_row("running", P_FDA) + LEARN_1, chip="GPT-6.2 Sol", overlay=overlay)


def f_sure_reach() -> str:
    alert = mac_alert(
        "Atum wants to turn on Remote Login.",
        f"So {NAME} can use this Mac’s apps and files. Enter your password to allow this.",
        [("Cancel", False), ("Allow", True)], ic="lock-simple", field=True,
    )
    return window(WELCOME + own_tap("Sure") + ask_row("running", P_REACH) + LEARN_1, chip="GPT-6.2 Sol", overlay=f'<div class="sys-scrim">{alert}</div>')


def f_google_tap() -> str:
    return window(WELCOME + own_tap("Sure") + ask_row("google", SO_FAR) + LEARN_1, chip="GPT-6.2 Sol")


def f_google_browser() -> str:
    win = window(WELCOME + own_tap("Sure") + ask_row("running", "Finish in your browser") + LEARN_1, chip="GPT-6.2 Sol")
    page = (
        f'<div class="consent">{icon("google-logo", "ak-icon ak-icon--xl")}<h2>Sign in with Google</h2>'
        '<p>to continue to <b>Atum</b></p><div class="acct">'
        f'{avatar("Y")}<span><b>hello@example.com</b><br><small>Your account</small></span></div>'
        '<div class="scopes"><div>Read your mail and calendar</div><div>See files you share in Drive</div></div>'
        '<div class="consent-btns"><span class="ak-btn">Cancel</span><span class="ak-btn ak-btn--primary">Allow</span></div></div>'
    )
    return f'<div class="duo">{win}{browser("accounts.google.com", page, 400, 560)}</div>'


def f_all_set() -> str:
    return window(WELCOME + own_tap("Sure") + ask_row("done", DONE_LINE) + LEARN_1 + learning_line("Learning from 6 sources"))


def f_not_now() -> str:
    reply = agent_msg("No problem. I’ll learn from our chats for now. What would you like to tackle first?", time="09:42")
    return window(WELCOME + own_tap("Not now") + ask_row("later") + reply, chip="GPT-6.2 Sol")


def f_choose() -> str:
    st = {**PLANS_LAUNCH, **SOURCES_FRESH, "location": "ready"}
    return window(WELCOME + connections_row(st), chip="GPT-6.2 Sol")


def f_learn2() -> str:
    return window(connections_summary(SUMMARY) + LEARN_1 + LEARN_2 + learning_line("Learning from 6 sources"))


def f_nudge5() -> str:
    return window(connections_summary(SUMMARY) + LEARN_1 + LEARN_2 + NUDGE_1)


def f_nudge15() -> str:
    reply = own_msg("Yes please")
    done = agent_msg("Done — it’s in your Drive as “Launch review agenda”. Two open questions are at the top.", time="09:49")
    return window(LEARN_2 + NUDGE_1 + reply + done + '<div class="silent">+15 min · nothing new worth saying, so Nova stays quiet</div>')


def f_nudge35() -> str:
    reply = own_msg("Yes please")
    done = agent_msg("Done — it’s in your Drive as “Launch review agenda”. Two open questions are at the top.", time="09:49")
    return window(NUDGE_1 + reply + done + NUDGE_3, unread=True)


def f_nudge60() -> str:
    lock = (
        '<div class="lock-time">10:42</div><div class="lock-date">Tuesday</div>'
        + push(NAME, "The venue replied: Friday works. I put the details next to the agenda.", "now")
    )
    return f'<div class="duo">{phone(lock, lock=True, clock="10:42")}</div>'


def f_evening() -> str:
    msg = agent_msg(
        "Before you wrap up: the launch FAQ is still a blank page. I can turn this week’s notes into a first draft overnight.",
        time="18:00",
    )
    return window(NUDGE_3 + own_msg("Send the venue reply as drafted") + agent_msg("Sent.", time="10:21") + msg)


BRIEF = agent_msg(
    "Good morning. Three meetings today, the first at 10:00 with the design team.",
    "The FAQ draft is in your Drive. One thing needs you: approve the launch budget.",
    time="08:00",
)


def f_brief() -> str:
    return window(agent_msg("Before you wrap up: the launch FAQ is still a blank page. I can turn this week’s notes into a first draft overnight.", time="18:00")
                  + own_msg("Go ahead") + day_sep("Wednesday") + BRIEF)


def f_brief_phone() -> str:
    lock = '<div class="lock-time">8:00</div><div class="lock-date">Wednesday</div>' + push(NAME, "Good morning. Three meetings today, the first at 10:00…", "now")
    chat = day_sep("Wednesday") + BRIEF
    return f'<div class="duo">{phone(lock, lock=True, clock="8:00")}{phone(phone_chat(chat), clock="8:01")}</div>'


def f_quiet_idea() -> str:
    idea = agent_msg("You have a free hour at 1 pm. Good moment for the budget sign-off? I’ve put the two numbers that changed at the top.", time="11:30")
    return window(day_sep("Wednesday") + BRIEF + idea)


def f_day2() -> str:
    msg = agent_msg("Tomorrow’s 9:00 with the design team moved to 9:30. I’ve updated your agenda.", time="17:42")
    slots = '<div class="silent">Day 2 · Nova checks in every 2 hours and stays quiet unless something matters</div>'
    return window(BRIEF + agent_msg("You have a free hour at 1 pm. Good moment for the budget sign-off? I’ve put the two numbers that changed at the top.", time="11:30") + msg + slots)


def f_steady() -> str:
    msg = agent_msg("Following up: the caterer hasn’t answered since Tuesday. Want me to nudge them?", time="Thu 10:00")
    return window(day_sep("Thursday") + agent_msg("Good morning. Launch review at 2 pm — agenda and budget are ready in your Drive.", time="08:00") + msg)


def f_phone_first() -> str:
    chat = own_msg("hi") + agent_msg(
        f"Hi! I’m {NAME}. Open Atum on your Mac when you can — that’s where you connect what I learn from.",
        "Until then, ask me anything.",
        time="09:42",
    )
    return f'<div class="duo">{phone(phone_chat(chat), clock="9:42")}</div>'


# id: (title, timeline key, trigger caption, builder, themes, canvas height)
FRAMES: list[tuple[str, str, str, str, object, tuple[str, ...], int]] = [
    ("01-welcome-story", "Before sign-in", "signup", "First launch on this Mac: the welcome story plays once.", f_story, ("light",), 1000),
    ("02-sign-in", "Sign in", "signup", "The story ends on two choices. Each opens the browser.", f_signin, ("light", "dark"), 1000),
    ("03-sign-up-captcha", "Sign up with email", "signup", "Email sign-up in the browser checks for a human (Turnstile) before the account exists.", f_signup, ("light",), 1000),
    ("04-launch", "Launch screen", "signup", "Account created. While this shows (≈2.6 s) Atum reads this Mac’s AI plans and picks the best one.", f_launch, ("light", "dark"), 1000),
    ("05-writing", "Nova is writing", "t0", "The chat opens and the welcome request goes out. The chip already shows the plan Atum picked.", f_writing, ("light",), 1000),
    ("06-retrying", "Taking longer", "t0", "No welcome after 20 s: Atum asks once more. No ready-made greeting stands in.", f_retrying, ("light",), 1000),
    ("07-quiet-state", "Still no answer", "t0", "The retry also went unanswered: one quiet line and Try again. Connections still work.", f_quiet, ("light",), 1000),
    ("08a-welcome-asks", "The welcome asks", "t6", "Atum already connected what needs no prompt. Nova’s own welcome names it and asks for the rest. Starts the 48-hour clock.", f_welcome, ("light", "dark"), 1000),
    ("08b-sure-folders", "Sure: folders", "t6", "Sure runs the rest in turn, each as the native macOS prompt only. First, one prompt per folder.", f_sure_folders, ("light", "dark"), 1000),
    ("08c-sure-full-disk", "Sure: Messages", "t2m", "Messages needs Full Disk Access, which macOS grants only in this pane. Nova already reports what it learned.", f_sure_fda, ("light",), 1000),
    ("08d-sure-this-mac", "Sure: this Mac", "t2m", "One password prompt turns on Remote Login. A denied or skipped step settles quietly and the next one runs.", f_sure_reach, ("light",), 1000),
    ("08e-google-tap", "Google, last", "t2m", "Google’s sign-in is the only manual step, so it comes last as one tap.", f_google_tap, ("light", "dark"), 1000),
    ("08f-google-browser", "Google in the browser", "t2m", "One browser trip covers mail, calendar and Drive.", f_google_browser, ("light",), 1000),
    ("08g-all-set", "All set", "t2m", "Everything answered: the ask shrinks to one line. Learning started with the first source and keeps going.", f_all_set, ("light", "dark"), 1000),
    ("08h-not-now", "Not now", "t6", "Not now settles quietly. The way back stays one tap away; nothing blocks the chat.", f_not_now, ("light",), 1000),
    ("08i-choose", "Choose what to connect", "t6", "One tap opens the full Connections list, row by row (kept as it was).", f_choose, ("light",), 1000),
    ("14-learning-deeper", "Learning goes deeper", "t2m", "Google arrived, so the same run reads the calendar and mail too. No second run.", f_learn2, ("light",), 1000),
    ("15-nudge-5", "Nudge 1 · +5 min", "t5m", "Warm-up nudge 1, 5 min after the welcome, built on what Nova has learned.", f_nudge5, ("light", "dark"), 1000),
    ("16-nudge-15", "Nudge 2 · +15 min", "t15m", "Nudge 2: nothing worth saying, so it stays silent.", f_nudge15, ("light",), 1000),
    ("17-nudge-35", "Nudge 3 · +35 min", "t35m", "Nudge 3 offers the next useful thing.", f_nudge35, ("light",), 1000),
    ("18-nudge-60-phone", "Nudge 4 · +60 min", "t60m", "Nudge 4 reaches the phone when the Mac is away.", f_nudge60, ("light",), 1000),
    ("19-day1-evening", "Day 1 evening", "eve", "Day-1 check-ins run hourly in daytime. Most stay silent; this one has something.", f_evening, ("light",), 1000),
    ("20-morning-brief", "Morning brief", "brief", "08:00 next day: the morning brief.", f_brief, ("light", "dark"), 1000),
    ("21-morning-brief-phone", "Morning brief on the phone", "brief", "The same brief, on the phone.", f_brief_phone, ("light", "dark"), 1000),
    ("22-quiet-suggestion", "Quiet suggestion", "quiet", "11:30: at most one quiet suggestion a day.", f_quiet_idea, ("light",), 1000),
    ("23-day2-taper", "Day 2 taper", "day2", "From hour 32, check-ins every 2 hours until hour 48.", f_day2, ("light",), 1000),
    ("24-steady-48h", "Steady state", "h48", "From hour 48: the ordinary follow-up sweep (every 2 h, 09:00–20:00), the 08:00 brief, 11:30 suggestion.", f_steady, ("light", "dark"), 1000),
    ("25-phone-first", "Phone first", "t0", "Someone who starts on the phone: no welcome request, so their first message starts the clock.", f_phone_first, ("light",), 1000),
]


CSS = r"""
html, body { margin: 0; }
body { width: %(w)spx; background: var(--ak-ground); font: var(--ak-t-body); color: var(--ak-ink); }
.frame { padding: 28px 36px 36px; box-sizing: border-box; }
.f-head { display: flex; align-items: baseline; gap: 14px; }
.f-no { font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-3); font-variant-numeric: tabular-nums; }
.f-title { font: var(--ak-t-title); margin: 0; }
.f-cap { font: var(--ak-t-body); color: var(--ak-ink-2); margin: 6px 0 14px; }
.tl { display: grid; grid-template-columns: repeat(13, 1fr); border-top: 1px solid var(--ak-line-2); margin-bottom: 22px; }
.tl-cell { display: flex; flex-direction: column; gap: 1px; padding-top: 8px; position: relative; color: var(--ak-ink-3); }
.tl-dot { position: absolute; top: -5px; left: 0; width: 9px; height: 9px; border-radius: 50%%; background: var(--ak-ground); box-shadow: inset 0 0 0 1.5px var(--ak-ink-4); }
.tl-cell.is-past .tl-dot { background: var(--ak-ink-4); box-shadow: none; }
.tl-cell.is-now .tl-dot { background: var(--ak-ink); box-shadow: 0 0 0 3px var(--ak-ground), 0 0 0 4.5px var(--ak-ink); }
.tl-cell.is-now { color: var(--ak-ink); }
.tl-l { font: var(--ak-t-caption); font-weight: 600; }
.tl-c { font: var(--ak-t-caption); font-weight: 400; }
.stage { display: flex; justify-content: center; }
.duo { display: flex; gap: 28px; align-items: center; justify-content: center; }

/* desktop window */
.win { width: 1000px; height: 800px; border-radius: 12px; overflow: hidden; box-shadow: var(--ak-shadow-3), inset 0 0 0 .5px var(--ak-line-2); display: flex; flex-direction: column; position: relative; background: var(--ak-chrome); }
.duo .win { width: 640px; flex: none; }
.duo .browser, .duo .phone { flex: none; }
.titlebar { height: 34px; display: flex; align-items: center; padding: 0 14px; flex: none; }
.lights { display: inline-flex; gap: 8px; }
.lights i { width: 12px; height: 12px; border-radius: 50%%; background: var(--ak-line-2); display: block; }
.win-body { flex: 1; display: flex; min-height: 0; padding: 0 8px 8px 0; position: relative; }
.rail { width: 52px; display: flex; flex-direction: column; align-items: center; gap: 4px; padding-top: 4px; flex: none; }
.rail-gap { flex: 1; }
.roster { width: 220px; flex: none; padding: 0 8px; display: flex; flex-direction: column; gap: 8px; }
.duo .roster { width: 170px; }
.r-agent { font-weight: 600; }
.chat { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.chat-head { height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid var(--ak-line); flex: none; font: var(--ak-t-headline); }
.transcript { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: 14px; padding: 18px 22px 8px; }
.composer { padding: 8px 16px 14px; flex: none; }
.comp-box { border-radius: var(--ak-r-xl); box-shadow: inset 0 0 0 1px var(--ak-line-2); padding: 10px 10px 8px 14px; display: flex; flex-direction: column; gap: 8px; }
.comp-ph { color: var(--ak-ink-3); }
.comp-row { display: flex; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: var(--ak-r-full); background: var(--ak-fill-quiet); font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); }
.send { margin-left: auto; width: 28px; height: 28px; border-radius: 50%%; background: var(--ak-ink); color: var(--ak-on-ink); display: inline-flex; align-items: center; justify-content: center; }
.win-center { flex: 1; display: flex; align-items: center; justify-content: center; margin: 0 8px 8px; border-radius: var(--ak-r-lg); background: var(--ak-surface); box-shadow: var(--ak-shadow-1); }

/* messages */
.msg { display: flex; gap: 10px; align-items: flex-start; max-width: 600px; }
.msg.own { align-self: flex-end; justify-content: flex-end; }
.msg-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.who { font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); display: flex; gap: 8px; }
.when { font-weight: 400; color: var(--ak-ink-3); }
.face-gap { width: 28px; flex: none; }
.bubble { align-self: flex-start; max-width: 520px; border-radius: var(--ak-r-xl); background: var(--ak-fill-quiet); padding: 8px 12px; font: var(--ak-t-chat); }
.bubble p { margin: 0; } .bubble p + p { margin-top: 8px; }
.bubble.own { background: var(--ak-bubble-own); color: var(--ak-on-bubble-own); }
.bubble.typing { padding: 12px 14px; }
.dots { display: inline-flex; gap: 4px; } .dots i { width: 6px; height: 6px; border-radius: 50%%; background: var(--ak-ink-3); display: block; opacity: .7; }
.dots i:nth-child(2) { opacity: .45; } .dots i:nth-child(3) { opacity: .25; }
.typing-note { font: var(--ak-t-callout); color: var(--ak-ink-3); padding-left: 4px; }
.quiet-line { display: flex; align-items: center; gap: 10px; font: var(--ak-t-body); color: var(--ak-ink-3); }
.day-sep { display: flex; align-items: center; gap: 10px; font: var(--ak-t-caption); font-weight: 600; color: var(--ak-ink-3); }
.day-sep::before, .day-sep::after { content: ""; flex: 1; height: 1px; background: var(--ak-line); }
.learn { display: flex; align-items: center; gap: 8px; font: var(--ak-t-callout); color: var(--ak-ink-3); margin-left: 10px; }
.learn .ak-spinner { width: 12px; height: 12px; border-width: 1.5px; }
.silent { align-self: center; font: italic var(--ak-t-callout); color: var(--ak-ink-3); padding: 4px 12px; border-radius: var(--ak-r-full); border: 1px dashed var(--ak-ink-4); }

/* Connections */
.conn { border-top: 1px solid var(--ak-line); border-bottom: 1px solid var(--ak-line); padding: 6px 0; max-width: 520px; }
.chead { display: none; }
.cgrp { display: grid; grid-template-columns: 84px minmax(0, 1fr); }
.cgrp + .cgrp { border-top: 1px solid var(--ak-line); margin-top: 4px; padding-top: 4px; }
.clabel { font: var(--ak-t-callout); color: var(--ak-ink-3); padding-top: 11px; }
.crows { display: flex; flex-direction: column; }
.crow { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 2px 8px; border-radius: var(--ak-r-md); }
.crow.is-tint { background: var(--ak-ok-fill); }
.crow.is-skipped .cname, .crow.is-skipped .cmark { opacity: .55; }
.cmark { width: 22px; height: 22px; border-radius: 6px; background: var(--ak-fill-press); color: var(--ak-ink-2); display: inline-flex; align-items: center; justify-content: center; font: 700 11px/1 var(--ak-font); flex: none; }
.cmark .ak-icon { width: 14px; height: 14px; }
.cmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cname { font: 500 14px/18px var(--ak-font); }
.csub { font: 400 12px/15px var(--ak-font); color: var(--ak-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cbtn { height: 24px; padding: 0 10px; }
.cstate { display: inline-flex; align-items: center; gap: 4px; font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-3); min-width: 24px; justify-content: flex-end; }
.cstate.ok { color: var(--ak-ok); }
.cstate .ak-spinner { width: 14px; height: 14px; }
.cfoot { display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 6px 8px 0; }
.cloud { flex: 1; font: var(--ak-t-callout); color: var(--ak-ink-3); }
.csummary { display: inline-flex; align-items: center; gap: 8px; font: var(--ak-t-callout); color: var(--ak-ink-3); padding: 6px 0; }
.clink { color: var(--ak-ink-2); font-weight: 600; }

/* the ask row */
.ask { display: flex; align-items: center; gap: 8px; min-height: 30px; max-width: 520px; }
.ask-btn { height: 28px; padding: 0 14px; display: inline-flex; align-items: center; gap: 6px; }
.ask-link { margin-left: auto; font: var(--ak-t-callout); font-weight: 600; color: var(--ak-ink-2); padding: 0 4px; }
.ask-progress { display: inline-flex; align-items: center; gap: 8px; font: var(--ak-t-callout); color: var(--ak-ink-2); min-width: 0; }
.ask-progress .ak-spinner { width: 12px; height: 12px; border-width: 1.5px; flex: none; }
.ask-progress.ok .ak-icon { color: var(--ak-ok); flex: none; }
.ask-line { font: var(--ak-t-callout); color: var(--ak-ink-3); padding-left: 2px; }
.tap-note { align-self: flex-end; font: italic var(--ak-t-caption); color: var(--ak-ink-3); padding: 2px 10px; border-radius: var(--ak-r-full); border: 1px dashed var(--ak-ink-4); }
.sys-scrim.right { justify-content: flex-end; padding: 60px 40px 0 0; }
.ss { width: 320px; border-radius: 12px; overflow: hidden; background: var(--ak-raised); box-shadow: var(--ak-shadow-3), inset 0 0 0 .5px var(--ak-line-2); align-self: flex-start; }
.ss-bar { height: 36px; display: flex; align-items: center; gap: 14px; padding: 0 12px; background: var(--ak-chrome); font: 700 13px/1 var(--ak-font); }
.ss-body { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 6px; }
.ss-help { font: 400 11px/15px var(--ak-font); color: var(--ak-ink-2); margin-bottom: 4px; }
.ss-row { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px; border-radius: 8px; background: var(--ak-fill-quiet); font: 500 13px/1 var(--ak-font); }
.ss-row span:nth-child(2) { flex: 1; }
.ss-toggle { width: 30px; height: 18px; border-radius: 9px; background: var(--ak-fill-press); position: relative; }
.ss-toggle i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.ss-toggle.is-on { background: #2a6ff0; } .ss-toggle.is-on i { left: 14px; }

/* system UI */
.sys-scrim { position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0,0,0,.08); }
.mac-alert { width: 260px; border-radius: 14px; background: var(--ak-raised); box-shadow: var(--ak-shadow-3), inset 0 0 0 .5px var(--ak-line-2); padding: 18px 16px 14px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; }
.ma-icon { position: relative; color: var(--ak-ink); margin-bottom: 4px; }
.ma-badge { position: absolute; right: -6px; bottom: -4px; width: 20px; height: 20px; border-radius: 6px; background: var(--ak-surface); box-shadow: var(--ak-shadow-1); display: inline-flex; align-items: center; justify-content: center; }
.ma-title { font: 700 13px/17px var(--ak-font); }
.ma-body { font: 400 11px/15px var(--ak-font); color: var(--ak-ink-2); }
.ma-field { width: 100%%; height: 26px; box-sizing: border-box; margin-top: 4px; }
.ma-btns { display: flex; gap: 8px; width: 100%%; margin-top: 8px; }
.ma-btn { flex: 1; height: 26px; border-radius: 7px; background: var(--ak-fill-press); font: 500 12px/26px var(--ak-font); }
.ma-btn.is-def { background: #2a6ff0; color: #fff; }

.browser { border-radius: 12px; overflow: hidden; background: var(--ak-surface); box-shadow: var(--ak-shadow-3), inset 0 0 0 .5px var(--ak-line-2); display: flex; flex-direction: column; }
.b-bar { height: 40px; display: flex; align-items: center; gap: 14px; padding: 0 12px; background: var(--ak-chrome); flex: none; }
.b-url { flex: 1; height: 26px; border-radius: 7px; background: var(--ak-fill-quiet); display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: var(--ak-t-callout); color: var(--ak-ink-2); }
.b-page { flex: 1; display: flex; align-items: center; justify-content: center; }
.su { width: 300px; display: flex; flex-direction: column; gap: 6px; }
.su h2, .consent h2 { font: var(--ak-t-title); margin: 10px 0 12px; }
.su .ak-field { margin-bottom: 8px; }
.turnstile { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 12px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--ak-line-2); background: var(--ak-sunk); margin: 6px 0 12px; font: var(--ak-t-body); }
.ts-check { width: 24px; height: 24px; border-radius: 50%%; background: var(--ak-ok); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
.ts-brand { margin-left: auto; font: 600 10px/12px var(--ak-font); color: var(--ak-ink-3); text-align: right; }
.wide { width: 100%%; }
.fine { font: var(--ak-t-callout); color: var(--ak-ink-3); text-align: center; margin-top: 10px; }
.consent { width: 300px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; }
.consent p { margin: 0 0 12px; color: var(--ak-ink-2); }
.acct { display: flex; gap: 10px; align-items: center; text-align: left; width: 100%%; padding: 10px; border-radius: var(--ak-r-md); box-shadow: inset 0 0 0 1px var(--ak-line-2); }
.scopes { width: 100%%; text-align: left; display: flex; flex-direction: column; gap: 8px; margin: 14px 0; font: var(--ak-t-body); color: var(--ak-ink-2); }
.scopes div::before { content: "•"; margin-right: 8px; color: var(--ak-ink-3); }
.consent-btns { display: flex; gap: 8px; justify-content: flex-end; width: 100%%; }

.story { display: flex; flex-direction: column; align-items: center; gap: 22px; color: var(--ak-ink); }
.story-line { font: var(--ak-t-display); letter-spacing: -.01em; }
.signin { width: 320px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.signin h1 { font: var(--ak-t-display); margin: 10px 0 0; }
.signin p { margin: 0 0 14px; color: var(--ak-ink-2); }
.launch { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.launch-line { font: var(--ak-t-headline); color: var(--ak-ink-2); }
.bar { width: 160px; height: 3px; border-radius: 2px; background: var(--ak-fill-press); overflow: hidden; } .bar i { display: block; width: 60%%; height: 100%%; background: var(--ak-ink-2); }
.wait { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.wait-line { font: var(--ak-t-headline); color: var(--ak-ink-2); }
.atum-mark { color: var(--ak-ink); }

/* phone */
.phone { width: 300px; height: 620px; border-radius: 44px; background: var(--ak-surface); box-shadow: var(--ak-shadow-3), inset 0 0 0 8px #111214, inset 0 0 0 9px var(--ak-line-2); position: relative; overflow: hidden; display: flex; flex-direction: column; padding: 10px; box-sizing: border-box; }
.phone.lock { background: linear-gradient(180deg, #3b4150, #1d2028); }
.p-notch { position: absolute; top: 18px; left: 50%%; transform: translateX(-50%%); width: 86px; height: 24px; border-radius: 14px; background: #111214; }
.p-status { height: 44px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; font: 600 13px/1 var(--ak-font); flex: none; }
.lock .p-status { color: #fff; }
.lock-time { color: #fff; font: 300 64px/1 var(--ak-font-display); text-align: center; margin-top: 30px; }
.lock-date { color: rgba(255,255,255,.8); font: 500 16px/1 var(--ak-font); text-align: center; margin: 8px 0 auto; }
.push { margin: 0 6px 120px; border-radius: 20px; padding: 12px; display: flex; gap: 10px; }
.push-icon { width: 34px; height: 34px; border-radius: 9px; background: var(--ak-surface); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.push-main { flex: 1; min-width: 0; }
.push-top { display: flex; justify-content: space-between; font: var(--ak-t-callout); } .push-top span { color: var(--ak-ink-3); }
.push-body { font: 400 13px/17px var(--ak-font); color: var(--ak-ink); margin-top: 2px; }
.p-head { height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 10px; font: var(--ak-t-headline); border-bottom: 1px solid var(--ak-line); flex: none; }
.p-transcript { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 12px; padding: 12px 6px; overflow: hidden; }
.p-transcript .bubble { max-width: 210px; font: 400 14px/20px var(--ak-font); }
.p-transcript .msg .ak-avatar { width: 24px; height: 24px; font-size: 10px; }
.p-transcript .face-gap { width: 24px; }
.p-comp { margin: 4px 4px 14px; height: 38px; border-radius: 19px; box-shadow: inset 0 0 0 1px var(--ak-line-2); display: flex; align-items: center; padding: 0 5px 0 14px; color: var(--ak-ink-3); flex: none; }
.p-comp .send { width: 28px; height: 28px; }
"""


def label(fid: str) -> str:
    """The frame's number as the storyboard says it: the id's prefix ("08a")."""
    return fid.split("-", 1)[0]


def page(theme: str, n: int, fid: str, title: str, at: str, caption: str, body: str) -> str:
    return (
        f'<!doctype html><html class="ak-{theme}"><head><meta charset="utf-8">'
        f'<link rel="stylesheet" href="{KIT_CSS.as_uri()}"><style>{CSS % {"w": CANVAS_W}}</style></head>'
        f'<body class="ak-{theme}"><div class="frame">'
        f'<div class="f-head"><span class="f-no">{label(fid)}</span><h1 class="f-title">{E(title)}</h1></div>'
        f'<p class="f-cap">{E(caption)}</p>{strip(at)}<div class="stage">{body}</div></div></body></html>'
    )


def shoot(src: Path, png: Path, height: int) -> None:
    profile = tempfile.mkdtemp(prefix="new-user-flow-chrome-")
    png.unlink(missing_ok=True)
    try:
        # Headless Chrome on macOS can crash in teardown after writing the file; the PNG is the result.
        subprocess.run(
            [
                CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5",
                f"--user-data-dir={profile}", f"--window-size={CANVAS_W},{height}",
                f"--screenshot={png}", src.as_uri(),
            ],
            check=False, capture_output=True, timeout=90,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    if not png.exists() or png.stat().st_size < 10_000:
        raise RuntimeError(f"Chrome did not write {png}")


def index_page() -> str:
    """The storyboard in order: light by default, a toggle shows the dark frames where they exist."""
    cards = []
    for n, (fid, title, at, caption, _build, themes, _h) in enumerate(FRAMES, start=1):
        clock = next(f"{label} · {c}" for k, label, c in TIMELINE if k == at)
        imgs = "".join(
            f'<img class="t-{t}" src="{fid}-{t}.png" alt="{E(title)} ({t})" loading="lazy">' for t in themes
        )
        dark = "" if "dark" in themes else " no-dark"
        cards.append(
            f'<section class="card{dark}" id="{fid}"><header><span class="n">{label(fid)}</span><h2>{E(title)}</h2>'
            f'<span class="at">{E(clock)}</span></header><p>{E(caption)}</p>{imgs}</section>'
        )
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>New user flow</title><style>"
        ":root{--bg:#f4f5f7;--ink:#1b1d22;--ink3:#5f646d;--line:rgba(23,25,31,.12)}"
        "@media (prefers-color-scheme:dark){:root{--bg:#17181c;--ink:#ecedf0;--ink3:#9da2ab;--line:rgba(255,255,255,.12)}}"
        "body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}"
        "main{max-width:1280px;margin:0 auto;padding:32px 16px 80px}"
        "h1{font-size:26px;margin:0 0 4px}.lede{color:var(--ink3);margin:0 0 20px;max-width:70ch}"
        ".bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);z-index:1;display:flex;gap:12px;align-items:center}"
        "button{font:inherit;border:0;border-radius:8px;padding:6px 12px;background:var(--line);color:var(--ink)}"
        ".card{padding:28px 0;border-bottom:1px solid var(--line)}header{display:flex;gap:12px;align-items:baseline}"
        "h2{font-size:20px;margin:0}.n,.at{color:var(--ink3);font-size:13px}.at{margin-left:auto}"
        ".card p{margin:4px 0 12px;color:var(--ink3)}img{width:100%;height:auto;border-radius:10px;display:block}"
        "body:not(.dark) img.t-dark{display:none}body.dark img.t-light{display:none}body.dark .no-dark img.t-light{display:block}"
        "</style></head><body><main>"
        "<h1>A new person’s first 48 hours</h1>"
        '<p class="lede">Every frame of the unified first run and warm-up, in order. Plan: '
        "docs/plans/2026-11-28-unified-first-run-and-48h.md. Agent lines are examples of the agent’s own voice, never fixed text. "
        "Names are generic.</p>"
        '<div class="bar"><button onclick="document.body.classList.toggle(\'dark\')">Light / dark</button>'
        f'<span class="at">{len(FRAMES)} frames</span></div>'
        + "".join(cards)
        + "</main></body></html>\n"
    )


def main() -> int:
    html_only = "--html-only" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    work = Path(tempfile.mkdtemp(prefix="new-user-flow-html-"))
    manifest = []
    for n, (fid, title, at, caption, build, themes, height) in enumerate(FRAMES, start=1):
        body = build()
        for theme in themes:
            name = f"{fid}-{theme}"
            manifest.append({"id": fid, "n": n, "no": label(fid), "title": title, "at": at, "caption": caption, "theme": theme, "png": f"{name}.png"})
            if only and fid not in only:
                continue
            src = work / f"{name}.html"
            src.write_text(page(theme, n, fid, title, at, caption, body))
            if not html_only:
                shoot(src, OUT / f"{name}.png", height)
                print("wrote", (OUT / f"{name}.png").relative_to(ROOT))
    (OUT / "frames.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (OUT / "index.html").write_text(index_page())
    print("html in", work)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
