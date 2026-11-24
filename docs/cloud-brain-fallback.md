# Cloud Brain migration and local fallback

Keep local ingestion available until managed cloud coverage is complete. After
cutover, the account's cloud-readonly marker refuses ingestion, correction and
coverage writes. Retrieval and privacy withdrawal/fencing remain available.

The awareness transport treats a known readonly refusal as a plain refusal.
It preserves the native provider for privacy operations rather than retiring or
stopping it. Unknown outcomes still retire the exact provider as before.

Verification: local transport and native supervisor suites pass, 41 tests.
The transport regression test refuses ingestion and then successfully withdraws
through the same provider without stopping it. This source change is built, not
installed or activated. Release consumers must advance their verified public
source pin after normal assembly and release checks.


## Native historical read transport

The native host may start awareness/historical-port.mjs over its existing
MatrixLocalBrain supervisor, inside a private account directory. The Unix socket
is mode 0600. Pass the fixed native owner and managed run binding plus a current
callback returning that same custody ONLY after privacy reconciliation. A UI
controls view is insufficient authority. The server exposes only brain.retrieve,
rejects foreign agents and discards results when custody changes during a read.
Close the port before account transition or retiring the bound run; never unlink
another process's socket to take over its address.

The isolated stdio controller can supply managed_memory.historicalSocket beside
binding at session.create. The gateway freezes the socket on admission/retry and
constructs HistoricalAwareness plus CloudFirstAwareness v2. The adapter validates
v1 evidence, requires an exact native binding attestation and validates the
resulting v2 lineage. It never derives an owner or policy generation from raw v1
records. Empty/denied/malformed cloud replies do not authorize fallback.

Ordinary Electron launcher activation is still outstanding: it must use the
real reconciled native authority to start the port and pass the admitted socket.
The module and runtime admission are built and tested; this is not a claim of
installed activation. Do not use the UI controls view to bypass that remaining
binding. Historical fallback is labelled local_historical_fallback.

Freeze enrollment now also needs --cutover-file: an operator-owned private
atum.awareness-cutover/1 receipt for the exact localRoot, completeInventory=true,
liveTransportProven=true and all complete/cutoverAllowed reports with no gaps.
Missing or incomplete evidence refuses before enrollment writes. The receipt is
an operator assertion requiring fresh source checks, not automatic approval.

Verification: real Postgres/GBrain fixture proof now has 28 checks, including
live socket recall and a stopped managed service with a separate real local
store. Socket tests cover foreign agents, write rejection and privacy changes
during a read. The synthetic proof does not run a live Matrix homeserver or
install the Desktop launcher.

Public validation removes an unused synthetic request literal; real request
shapes are captured from the provider in the mapping test. No policy exception.
