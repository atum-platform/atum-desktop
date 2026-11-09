# `atum.canonical-room/1`: owner-private canonical Matrix room reads

This frozen data-only pack reserves two additive owner-read projections. It does not create, discover, migrate, write, repair, backfill, clean up, retire, or move a Matrix room or mapping.

## Routes and identity

`GET /api/matrix/v1/apps/{slug}/bot` adds required `room_id`; both `GET /api/matrix/v1/agents` and its mirrored `GET /api/matrix/web/v1/agents` owner route add required camel-case `roomId` to every active top-level agent row. All are owner reads with `Cache-Control: no-store`. The authenticated principal is server-derived. The app slug comes only from the server-resolved path and must resolve to an active app.

The app-bot route already rejects query/body identity injection. The established native and web agent-list reads instead ignore query and body bytes; those bytes never select an owner, agent, or controller, and this data-only pack does not introduce a new 400. The fixtures intentionally lock that asymmetry.

The fixtures model the existing response envelopes as open compatibility carriers while freezing the existing profile/agent binding and required mapping field. `roomId` is required only on active top-level rows; nested `retired_agents` tombstones remain legacy metadata, never gain a room mapping, and are never active targets. A missing required field is incompatible, never null. Existing strict consumers must accept these additive fields before server emission.

## Room value and privacy

A canonical room is either null or a full Matrix room ID matching `^![!-9;-~]+:[!-~]+$`, with 4 through 1024 UTF-8 bytes. The permitted characters are ASCII, so the pack checker’s character bounds are byte-equivalent. The legacy app-bot outcome input only checks length/leading `!`; Contract 5 intentionally requires a server-qualified ID for the new canonical output and LA10 must use the canonical validator there. Null means the server has no recorded mapping; it never authorizes discovery, creation, or fallback.

This is owner-private routing metadata only. Its presence does not prove room membership, consent/link readiness, app activation, or any other authorization. A mapping may be returned before consent or link readiness. The canonical-room addition exposes only the room ID or null: no controller/app-host/public-catalog projection, access token, credential, executor, lease, event, history, member/content, or internal mapping metadata. The established `atum.app-bot-status/1` envelope remains an open compatibility carrier, including the already-published `bot` metadata; this overlay does not redefine or expand it.

## Scope boundary

There is no controller directory or controller backfill in this pack. Database migration, mapping writes, repair/backfill/cleanup, room creation, races, retirement, move behavior, and LA10 runtime implementation are explicitly deferred. Older native, web, and mobile consumers are not activation-safe until they accept the required additive fields and explicit null.

Run `pnpm verify:canonical-room-contract` to execute both independent validators, deterministic generation check, and behavior tests.
