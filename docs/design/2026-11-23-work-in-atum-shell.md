# Work in the Atum shell: one frame, account-level connections (design spec, 2026-11-23)

**Status:** design only. No product code. Branch `docs/work-ui-1123`, local commit, not pushed.
**Authority:** Opus is the UI/UX authority (playbook). **Authorization:** owner, 2026-11-23, testing Work on the signed
A-1 build: "Work seems to be T3 inside Atum shell … panels are inside Atum panels? I feel like Atum panels can be reused
for T3 panels? UI looks weird"; "Subs still don't work, 'atum model' and 'atum delegated' makes no sense. And there's no
way for me to connect my subs?"; "Still seeing 'binh minh'". Direction: every subscription connection (ChatGPT/Codex,
Claude, Antigravity) is reached from Work; cloud agents use Work sessions for relay and for delegation.
Coordinator follow-up, same day: **connections are account-level** (connect once anywhere, available everywhere), and
**Google data restrictions are removed** (owner's attestation): no "Atum only" greying anywhere in the picker.

Mockups: [`2026-11-23-work-in-atum-shell-mockups.html`](./2026-11-23-work-in-atum-shell-mockups.html) (open in a
browser, light and dark). ASCII versions are inline below.

References used. `D:` this repo (atum-desktop @ 784f608f). `T3:` atum-platform/atum-work @ 5d8d30d04ee1 (the bundled
T3). `R:` the relay plan, `docs/plans/2026-11-22-session-handoff-relay.md` (atum-app, branch
`docs/session-handoff-relay-1122`).

---

## 0. What is wrong today (the screenshot)

| Owner sees | Cause | Where |
|---|---|---|
| A sidebar inside a card inside the frame: T3's thread list, its own "Work" logo, its own sidebar toggle and a row of footer icons, all inside one rounded Atum card | The Work page gives T3 one rounded host rectangle (`data-atum-work-host`) and T3 draws its whole desktop layout inside it | `D: apps/desktop/src/app/work/work-screen.tsx:136-143`; `D: electron/work/surface/electron-view.ts:66-73` (`setBorderRadius`, `setBounds`) |
| Three panel toggles at the top right that look like a second title bar | T3's own thread header, inside the card | `T3: apps/web/src/components/chat/ChatHeader.tsx` |
| "Atum · binh-minh" | The sidecar pins a retired alias, and the ACP catalog prefixes every row with the provider name | `D: electron/work/sidecar/process.ts:11`, `supervisor.py:212`, `host.ts:211`; `D: acp_adapter/model_catalog.py:220` (`f"{provider_name} · {rendered_model}"`) |
| "AT" and "AD" in the picker rail; "Atum (delegated)" | The internal delegated broker is a normal, visible provider instance | `D: electron/work/sidecar/process.ts:55-58` (`BROKER_PROFILES`) |
| No ChatGPT, Claude or Antigravity anywhere | Both plan instances ship disabled with `/usr/bin/false`; the Connect step is compiled off | `D: electron/work/sidecar/process.ts:125-127`, `:52` (`WORK_PLAN_CONNECT_SHIPPED = false`) |

---

## 1. Layout: Work uses Atum's panels

### 1.1 The decision

**One owner view, Atum's materials.** On the Work destination the Atum renderer stops drawing a roster panel and a
main card. It gives the owner view the **whole region right of the rail, under the 48 px title band**, with a
transparent background. Inside that region, T3 paints its own three regions **as Atum's three panels**: its thread
list is the roster panel, its thread is the main card, its right panel is the side panel. The frame shows through the
8 px gaps. Nothing is nested any more: rail · roster · main · side, exactly STYLE §2.

```text
 today                                          after
┌──┬──────────────────────────────────────┐    ┌──┬───────────┬────────────────────────┐
│  │ Work                                 │    │  │ ◧  ✎      │ Work           ◯◯ 2 ▾  │  ← Atum title band (48 px)
│▣ │╭────────────────────────────────────╮│    │▣ │╭─────────╮ ╭──────────────────────╮│
│  ││[■ Work  ◧]│ workspace / New thr ▤▭▯││    │  ││ Search  │ │ Fix the login bug     ││
│◎ ││ Search ⚲ ✎│                        ││    │◎ ││         │ │                       ││
│  ││ workspace │                        ││    │  ││ Today   │ │   …the thread…        ││
│▢ ││ New thread│        Ask anything    ││    │▢ ││ ● Fix … │ │                       ││
│  ││           │                        ││    │  ││ ◯ Luna's│ │ ╭───────────────────╮ ││
│  ││ Settled 0 │                        ││    │  ││   chat  │ │ │ Ask anything      │ ││
│◉ ││ ⚙ ⑂ ⓘ ▥  │                        ││    │◉ ││ Settled │ │ │ ⊕   Nhật Thực ▾ ↑ │ ││
│  │╰────────────────────────────────────╯│    │  │╰─────────╯ ╰──────────────────────╯│
└──┴──────────────────────────────────────┘    └──┴───────────┴────────────────────────┘
   one Atum card with T3's whole app in it        T3's regions ARE the roster panel and main card
```

### 1.2 Region map

| T3 region | Fate | Atum region it becomes | Mechanism |
|---|---|---|---|
| Thread sidebar (`T3: components/AppSidebarLayout.tsx:479-495`, `<Sidebar collapsible="offcanvas" data-app-sidebar>`) | **Kept**, restyled | **Roster panel**: 268 px default, `--atum-r-panel` 14 px, `--atum-roster-bg`, 0.5 px rim, top highlight, 8 px from the rail and from main | Environment theme CSS (§1.3) |
| Sidebar brand row (the "Work" logo and T3's own toggle) | **Hidden** | Atum's title band holds the toggle and New thread over the roster column (STYLE §2 "Above the roster: the sidebar toggle and New chat") | Theme CSS hides the row; the band's two controls send T3's own commands (§1.4) |
| Sidebar search, project groups, thread rows, "Settled" | **Kept** | Roster rows, 40 px pitch, kit selected fill (never blue) | Theme CSS |
| Sidebar footer icons (settings, source control, activity, usage) | **Hidden except Settings** | One quiet gear at the foot of the roster panel. Usage is not on any status line (owner rule: no balance meters) and stays reachable inside T3 Settings | Theme CSS |
| Thread view + composer | **Kept** | **Main card**: `--atum-main-bg`, `--atum-main-edge`, 14 px radius | Theme CSS (T3's `sidebar-inset` slot, `T3: components/ui/sidebar.tsx:651-654`, already supports an inset, rounded main) |
| Thread header (breadcrumb, panel toggles) | **Kept, quiet** | First row of the main card: 44 px, no rule under it, title in body-strong, the three panel toggles as circle icon buttons at the right. Phase 2 lifts it into the title band (§1.5) | Theme CSS |
| Right panel (diff, browser, files) | **Kept** | **Side panel**: a second card, 4 px either side of an 8 px gap (STYLE §2) | Theme CSS |
| Terminal drawer | **Kept** | Bottom of the main card, inside it | Theme CSS |
| T3 modals, popovers, the model picker | **Kept** | Kit surfaces: `--ak-shadow-*`, kit radii, kit type | Theme colors + CSS |
| T3's welcome / onboarding page | **Never shown** in the Atum build | n/a; Atum's connect sheet replaces it (§3) | already gated by the Atum build flag (`T3: routes/__root.tsx:230`, `VITE_ATUM_WORK_BUILD`) |

### 1.3 Mechanism: native first

The order we checked, best first:

1. **T3's environment theme (chosen).** T3 already lets the server publish a theme with **colors and CSS** that every
   client of that server applies, and a server-side default that switches clients to it:
   `T3: docs/user/appearance.md:51-63` (Custom CSS "applies after T3 Code's own styles"), `:82-110` (Environment
   themes; publish by saving JSON into the server's `userdata/themes/`; `t3 theme set <id>`), and the settings keys
   `defaultTheme` / `defaultThemeSetAt` (`T3: packages/contracts/src/settings.ts:1508-1512`). Our sidecar already
   writes the server's `settings.json` before T3 opens its home (`D: electron/work/sidecar/supervisor.py:200-218`), so
   it can drop `atum.json` into `<account>/work/server/userdata/themes/` and set `defaultTheme: "atum"` with a fresh
   `defaultThemeSetAt` on every start. **Zero fork diff** for colors, radii, gaps, hidden rows, panel cards.
   - The theme is **generated at build time from the Kit tokens** (`packages/atum-kit` CSS variables, light and dark),
     not hand-copied, so Work follows look packs (STYLE §3a) when the Kit changes.
   - Selectors target T3's stable `data-slot` / `data-app-sidebar` attributes, never class names.
2. **T3's sidebar `variant`.** The shadcn sidebar T3 uses has `variant: "sidebar" | "floating" | "inset"`
   (`T3: components/ui/sidebar.tsx:284-292, 395-410`). `inset` is very close to Atum's frame (sidebar on the frame,
   main as a rounded inset card). Today AppSidebarLayout does not pass it. If theme CSS fights the default variant,
   the fork passes `variant="inset"` under `VITE_ATUM_WORK_BUILD` (one prop; a candidate upstream setting).
3. **Fork code under the existing build flag** only for what CSS cannot do: the title-band commands (§1.4), the relay
   thread line (§4), hiding the delegated broker (§2). Each is a few lines behind `VITE_ATUM_WORK_BUILD`, which the
   fork already uses (`T3: routes/__root.tsx:230`).

**Rejected.** (a) Rebuilding T3's thread list in Atum's React roster from T3's API: a parallel reimplementation of
drafts, pins, settle/snooze, projects, drag-drop and undo (`T3: docs/user/thread-sidebar.md`), the exact anti-pattern
in `AGENTS.md` ("Do not re-implement the primary chat experience"). (b) Several native views, one per region: T3 has
no sidebar-only route, and two copies of T3's client state would drift.

### 1.4 What the Atum renderer does on Work

| Piece | Change | Where |
|---|---|---|
| Roster slot | Not drawn while Work is on screen (the view paints the roster panel) | `D: src/app/atum/shell-frame.tsx:109-125` (`sidebarShowing` false for Work) |
| Host | Spans roster + main + side columns, below the band, **no card background, no radius**; the 8 px insets stay | `D: src/app/work/work-screen.tsx:136-143` |
| View | Transparent background so the frame (and its vibrancy) shows in the gaps; `setBorderRadius(0)` | `D: electron/work/surface/electron-view.ts:26-35, 66` |
| Title band, over the roster column | Sidebar toggle and New thread (Phosphor Light). They call T3's own commands through the owner preload (`toggleSidebar`, `newThread`), which T3 already exposes as keybinding commands (`T3: docs/user/keybindings.md`) | `D: electron/work/sidecar/preload.ts` + the fork's listener |
| Title band, over the main column | "Work" in headline; at the right, the Assistants pill (who is working now). The Assistants **band** and the relay shared-context line leave the body: the band's one control ("Assistants can start work here") moves into the pill's popover; the shared-context line moves onto each relay thread (§4) | `D: work-screen.tsx:106-135` |
| "Add Protons" | Unchanged: title-band action, only when Atum models are out (no balance shown) | `D: work-screen.tsx:109-113` |

### 1.5 Phase 2 (optional, behind a probe)

Lift T3's thread header (thread title, panel toggles) into the title band so the main card has no header row at all.
This needs the view to extend under the band with `-webkit-app-region: drag` honoured inside a `WebContentsView` and
the traffic lights kept clear. **Probe P2** decides; if it fails, Phase 1 stands and looks right on its own.

---

## 2. The model picker in Work

### 2.1 One picker, T3's

T3's own picker **is** the "two-column provider-rail picker (T3 style)" the owner chose as the one model picker
(STYLE §12): rail `T3: components/chat/ModelPickerSidebar.tsx`, list `ModelPickerContent.tsx`. Work keeps it and only
fixes what it is fed. Rows stay one line: provider mark, name, muted description, ⌘ hint.

```text
╭───────────────────────────────────────────────────────────────╮
│ ★  │ ⚲ Search models                                          │
│    │──────────────────────────────────────────────────────────│
│(A) │ ◆ Nguyệt Thực   Suggested · Good for everyday tasks  ⌘1  │  ← Atum mark, real names
│    │ ◆ Nhật Thực     Good for hard tasks           ✓      ⌘2  │
│ G  │ ◆ Thái Cực      The most powerful model              ⌘3  │
│    │                                                          │
│ C  │                                                          │
│    │                                                          │
│ A· │                                                          │
╰───────────────────────────────────────────────────────────────╯
 rail: ★ favourites · Atum · ChatGPT · Claude · Antigravity
       connected = solid mark · not connected = mark with a small hollow dot (no text in the rail)
```

Selecting a connected plan in the rail lists its models exactly as T3 advertises them. Selecting one that is **not
connected** replaces the list with one centred state:

```text
│ G  │                                                          │
│    │                 (ChatGPT mark, 40 px)                    │
│    │               Use your ChatGPT plan                      │
│    │                   [ Connect ]                            │
```

One line, one capsule. No prices, no limits text, no "relay", no "Mac offline", no Google caveat.

### 2.2 Rules

| Rule | Design | Basis |
|---|---|---|
| Atum's models | Shown under their **current names**: Nguyệt Thực (GPT-6 Luna), Nhật Thực (GPT-6.1 Sol), Thái Cực (Sonnet 5.5), with STYLE §12's lines. A model the account cannot use yet is disabled with its own line ("Coming soon"), as in Atum's picker. **"Bình Minh" appears nowhere.** No "Atum ·" prefix on rows: the rail already says Atum | owner lineup; STYLE §12 |
| Default model | Nguyệt Thực, the suggested one | STYLE §12 |
| The delegated broker | **Never in the picker.** It stays a running provider instance (cloud delegation launches use it) but has no rail entry and no rows | owner: "'atum delegated' makes no sense" |
| Subscriptions in the rail | ChatGPT, Claude, Antigravity always appear, connected or not, read from the **account-level connection set** (§6). Order: Atum, then connected plans, then unconnected | coordinator 11-23 |
| Connect | The one action on an unconnected plan. It opens the **account-level connect sheet** (§3), never T3's Settings page and never a Work-only flow | coordinator 11-23 |
| Plan limit reached | The plan's rows show the reset time when known, nothing else; the composer warning as specified 11-11 | R §6 |
| Google | No greying, no "Atum only" anywhere | coordinator 11-23 (restriction removed) |
| Avatars | Provider and Atum marks are squircles (services/apps); assistants are circles | STYLE §5 |

### 2.3 Native hooks this rides on

- T3 already offers setup for an enabled provider that is unauthenticated or not installed:
  `shouldOfferModelPickerSetup` (`T3: components/chat/ModelPickerContent.tsx:129-142`) and the "Set up {provider}"
  action that calls `onOpenProviderSetup(instanceId)` (`:203-234`; wired at `T3: components/ChatView.tsx:3485`).
  The Atum build relabels it **Connect**, moves it into the empty list state above, and routes `onOpenProviderSetup`
  to the preload (`window.atumWork.openConnect(provider)`) instead of `/settings/providers`.
- For that to fire at all, the plan instances must be **enabled and real** (not `/usr/bin/false`), so T3 reports them
  `unauthenticated` rather than `disabled` (`ModelPickerSidebar.tsx:22-23` shows "Disabled in settings" for the latter).
- Hiding the broker: T3 has per-model hiding (`hiddenModels`, `T3: packages/contracts/src/settings.ts:363-369`) but no
  per-instance picker flag. Add a small, generic `showInPicker: false` on the provider instance (fork first, offered
  upstream), set by the sidecar for `atum-managed-delegated`.

---

## 3. Connecting a subscription

### 3.1 One sheet, account-level

Every Connect in Atum (Work's picker, an agent chat's picker, an assistant's model row, Settings › Connections, the
greyed cloud-picker note) opens **the same Atum sheet**. It is drawn by the Atum renderer (the Work view hides while a
sheet covers it, as today: `D: work-screen.tsx` `obstructed`). The sign-in itself is always **the maker's own**, run by
T3 on this Mac: Atum code never sees a token (`R §5`, "Token custody").

```text
            ╭──────────────────────────────────────╮
            │              (G)                     │   provider mark, 48 px squircle
            │                                      │
            │        Connect ChatGPT               │   title
            │  Sign in with OpenAI. Atum never     │   one line
            │  sees your login.                    │
            │                                      │
            │  ☐ My assistants can use it too      │   the consent, default off
            │                                      │
            │                 Not now  [Continue]  │
            ╰──────────────────────────────────────╯
```

Three states, one focus each:

| State | What the sheet shows |
|---|---|
| **Ask** | Mark, "Connect {Provider}", one line, the consent checkbox, **Continue** / Not now |
| **Signing in** | Mark, "Finish in your browser", a spinner. A code field appears **only** if the maker hands back a code instead of returning on its own (Antigravity's code page, a Claude login that cannot return) |
| **Done** | Mark with the kit's check, "ChatGPT is connected". Closes itself after a beat; the picker now lists the plan's models and the new thread uses the one the owner tapped |

### 3.2 Per provider (all native T3 sign-in)

| | Owner steps | Native path |
|---|---|---|
| **ChatGPT / Codex** | Continue → OpenAI's page in the browser → Allow → back in Atum, done. **2 taps** | T3's managed ChatGPT sign-in, which also installs Codex: `T3: docs/user/providers-codex.md:5-19`. The view policy must allow this one external open (`D: docs/work-subscriptions.md` "Gate 4a … belongs to the Connect lane") |
| **Claude** | Continue → Claude's page in the browser → Authorize → done. **2 taps** | Claude Code's own `claude auth login`, which T3 already runs in its embedded terminal during onboarding: `T3: onboarding/providerReadiness.logic.ts:67-78`, `components/onboarding/WelcomePage.tsx:508-521`. Atum runs the same command through T3's terminal API **without showing a terminal**; the sheet shows the terminal viewport only as the fallback when the CLI asks for typed input |
| **Antigravity** | Continue → Google sign-in in the browser → done, or paste the code the page shows. **2-3 taps** | T3's own `agy` install and browser sign-in: `T3: docs/user/providers-antigravity.md:9-24` (code paste at `:19-24`) |

Install time (Codex, `agy`, Claude Code) is part of **Signing in**: the spinner line reads "Getting ready…" first.
No install prompt, no path, no config.

### 3.3 "My assistants can use it too": where consent lives

- It is **one checkbox in the connect sheet, default off.** OpenAI asks for express consent before background use
  (`D: docs/work-subscriptions.md`, plan switch row); the relay plan keeps consent "opt-in and default off, per plan"
  (`R §5`, risk record). Off is the one place the "default on" rule yields; it is visible, one tap, in the same sheet.
- Ticked = every assistant of the account may use this plan for relay and delegation, on every Mac that holds the
  connection. Choosing particular assistants is not in the sheet; it is the plan row on each assistant's card
  (Controls › model), where the owner is already looking at that assistant.
- Afterwards it is a switch on the connection's row in **Settings › Connections** ("My assistants can use it"), next
  to Disconnect. This replaces slice B's separate per-Mac switch and multi-step consent sheet with one account-level
  switch; the consent record (`work_consent_set` / `_revoke`) is unchanged underneath.
- **Greying in a cloud assistant's picker follows `R §3.1` exactly:** a plan model is selectable whenever that plan is
  connected **and** consented on at least one of the owner's Macs, and is never greyed because that Mac is asleep or
  offline now. It is greyed only when no Mac has it, with the one action that fixes it: **Connect** (this sheet, or,
  when consent is the missing piece, the same sheet opened on its checkbox). In Work's own picker consent never greys
  anything: the owner using their own plan needs no consent.

---

## 4. Sessions started by an assistant

Relay threads (an assistant's chat running on the owner's plan, `R §3.2`: one thread per assistant, conversation,
Mac, generation and reset epoch) and delegated threads (work an assistant hands to this Mac) are **ordinary threads in
T3's own list**. No second list, no tab, no filter.

```text
 roster panel                      main card
╭───────────────────╮  ╭──────────────────────────────────────────────╮
│ ⚲ Search          │  │ (L) Luna's chat · Started by Luna     ▤ ▭ ▯  │
│                   │  │ What you type here can show up in Luna's     │  ← one muted line, relay only (R O14)
│ Today             │  │ replies.                                     │
│ (L) Luna's chat ● │  │                                              │
│ (L) Draft the Q4… │  │  ▸ Context from your chat · 14 messages      │  ← the seed, collapsed
│ ◆ Fix login bug   │  │                                              │
│                   │  │  …the plan's own turns, as T3 renders them…  │
│ Settled         3 │  │                                              │
│ ⚙                 │  │ ╭──────────────────────────────────────────╮ │
╰───────────────────╯  │ │ Ask anything               ChatGPT ▾  ↑  │ │
                       │ ╰──────────────────────────────────────────╯ │
                       ╰──────────────────────────────────────────────╯
```

| Element | Design | Native / glue |
|---|---|---|
| Row in the list | The assistant's **circle** face (16 px) where a thread shows its provider mark; the title; T3's own running dot | Theme CSS + the fork reads the thread's linked origin |
| Title | Relay: "{Name}'s chat", stable (one thread per conversation, no New chat, `R O8`). Delegated: the task's own title, as T3 names it | T3 title generation for delegated; the gate sets the relay title at launch |
| "Started by {Name}" | In the thread header beside the title, with the face. This is T3's own linked-origin badge ("From …", `T3: components/chat/ChatHeader.tsx:398-411`) relabelled, with the origin name the gate already supplies (`D: electron/work/mount/gate-factory.ts:61`) | Fork label under the build flag |
| The disclosure line | Relay threads only, one muted line under the header: "What you type here can show up in {Name}'s replies." This replaces today's page-level line (`D: src/app/work/relay-chrome.tsx`) | `R O14`; copy already in `D: src/app/work/relay-copy.ts` |
| The seed | Collapsed to one line, "Context from your chat · N messages", expandable. Never a wall of history | T3's handoff rendering if it fits (`T3: components/ChatView.handoffCompaction.browser.test.tsx`), else a fork disclosure |
| Words | No Atum-written text inside the thread. The assistant's and the plan's turns speak for themselves; status is chrome only (owner rule: no canned agent text) | — |
| Stop, questions | T3's own (`t3_thread_interrupt`, `t3_pending_request`) | `R §2` |
| Held / late answers | Shown in the **chat** ("Waiting for your Mac"), not here; in Work the thread is simply running or finished | `R O12, O13` |

Who is working right now stays in the title band's Assistants pill: faces of assistants with a running thread, one
tap opens a small list that jumps to each thread.

---

## 5. Mockups

`docs/design/2026-11-23-work-in-atum-shell-mockups.html`, three frames, light and dark:

1. **Default Work**: rail, title band, roster panel (T3's list), main card (empty thread, composer with Nguyệt Thực).
2. **Picker**: Atum's three models; ChatGPT connected (its models), Claude and Antigravity unconnected (hollow dot);
   the unconnected state with Connect.
3. **Connect sheet**: Ask, Signing in, Done.

---

## 6. What Work needs from the account-level connections layer

A separate lane is re-architecting connections account-wide. Work needs exactly this from it, and nothing Work-only:

1. **One read: the account's connection set.** For each provider (`chatgpt`, `claude`, `antigravity`, and later
   others): `state` (`connected` / `not_connected` / `needs_attention`), **which devices hold it** (by the owner's own
   device name), `assistantsMayUse` (the consent), and the reset time when a limit is reached. Work's picker rail and
   every other picker render from this one read.
2. **One action: `connect(provider, {from})`.** Opens the shared sheet (§3). On a Mac it runs T3's native sign-in
   there. On a device that cannot hold the login (phone, web), the sheet says "Connect on your Mac" and offers to send
   the step to the owner's Mac (the Mac then shows the same sheet).
3. **Custody stays on the device.** Device-bound plans (ChatGPT, Claude, Antigravity) are "account-level" as a
   **fact** (connected, on which Mac, consented), never as a copied token (`openai-siwc` custody; `R §5`). The
   layer stores the fact; T3 and the maker's client keep the login.
4. **Change events.** Work learns of connect/disconnect/consent changes from the layer (today: T3's provider status
   feeding `PlanFact`, `D: docs/work-subscriptions.md` "Fact (G9)"), so the picker updates without a reload.
5. **Consent as one account-level switch per connection**, written through the existing consent record
   (`work_consent_set` / `_revoke`); per-assistant choices are the layer's, surfaced on assistant cards.
6. **Disconnect** from Settings › Connections, which stops plan threads at once (slice B's cutoff, unchanged).

---

## 7. Implementation split

### Desktop UI (Opus builds)

| # | Piece | Files |
|---|---|---|
| U1 | Work layout: no roster slot on Work, host spans roster+main+side, transparent, no card; title-band controls over the roster column (toggle, New thread) | `src/app/work/work-screen.tsx`, `src/matrix/app.tsx` (Work branch of `AtumShellFrame`), `src/app/atum/shell-frame.tsx` |
| U2 | Move the Assistants band into the pill popover; drop the page-level relay line | `src/app/work/assistants.tsx`, `relay-chrome.tsx`, `work-screen.tsx` |
| U3 | The **Atum environment theme**: colors and CSS generated from Kit tokens (light, dark, look packs); the region map of §1.2; picker rows and the unconnected state; relay thread row face, header badge, disclosure line, collapsed seed | new `apps/desktop/scripts/build-work-theme.mjs` → `work-runtime/themes/atum.json`; visual check against the pin |
| U4 | The **account-level connect sheet** (Ask / Signing in / Done, consent checkbox, code field fallback), one component used by every Connect | new `src/app/connections/connect-sheet.tsx` (replaces `src/app/work/plan-connect.tsx` and the multi-step `plan-consent.tsx`) |
| U5 | Settings › Connections: one row per connection with "My assistants can use it" and Disconnect; cloud-picker greying per `R §3.1` with Connect | `src/matrix/settings-*`, `src/matrix/model-picker*` |
| U6 | Copy (en, vi) for every line above; remove "Atum (delegated)" and any "binh-minh" from Atum copy | `src/app/work/copy.ts`, `relay-copy.ts` |

### Engineering (Sol builds)

| # | Piece | Files |
|---|---|---|
| E1 | **Real Atum model names**: drop `binh-minh` (`ATUM_WORK_MODEL`, `supervisor.py` default, `host.ts` access alias check); the managed ACP catalog advertises the account's lineup (Nguyệt Thực, Nhật Thực, Thái Cực) with display names and no "Atum ·" prefix; default Nguyệt Thực; access check by the account's model access, not one alias | `electron/work/sidecar/process.ts:11`, `supervisor.py:212`, `host.ts:211`; `acp_adapter/model_catalog.py:220`, `acp_adapter/managed.py` |
| E2 | **Hide the delegated broker**: generic `showInPicker: false` on provider instances in the fork (offered upstream), set for `atum-managed-delegated` | atum-work `packages/contracts/src/settings.ts`, `ModelPickerContent.tsx` filter; `process.ts:55-58` |
| E3 | **Enable the plan instances** (`codex`, `claudeAgent`, `antigravity`) as real, T3-managed installs so T3 reports `unauthenticated`; flip `WORK_PLAN_CONNECT_SHIPPED` with it. **Blocked on the owner's B-0 containment choice** (`D: docs/work-subscriptions.md` "Gaps": same-macOS-user file reads of plan logins) | `process.ts:52, 125-127`, `supervisor.py` |
| E4 | **Connect plumbing**: preload `openConnect(provider)`, `toggleSidebar`, `newThread`; main routes Connect to the renderer sheet; the sheet drives T3's native sign-in (managed ChatGPT, `claude auth login` via T3's terminal API headless, `agy` sign-in) and reports progress; view policy allows the maker's sign-in page to open externally | `electron/work/sidecar/preload.ts`, `host.ts`, `electron/work/session/*` (policy), `electron/work/surface/surface.ts` |
| E5 | **Theme delivery**: sidecar copies `atum.json` into the server's `userdata/themes/` and sets `defaultTheme` + fresh `defaultThemeSetAt` each start; transparent `WebContentsView` with radius 0 | `supervisor.py:200-218`, `electron/work/surface/electron-view.ts` |
| E6 | **Relay/delegated thread labels**: gate sets relay thread title "{Name}'s chat" and the origin name; fork relabels the linked-origin badge to "Started by {Name}" and renders the O14 line on relay threads | `electron/work/gate/*`, atum-work `ChatHeader.tsx:398-411` |
| E7 | **Account-level connection fact**: report all three providers (not only `codex`) into the account layer's set; consent as one switch per connection over the existing record | `electron/work/gate/plan-fact.ts`, `contract.ts` (with the connections lane's contract change first, DR-3) |

### Probes (before U1/U3 land)

| Probe | Question | Fallback |
|---|---|---|
| P1 | Does a transparent `WebContentsView` over the window show the frame's vibrancy in the 8 px gaps on macOS? | Theme paints the gaps with `--atum-frame-bg` (solid in Work only) |
| P2 | Is `-webkit-app-region: drag` honoured inside the view, traffic lights kept clear? (Phase 2 only) | Phase 1 header row stays in the main card |
| P3 | Do theme selectors survive a pin bump? | A screenshot check of the three mockup states runs on every atum-work pin bump |

### Order

E1 + E2 first (they fix "binh-minh" and "Atum delegated" on their own, no dependency) · U1 + U3 + E5 (the layout) ·
U4 + E4 (Connect) · E3 when B-0 is decided · U5 + E7 with the connections lane · E6 + U3's relay pieces with relay R1.

Nothing in this document authorises a build, a deploy, a purchase or a production change.
