# `atum.company-workspace/1.2`: admin-created invite links (S5)

- **Row:** B19 slice S5, contract first (DR-3). Authored 2026-10-21 against platform `origin/main` `93380e6e`.
  Owner authority: 2026-10-05 (Team Space is humans-only, built once on the finished cloud), 2026-10-19
  (planning), and 2026-10-20/21 (item 15, rolling execution). Product decisions: `launch/b19-team-space-plan.md`
  decision 9 and the S5 row.
- **Provider:** the Atum platform company authority and the Shell native routes. **Consumers:** desktop Team
  Space, the phone (S5 redemption), and the web handoff page the link opens in a browser.
- **Status:** frozen when merged. It adds no SQL, route, flag, deployment or production state. Server,
  migrations, desktop and phone ship in their own lanes behind this contract.
- **Base:** `atum.company-workspace/1.1` (`spec/company-workspace/v1.1`, pack digest `9e285a3a08337235f9f405e0a3a516fc1e7db45e3daa72614f9614f4de1ad9f6`). That pack
  and `atum.company-workspace/1` are not edited, and every 1.1 byte remains the 1.1 wire.
- **Checked by:** `pnpm verify:company-invite-link-contract` (both independent pack checkers, the deterministic
  authoring check, and a reference interpreter for the link traces), plus the protocol mirror's Vitest suite.

## What this pack adds

One capability: an **active admin** of a company creates a link that another signed-in person can redeem to
join as `member`. The link is a bearer capability, not an emailed invitation: Atum sends no email and the admin
pastes the link into any messenger or email themselves.

| Need | 1.2 |
|---|---|
| Ask for the new shapes | request header `Atum-Company-Wire: 1.2`; new answers carry `schemaVersion: 3` |
| Create a link | `POST /api/matrix/v1/companies/{companyId}/invite-links` |
| See the company before joining | `POST /api/matrix/v1/invite-links/preview` with the token; no effect |
| Join | `POST /api/matrix/v1/invite-links/redeem`; the server does invite + accept in one transaction |
| Withdraw | `POST /api/matrix/v1/companies/{companyId}/invite-links/{linkId}/revoke`; idempotent |
| List links | `GET /api/matrix/v1/companies/{companyId}/invite-links`; metadata only, never the token |
| Every refusal | one `404 {"error":"matrix_404","details":{"reason":"invite_link_unavailable"}}` |

## Fixed parameters (the plan's S5 minimum)

| Property | Contract |
|---|---|
| Token | at least **32 bytes** from a CSPRNG, base64url, **43 to 128 characters**. Not a UUID, a counter or anything derived from the company, the creator or the person. Only a **keyed hash** is stored at rest |
| Default expiry | **7 days (604 800 s)** when `expiresInSeconds` is omitted; accepted range 3 600 s to 2 592 000 s (30 days) |
| Max uses | `maxUses` 1 to 100; **10 when omitted** (one named constant, `DEFAULT_MAX_USES`). A use is a successful joining, never a preview or a replay |
| Role | `member` only. `admin` cannot be created, previewed or redeemed through a link |
| Revocable | any **current active, non-revoking admin** may revoke at any time; revocation is immediate and idempotent |
| Atomic redeem | the invitation and its acceptance commit in one transaction with the use count |
| Replay | scope is `(actor, requestId)`; the same actor and `requestId` with the same token is answered without consuming a use; a different actor under that `requestId`, or a changed expiry/`maxUses`/token by the same actor, is `409` |
| Pending removal | a person in `revoking` cannot preview, redeem or be re-added by a link |
| Removed people | a removed or banned person cannot preview or rejoin through a link (uniform `404`, no oracle); only a direct handle invitation from an active admin readmits them |
| Link cap | at most **20 live links per company**; create at the cap is `409 invite_link_limit_reached` |
| Creation rate | at most **10 creations per admin in a rolling hour**; beyond that create is `429 invite_link_rate_limited` |
| Redaction | the token never appears in a list answer, a log, a referrer, analytics or a crash report |

## Version selection

`Atum-Company-Wire: 1.2` selects this wire. Absent selects v1, `1.1` selects the 1.1 wire, and any other value
is `400 matrix_400` with no effect, exactly as 1.1 defines. The header applies to the company workspace actions
and the channel directory actions 1.1 lists, plus the invite-link actions here. Other packs keep their own
selectors.

**1.2 is additive.** Every 1.1 answer under the `1.2` header is byte-identical to the 1.1 answer, including
`schemaVersion: 2`; a 1.2 server does not restate 1.1 shapes. The **new** invite-link messages carry
`schemaVersion: 3`, which is how a client recognises a server that speaks 1.2. A client that needs to probe
before showing "copy link" sends `POST /api/matrix/v1/invite-links/preview` (or `GET …/invite-links`) and treats
`404` before authentication as "this server is 1.1". Never infer support from a build or a flag.

Rollout order: database, Shell, desktop/phone, then the web handoff page. Rollback in reverse. A rolled-back
Shell answers `404` before authentication to every 1.2-only action, so no state changes.

## Routes and shapes

| Route | Who | Request | Answer |
|---|---|---|---|
| `POST /api/matrix/v1/companies/{companyId}/invite-links` | active admin | `invite-link.create.request` | `invite-link.create.response` |
| `GET /api/matrix/v1/companies/{companyId}/invite-links` | active member (admin sees all links; a member sees an empty list) | — | `invite-link.list.response` |
| `POST /api/matrix/v1/companies/{companyId}/invite-links/{linkId}/revoke` | active admin | `invite-link.revoke.request` | `invite-link.revoke.response` |
| `POST /api/matrix/v1/invite-links/preview` | any signed-in human | `invite-link.preview.request` | `invite-link.preview.response` |
| `POST /api/matrix/v1/invite-links/redeem` | any signed-in human | `invite-link.redeem.request` | `invite-link.redeem.response` |

All answers to 1.2 requests are `Cache-Control: no-store` and `Vary: Atum-Company-Wire`. Preview and redeem
require authentication; an unauthenticated click only stores the token for the sign-in handoff (below).

### Create

`{requestId, role: "member", expiresInSeconds?, maxUses?}`. The first answer is
`{schemaVersion: 3, replayed: false, link: {id, companyId, role, state, createdAt, expiresAt, maxUses, uses, url}}`.
`url` is the only place the token is ever projected onto the wire, and only in this first answer. The canonical
form is `https://atum.app/j/<token>`; clients copy it verbatim, never build one.

- **Only a currently active, non-revoking effective admin creates.** This includes the single `owner` introduced
  by 1.3 (older wires project that owner as `admin`). Adminship is re-checked on every create call and every replay.
  A demoted, removed or `revoking` caller is plain `403 matrix_403`, with no `url` and no link metadata.
- **Replay.** The scope is `(actor, requestId)`. The same admin and `requestId` returns the **same link metadata**
  with `replayed: true` and **no `url`**: the server stores only a keyed hash of the token, so the raw token cannot
  be re-emitted. The shape is
  `{schemaVersion: 3, replayed: true, link: {id, role, state, createdAt, expiresAt, maxUses, uses}}`.
  A `requestId` already used by a **different actor** is `409 matrix_409` and never returns the first actor's
  result. The same actor reusing a `requestId` with a different expiry or `maxUses` is also `409` and changes
  nothing. A role other than `"member"` never reaches replay: the request shape refuses it with `400` first.
- **A lost create answer is not recoverable.** Because the token is not stored, a client that lost the first answer
  tells the admin to create a new link. The old link stays live until it expires or is revoked; the list still shows
  it by id, so an admin can revoke it without the token.
- **Resend/rotate is revoke plus create.** There is no resend mutation for a bearer link. An admin revokes the old
  link, then creates a new link with a new `requestId`, link ID, token, expiry and use counter. The new create cannot
  recover, extend or reuse the old secret.
- `link.uses` is the current count, so a replay can show more than zero.
- A retired company, a caller who is not an active admin, or a company the caller cannot read is refused with the
  1.1 statuses (`403`/`404`); creation never revives a company. A company holding 20 live links refuses create with
  `409 invite_link_limit_reached`; more than 10 creations by the same admin in a rolling hour refuses with
  `429 invite_link_rate_limited`.
- **Authorization comes first.** The active-admin check runs before the live-link cap and the rate check. A plain
  member calling create against a company at 20 live links gets `403 matrix_403`, never the `409`, and a member
  over the rate gets `403`, never the `429`; the caller the list audience keeps blind never learns the count.

### List

`{schemaVersion: 3, links: [...]}` with at most 100 links, newest first. Each entry is
`{id, role, state, createdAt, expiresAt, maxUses, uses}`. **No `url`, no `token`, no `memberRef`, no principal.**
This is what makes "the token is shown once" checkable: only the first, non-replayed `create.response` has a
`url` field, and its direction is the one direction in this pack that permits it. A member who is not an admin
sees `links: []`.

`state` is computed at read time with this precedence: `revoked` if the link was revoked **or the company is
retired**, else `expired` if `now >= expiresAt`, else `exhausted` if `uses >= maxUses`, else `active`. Revocation
(and retirement) wins over the other two, so a retired company's links never display `active` and an admin cannot
mistake a dead invite for a live one.

### Preview

`{token}`. Answers `{schemaVersion: 3, company: {id, displayName}, role: "member", inviter: {handle|null,
displayName|null}, expiresAt, maxUses, usesRemaining}`. It has **no effect**: no use is consumed, no invitation
is created, no request is stored. A preview can be stale; redeem is authoritative and can still answer
`invite_link_unavailable` after a successful preview.

Preview is **not** an oracle for people choice 8 excludes. A person in `revoking` or a `removed` person gets the
same uniform `404 {"error":"matrix_404","details":{"reason":"invite_link_unavailable"}}` that redeem gives — no
company name, no inviter, no expiry, no `usesRemaining`, no link liveness — exactly as if the token were unknown.
The rule is checked before any company or link projection.

`inviter` is the creating admin's current handle and display name, or both `null` once that person is no longer
an active member. The link belongs to the **company**, not to its creator: it stays valid when the creator
leaves, and any current active, non-revoking admin can revoke it.

### Redeem

`{requestId, token}`. In **one transaction**, the server:

1. authenticates the actor and checks the person is an eligible human, not `revoking` or `removed`; this occurs
   before replay lookup so an ineligible caller receives the uniform `404` even for a stored request ID;
2. looks up the replay by `(actor, requestId)`;
3. for a first execution, checks the link is `active` — not revoked, expired or exhausted — and the company is active;
4. acquires quota locks in the global order **target-person quota → company → invite-link**, then checks the
   person's ten-company cap and the company's 100-member cap (or uses a proven `SERIALIZABLE` equivalent);
5. creates the invitation **and** accepts it, or accepts an existing `invited` row;
6. consumes exactly one use **only if the link created the membership row**, and stores the replay.

Answers `{schemaVersion: 3, companyId, memberRef, role: "member", state: "active", link: {id, maxUses,
usesRemaining, consumedNow, replayed}}`.

- **Replay.** The scope is `(actor, requestId)` after current person eligibility. An eligible same actor,
  `requestId` and token is answered from the stored
  result with `replayed: true`, `consumedNow: false` and the **current** `usesRemaining`. It is answered even after
  the link was revoked or exhausted, because the join already happened; it reveals nothing the actor did not
  already cause. A removed, revoking or non-human actor receives uniform `404` before receipt lookup. A
  `requestId` already used by a **different actor** is `409 matrix_409` and never returns the
  first actor's stored result. The same actor reusing a `requestId` with a different token is also `409`.
- **Existing membership.** An `active` member gets `state: "active"` with `consumedNow: false` and no use spent.
  A person with a pending 1.3 direct invitation is accepted with `consumedNow: false`: that exact attempt becomes
  terminal `accepted` atomically, and no `invited` member state remains. The invitation already reserved their
  place, so the link did not create it. A `removed` or banned person is **not** eligible through a link and is refused with the
  uniform `404`; no use is spent.
- **Races.** The use count, the link state, the ban check and the cap checks are read and written in the same
  transaction. Every redemption that may create or accept membership acquires quota locks in the same global
  order: **target-person quota → company → invite-link**. The target-person lock serializes the same human joining
  different companies; the company lock serializes different people joining one company; the link lock serializes
  use/revoke. A proven `SERIALIZABLE` equivalent is allowed only when it covers both membership predicates. Thus
  concurrent redeems of **different** links cannot jointly overshoot either cap. Two redemptions of the last use produce exactly one
  `joined` and one `invite_link_unavailable`, in either order. A revoke concurrent with a redeem produces either
  (redeem succeeds, then revoke) or (revoke commits first, redeem is unavailable); never a joined person on a
  revoked link and never a consumed use for a failed redemption.
- **Pending removal.** A person in `revoking` cannot redeem, preview or be re-added; the answer is the same
  `invite_link_unavailable`. Nothing about the pending removal is disclosed. `removed` is not pending but is still
  closed to links: only a direct handle invitation from an active admin readmits that person, exactly as 1.1's
  handle path does, and no old project grant is restored. Removing a person does not revoke other people's links.
- **First channel.** A successful redeem answers with the membership only; the client opens the company and its
  default channel through the 1.1 snapshot and channel directory. Redeem does not seed or change channels.

### Revoke

`{requestId}`. Requires a **currently active, non-revoking effective admin**, including the 1.3 `owner`; adminship is re-checked on every revoke call,
including a replay. A demoted, removed or `revoking` caller is plain `403 matrix_403` with no link metadata. The
answer is `{schemaVersion: 3, linkId, state: "revoked", revokedAt, replayed}`. Revoking an already revoked,
expired or exhausted link is a successful no-op that leaves the state `revoked` and keeps the first `revokedAt`;
the same actor and `requestId` answers `replayed: true`, and a `requestId` already used by a different actor is
`409` and never returns the first actor's result. A different `requestId` after revocation still answers success
(`revoked`) because the desired state already holds. Revocation does not undo joins that already happened, and it
does not remove a person who joined earlier.

### Errors

Bodies are closed. There are three link refusals:

```
404 {"error":"matrix_404","details":{"reason":"invite_link_unavailable"}}
409 {"error":"matrix_409","details":{"reason":"invite_link_limit_reached"}}
429 {"error":"matrix_429","details":{"reason":"invite_link_rate_limited"}}
```

The `404` is for every cause that makes a link unusable: unknown token, malformed token that still passed the
shape check, revoked, expired, exhausted, retired company, capacity, an ineligible principal, a removed person,
and a person in `revoking`, in both **preview** and **redeem**. There is no cause field, no company name, no
hint. The token holder already holds the capability; the uniform body exists so a revocation or exhaustion race
cannot be used to learn link state, and a removed person cannot use preview to learn that a circulating link is
still live. The `409` is only a create at the 20-live-link cap, and the `429` only a create beyond the per-admin
rate; both are stated so an admin can act. Authorization is checked before either create refusal: a non-admin is
plain `403` and sees neither. Admin routes otherwise use the 1.1 plain statuses (`400`, `401`, `403`, `404`,
`409`, `503`); a demoted or `revoking` admin on create, create replay or revoke is plain `403`, and a create replay
reused by a different actor or with a changed expiry or `maxUses` is plain `409`. A changed role is a `400` shape
refusal, never a replay.

## Tokens in logs, referrers and clients

The token is a bearer capability for a company. It must not leak through the ordinary plumbing:

- **At rest, the token is not stored.** The server keeps only a keyed hash (SHA-256 with a server-side pepper held
  outside the database, or an equivalent salted hash), keyed by link id, and compares in constant time. A database
  read, backup, replica or support export therefore contains no usable link. Because of this, a create replay
  answers metadata only and never the `url`.
- **Server access logs** record the route template (`/api/matrix/v1/invite-links/redeem`), never the concrete
  path, query or body. Error logs and traces redact `token` and any `/j/<token>` substring. No token in metrics
  labels, analytics events or support bundles.
- **Responses** that can carry a token (the first create answer) and all link answers are `Cache-Control:
  no-store`, `Pragma: no-cache` and `Referrer-Policy: no-referrer`.
- **The web handoff page** at `/j/<token>` answers with `Referrer-Policy: no-referrer`, loads no third-party
  script and no analytics, sets `Cache-Control: no-store`, and does not render the token as text. It hands the
  token to the desktop app (`atum://join/<token>`) or the phone universal link, or keeps it in memory across
  sign-in for the in-page flow. The token is removed from the address bar with `history.replaceState` as soon as
  it has been read, so a screenshot, a copied URL or a subsequent navigation cannot carry it.
- **Clients** keep the pending token in memory or the platform secure store, never in a journal, a log, a crash
  report, an analytics property or a chat message. A copy action copies the URL; it is not echoed into the UI
  after the handoff. If the app is killed before redemption, the user opens the link again; the link survives
  sign-in for its own lifetime, nothing else is persisted.
- The **API** never takes a token in a path or query. Preview and redeem take it in the JSON body, so a proxy or
  access log that records paths and queries cannot capture it.

## Compatibility with v1 and 1.1

- The 1.1 pack is unchanged, byte for byte. `Atum-Company-Wire: 1.1` answers exactly what it answered before;
  the 1.2 routes are unknown actions there (`404` before authentication).
- Under `Atum-Company-Wire: 1.2`, every 1.1 request and answer is unchanged. Only the new actions and the new
  `schemaVersion: 3` bodies are added. A 1.2 client that meets a 1.1 server hides the link surface and keeps
  using 1.1.
- A v1 caller never sees a link shape: without the header, the answer is the v1 answer and every 1.2-only action
  is `404`.
- `memberRef` in the redeem answer is the same opaque, company-scoped ref 1.1 defines. The link never becomes a
  second identity: joining through a link produces the ordinary membership row, and a later removal, leave or
  **handle** readmission behaves exactly as 1.1 says. A removed person cannot come back through a link; that is
  the one link-specific exception, and it does not change the 1.1 handle path or any 1.1 byte.

## Humans only

Invite links do not widen the humans-only rule. An agent, app, service or company principal cannot preview,
redeem or hold a membership through a link; the refusal is `invite_link_unavailable`. Creating and revoking
require an active **human** admin. The 1.1 refusal of agent invites by handle and by raw Matrix is unchanged,
and this pack authorizes no assistant in a company channel.

## Out of this pack

Server routes, SQL and migrations; the desktop and phone surfaces; email or message delivery (Atum sends none);
per-link channel or project scoping (a link always joins the company as `member`, with the company's default
channel and no project grant); QR codes; link analytics; multi-use links with a per-use identity; link expiry
extension; and an operator view of links. Those are follow-up lanes, not amendments a client may assume.

## Using the fixtures

A provider's tests load `fixtures/`; every `accept` file must be produced or accepted and every `reject` file
must be refused. The `*.trace.json` files are replayed by the reference interpreter in
`spec/_tools/company_workspace_1_2_contract.test.mjs`; a provider's pgTAP or integration suite should replay the
same traces, including both serialisations of every `race` step, against the real function. Client parsers
should use the protocol mirror in `packages/protocol/src/company-workspace.ts`.

A trace step carries the state the DSL needs and nothing secret. A `create` step may carry `maxUses` and
`expiresInSeconds`; the interpreter compares the effective values of a same-actor replay and answers `409` when
they differ. A `redeem` step may carry a **`linkLabel`** — a short trace-local name such as `a` or `b`, never a
token — and two different labels mean the two steps sent different tokens; a same-actor replay with a different
label answers `409`. `linkLabel` carries no bearer material and is not a substitute for real token bytes.

## Open product choices

This pack fixes a shape, not every product answer. Decisions taken in round 2 are marked **decided**; the rest
remain open for the coordinator before S5 ships.

1. **Link host and path.** `https://atum.app/j/<token>` with a client-side handoff. Alternative: a dedicated
   domain, a query parameter, or a fragment-only link. Any change is a new minor pack.
2. **Token re-display.** The token is returned only by the first create answer; a replay returns metadata and no
   `url`, and list never shows it. Alternative: let any active admin re-copy a live link from the list, which
   would require storing the raw token and weaken the "shown once, hashed at rest" guarantee.
3. **Default max uses — decided: 10.** It is one named constant (`DEFAULT_MAX_USES`) in the author source, so the
   owner can change it in one place. Alternatives still available: 1 (single-use link), 25, unlimited (not
   representable here), or requiring the admin to choose every time.
4. **Whether an invitee spends a use.** A person with a pending handle invitation is accepted without spending
   one. Alternative: any successful join through the link spends a use.
5. **Existing member behaviour.** Redeeming while already `active` succeeds with no use. Alternative: refuse with
   the uniform error, or answer a distinct `already_member` code (it is a label in the traces, not a wire field).
6. **Preview authentication.** Preview requires sign-in and shows the company name only after authentication.
   Alternative: a public preview with the company name before sign-in (a bigger disclosure to a link holder).
7. **Who owns a link.** The company does; it survives its creator leaving, and any current active admin can
   revoke. Alternative: links are creator-owned and die when the creator stops being an admin.
8. **Removed people cannot rejoin by link — decided.** A removed or banned person gets the uniform
   `invite_link_unavailable` on every redeem, with no oracle. Only a direct handle invitation from an active
   admin readmits them. Removing a person does **not** revoke other people's links. Alternative: also revoke every
   link on removal, or a post-removal cool-down.
9. **Per-link scope.** A link is company-wide `member` with no project grant and no channel scope. Alternative:
   per-channel or per-project links, which need a wider contract.
10. **Link count and rate — decided: 20 live links per company and 10 creations per admin per rolling hour.**
    The refusals are `409 invite_link_limit_reached` and `429 invite_link_rate_limited`. Thresholds can move
    before release without a wire change; the two reasons are now part of the closed union.
11. **Revocation precedence.** `revoked` (including a retired company) wins over expired/exhausted in the
    displayed state, and revoking an expired/exhausted link records `revoked`. Alternative: keep the terminal
    reason and make revoke a no-op.
12. **Landing page.** A first-party page at `/j/<token>` with no analytics. Alternative: deep-link only, or a
    hosted page with product analytics (rejected here because the token would enter analytics).
13. **List audience.** Any active member may call list; a non-admin gets `links: []`. Alternative: `403` for a
    non-admin, or a member-visible count with no metadata.
14. **Role field.** Create always carries `role: "member"`; omitting it is `400`. Alternative: omit it and let the
    server default, which makes "member only" implicit in the absence of a field.
15. **Full or retired company (narrowed).** On the invitee side a link is unusable and answers the same
    `invite_link_unavailable` once the company is retired or at its member cap; the admin create cap now has its
    own `409` (`invite_link_limit_reached`). Alternative for the invitee side: a specific `409` so the holder can
    ask an admin.
