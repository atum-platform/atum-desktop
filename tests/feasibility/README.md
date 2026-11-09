# Unified-group feasibility probes (opt-in)

These are engineering fixtures, not a production executor or published protocol.
No live model is called. Run from the app repository root with its virtualenv:

```sh
.venv/bin/python -m pytest tests/feasibility/shared_process_probe.py -q
```

This is the current cold-process proof. It launches the real Hermes core against
an explicitly populated temporary profile. The provider transport is synthetic;
config, plugin discovery, prompt building, tool resolution/denial and the loop
are real. Audit observation starts before Hermes import, snapshots cover the
private fixture, and the parent checks environment independence. Expected: 3 pass.
Temporary shared logs/ancillary bootstrap state are allowed. The private fixture
is unchanged and no observed SQLite connection reuses a canonical session store.
The observer covers four named CPython audit events, not all I/O or a production
sandbox; the evidence report enumerates the unobserved classes. All temporary profile data is removed
when the fixture exits.

Exercise the real SDK HTTP and streaming paths with a local synthetic provider:

```sh
.venv/bin/python -m pytest tests/feasibility/shared_http_probe.py tests/feasibility/shared_process_probe.py -q
```

Both HTTP/SSE cases run two fresh Hermes processes, carry earlier group replies
forward, reuse an isolated profile/workspace directory to preserve the system prefix
within turns and across restarts, and refuse a forged private
file tool. Real request bytes and streaming chunks are captured. Expected: 5 pass.
The custom provider fixture serves its own model metadata; no remote model or
paid account is used. Provider-specific pricing/catalog access is a separate
route boundary, not implicitly permitted by these checks.

The older diagnostic is deliberately separate:

```sh
.venv/bin/python -m pytest tests/feasibility/shared_group_probe.py -q
```

It demonstrates why the ordinary private process cannot be reused unchanged:
private config hints and context plugins remain active, and a context-local home
alone does not prevent the process session ID changing. Its failed shared-policy
assertions are evidence against that reuse proposal, not regressions in supported
private Hermes behavior. Use a clean worktree without a repository .env. Neither
file is included by ordinary pytest test-name discovery.

Desktop's normal regression coverage lives in
`apps/desktop/electron/atum-messaging/private-advisory-runner.test.ts`; it proves
the private runner refuses shared mode before dispatch. Run from apps/desktop:

```sh
npx vitest run electron/atum-messaging/private-advisory-runner.test.ts --project electron
```