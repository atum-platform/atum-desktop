# Desktop MAS provider choice (2026-11-15)

This desktop change must ship **before Apple goes live on MAS**. It implements the
provider-choice compatibility slice of the 2026-11-15 Sign in with Apple plan.
The coordinator approved keeping the existing desktop UI for this slice.

## Behavior

- The sign-in entry no longer pins Google's deployment-specific provider ID.
  It follows MAS's own single-provider redirect or reads the sole provider from
  MAS's same-origin upstream links, including Minijinja's escaped slashes.
- When MAS offers Apple and Google (in either order), desktop opens MAS's chooser
  for the existing authorization grant. An optional provider hint cannot bypass
  a multi-provider chooser. No provider offer is cached across sign-in attempts.
- Email and create-account attempts can open a provider-only chooser without
  throwing. The existing `matrix_password_unavailable` result remains for MAS's
  automatic single-provider redirect when passwords are disabled.
- The background email-availability probe checks for a password input. A chooser
  containing provider links but no password input is unavailable for email;
  an unfamiliar or unreadable page remains unknown. An already-started email
  attempt can still open the chooser.
- Grant continuation, PKCE/state, callback handling, and password registration
  capability checks keep their existing flow. Unrecognised pages leave selection
  to MAS. No new dependencies, desktop buttons, translations, or copy keys.

## Follow-up

A dedicated desktop Apple button and its shared/exported copy keys remain a
separate follow-up to the broader plan. That work must consider provider
availability so Google-only MAS deployments keep working. No copy keys are
introduced or reserved by this compatibility change.

## Verification

Verification commands run from `apps/desktop`; final results are recorded below.
No production access, release, push, pull request, or nested review was performed.
Assembly review and publication belong to the coordinating session.

- `npx vitest run --project electron electron/matrix/sign-in-entry.test.ts electron/matrix/account.test.ts electron/matrix/account-domain.test.ts electron/matrix/account-owner-repair.test.ts electron/matrix/ipc-policy.test.ts electron/native-auth-decisions.test.ts --maxWorkers=2`
  — **401 tests passed in 6 files**.
- `npx vitest run --project electron electron/matrix/sign-in-entry.test.ts --maxWorkers=2`
  — **26 tests passed**, rerun after formatting/lint fixes. Covers Google-only,
  Apple+Google in either order, passwords enabled/disabled, email/create chooser
  paths, optional hints, escaped/foreign/invalid links, and unknown-page fallbacks.
- `npx eslint electron/matrix/sign-in-entry.ts electron/matrix/sign-in-entry.test.ts --max-warnings=0`
  — **passed, 2 files, zero warnings/errors**.
- `npx prettier --check electron/matrix/sign-in-entry.ts electron/matrix/sign-in-entry.test.ts`
  — **passed, 2 files**.
- `npx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2023 --module ESNext --moduleResolution Bundler --lib ES2023,DOM --types node --esModuleInterop electron/matrix/sign-in-entry.ts electron/matrix/sign-in-entry.test.ts`
  — **passed, both touched TypeScript files and their import closure**.
- `npm run typecheck` — the client-boundary check passed; the renderer-wide
  TypeScript phase was stopped after more than seven minutes under host memory
  pressure, with no diagnostics emitted. The consumer-browser, full Electron,
  and E2E typecheck phases were not reached. The focused strict check above
  completed successfully afterward.
- `git diff --check` — **passed**.

The full desktop test suite, packaged app/E2E tests, and a live MAS sign-in smoke
were not run. Fixtures model the relevant MAS 1.24 single-provider and chooser
responses; staging/live acceptance remains with the rollout coordinator.

The pristine dependency setup has existing problems: `npm ci --workspace
apps/desktop --include-workspace-root --ignore-scripts --no-audit --no-fund`
refused a missing `undici@6.29.0` lock entry. A lockfile-preserving install needed
`--legacy-peer-deps` because the TUI's React/Ink peers conflict. npm also resolved
Minimatch 3's `brace-expansion` to the incompatible root override (5.0.12); the
ignored local install was given its already-declared 1.1.21 nested dependency to
run ESLint. Package manifests and the lockfile are unchanged.

- Public guard: the credentials-URL test fixture uses `user:noreply@auth.example` so the outbound guard does not read it as a personal address; the 26 entry tests still pass.
