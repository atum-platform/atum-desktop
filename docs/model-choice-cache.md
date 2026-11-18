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

## Managed cloud conversation effort (2026-11-18)

Standard Matrix conversation picks now project eligible per-alias levels and
saved effort from the cloud offer, through main’s subscription-enriched
cloudModelView projection. Nguyệt Thực and Nhật Thực expose only the
advertised conversation levels (low/medium/high). No offer, one level, or no
levels keeps the compact card. The Mac fallback remains medium-only; no
max/xhigh support is invented.

The column reads cloud saved effort rather than stale room account data. An
effort click uses the existing setModel command. Main resolves effort-only
commands against the current server alias and refuses unadvertised levels.
Explicit effort overrides the destination's saved effort even when its model
is unchanged. Legacy writes also carry the effort through fenced retries.
Accepted writes refresh the server offer; refused writes undo the optimistic
pick. Persistence remains the owner's server choice, not room account data.

Reused infrastructure: model-picker's effort column and pending picks,
cloud-model-choice's parser/cache, model-destinations' fenced writes and legacy
reload. No new protocol, core model tool or dependency.

The desktop submits the selected effort with the owner model choice and refreshes the offer after the server acknowledges it.

## Previous cache-ordering verification

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
