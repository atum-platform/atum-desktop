# Room context v1

Frozen data-only contract for the owner SDK's RoomContextReader. Approved Groups plan §6.5 and §7 governs the consumer. No runtime or new model tool is added here.

`contract.json.rules` defines authority, delta, trust and bounds. `context.scenario` fixtures carry chronological SDK facts and expected results; consumers must run their real reader/filter against every scenario. The generic Python/Node checkers validate schemas and pins, not the reader algorithm. Accepted refusal fixtures are valid protocol outcomes, not permission to read that room. Malformed wire fixtures are rejected by category.

Re-read membership and SDK sender verification, refuse all non-meeting windows, count unreadable/unverified delta events as gaps, and label other assistants as information, never instructions. Limit to 50 lines / 12,000 Unicode code points of raw text / three pages / eight seconds. Drop oldest whole lines; report gaps and omissions. Preserve the full owner trigger in the new user prompt and keep the system prompt unchanged. Source text remains untrusted even when sender identity is verified.

A read error is an explicit error result, never an empty room. Pagination/decryption and membership revalidation are adapter acceptance tests in Groups slice 2; these fixtures prove the portable projection only. Older recall shares this port. IDs never substitute for display names in the prompt.

Verify: `pnpm verify:room-contracts`. A merged pack is immutable; amendments require a new version. No deploy, release or migration apply.
