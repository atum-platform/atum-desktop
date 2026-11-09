# Public CI runtime and verification

The required GitHub Actions checks are `client` and `hermes`. Keep these job
identifiers stable when editing `.github/workflows/public-client.yml`.

The desktop Vitest suite includes real Python gateway and cron integration tests.
Several launch `<checkout>/.venv/bin/python` directly; `actions/setup-python` alone
cannot satisfy this contract. Before Vitest, install uv 0.13.5 and run:

```sh
uv sync --locked --python 3.14 --group dev --group test --extra all
```

This creates the project `.venv` from `uv.lock`, including the normal runtime
features and test tooling. Export its interpreter as `HERMES_PYTHON` and
`ATUM_SYNC_PYTHON`, and put `.venv/bin` on PATH for fallback subprocesses.
Do not substitute a link to another checkout's environment.

The Hermes per-file suite retains four workers and a 120-second per-file timeout.
Its job budget is 120 minutes: bootstrap run 42648965269 reached 79.9% with zero
failures before the former 45-minute job limit cancelled it. The longer budget
requires hosted CI confirmation; it does not change test selection or isolation.

## Local verification, 2026-11-09

A fresh clone at root commit `912b0299f461e353455d1b7bd1d75bb0c21d57d4`,
Node 24.21.0, Python 3.14.7, and uv 0.13.5 was used on macOS arm64.
Without `.venv`, the five bootstrap-failing Vitest files reproduced 18 failures
and 29 passes, including ENOENT and `matrix_conversation_jobs_unavailable`:

```sh
npm exec --workspace apps/desktop -- vitest run --project electron \
  electron/matrix/mac-job-runner.test.ts \
  electron/matrix/mac-job-startup.test.ts \
  electron/matrix/conversation/jobs.test.ts \
  shared/setup-methods.test.ts \
  electron/atum-messaging/shared-group-runner.test.ts --maxWorkers 4
```

After the locked sync and interpreter exports, the same five files passed:
47 tests passed in 65.54 seconds. This also resolved the conversation-jobs error.
`npm ci --ignore-scripts`, the standalone client boundary/typecheck-without-controller
check, and `npm run typecheck --workspace apps/desktop` passed. Workflow YAML parsing,
setup-shell syntax, and `git diff --check` passed. A structural comparison with the
bootstrap workflow confirmed only two client setup steps and the Hermes timeout
changed; permissions, action pins, fork guards, credentials behavior, and test
commands remain the same.

The full desktop and Hermes suites were not rerun locally. Hosted Linux execution
and the longer Hermes job budget remain for coordinator verification. No push,
PR, hosted workflow run, repository setting change, deployment, or artifact upload
was performed during this local preparation.

## Round 2: Radix unmount timers, 2026-11-10

The coordinator reported Hermes passing on `7e9f8923d9`, confirming the expanded
job budget. Client assertions passed (1,599 files / 23,875 tests), but Vitest
exited 1 for an unhandled FocusScope timer attributed to
`src/app/shell/model-menu-panel.test.tsx`.

Radix FocusScope schedules a zero-delay callback during unmount that creates a
`CustomEvent` and dispatches it on its detached container. Synchronous Testing
Library cleanup leaves this callback pending. If it runs after jsdom teardown,
Node's event constructor is incompatible with the retained jsdom container.

Use the existing `quiet-launch.test.tsx` approach: explicitly clean up, then
await a real zero-delay timer before resetting mocks/globals or allowing jsdom
to close. This executes the focus restoration rather than suppressing errors.
The model-menu panel and eight other suites that mount real Radix menu/popover
content now follow this order: model-edit submenu, model-picker popover,
agent-home control, usage meter, project menu, session-actions menu, approval,
and app-view overlay holds.

The source audit also checked the remaining `Popover`/`DropdownMenu`/`FocusScope`
test matches. Quiet launch already drains unmounts; composer trigger-popover
renders plain markup; session-row mocks session-actions and does not open a
menu; overlay-inventory and design-contract tests read source without mounting
content. These need no timer change. Production components and CI configuration
are unchanged in this round.

Round 2 local evidence (Node 24.21.0, macOS arm64):

- Ran `model-menu-panel.test.tsx` in 20 separate Vitest processes with
  `--project ui --maxWorkers 4`: 20/20 successful exits, 27 tests each
  (540 total passes), no unhandled errors.
- Ran all nine touched files together with the desktop Vitest configuration:
  9 files / 119 tests passed, no unhandled errors.
- Desktop typecheck and client boundary passed. Focused ESLint exited 0 with
  0 errors / 54 warnings; linting the same files from unmodified `HEAD` also
  reported 54 warnings. `git diff --check` passed.
- Evidence remains in `/private/tmp/public-ci-round2-repeat/` and
  `/private/tmp/public-ci-round2-{touched,typecheck,lint}.log` on the preparation
  machine. This round did not rerun the full desktop or Hermes suites.

Prepared locally only on `fix/public-ci-venv-timeout` for coordinator assembly;
no push or repository setting change. Hosted verification of this new test
cleanup commit remains outstanding.
