# Work provider recovery — 2026-11-23

State: implemented locally; not released or verified in an installed app.

The owner reported unavailable local subscription providers, a blocked ChatGPT Connect action, a visible delegated Atum provider, and model aliases displayed as labels.

## Native mechanism and changes

Work previously replaced PATH with its runtime and system directories. Before substituting the isolated Work HOME, the host now resolves the login-shell PATH with T3 Code's native `-ilc` shell capture protocol. The shell-specific capture helper is adapted from `packages/shared/src/shell.ts` at release commit `69a0515771`; its MIT notice is included beside the adapter. The Effect-based desktop service cannot be imported into this Electron host, so a small Node process adapter executes that same native capture command. Only PATH crosses into Work. No credential environment is copied. Bundled executables retain precedence. Failure retains the inherited PATH and system fallback.

ACP model rows and the current-model fallback now use the Atum product names for both served aliases. Wire model IDs remain unchanged. A cross-language test checks every selectable desktop lineup entry against the Python label function.

The companion Work fork change is based on `69a0515771` (0.1.13). It removes the retired custody bridge prerequisite, allowing the existing Codex `startAuth` flow to proceed. It filters internal instances with `showInPicker: false` out of Settings, while their enabled provider configuration and existing picker filtering remain intact. This is separate from the concurrent upstream-integration lane.

## Findings and limits

Claude and Codex binaries exist on the host PATH. Antigravity is different: native T3 resolves its own managed ACP installation first, then the `agy` executable on PATH (`AntigravityInstallation.ts`). No `agy` executable was found in the current shell. A T3-managed ACP installation under T3's own state is not automatically an installation in Work's isolated state. The PATH fix enables external CLI discovery; it does not prove that Antigravity is installed for Work. No installed application data was inspected or modified.

The live device hub is `wss://devices.atumplatform.com/v1`. Device close 4401 means unauthorized. The controller rejects missing enrollment, identity/enrollment/Matrix-device mismatches, bad signatures/proofs, and replayed nonces. The desktop retries at a 30-second cap, consistent with the reported cadence. This is not evidence of a retired endpoint. Account-specific rejection cannot be determined without enrollment/controller evidence; no retry policy was changed.

## Verification

Combined focused Electron Vitest, including the model-label contract: 6 files, 17 tests passed (exit 0). Electron TypeScript no-emit check passed (exit 0). Focused ESLint passed (exit 0).

Companion fork focused Vitest: 2 files, 7 tests passed (exit 0), using existing Vitest and an alias for `vite-plus/test`; no dependencies installed. These exercise removal of the custody prerequisite, external sign-in dispatch and settings visibility. Actual browser authentication was not attempted; credentials and installed application state were excluded. The fork's full frontend toolchain is unavailable in the supplied dependency tree.

Public guard against origin/main passed (exit 0), including ancestry, raw paths/modes, identifiers, secrets and commit metadata. Dependency symlinks were removed before committing. Both checkouts together occupy approximately 506 MB, below the 1.5 GB cap. No pushes, PRs, CI, deployment, cloud access, nested agents or spending were performed. Coordinator next steps: review both local commits, integrate the fork patch into the runtime integration lane, validate native sign-in and managed Antigravity installation in a release candidate.
