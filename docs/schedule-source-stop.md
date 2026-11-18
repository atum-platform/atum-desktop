# Schedule source Stop

The authenticated same-user `stop-source` gateway control verb accepts schedule
parameters `{profile_id, kind: "schedule", job, execution, action}` plus optional
opaque string `member`. `profile_id` is a canonical absolute served profile home;
`action` is `stop` or `receipt`. Execution IDs cannot contain `:`. The existing
Matrix owner-source parameter and receipt contract remains unchanged.

The job and execution identify the exact `cron-owner` admission through
`cron_request_id`; member is receipt metadata and never selects authority or work.
Cancellation uses native `cron.cancel`, including its claim-before-execute latch.
The cron watchdog uses the same `request_hard_interrupt` helper as native turn
Stop, so explicit cancellation can abort compression as well as normal work.
When the watchdog observes cancellation, the owner settles that admission as
interrupted and the scheduler suppresses the routine failure notice.

With Matrix presentation enabled, a running native agent occurrence can publish
an empty transient `m.notice` as soon as the cron admission starts. Its
`io.atum.progress` marker carries `trigger: "cron"` and
`schedule: {job, execution}` on the original and every edit. The gateway checks
that the admission's exact request matches a running scheduler row with a
scheduled instant. The notice has no reply target because the execution starts
without an incoming Matrix message.

Progress requires one unthreaded Matrix delivery destination and the profile's
connected presentation adapter. The adapter verifies invite-only joins,
non-public history, and exactly two joined members, the bot and an authorized
owner. It uses the home or job origin's owner when available and otherwise
requires an explicitly allowlisted peer. A run's own settlement removes its
notice. An answer from another run can arrive while this notice remains
active. Concurrent occurrences of the same job have distinct Stop targets.

Responses contain `accepted`, `state`, and `receipt`. Only terminal observations
return `accepted: true`: `state: interrupted` for a cancelled/interrupted admission,
or `finished` for a previously completed/failed execution. A receipt contains
`{kind: "schedule", job, execution, state}` and the original optional member.
A completed/failed cron execution ledger entry also proves finished when no
admission remains. Unknown, missing, mismatched, and recovery-unknown executions
return `{accepted: false, state: "unknown", receipt: null}`.

Before cancellation the gateway atomically persists a mode-0600 pending intent
under the owning home's `cron/stop-receipts/`, keyed by a hash of job and execution.
If native cancellation has not settled within three seconds, it returns
`{accepted: false, state: "pending", receipt: null}`. A `receipt` retry completes
that intent through the same exact cancellation path. A receipt query without an
intent does not start cancellation. Terminal receipts survive restart; changing
member on retry preserves the original metadata. Errors/timeouts never imply ACK.

These receipts report native execution state only. They do not confer host
authority and are not a security boundary against the local agent user.

Verification: focused socket tests use temporary homes, real admission and cron
execution stores, and the real cron watchdog with an inert blocking agent. They
cover running, pending, queued, finished and unknown execution states, metadata
retries and job/execution isolation. Existing owner-source tests exercise both
queued and claimed turns unchanged. No accounts or inference APIs are used.

Local checkpoint verification: 78 tests passed across eight files via
`scripts/run_tests.sh`: schedule source control (10), owner source control (2),
session cron (4), canonical cron (9), inactivity timeout (6), shutdown interrupt
(25), fire-claim loss after delivery (6), and chat Stop scope (16). RED evidence:
all five initial schedule cases failed on the unchanged control endpoint; the
watchdog integration then failed specifically because it called soft interrupt.
