# Work in the Atum shell: one frame, account-level connections (design spec, 2026-11-23)

**Status:** design only. No product code. Branch `docs/work-ui-1123`, local commit, not pushed.
**Authority:** Opus is the UI/UX authority (playbook). **Authorization:** owner, 2026-11-23, testing Work on the signed
A-1 build: "Work seems to be T3 inside Atum shell … panels are inside Atum panels? I feel like Atum panels can be reused
for T3 panels? UI looks weird"; "Subs still don't work, 'atum model' and 'atum delegated' makes no sense. And there's no
way for me to connect my subs?"; "Still seeing 'binh minh'". Direction: every subscription connection (ChatGPT/Codex,
Claude, Antigravity) is reached from Work; cloud agents use Work sessions for relay and for delegation.
Coordinator follow-up, same day: **connections are account-level** (connect once anywhere, available everywhere), and
**Google data restrictions are removed** (owner's attestation): no "Atum only" greying anywhere in the picker.
Second pass, same day (owner): "get the mode split folded in" and "the design of Work isn't in line with our
consistent aesthetics - icon uses for example". Original intent (self-work plan, `docs/self-work-plan-1121-r5` §0): "edit
the UI UX for work mode vs code mode (code can stay basically the same as T3 now, work mode has less coding-specific
stuff to be less intimidating) … a toggle inside its screen to switch between code and work". That pass adds §8-§11;
§11 supersedes §7's order.

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

`docs/design/2026-11-23-work-in-atum-shell-mockups.html`. The second pass (§10) redraws every frame with the Kit's
real Phosphor Light glyphs and adds the mode frames. The first three frames:

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

---

## 8. Work mode (default) and Code mode

References in this section: `T3:` is `atum-platform/atum-work` @ `5d8d30d04ee11af5ba92d5aa40a7778505f04cff`, paths under
`apps/web/src/` unless they start with `packages/`.

### 8.1 The decision

**Two modes of one surface. The mode is presentation only.** It never changes a thread's provider, model, session,
prompt or history, so flipping it costs nothing and breaks no cache (AGENTS.md, "Prompt caching must not break").
Both modes run the same T3, the same threads, the same picker and the same Atum frame (§1).

- **Work** is the default. Airy, plain words, no source-control vocabulary: documents, files, design, research,
  everyday tasks. What it hides is listed in §8.3; nothing it hides is *disabled*: the agent still runs commands and
  edits files, and the owner sees the result as files, not as diffs and terminals.
- **Code** is T3 as it is today, restyled to Atum (§9): branches, worktrees, diffs, terminal, PRs, scripts, open-in.

### 8.2 Where the switch lives and what it remembers

**One control: a two-segment `.ak-seg` "Work · Code" in the title band over the main column**, at the right, before
the Assistants pill (STYLE §2: the title bar belongs to the page under it; a page's controls live in its title band,
never in a second header). Small size (26 px). It is the "toggle inside its screen" of the owner's brief.

**Remembered per project, not per thread.** Why:

1. **What a folder is decides what tools make sense.** A repository wants branches and diffs; a folder of documents
   does not. Mode is a property of the place, like Finder's view per folder.
2. **Native.** T3 already has project-scoped settings with inheritance and per-project overrides
   (`T3: packages/contracts/src/settings.ts:1173` `PROJECT_SCOPED_SERVER_SETTING_KEYS`, `:1211`
   `ProjectSettingsOverrides`, absent keys inherit). The mode is one more key there. Per thread would need a new
   thread field, an orchestration event and a migration.
3. **Calm.** T3's roster groups threads by project. Per-thread mode would flip the chrome as the owner walks down the
   list; per project it changes only when they cross into another project.
4. **Deterministic for assistants** (§8.4): every assistant-started thread lands in a known project.

**Default: Work, with one automatic exception.** A project whose folder is a git repository opens in **Code** the
first time (T3 already knows: `isGitRepo`, passed as `showGitControls={isGitRepo}` at `T3: components/ChatView.tsx:3872`).
Anyone with a repository is a coder; nobody is asked to choose (owner rule: default automatic, no decisions). Once the
owner flips the switch on a project, that choice is kept for the project.

### 8.3 What each mode shows

| Element | Work | Code | Controlled by (native first) |
|---|---|---|---|
| Thread header panel toggles | **Right panel only** (opens Files / Preview / Browser) | Thread details, terminal, right panel, maximize | Existing props `showThreadPanelControl`, `showTerminalControl`, `showRightPanelControl` on `PanelLayoutControls` (`T3: components/chat/PanelLayoutControls.tsx:23-25, 96-134`), rendered at `ChatView.tsx:3370` |
| Terminal drawer | **Hidden, not mounted.** The agent's commands still run; they appear as the collapsed work line below | Shown | `<ChatTerminalDrawers>` at `ChatView.tsx:4047`; the `terminal.toggle` keybinding is a no-op in Work |
| Right panel | Files, Preview, Browser surfaces | All, including Diff | `<ChatRightPanel>` at `ChatView.tsx:4063`; `RightPanelSurfaceContent.tsx:116` (`DiffPanel`) skipped in Work |
| Composer context strip: env mode (local / worktree), branch, start-from-origin, environment, PR checkout | **Hidden.** Work projects run local (`defaultThreadEnvMode: "local"`) | Shown | `showComposerContextStrip` (`ChatView.tsx:1818`) feeds `<BranchToolbar>` (`:3865`); project setting `defaultThreadEnvMode` (`packages/contracts/src/settings.ts:1215`) |
| Permission mode chip (Supervised / Auto-accept / Auto / Full access) | **Hidden.** Work projects use `auto` (provider approves routine actions, asks for the rest; owner 11-17 "smart") | Shown | `<ComposerContextPermissions>` (`ChatView.tsx:3908`, modes in `components/chat/runtimeModeConfig.ts:15-40`); project setting `defaultRuntimeMode` (`settings.ts:1214`) |
| Approvals when they arrive | **Shown, plain**: one `.ak-ask`, "Allow changes to 3 files in Documents?", Allow / Not now; the command or path behind a "Details" disclosure | T3's own row with the command | `TimelinePendingApprovalRow.tsx`, `ComposerPendingApprovalActions.tsx` (restyled, same data) |
| Thread details panel (branch, open-in, scripts, PR rows, git actions, servers) | **Hidden** | Shown | `<ThreadDetailsPanel>` at `ChatView.tsx:3962` (contains `OpenInPicker` `ThreadDetailsPanel.tsx:206`, `ProjectScriptsControl` `:217`, `GitActionsControl` `:252`, `ThreadServersPanel` `:268`) |
| Pull requests and Issues links in the roster | **Hidden** | Shown | `components/sidebar/SidebarChrome.tsx:291-299` (Settings, `:285`, stays) |
| Roster footer | Settings gear only (§1.2) | Settings, Pull requests, Issues | `SidebarChrome.tsx:318` (`SidebarFooter`), usage item `:304` hidden in both (no balance meters) |
| Agent's tool steps | **Collapsed** to one quiet line, "Worked for 2 min · 6 steps", expandable; raw shell output only inside | T3's work groups as they are | T3 already groups them (`WorkGroupSection`, `components/chat/TimelineWorkGroupRows.tsx:66`); Work starts groups collapsed |
| Changed files | **File cards** (STYLE §10 "Files": sunk tile with the file's glyph, name, "Document · changed"); Open opens Preview | `+12 −3` stats, `ChangedFilesTree`, Diff | `DiffStatLabel` / `ChangedFilesTree.tsx:77-278` replaced in Work by the card |
| Timeline minimap | Hidden | Shown | `MessagesTimeline.tsx:1503` |
| Model picker | **Same picker** (one picker everywhere). Chip shows the model name only | Chip with effort glyph | `ProviderModelPicker` at `components/chat/ComposerFooterControls.tsx:321`; the thinking column follows STYLE §12 in both |
| Slash suggestions | `/model`, `/side`, skills | Everything, including the provider's own (`/compact`, `/review`, `/init` …) | `useComposerMenuItems.ts:256-322`; Work drops `provider-slash-command` items from **suggestions only**: typed, they still run (same rule as desktop's `isDesktopSlashExtensionCommand`) |
| Command palette | Threads, projects, models, themes | Everything | Work filters git, worktree and port-forward items (`CommandPalettePortForwardItems.tsx`, `CommandPaletteProjectItems.tsx`) |
| New-thread empty state | Atum's (§9.5): mark, "What should we work on?", one line, three suggestions | T3's hero (project heading, "Ask anything"), restyled | `DraftHeroHeadline` at `ChatView.tsx:3651` |
| Subagent bar | Shown, as faces + "2 helpers working" | T3's bar | `ProviderSubagentBar` at `ChatView.tsx:3677` |
| Usage limits chip | Hidden (both); only the limit-reached composer warning (11-11 rule) | Hidden | `ComposerUsageLimits.tsx` |
| Settings (from the gear) | General, Appearance, and a "Connections" row that opens Atum's sheet (§3) | Every T3 page | `components/settings/SettingsSidebarNav.tsx` nav list filtered in Work |

### 8.4 Threads started by an assistant

- **Relay threads** live in the assistant's relay project, provisioned by the gate (`D: electron/work/gate/gate.ts:64`
  `relayProvision` returns its `projectId`). That project is created **Work** and is never a repository, so a relay
  thread always opens in Work.
- **Delegated threads** name their project (`D: electron/work/gate/contract.ts:148`). They open in **that project's
  mode**: a writing task in Documents opens in Work, a fix in a repository opens in Code. No rule beyond §8.2.
- The badge, title and disclosure line of §4 are the same in both modes.

### 8.5 Moving between modes

- Flip the switch: the current project changes mode at once, every thread in it included, with a 200 ms cross-fade of
  the chrome (fade only under Reduce Motion). The transcript does not move; nothing is re-sent.
- A keybinding command `atum.mode.toggle` (⌘⇧M) through T3's own keybinding registry (`T3: docs/user/keybindings.md`).
- No per-thread override, deliberately: one thread that needs a terminal is a reason to flip its project, which is
  one tap and reversible.
- Moving a thread to another project (T3's own move) takes on that project's mode.

### 8.6 Mechanism

1. **One project-scoped key**, `atumSurfaceMode: "work" | "code"`, added to `PROJECT_SCOPED_SERVER_SETTING_KEYS`
   (`settings.ts:1173`) and `ProjectSettingsOverrides` (`:1211`). Server default `"work"`; the git-repository default
   of §8.2 is applied once at project creation. Behind `VITE_ATUM_WORK_BUILD`, a hook `useAtumSurfaceMode(projectId)`
   reads it; **outside the Atum build it always returns `"code"`**, so upstream behaviour is byte-identical and pin
   bumps stay cheap.
2. **Existing props first**: the panel toggles and the context strip already take booleans (§8.3), so most rows are
   one prop at the call site.
3. **Render guards** (`mode === "code" &&`) for the few interactive pieces with no prop (terminal drawer, thread
   details, diff surface, minimap, PR links), so a hidden panel cannot be opened by a shortcut either.
4. **Theme CSS** only for presentation: the root carries `data-atum-mode="work|code"`, and the environment theme (§1.3)
   uses it for density (roster row lines, collapsed work groups' styling). No hidden-but-mounted interactive control.
5. **Sidecar defaults** for Work projects: `defaultThreadEnvMode: "local"`, `defaultRuntimeMode: "auto"`.

---

## 9. Icons and aesthetics

### 9.1 What is wrong

T3 draws **Lucide** (stroke icons, `lucide-react` ^0.564, imported directly in about 330 files of `T3: apps/web/src`).
Atum draws **Phosphor Light**, Fill for the selected state only (STYLE §8, owner 2026-10-28), from the Kit's pinned
set (`D: packages/atum-kit/icons.json`; paths in `dist/phosphor-icons.json`, Phosphor 2.1.1). Side by side in one
window the two read as two products: different stroke weight, corner shapes and metaphors (a "square pen" for New
thread where Atum draws `note-pencil`; a blue info badge where Atum has a quiet badge; square toggles where Atum has
circle icon buttons).

### 9.2 Mechanism: one icon map in the fork, behind the Atum build flag

Adopted pattern: the desktop already did exactly this when it moved from Tabler to Phosphor without touching a call
site: "The exported names are the ones the Tabler set used, so no call site changed; the Phosphor glyph for each is
chosen by meaning" (`D: apps/desktop/src/lib/icons.ts:3-5`, `src/lib/phosphor-icon.tsx`).

1. **`atum-icon-map.json` in the fork** (the table in §9.3) is the source of truth: Lucide export name → Phosphor name
   (+ `mirror`, `weight`).
2. **A generated shim**, `apps/web/src/atum/lucide-phosphor.tsx`, built from that map and the Kit's
   `dist/phosphor-icons.json` (copied into the fork's build by the desktop's Work-runtime packaging, never fetched).
   Each mapped name is exported in both Lucide forms (`X` and `XIcon`), takes Lucide's props (`className`, `size`,
   `strokeWidth` ignored, `aria-*`, `style`) and draws the Phosphor path in `currentColor` on a 256 viewBox. It
   re-exports the real Lucide for anything unmapped (`export *`), so a missed name degrades to Lucide, never to a crash.
3. **One Vite alias under `VITE_ATUM_WORK_BUILD`** (`T3: apps/web/vite.config.ts`, the same flag already used at
   `:331`): exact `^lucide-react$` → the shim. The shim imports real Lucide by its file path, which the exact alias
   does not catch. Upstream builds are untouched.
4. **A build check** fails the Atum Work build when a rendered Lucide name has no map row, so a pin bump that brings a
   new icon is caught at build, not by the owner.
5. **Sizes.** T3 uses 14 and 16 px (`size-3.5`, `size-4`). Phosphor Light is too thin below 16, so the shim draws
   any glyph smaller than 16 at 16 (STYLE §6: 16 dense rows, 18 buttons, 20 toolbars). Header and composer icon
   buttons are 18 inside 32 px circles via the theme (§9.4).
6. **Not mapped, on purpose:** brand art in `T3: components/Icons.tsx` (Finder, editors, provider logos) stays brand
   art inside a **squircle** (apps are squircles, STYLE §5); a project's custom icon chosen by the owner
   (`lib/lucideIconByName.ts`) is content and stays as chosen; a generic working spinner (`LoaderCircle`) becomes the
   Kit's `.ak-spinner`, and **the model at work shows the Atum atom** (STYLE §10), never a spinner.
7. **37 names to add to the Kit's `icons.json`** (then rebuild the Kit): `alarm`, `arrow-bend-left-up`, `arrow-bend-up-right`, `arrow-circle-up`, `arrow-u-up-right`, `arrow-up-left`, `arrows-down-up`, `battery-medium`, `circle-dashed`, `cloud-arrow-up`, `cursor`, `cursor-click`, `eraser`, `funnel-simple`, `gauge`, `git-commit`, `git-merge`, `hammer`, `laptop`, `link-break`, `list-plus`, `lock-simple-open`, `memory`, `paragraph`, `path`, `picture-in-picture`, `power`, `qr-code`, `scales`, `scan`, `scroll`, `shield-slash`, `translate`, `trend-down`, `user-check`, `user-plus`, `warning-octagon`. Marked ⁺ below.

### 9.3 The full map (every Lucide name the pinned T3 imports; ⁺ = add to the Kit first)

Both modes see a subset of these; Code sees more. The map covers all 245 so no surface falls back to Lucide.
Choices by meaning, as the desktop's map did: chats are `chat-circle` (Atum's chat glyph), New thread is
`note-pencil`, folders are `folder-simple` whether or not they hold a repository (Work never shows git as a folder
badge), `Bot` is `sparkle` (an assistant has a face, §9.4; a glyph-only slot gets the sparkle), the thread-details
toggle `SquareMenu` is `info`, the terminal toggle `PanelBottom` is `terminal-window`, and `PanelRight` is
`sidebar-simple` mirrored.

| Lucide (T3) → Phosphor Light (Atum) | | |
|---|---|---|
| `Activity` → `pulse` | `AlarmClock` → `alarm` ⁺ | `AlarmClockOff` → `alarm` ⁺ |
| `AlertTriangle` → `warning` | `Archive` → `archive` | `ArchiveX` → `archive` |
| `ArrowDown` → `arrow-down` | `ArrowDownUp` → `arrows-down-up` ⁺ | `ArrowLeft` → `arrow-left` |
| `ArrowRight` → `arrow-right` | `ArrowRightLeft` → `arrows-left-right` | `ArrowUp` → `arrow-up` |
| `ArrowUpCircle` → `arrow-circle-up` ⁺ | `ArrowUpLeft` → `arrow-up-left` ⁺ | `ArrowUpRight` → `arrow-up-right` |
| `AtSign` → `at` | `AudioLines` → `wave-sine` | `Battery` → `battery-medium` ⁺ |
| `Blocks` → `puzzle-piece` | `BookOpen` → `book-open` | `Bookmark` → `bookmark-simple` |
| `Bot` → `sparkle` | `Box` → `package` | `Brain` → `brain` |
| `Bug` → `bug` | `Building` → `buildings` | `Cable` → `plug` |
| `Calendar` → `calendar-blank` | `CalendarArrowDown` → `calendar-blank` | `CalendarArrowUp` → `calendar-blank` |
| `CalendarClock` → `calendar-check` | `Camera` → `camera` | `ChartNoAxesColumn` → `chart-bar` |
| `Check` → `check` | `CheckCircle2` → `check-circle` | `ChevronDown` → `caret-down` |
| `ChevronLeft` → `caret-left` | `ChevronRight` → `caret-right` | `ChevronUp` → `caret-up` |
| `ChevronsDownUp` → `arrows-in-line-vertical` | `ChevronsLeftRightEllipsis` → `dots-three` | `ChevronsUpDown` → `caret-up-down` |
| `Circle` → `circle` | `CircleAlert` → `warning-circle` | `CircleArrowUp` → `arrow-circle-up` ⁺ |
| `CircleCheck` → `check-circle` | `CircleDashed` → `circle-dashed` ⁺ | `CircleDot` → `dot-outline` |
| `CircleDotDashed` → `circle-dashed` ⁺ | `CircleSlash` → `prohibit` | `CircleStop` → `stop` |
| `CircleX` → `x-circle` | `ClipboardCopy` → `clipboard` | `Clock` → `clock` |
| `Clock3` → `clock` | `Cloud` → `cloud` | `CloudDownload` → `cloud-arrow-down` |
| `CloudUpload` → `cloud-arrow-up` ⁺ | `Code` → `code` | `Code2` → `code` |
| `Columns2` → `columns` | `Copy` → `copy` | `CornerLeftUp` → `arrow-bend-left-up` ⁺ |
| `CornerUpRight` → `arrow-bend-up-right` ⁺ | `Cpu` → `cpu` | `Database` → `database` |
| `Download` → `download-simple` | `Ellipsis` → `dots-three` | `Eraser` → `eraser` ⁺ |
| `ExternalLink` → `arrow-square-out` | `Eye` → `eye` | `EyeOff` → `eye-slash` |
| `File` → `file` | `FileCode2` → `file-code` | `FileDiff` → `git-diff` |
| `FileJson` → `file-code` | `FileSearch` → `magnifying-glass` | `FileSpreadsheet` → `file-xls` |
| `FileText` → `file-text` | `Files` → `files` | `Film` → `film-strip` |
| `FlaskConical` → `flask` | `FlaskConicalOff` → `flask` | `Folder` → `folder-simple` |
| `FolderClosed` → `folder-simple` | `FolderCode` → `folder-simple` | `FolderGit` → `folder-simple` |
| `FolderGit2` → `folder-simple` | `FolderOpen` → `folder-open` | `FolderPlus` → `folder-simple-plus` |
| `FolderTree` → `tree-structure` | `Gauge` → `gauge` ⁺ | `GitBranch` → `git-branch` |
| `GitBranchPlus` → `git-branch` | `GitCommit` → `git-commit` ⁺ | `GitCommitHorizontal` → `git-commit` ⁺ |
| `GitFork` → `git-fork` | `GitMerge` → `git-merge` ⁺ | `GitPullRequestArrow` → `git-pull-request` |
| `GitPullRequestClosed` → `git-pull-request` | `GitPullRequestDraft` → `git-pull-request` | `Globe` → `globe-simple` |
| `Globe2` → `globe` | `GripVertical` → `dots-six-vertical` | `Hammer` → `hammer` ⁺ |
| `HardDrive` → `hard-drives` | `History` → `clock-counter-clockwise` | `Home` → `house` |
| `Image` → `image` | `Inbox` → `tray` | `Info` → `info` |
| `KeyRound` → `key` | `Keyboard` → `keyboard` | `Languages` → `translate` ⁺ |
| `Laptop` → `laptop` ⁺ | `Layers` → `stack` | `Lightbulb` → `lightbulb` |
| `Link` → `link` | `Link2` → `link` | `Link2Off` → `link-break` ⁺ |
| `ListChecks` → `list-checks` | `ListFilter` → `funnel-simple` ⁺ | `ListPlus` → `list-plus` ⁺ |
| `ListTodo` → `list-checks` | `ListTree` → `tree-structure` | `LoaderCircle` → `(kit spinner)` |
| `Lock` → `lock-simple` | `LockOpen` → `lock-simple-open` ⁺ | `LogIn` → `sign-in` |
| `Mail` → `envelope-simple` | `Maximize` → `arrows-out` | `Maximize2` → `arrows-out-simple` |
| `MemoryStick` → `memory` ⁺ | `MessageCircle` → `chat-circle` | `MessageCircleQuestion` → `question` |
| `MessageSquare` → `chat-circle` | `MessageSquareDashed` → `chat-circle-dots` | `MessageSquareOff` → `chat-circle` |
| `MessageSquarePlus` → `note-pencil` | `MessageSquareText` → `chat-text` | `MessageSquareWarning` → `warning-circle` |
| `MessagesSquare` → `chats-circle` | `Mic` → `microphone` | `MicOff` → `microphone-slash` |
| `Minimize2` → `arrows-in-simple` | `Minus` → `minus` | `Monitor` → `monitor` |
| `Moon` → `moon` | `MoreHorizontal` → `dots-three` | `MoreVertical` → `dots-three-vertical` |
| `MousePointer2` → `cursor` ⁺ | `MousePointerClick` → `cursor-click` ⁺ | `OctagonAlert` → `warning-octagon` ⁺ |
| `OctagonX` → `x-circle` | `Package` → `package` | `PackagePlus` → `package` |
| `Paintbrush` → `paint-brush` | `Palette` → `palette` | `PanelBottom` → `terminal-window` |
| `PanelLeft` → `sidebar-simple` | `PanelLeftClose` → `sidebar-simple` | `PanelRight` → `sidebar-simple (mirrored)` |
| `PanelsTopLeft` → `layout` | `Paperclip` → `paperclip` | `Pause` → `pause` |
| `PenLine` → `pencil-simple-line` | `Pencil` → `pencil-simple` | `PictureInPicture2` → `picture-in-picture` ⁺ |
| `Pilcrow` → `paragraph` ⁺ | `Pin` → `push-pin` | `PinOff` → `push-pin-slash` |
| `Play` → `play` | `Plug` → `plug` | `Plug2` → `plug` |
| `Plus` → `plus` | `Power` → `power` ⁺ | `Presentation` → `presentation` |
| `QrCode` → `qr-code` ⁺ | `Quote` → `quotes` | `RadioTower` → `broadcast` |
| `Redo2` → `arrow-u-up-right` ⁺ | `RefreshCw` → `arrows-clockwise` | `Reply` → `arrow-bend-up-left` |
| `RotateCcw` → `arrow-counter-clockwise` | `RotateCw` → `arrow-clockwise` | `Route` → `path` ⁺ |
| `Rows3` → `rows` | `Scale` → `scales` ⁺ | `Scan` → `scan` ⁺ |
| `ScrollText` → `scroll` ⁺ | `Search` → `magnifying-glass` | `Send` → `paper-plane-right` |
| `Server` → `hard-drives` | `Settings` → `gear` | `Settings2` → `gear-six` |
| `Shield` → `shield` | `ShieldCheck` → `shield-check` | `ShieldOff` → `shield-slash` ⁺ |
| `ShieldQuestion` → `shield` | `SlidersHorizontal` → `sliders-horizontal` | `Smartphone` → `device-mobile` |
| `SmilePlus` → `smiley` | `Square` → `stop` | `SquareArrowOutUpRight` → `arrow-square-out` |
| `SquareMenu` → `info` | `SquarePen` → `note-pencil` | `SquareSplitHorizontal` → `columns` |
| `SquareSplitVertical` → `rows` | `Star` → `star` | `Sun` → `sun` |
| `Table2` → `table` | `Tag` → `tag` | `Target` → `target` |
| `Terminal` → `terminal-window` | `TerminalSquare` → `terminal-window` | `Text` → `text-aa` |
| `TextSearch` → `magnifying-glass` | `TextWrap` → `paragraph` ⁺ | `Ticket` → `ticket` |
| `Trash2` → `trash` | `TrendingDown` → `trend-down` ⁺ | `TrendingUp` → `trend-up` |
| `TriangleAlert` → `warning` | `Type` → `text-aa` | `Undo2` → `arrow-u-up-left` |
| `Unlink` → `link-break` ⁺ | `Unlink2` → `link-break` ⁺ | `Unplug` → `plug` |
| `Upload` → `upload-simple` | `User` → `user` | `UserCheck` → `user-check` ⁺ |
| `UserLock` → `user` | `UserPlus` → `user-plus` ⁺ | `UserRound` → `user-circle` |
| `UserRoundX` → `user` | `Users` → `users` | `Volume2` → `speaker-simple-high` |
| `VolumeOff` → `speaker-simple-slash` | `WifiOff` → `wifi-slash` | `Workflow` → `tree-structure` |
| `WrapText` → `paragraph` ⁺ | `Wrench` → `wrench` | `X` → `x` |
| `XCircle` → `x-circle` | `Zap` → `lightning` |  |

**Where each one shows.** Work mode, visible on every screen: `note-pencil`, `sidebar-simple`, `magnifying-glass`,
`gear`, `folder-simple`, `caret-down`/`caret-right`, `plus`, `paperclip`, `microphone`, `arrow-up` (send), `stop`,
`sidebar-simple` mirrored (right panel), `dots-three`, `push-pin`, `archive`, `check`, `x`, `copy`, `arrow-square-out`,
`info`, `warning`, `warning-circle`, `file`/`file-text`/`image`, `eye`, `globe-simple` (browser surface), `clock`.
Code mode adds: `terminal-window`, `git-branch`, `git-diff`, `git-pull-request`, `git-merge`, `git-commit`,
`git-fork`, `tree-structure`, `arrows-out-simple`/`arrows-in-simple`, `play`, `hard-drives`, `code`, `lock-simple`,
`pencil-simple-line`, `shield-check`, `shield-slash`, `bug`, `flask`.

**The rail glyph for Work itself** (desktop, not the fork). Today it is `terminal-window` at 16 px
(`D: apps/desktop/src/app/atum/shell-surface.tsx:301`, `Terminal` = `phosphorIcon('terminal-window')` at
`src/lib/icons.ts:233`): the most intimidating glyph in the set, on the default-Work destination, and under the rail's
24 px (STYLE §6). It becomes **`pen-nib`** (already in the Kit), Light at rest and Fill when Work is the current
destination, 24 px like its neighbours. A pen reads as "make something", which covers documents, design and code alike.

### 9.4 Type, space, shape, faces

All generated into the environment theme from Kit tokens (`D: packages/atum-kit/tokens.json`), light and dark, never
hand-copied (§1.3).

| Thing | T3 today | Atum (both modes) |
|---|---|---|
| Font | T3's own stack and sizes | Kit `font`: system (SF Pro); code blocks and the terminal SF Mono 12/18 (Code mode only in practice) |
| Type roles | ad hoc 12-14 px | STYLE §4 roles only: thread title **Headline** 15/20; roster rows, menus, buttons **Body** 13/18; transcript and composer **Chat** 15/23; secondary lines **Callout** 12/16; times **Caption** 11/14; section labels 12 semibold `--ak-ink-3`, never uppercase |
| Space | Tailwind steps | 4-point grid (`--ak-s1`…`--ak-s12`); roster rows 40 px pitch; controls 26 / 32 / 40 |
| Containers | 6-8 px radii | Kit scale: panels and popovers `--ak-r-lg` 14; menus glass; sheets `--ak-r-2xl` 26; file cards `--ak-r-xl` 20; concentric nesting |
| Buttons | rounded rectangles | **Capsules**; icon buttons are **circles** (T3's `ui/toggle` square toggles included); one primary per view |
| Composer | bordered box | Frosted capsule, `--ak-glass`, radius 20 (STYLE §11), add (+) left; model chip, dictation, send right; send faint until there is text |
| Selected row | accent fill | Kit selected fill, never blue; Fill weight of the row's glyph |
| Badges | coloured "info" badge (`ui/badge`, e.g. "From …" at `T3: components/chat/ChatHeader.tsx:399`) | `.ak-badge--quiet`; mention is the only red badge |
| Focus | always-on rings | Keyboard focus only, `3px solid var(--ak-focus)`, following the control's shape (STYLE §9) |
| Shadows | T3's | `--ak-shadow-1/-2/-3` only |
| **Faces** | provider marks on thread rows; no people | **Assistants and people: circles**, Kit monogram until a photo (white initial on `--ak-monogram`). **Providers and apps** (Atum, ChatGPT, Claude, Antigravity, editors): **squircles**, 22.5% + `corner-shape: squircle`. Projects: the `folder-simple` glyph in ink, no tile |
| Motion | T3's | 120 ms hover/press, 200 ms menus and the mode cross-fade, 320 ms panels; fades only under Reduce Motion |

### 9.5 Empty, loading and error states

| State | Work | Code |
|---|---|---|
| New thread | The Atum mark (48, squircle), **"What should we work on?"** (Display), one muted line "Files in {project} are in reach.", three `.ak-btn--sm` capsules: Write something · Research a topic · Design a page. Nothing else; no tips, no shortcuts list | T3's hero restyled: project name (Headline), composer focused, no suggestions |
| Empty roster | `.ak-state`: "No threads yet", New thread capsule | same |
| Thread loading | Three `.ak-skeleton` lines, never a spinner over the transcript | same |
| Model at work | **The Atum atom** with "Working · 1:12" in Caption beside the collapsed work line | the atom on T3's work group header |
| Work starting (sidecar not ready) | Centered `.ak-spinner` + "Getting Work ready" (one line); after 20 s "Still starting…" + Retry | same |
| Error in a thread | `.ak-notice--danger`, one line in plain words, Retry; details behind a disclosure | T3's error text inside the same notice |
| Plan not connected / limit reached | §2 rules, unchanged | same |

---

## 10. Mockups (second pass)

The mockups file now draws every icon from the Kit's real Phosphor Light paths (inlined from
`packages/atum-kit/dist/phosphor-icons.json`), with a Light / Dark / System switch at the top:

1. **Work mode, new thread**: mode switch on Work, roster with an assistant's circle face, the Work empty state.
2. **Work mode, a thread at work**: collapsed work line with the Atum atom, a plain `.ak-ask` approval, file cards,
   the right panel on Preview; no terminal, branch strip, permission chip or diff.
3. **Code mode, the same project flipped**: header toggles (details, terminal, right panel), branch / worktree strip,
   permission chip, `+/−` stats, the terminal drawer, the Diff surface.
4. **The mode switch**: the band in both states, and the cross-fade note.
5. **Light and dark side by side**: frames 1 and 3 in both themes.
6. **Icon sheet**: the slots Work shows, each with its T3 name and the Atum glyph.
7-9. The first pass's picker, unconnected state and connect sheet, redrawn with Kit glyphs.

---

## 11. Implementation split and order, second pass (target: Work runtime 0.1.13)

Supersedes §7's order; §7's rows stand unless renumbered here. Lanes per the playbook: **desktop UI and fork UI →
Opus**; **plumbing (fork contracts, sidecar, build, preload) → Sol**. One PR per repo outcome; the fork changes ship
in one atum-work pin bump that the desktop's Work runtime 0.1.13 consumes.

### Fork, atum-work (behind `VITE_ATUM_WORK_BUILD`)

| # | Piece | Lane | Files (T3 pin) |
|---|---|---|---|
| F1 | `atumSurfaceMode` project-scoped key, default `"work"`, git-repo default at creation; `useAtumSurfaceMode` (returns `"code"` outside the Atum build); `data-atum-mode` on the root; `atum.mode.toggle` keybinding command | Sol | `packages/contracts/src/settings.ts:1173, 1211, 1366`; new `apps/web/src/atum/surfaceMode.ts`; keybinding registry |
| F2 | Mode guards and props per §8.3 (panel toggles, context strip, permission chip, terminal drawer, thread details, diff surface, PR links, minimap, slash suggestions, palette filter, settings nav filter) | Opus | `ChatView.tsx:1818, 3370, 3865, 3908, 3962, 4047, 4063`; `PanelLayoutControls.tsx`; `RightPanelSurfaceContent.tsx:116`; `SidebarChrome.tsx:291-318`; `MessagesTimeline.tsx:1503`; `useComposerMenuItems.ts:296-322`; `SettingsSidebarNav.tsx` |
| F3 | Work-mode presentation: collapsed work groups with the atom, file cards for changed files, plain `.ak-ask` approvals, the Work empty state, subagent faces | Opus | `TimelineWorkGroupRows.tsx`, `ChangedFilesTree.tsx`, `TimelinePendingApprovalRow.tsx`, `DraftHeroHeadline.tsx`, `ProviderSubagentBar.tsx` |
| F4 | Icon map: `atum-icon-map.json`, the generated `lucide-phosphor.tsx` shim, the exact Vite alias, the unmapped-name build check, the 16 px floor | Sol (generator, alias, check) + Opus (the map's choices, already in §9.3) | new `apps/web/src/atum/*`, `apps/web/vite.config.ts` |
| F5 | §7 E2 (`showInPicker`), E6 (relay labels) unchanged | Sol / Opus | as §7 |

### Kit and desktop, atum-desktop

| # | Piece | Lane | Files |
|---|---|---|---|
| K1 | Add the 37 names of §9.2 to `icons.json`; rebuild `dist/` | Sol | `packages/atum-kit/icons.json`, `dist/phosphor-icons.json` |
| U3′ | The environment theme generator, now also: type roles, radii, capsules and circle icon buttons, glass composer, quiet badges, focus, `data-atum-mode` density rules, light and dark, look packs | Opus | `apps/desktop/scripts/build-work-theme.mjs` → `work-runtime/themes/atum.json` |
| U7 | The title-band mode switch (`.ak-seg` Work · Code) wired to the project's mode through the preload; the Work rail glyph becomes `pen-nib` at 24 px (§9.3) | Opus | `src/app/work/work-screen.tsx`, `src/app/work/copy.ts` (en, vi), `src/app/atum/shell-surface.tsx:301`, `src/lib/icons.ts` |
| E5′ | Theme delivery (§7 E5) plus: the Kit icon paths and theme copied into the Work runtime package at build; sidecar writes Work project defaults (`defaultThreadEnvMode: "local"`, `defaultRuntimeMode: "auto"`); relay projects created Work | Sol | `electron/work/sidecar/supervisor.py:200-218`, Work-runtime packaging script, `electron/work/gate/gate.ts:64` |
| E8 | Preload `getSurfaceMode` / `setSurfaceMode(projectId)` and the change event for the band's switch | Sol | `electron/work/sidecar/preload.ts`, `host.ts` |
| U1, U2, U4-U6, E1-E4, E6-E7 | As §7 | as §7 | as §7 |

### Order

1. **K1 + F4 + E1 + E2** (no dependencies; fixes the icon mismatch and "binh-minh" / "Atum delegated" on their own).
2. **F1 + E8** (the mode key and its plumbing), then **F2 + U7** in parallel (Opus on both; disjoint repos).
3. **U3′ + E5′ + U1** (the layout and theme, after F1 so `data-atum-mode` exists), with probes P1-P3.
4. **F3** (Work presentation) once F2 lands; screenshot check of mockup frames 1-3 against the built runtime.
5. **Work runtime 0.1.13** = the atum-work pin with F1-F4, plus the desktop's K1, U1, U3′, U7, E1, E2, E5′, E8.
   Connect (U4 + E4, E3 on B-0), connections (U5 + E7) and relay labels (E6) follow on their own lanes as in §7.

**Acceptance for 0.1.13:** a new documents project opens in Work with none of §8.3's Code-only elements reachable by
click or shortcut; a repository project opens in Code; the switch flips one project and nothing else; every icon in
both modes is a Kit glyph (the build check passes with zero unmapped names); an Opus UI review against STYLE's
checklist (§16) in light and dark.

Nothing in this section authorises a build, a deploy, a purchase or a production change.
