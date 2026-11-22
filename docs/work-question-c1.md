# Work question connector — local checkpoint

Status: partly built, not live. No push, PR, CI, deployment, production access or model calls.

This checkpoint extends the existing owner Matrix SDK queue instead of creating another client. Main owns a private loopback HTTP endpoint, startup secret, account-generation cancellation and receipts persisted before send. Questions use stable Matrix transaction IDs, the existing owned-agent DM, and `io.atum.work_request` v1. Request IDs are bound to the thread and original payload; polls and acknowledgement retries reuse the receipt. Work origin does not restrict the agent's normal capabilities, per the coordinator's override.

An answer must come from the expected trusted sender in the resolved room and reply to the exact question. `io.atum.work_answer` v1 uses `request_id`, terminal `state: answered`, `data_class` and optional ordered `parts` event IDs. Every part must pass sender/relation validation; every part needs runtime clean certification for a non-Google answer. Presence of `io.atum.provenance` overrides clean classification. Notices, edits without pure reply authority and incomplete outcomes do not settle the request. This uses the existing invocation reader and its decryption/trust rules. The latest 100 room events plus the live timeline are scanned; older unsynced outcomes outside that window may time out.

**Release limitation:** protected and unknown answers are currently withheld from every provider. The certified Atum route and durable protected-transcript fence are not implemented in this checkpoint. Do not enable protected release merely by matching a provider name. The proposed `release` port is closed for protected data. Plan sessions receive `google_requires_atum`; clean runtime-certified outcomes may pass. The service is wired to sidecar startup/retirement; its secret is excluded from ACP gateway environments. The companion T3 toolkit consumes and removes it from the server environment before spawning providers.

The desktop archive still pins T3 `5d8d30d04ee1` (0.1.11). The requested separate fork worktree began at its current origin/main `0b02be3d5`. This is not an exact-pin integration proof, and no runtime archive or manifest was changed.

Local verification completed with nine desktop tests passing.
Electron TypeScript passed. Focused ESLint passed.
The full desktop typecheck returned code 2 because the shared dependencies lack the react-streamdown package and its dependent properties. The renderer check is not green.
Five companion transport tests passed. Native provider integration was not exercised.
The fork package checks could not finish because its toolchain was missing.
An automatic dependency installation was cancelled and its partial directory removed.
No paid eval was run.

Outstanding before release: implement and prove certified Atum protected delivery with durable switch/resume/title/summary fencing; live provider revalidation in main before protected serialization; exact bundled-pin MCP discovery/execution/resume for all provider drivers; full Matrix fixture coverage (multipart, edits, duplicate sync, decryption retry and offline/reconnect); bounded history catch-up; overall auth/account/sidecar replacement proofs; cloud runtime provenance support. The receipts have no garbage collection yet. The native SDK queue supplies the existing 30-second send command bound; no cloud cancellation is claimed on local timeout.

Public guard initially refused the session-note path because docs/sessions is a denied public prefix. The note was moved to this public integration-document path and the local checkpoint amended; no policy was relaxed.

## Round 2

The connector reads the cloud runtime's numbered v1 `part` and `parts`
markers. Every part must be a trusted original reply with the same request
and total count. Duplicate event IDs count once. Notices, edits, interim
markers and inconsistent part indexes cannot supply missing parts. A
protection marker can never certify a part as clean.

The SDK reader uses the native invocation reader for sender verification,
encryption and missing-session retry. It follows the existing result
recovery bounds of five 50-event Matrix /messages pages and a 20-second
read deadline after inspecting the live tail. This is a positive lookup
and leaves the receipt waiting when the result falls outside the budget
or the room is offline. It never changes the visible timeline.

The server credential now starts inside the sidecar's abortable startup.
Account generation changes and sidecar retirement stop old requests before
further receipt writes or answer release. The HTTP fixture retires the old
endpoint and resumes an existing receipt with a new startup credential.
Expired receipts are compacted on startup and connector traffic into
content-free request IDs, so a late retry cannot post again. The IDs
remain durable for idempotency. Concurrent acknowledgement retries share
one send attempt and use the original Matrix transaction ID.

The fork toolkit was ported onto the exact source base of the current
Work runtime. The shipped archive and its manifest still require a
separate build and repin. Main and the fork both withhold protected and
unknown bytes. The existing Work model key authenticates a managed model
route, and certified protected delivery still requires route enforcement,
live main-side provider revalidation and durable transcript reuse fencing
across provider switch, resume, titles and summaries.

Local fixtures cover numbered multipart, duplicates, edits, offline
paging beyond 100 events, decryption retry, account turnover, HTTP
credential replacement, receipt compaction and acknowledgement retries.
The full Desktop typecheck was run with its lockfile workspace
dependencies, including the missing Streamdown dependency.
