# Remote brain profile enrollment

`python -m hermes_cli.remote_brain --home PROFILE --endpoint HTTPS_MCP_URL`
installs the existing native MCP search/get_page tools before conversations start.
Use native interactive MCP login once, or supply a protected `--client-file`
with client_id and client_secret for unattended machine authorization. The MCP
SDK owns token acquisition and renewal. Credentials live in native protected
storage and never in config.yaml. Repeat --home for additional profiles.

Optional `--local-brain-root` installs an account-specific ingestion freeze. The
native desktop supervisor rejects ingest, correction and new coverage writes;
recall and privacy fencing/withdrawal remain available. Native index recovery
still needs filesystem writes. This does not export or migrate old knowledge.
The profile skill asks for cloud-first recall and historical local evidence only
on outage, preserving existing awareness suppression and custody contracts.

The machine OAuth adapter uses the SDK ClientCredentialsOAuthProvider. It uses the repository-pinned SDK 2.3 machine grant, binds the credential to
the endpoint issuer, and seeds cached token expiry on process restart. It introduces no OAuth server or token timer.

Verification: focused native supervisor tests include ingestion freeze, recall
and privacy removals. The private assembly's real-engine fixture proves native
machine credential reissuance after expiry with cited retrieval. Production
activation, physical migration and installed-client acceptance are separate.

Local verification: 15 native supervisor tests passed (exit 0). Private assembly
verification with the pinned MCP 2.3/httpx2 stack passed 116 focused Python tests
and the real GBrain renewal/citation fixture. No installed user profile or data
was accessed; no physical migration, push, PR, CI or deployment was performed.

Managed-awareness migration support (built, not activated): native brain.export
now retains full privacy records, original operation IDs, accepted receipt
identities and ledger sequence. Missing eligible bytes block coverage. The
platform's private approved-hash import/check operator uses these records before
content. It does not import through raw MCP. Runtime AtumAwarenessProvider accepts
a native managed_retrieve port and chooses it first; local fallback requires
current native privacy authority and an actual cloud outage, and is labeled
local_historical_fallback. Empty/denied/malformed results do not trigger fallback.
No real store, enrollment, migration, cloud or installed app was changed.

Fixture verification for this checkpoint: app vendor BrainState tests 22 passed
(exit 0); platform native state/contract/durability 38 passed (exit 0), managed
fixtures 52 passed (exit 0), and a disposable real Mac PGLite -> real managed
Postgres/GBrain proof passed 22 checks (exit 0), including native provisioning,
coverage, original-source recall and later withdrawal. Python provider/v2/cloud
selection tests had 69 passes and one pre-existing assertion failure (exit 1):
MemoryManager creates its expected provenance marker while the old test expects
no new files. Untouched-base reproduction also failed. No assertion was weakened.
Cross-family review and live enrollment/migration remain coordinator work.

Final focused Python v2/cloud-first/frozen-contract check: 50 passed, exit 0.
Public boundary guard against the incoming slice head passed (exit 0), invoked
directly without piping; paths, modes, full ancestry, identifiers, secrets and
metadata passed. Workspace remains below the requested storage limit.

Live-chat checkpoint (built, not activated): the existing isolated controller
now constructs the cloud-first v2 adapter before provider construction, retains
lineage validation and labels successful recall `retrievalOrigin:cloud`. The
adapter accepts a trusted v2 historical port, checks privacy before and after
fallback, and refuses denial, malformed and empty-success substitution. No raw
v1 history is stamped with v2 lineage. The cloud host has no Mac store and gets
no local fallback by default. Desktop historical-port admission remains required
before cutover. Enrollment alone must leave ingestion running; use
`--local-brain-root` only after complete migration coverage and transport proof
(step 7). No timer, real data, production or installed app was touched.

Live-chat focused verification: canonical per-file runner, 40 Python tests passed,
exit 0 (v1/v2 cloud-first provider and real controller/SQLite loopback).
