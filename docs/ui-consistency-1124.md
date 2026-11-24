# UI consistency pass (2026-11-24) — built, not live

Owner, testing 0.20.55: Work's Atum models showed as raw "Anthropic · claude-…" rows with a black-dot
mark; every picker logo carried an "AT"/"CO" badge; Work's New thread button did nothing; Work, Chat and
Team Space placed the bell and the hide-left-panel button differently. Companion fork change: atum-work
branch `feat/ui-consistency-1124` (`docs/work-ui-consistency-1124.md` there).

## What changed here

- **Atum's line-up in Work's picker.** Work's "Atum" instance is `acp_adapter.managed`; its model state
  came from the whole Hermes inventory, so every configured provider's raw ids appeared under Atum's name.
  A session on `atum-managed`/`atum-gateway` now offers Atum's served line-up only, by product name
  (`acp_adapter/model_labels.py` `ATUM_LINEUP`, mirroring `shared/matrix-models.ts`); a retired
  `binh-minh` resolves to Nguyệt Thực. Thái Cực is announced, not served, so ACP (which has no
  "announced" row state) does not list it. Test: `tests/acp_adapter/test_atum_model_lineup.py`.
- **New thread works.** The band's button runs `chat.new` inside the Work view, which on an empty draft
  only moves the caret into its composer. The click left keyboard focus in the desktop renderer, so the
  caret never showed and the button looked dead. `WorkHost.runCommand` now focuses the view before
  `chat.new` (`electron/work/sidecar/host.ts`).
- **One title-bar order on every page.** Lights, then hide-left-panel, then the bell at the left panel's
  far edge, as the chat roster's top row has it (owner 2026-11-13). Team Space gains the hide button
  (`$teamSpaceSidebarHidden` in `matrix/team-space-sidebar.tsx`; compact windows keep their one-pane flow)
  and its bell moves to the sidebar's edge (`styles.css`). Work's hide-threads button moves beside the
  lights; the bell follows it, then New thread.

## Known gap

Work's bell sits right after the hide button, not at the thread list's edge: the list is drawn by the
Work view and its width and open state are not reported to the desktop.

Verification: desktop typecheck 0; eslint 0 errors on touched files; vitest 858 + 512 (app shell) pass;
`tests/acp_adapter` 518 pass.
