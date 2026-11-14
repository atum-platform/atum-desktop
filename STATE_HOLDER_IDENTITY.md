# State holder identity

Session turn leases and compression locks serialize work through durable SQLite rows. Their
structured holder strings now carry the existing native boot witness from
`gateway.status.get_process_epoch`, via `hermes_state_pidns.holder_namespace_token`.
The witness is hex encoded because its native value contains colons, the holder separator.
Both `agent/turn_facade_lease.py` and `agent/conversation_compression.py` already use that helper.

The shared `hermes_state._compression_lock_holder_process_is_dead` checks a conflicting boot
witness before its same-PID shortcut and namespace/PID probes. A previous sandbox's lease is
reclaimable on the first attempt even when the new sandbox repeats its PID and namespace.
Acquisition still uses the existing SQLite transaction; holder-qualified renewal/release fences
late cleanup. Same-boot live holders remain protected. No schema migration or new configuration
is needed. Legacy/unparseable lease stamps retain the existing namespace rules and TTL expiry
(normally 300 seconds); they cannot be safely declared dead from a missing boot witness.

The state-layer audit also found repair and FTS-rebuild flock owner metadata in
`hermes_state_common.py`. Its shared writer now records `boot_epoch`, and its dead-owner check
uses the same native epoch-conflict predicate before PID/start-tick checks. Existing kernel
flock exclusion, bounded contention wait, inode verification and legacy probing remain in place.
`hermes_state_repair.py` uses this shared path. `hermes_state_holders.py` and
`hermes_state_lockowners.py` inspect current kernel processes/descriptors/locks; they do not
persist PID ownership. `hermes_state_lockguard.py` holds kernel descriptor locks, likewise
without durable PID ownership. `hermes_state_dbfile.py` records a diagnostic PID only.
Runtime worker turn/compression acquisition and message mutation guards already share the
updated dead-holder predicate.

## Verification (2026-11-13)

The new `tests/gateway/test_session_holder_boot_identity.py` first produced four failures and two
passes on the unmodified implementation. After the fix and expanded coverage, all nine cases
pass: immediate cross-boot turn/compression recovery with our own reused PID, same-boot live
exclusion, legacy expiry, stale release fencing, boot-stamped file locks, namespace compatibility,
and real two-process turn/compression races with the winner kept alive until both report.
Boot transitions are simulated at the native witness seam; no live container fault was run here.

A focused 11-file state/gateway run had 64 passes, one Linux-only skip on macOS, and three
pre-existing failures. All three reproduce after restoring the three changed production files
to the unchanged base: `test_turn_lease.py::test_full_dispatch_rejects_lease_timeout_without_running_goal_hook`
expects English but receives `gateway.busy.another_turn_running`; both variants of
`test_worker_compression_admission.py::test_automatic_worker_rotation_retains_retry_identity_and_fifo`
receive admission status `unknown` instead of `terminal`. These unrelated failures are unchanged.

The final focused run excluded exactly those known failures: ten files, 64 passed,
zero failed, one Linux-only skip. All runs used `scripts/run_tests.sh` with per-file isolation.
