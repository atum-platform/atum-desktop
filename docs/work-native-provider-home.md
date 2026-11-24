# Work native provider recovery — 2026-11-24

State: built-not-live. The owner's reports remain open pending an installed release and owner provider acceptance. Scope: nothing connects in Work (Codex/Claude/Antigravity), ChatGPT unavailable, Claude Sign in missing file, 10–15 second open, Hermes logo flash, incorrect Atum provider icon. No installed app/data writes or token/Keychain reads; no sign-in, push, PR, CI, cloud or spending.

## Evidence and native inventory

The installed onboarding terminal log ending in 8f8a7041-a172-43b6-ab18-09bb48b984b7 records line 7: the real Claude launcher attempts work/environment/.npm-global/bin/claude and reports “No such file or directory”. Both the real local and npm-global launchers exist. WorkSidecar supplied the isolated HOME, TMPDIR and XDG directories despite capturing the real shell PATH. The Claude cache generated inside work/environment confirms execution under that fake home; credential files were not opened.

Installed main.old.log lines 17362–17368: snapshot at 13:18:00.914Z, trial prepared 13:18:16.210Z, commit 13:18:16.414Z (15.296s snapshot-to-prepared). There are no retained per-phase provider status messages: supervisor discards child stderr/stdout. Thus Codex's exact authentication failure and Antigravity's UI error cannot be claimed from these logs. No provider tokens or auth database rows were read.

T3 source: cli/app.ts reads T3CODE_HOME; config.ts derives userdata, caches and worktrees beneath it. Existing Codex setupMode is native in contracts/settings.ts and providerInstallation.ts. Prior Atum defaults forced managed mode, which uses T3's separate managed token broker, so real HOME alone would not reuse the owner's Codex login. AntigravityInstallation.ts explicitly searches for agy and says the Antigravity app, IDE and CLI are separate installations. The desktop app exists on this Mac; the usual local/npm/Homebrew agy paths do not. Restoring HOME is necessary for CLI auth, but does not install agy.

The runtime 0.1.13 Work frontend required a retired prepareCodexSignIn bridge to return true before native startAuth. Runtime source fd60a217 removes that false preflight and hides the delegated settings row. Source 465ae1b95 includes it. UI source 219dc0d4d merged cleanly into the local runtime build.

## Changes

Work retains real OS HOME/TMPDIR, shell PATH and existing explicit XDG/Codex/Claude directory overrides. T3CODE_HOME remains per account under work/server. HERMES_HOME remains separately scoped to work/owner and work/delegated. No gateway requires a fake OS home. Codex uses native existing mode; only the exact legacy managed default is migrated, preserving custom binary/home settings and enabled flags.

Shell capture shares one Promise for the app run, including concurrent starts and account switches. Both gateways launch without serial readiness waits before T3. Matrix activation starts WorkSession in the background through normal recovery/update/disabled-account checks; concurrent first-open and warmup share one account start, avoiding duplicate recovery/update work. Startup phase timings are now logged without paths or credentials.

The runtime uses the existing desktop SVG for the managed Atum labels. Native local-ACP settings have no arbitrary icon override, so a small Work-build-only presentation branch handles those labels. Its boot shell now draws a Kit-sized spinner instead of the app icon. This covers the likely boot-logo flash; the exact owner-observed Hermes frame was not captured, so installed visual acceptance remains required.

Estimated startup after: cold native server/view around 2–5s plus one shell capture; warm Work click around 1–3s. These are estimates, not measurements of the installed release. Sequential gateway waits and repeated shell capture have been removed; new timing logs will provide the real breakdown after installation. The first Atum ACP session may report managed_gateway_not_ready if submitted before its gateway finishes; ordinary providers and the view boot independently.

## Artifact and verification

Local release input work-0.1.14/atum-work-0.1.14-darwin-arm64.tar.gz, 151398602 bytes, SHA256 83cfbb5a9257fc4ae3660acc76c09de09eaf081042fa5b63c6a84b0e02b2ad20. runtime-tools.json records the final fork source commit. Build used exact Node 26.13.1, locked Rust monitor and the fork's standard archive script. Archive smoke passed (exit 0); web unit project: 8 tests passed (exit 0). Full-monorepo knip cannot load uninstalled mobile/marketing configurations with the deliberately filtered archive dependency install; retained in the fork note.

Desktop focused checks: 117 tests passed, one opt-in real-runtime test skipped; Electron tsc exit 0; touched-file ESLint exit 0. Tests cover real HOME, per-account state, shell capture cache, supervisor nonblocking startup ordering, legacy Codex migration and concurrent WorkSession starts. Public guard is run after the final local commit and its result recorded in the handoff. Initial guard attempt failed because the shallow clone lacked policy ancestry; full history was fetched before the final check.

Owner expectations: Codex should discover the existing CLI login; Claude's launcher should resolve its real npm-global target and native login should work; Antigravity still needs the separate agy runtime installed via native T3 setup (no sign-in performed). Full native authentication acceptance and installed startup/branding remain open. Build dependencies and desktop dependency symlinks are removed after verification. No work is live yet.

Final public guard passed with exit 0 after fetching complete ancestry. The repository rejects session-logs as a public path, so this durable engineering note lives under docs instead. Final working trees are clean, desktop symlinks removed, fork build node_modules/toolchains removed; retained checkouts total about 1 GiB plus the 145 MiB release archive. Full check logs are summarized here; release coordinator owns review, installed proof and shipping.
