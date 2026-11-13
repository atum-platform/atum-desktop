# Resuming paused jobs and identifying routine turns

`resume_job(job_id, *, skip_missed=False)` keeps the existing resume policy by
default: an elapsed recurring slot remains due for the scheduler's ordinary
catch-up policy. Pause reasons remain descriptive and do not silently select a
resume policy.

Call `resume_job(job_id, skip_missed=True)` or run
`hermes cron resume <job> --skip-missed` to discard missed recurring occurrences.
The next time is computed from now by `compute_next_run`: cron expressions use
the active job profile's configured IANA timezone, including daylight saving
changes; intervals start a fresh full interval. Hermes does not store a separate
per-job timezone. Invoke the API inside the owning profile scope, as with all
cron operations. An expired one-shot still requires explicit rearming with
`--at` or `--run-now`; those flags cannot be combined with `--skip-missed`.
No job format migration or global catch-up configuration change is needed.

The opt-in Matrix presentation adapter derives routine identity only from
`cron.execution_identity.current_cron_execution()`. It adds `trigger: 'cron'`
to `io.atum.progress`, including edits and heartbeat updates. Final text messages
keep the existing UUID string in `io.atum.turn` and add the sibling
`io.atum.trigger: 'cron'`. Native scheduler result delivery is stamped even when
it has no owner-message admission; its turn UUID is stable for the room and
execution. Owner turns omit these trigger fields. Incoming message metadata is
not a source of routine identity.

This change adds metadata to existing presentation/delivery paths. It does not
create a progress notice for the separate native cron execution lane, which does
not enter the Matrix owner-admission presentation scope. Live routine progress
requires a further integration at that execution seam.

No native turn context currently identifies the enrolled computer a terminal
call is acting on. SSH host settings and Matrix encryption device IDs do not
identify that computer. Device metadata is therefore omitted.

Regression coverage uses temporary cron stores and native execution contexts:
missed interval slots, daily cron slots in Asian and DST-observing American
zones, unchanged default resume, CLI dispatch, routine/owner markers, and cron
result delivery without an owner admission. All Matrix I/O in tests is offline.

Validation: the focused `scripts/run_tests.sh` run passed 223 tests across ten
cron, console, gateway, and Matrix presentation files. Six intended regressions
failed before implementation (four schedule cases, CLI flag, routine marker);
the owner-turn control passed.
