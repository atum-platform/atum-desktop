# Provider autoswitch: Work chrome mockups · 2026-11-28

AUTHORIZATION: the owner approved provider autoswitch defaults on 2026-11-28. There is one opt-in, account-wide provider order,
with a per-agent or per-Work-session override. The switch happens at the next turn. Continue (from a settled checkpoint) appears
when a cut-off run may have done work. The owner's UX rules apply: never show fallback cost; grey out unavailable plans with one
action; status lives in the composer and model chip, never in agent text; airy; one action and at most one line per state; default
automatic.

These are static design mockups. The build is `feat/provider-autoswitch-ui` in atum-work (`1b942b30a9`). The engine is `feat/provider-autoswitch`
in atum-work. Feasibility research: `_research/provider-autoswitch-1128.md` (owner questions 1–3).

## Index

| State | Light | Dark | What it shows |
|---|---|---|---|
| a. Settings, off (default) | [a-off-light](a-off-light.png) | [a-off-dark](a-off-dark.png) | Settings › Providers. A folded **When a plan runs out** row says "Off" and has a switch. Nothing else |
| a. Settings, on | [a-on-light](a-on-light.png) | [a-on-dark](a-on-dark.png) | One line, then the connected plans in the order they take over. Drag, or use the step buttons. A plan that isn't signed in is greyed with one action, **Sign in**. The summary reads "ChatGPT → Claude" |
| b. Session override | [b-override-light](b-override-light.png) | [b-override-dark](b-override-dark.png) | The existing composer model picker. A **For this session** row under Effort: *Switch when out* / *Stay on ChatGPT*. Choosing what the account already does clears the override |
| c. Switched | [c-switched-light](c-switched-light.png) | [c-switched-dark](c-switched-dark.png) | The chip shows the model that will answer (Claude). Next to it, one quiet line: "ChatGPT is out until 8:37 PM · using Claude". No cost, no warning colour |
| c. Nothing left | [c-none-left-light](c-none-left-light.png) | [c-none-left-dark](c-none-left-dark.png) | No eligible plan. The existing red chip dot, plus "Plans are out until 8:37 PM". The draft stays in the composer |
| d. Continue | [d-continue-light](d-continue-light.png) | [d-continue-dark](d-continue-dark.png) | A run was cut off and may have done work. The line reads "ChatGPT ran out mid-reply" with one action, **Continue**, on the model in the chip |
| e. Switched back | [e-back-light](e-back-light.png) | [e-back-dark](e-back-dark.png) | After the reset, the next turn is back on ChatGPT. The chip shows GPT-6.2 with no line. Silent |

## Decisions

- **Where the setting lives.** It goes in Settings › Providers, under the provider cards and above Usage limits. The plans are configured
  there, and Work has no separate Models page. It is a folded row with a switch, like Load balancing. It is off by default, as the owner
  approved (opt-in).
- **Why the list has only connected plans.** A plan the user hasn't signed in to appears greyed at the end, with **Sign in**. It never
  gets a turn. Paid overages and same-provider account rotation are never offered (research, Consent).
- **Session override is two choices, not three.** "Follow settings" would always duplicate one of the other two. The row shows what this
  session will do. Picking the account's own behaviour stores no override.
- **Status sits beside the chip, not in a banner.** A banner card is heavier than one fact needs. The line truncates first on narrow
  composers, and the chip's tooltip carries the same words.
- **No warning colour while a switch is working.** Red is kept for "nothing can answer" (c, nothing left). That reuses the existing chip
  dot.
- **Continue is a deliberate action.** The cut-off run is never re-run automatically. Continue sends one continuation from the settled
  checkpoint on the model in the chip. The engine decides `canContinue`.
- **No "In use" pill in the list.** The session's own model is the preferred plan. The list is the order of plans that take over,
  so marking its first row "In use" would mislead.
- **Before the switching turn, the line says "Claude answers next".** The chip still shows the session's model until the switch
  happens. After the switch, the line reads "using Claude" (c).
- **Times come from evidence only.** "until 8:37 PM" appears only when the engine has an `exhaustedUntil`. Otherwise the line reads
  "ChatGPT is out · using Claude".

## Regenerating

`src/mockups.html` draws every state from the URL hash (`#c-switched-dark`). It uses the real Work kit: copy
`apps/web/dist/assets/main-*.css` from an atum-work build to `src/work-kit.css`, which is git-ignored. Then run `src/render.sh`, which
needs Playwright's `chrome-headless-shell`.
