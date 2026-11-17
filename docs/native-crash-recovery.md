# Native crash recovery

Unclean gateway startup uses the upstream Hermes active-turn recovery path
(NousResearch revision `3e9d42b876`). `recover_interrupted_turns` clears old
or invalid active-turn markers without setting `resume_pending`. Fresh markers
are promoted with reason `restart_interrupted`; suspended sessions stay suspended.
Startup passes the native maximum age, at least one hour or twice the agent
timeout. The startup scheduler accepts only `restart_timeout`,
`shutdown_timeout`, and `restart_interrupted`.

The former stale-marker promotion and its Ask comment were removed. An hours-old
marker must not trigger a model turn or a restored notice. Existing backup
reconciliation does not write `restore_backup:` metadata keys.

Regression coverage in `tests/gateway/test_native_crash_resume.py` reopens a
persisted session store, runs unclean-startup recovery, and exercises scheduling
and real adapter dispatch with a stubbed model boundary. A two-hour-old marker
yields zero model turns and zero outbound notices; a one-minute-old marker yields
one resumed answer. No external model calls are needed.

Run the focused coverage from the repository root:

```sh
PYTHONPATH=$PWD HERMES_PYTHON=$PWD/.venv/bin/python scripts/run_tests.sh \
  tests/gateway/test_native_crash_resume.py \
  tests/gateway/test_active_turn_recovery.py
```

Local verification: the recovery/session/restart-loop/Matrix regression batch
passed 606 tests with 2 skips. Supplemental configuration, Matrix, continuity,
and restart checks passed 283 tests with 8 skips. The final focused regression
rerun passed 6 tests. No failures were observed.
