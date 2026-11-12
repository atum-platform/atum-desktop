# Stopped-runtime sleep policy

`gateway.sleep_wake` extends the native `gateway.scale_to_zero.is_idle`
predicate for hosts that stop containers rather than suspend relay-backed Fly
machines. Native relay sleep remains unchanged. This module adds no model tool,
transport, queue, scheduler or mid-conversation prompt change.

`decide(Policy(), Facts(...))` permits sleep after ten idle minutes, no active
turn/cron/API/background work, no open operation and no pending intake or delivery.
Incomplete probes fail awake. Facts must be read while admission is excluded,
with that exclusion held through confirmed stop. Wake coverage defaults off.

The host owns a durable `WakeRequests` service and lifecycle serialization.
Authenticated push hints coalesce; they never contain work to execute. Start
requires current generation authority. A stopped owner cannot be revived by a
hint. Wake intent is persisted before start, retried after crashes with the
host's existing restart guard, and cleared only when healthy. A fresh idle window
starts after wake. Sleep does not change runtime generation or sender identity.

`next_native_schedule(home)` reads native cron's stored absolute next occurrence.
It never advances or claims jobs. Wake 120 seconds before that occurrence, then
let the native scheduler tick/claim/fire it. Unknown or unresolved schedules
prevent sleep. Publish schedule edits to the host even while the agent sleeps;
periodically reconcile in addition to hints. Host timer must tick at most every
ten seconds. If boot plus scheduler latency exceeds that margin, report lateness
and keep the agent awake until capacity recovers.

After wake the Matrix adapter resumes from its existing durable cursor, catches
up limited timelines, and reuses native admission/delivery evidence. Preserve
private state, identity store and stable sender across every stop/start. Push
coverage must include muted/read events, with independent reconciliation for
lost hints. Never reset the intake cursor or dispatch push payloads as prompts.
Exactly-once final text publication is the existing delivery-ledger contract;
this policy does not strengthen attachments, streaming or external tool effects.
