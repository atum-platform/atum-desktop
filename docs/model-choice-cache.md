# Desktop model-choice cache ordering

The Electron main process uses `MatrixCloudModelChoices` for legacy cloud offers
and `MatrixModelDestinations` for destination snapshots and subscription picks.
Both extend the platform's existing revision and policy-digest fences. No new
renderer API, persistence format, or dependency is required.

Each agent has a monotonically increasing pick intent within the active cache
owner. Only the latest intent may retry after a revision/policy conflict or adopt
a successful response. A superseded operation returns false without changing the
cache or emitting a change notification. A retry re-reads once and uses the fresh
server fence; it cannot restore an older pick after a newer pick succeeds.

Each operation captures the initiating account and cache activation generation.
Reads, retry continuations, device-name display work, successful writes, and
refresh completion bookkeeping discard work from a previous activation. This
also covers cap writes through the shared destination adoption path.

Read and write adoption both preserve revision ordering. An accepted write whose
response is older than the held snapshot still reports server success, but does
not replace the snapshot, emit a change notification, or reset its refresh clock.
Reads started before an adopted write remain fenced by the existing write count.

The cloud picker currently has no effort-only control: model capabilities for
the effort slider are populated only in local mode (`model-picker.tsx`), and the
slider is gated to unmanaged, non-home mode. The cloud `setModel` effort-only
restriction is therefore unchanged.

## Verification

Ten controlled-promise/fake-timer regressions cover obsolete retries, superseded
successful responses, sign-in generation changes (including delayed device-name
display), and late successful write responses with refresh-clock preservation.
All ten fail against the preceding implementation and pass with the fix.
The preceding read-ordering and conflict-retry tests are retained.

The six focused suites (cloud-model-choice, model-destinations,
main-model-destinations, model-picker, model-picker-popover, design-contract)
pass: 851 tests. Renderer and Electron TypeScript checks and ESLint on the four
changed TypeScript files pass. No Electron packaging or native build is needed
for this change. Installed-app acceptance remains a separate release step.
