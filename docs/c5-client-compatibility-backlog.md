# C5 reader-first rollout — built locally, not live

Owner request “All my agents” remains open until deployed and installed acceptance.

- Reader compatibility: built locally; accepts `agents: "all"`, expands the display
  to eligible agents, and preserves all-owner records during automatic sync/Connect.
- TODO C5 sender (later release): send `agents: "all"` only after a reader-capable
  desktop release has reached connected Macs. This change deliberately keeps the
  UUID-list input/sender contract. No feature flag or speculative machinery.
- Server migration 0547 itself returns `"all"` for migrated records. Publish and
  install the reader-capable release before applying 0547, not just before the
  later sender release. Old clients still writing fixed lists remain a rollout
  risk; migrate connected clients before activation.
- A4 targeting: built locally; new-shape authorized-key read retries the old
  device-less request only after HTTP 400. New Shell stays device/epoch strict.

Order: reader release first; host bridge first within the platform stack, then
0547, then 0548 + Shell, then targeted desktop. The Shell S2 optional-lastSeenAt
fix does not remove the host bridge ordering: the shared SQL list still emits
lastSeenAt and the old bridge rejects it. The coordinator owns final rollout,
CI, cross-family review and release acceptance. Nothing here is live yet.
