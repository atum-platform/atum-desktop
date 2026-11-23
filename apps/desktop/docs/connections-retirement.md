# Connection retirement checkpoint (2026-11-23)

Built locally; not released. Device plans now come from the account connection
registry and execute through Work. Historical cloud carry
snapshots no longer make a ChatGPT plan available in the legacy subscription
availability helper. SSH registration/presence compatibility remains because
the current picker still calls it: disabling it broke 20 picker tests, while
the main-branch helper passed all 83. OpenCode Go's account key behavior is unchanged.

Removed the retired-file disconnect wrapper and its filesystem deletion helper.
No runtime reads that old file; the remaining disconnect path still calls the
native provider disconnect and Hermes's locked account-auth cleanup.

## Retained consumers

- `electron/matrix/codex-accounts.ts`: main still uses `matrixSharedCodexHere`,
  and the startup migration uses its account-isolation decision. Deleting it
  would break those live imports.
- `account-subscriptions.ts`, `account-subscription-flow.ts`,
  `subscription-auth-lifecycle.ts`, `hermes-codex-migration.ts`: main still
  imports their status, environment, disconnect, diagnostics and startup APIs.
  Only the inert legacy-file deletion was removed here.
- `atum-managed-delegated`: the Work gate factory still selects it for delegated
  Atum tasks. The sidecar supervisor starts its filtered Hermes profile.
  Plan-provider isolation does not prove that this separate Atum profile is
  unused. Its replacement requires a verified Atum tool-isolation path first.
- Historical wire fields remain parseable; they no longer grant availability.
- `binh-minh` already occurs only in `RETIRED_MODELS` in the scoped Work/model
  sources. Keep that old-data parser.
- SSH model relay handlers were already absent. Native SSH terminal access and
  old authorized-key revocation are still necessary and stay.

## Verification

Focused subscription/availability tests passed (13 tests); Electron typecheck
passed. ESLint passed with two existing spacing warnings in `hermes-runtime.ts`.
Expanded picker/runtime/account-registry tests passed: 142 tests in five files,
exit 0. Public-boundary validation runs against the resulting commit. No installed app or account data was used.
