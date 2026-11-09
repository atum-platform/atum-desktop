# Agent sweep v2

`atum.agent-sweep/2` is a separately negotiated major profile. It retains the complete normal, first-48-hour warm-up, cloud/native authorization, settlement, publication and release behavior of `/1.1`, while replacing the closed five-key `sourceWatermarks` wire with an admitted `atum.agent-sources/1` snapshot, its digest/revision, an open bounded `sourceCursors` map and exact cursor bindings.

The platform pins the profile and admitted snapshot per occurrence. Dispatch repeats the snapshot digest/revision. Settlement cites that digest, carries sorted open source outcomes and proposes only generic cursor deltas. The platform accepts a delta only for an admitted `ok` or `partial` outcome under the byte-identical connection, scope, descriptor-revision and authority-revision binding. Failed, denied, unavailable, policy-unsupported and budget-skipped sources do not advance. Unmentioned stored cursors survive. Replay returns the durable receipt; recovery never translates an in-flight occurrence to another profile.

Unknown source IDs and kinds are valid. The accepted admission fixture carries an app/room descriptor unknown to product code through claim, settlement and the next claim cursor. The stale-binding, unadmitted-delta, duplicate-source, failed-cursor and snapshot-digest fixtures close the occurrence authority boundary.

## Legacy compatibility

`atum.agent-sweep/1` and `atum.agent-sweep/1.1` remain frozen. Their `sourceWatermarks` object still contains exactly five keys: `googleMail`, `googleCalendar`, `atumChats`, `conversation`, and `memory`. The compatibility projection maps non-null open cursors for those five IDs and emits `null` for an absent key. It omits Drive and every unknown source. Legacy nulls migrate to absent `/2` keys. Google Drive begins without an inherited cursor; Calendar may retain the old mixed bytes only until its first successful Calendar-only frontier.

The release adds no `budgetWeight`, rotation state, scheduler or per-source enablement. Existing grants make admitted descriptors ON by default; existing opt-outs and live authority still win.

Protocol release: `@atum/protocol` 0.7.56. Runtime migration allocation and activation belong to the platform lane.
