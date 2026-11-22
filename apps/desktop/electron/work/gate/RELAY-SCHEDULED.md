# Scheduled relay admission

Scheduled requests carry their native occurrence instant (`scheduled_at`, Unix milliseconds) and display name (`job_name`). The first admission must be no older than 15 minutes and no more than 60 seconds in the future. Exact retries retain the same frozen envelope.

Each agent has one open scheduled operation at a time. Concurrent requests for different jobs share that cap; ordinary conversation bindings remain independent. Before dispatch, a busy slot refuses without forwarding so the native scheduler can serve the occurrence locally. Switching scheduled consent off marks unfinished scheduled plan receipts Stop owed through the existing cutoff and cleanup machinery. A completed response still requires explicit close to release its binding.

Status uses an indexed SQL aggregate for scheduled usage and only updates the usage-window record when it changes. Titles use the job display name.

Local review-repair verification: gate suite 399 passed, 8 skipped; Electron TypeScript check and focused ESLint pass. Full ESLint exits with zero errors and existing warnings. Full renderer typecheck remains blocked by the checkout dependency tree missing `@assistant-ui/react-streamdown`. The full Electron suite initially had 13815 passed, 57 skipped and 18 failures in unrelated Python-backed files with missing interpreter/dependencies; focused rechecks are recorded in the coordinating session log. No published artifact changes in this checkpoint.
