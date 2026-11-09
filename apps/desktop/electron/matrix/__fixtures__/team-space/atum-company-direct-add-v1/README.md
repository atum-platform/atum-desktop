# Company direct add (company-workspace/1.12)

An owner or admin (and a member, when the company policy allows) adds an existing Atum person to a company
**directly**. The person does not accept. SQL authority: migration 0409. Opt in with `Atum-Company-Wire: 1.12`;
every earlier wire and profile is byte-identical and does not see these routes (404).

| Route | Purpose |
|---|---|
| `GET  /api/matrix/v1/companies/{companyId}/member-add` | What the caller can do here (readiness) |
| `POST /api/matrix/v1/companies/{companyId}/member-add` | Add a person |

Install-level signal: `GET /api/matrix/v1/company-capabilities` with `Atum-Company-Wire: 1.3` and
`Atum-Company-Invites: 3` (`spec/company-invites/v3`) carries `directAdd: ready | inactive`.
The setting: `directMemberAdd` in company-policy/1.3 (`spec/company-policy/v1.3`).

## Default and rule

`directMemberAdd` defaults to **`members`**, for new and existing companies:

- owners and admins always add directly (only an owner may add an `admin`; a member never grants admin);
- a member also adds directly, but only while `companyInvitations` is also `members`. Direct add is never wider than
  invitation, so with `companyInvitations: admins` a member can neither add nor invite;
- a company that wants adds to stay with owners and admins sets `directMemberAdd: admins`. A member who the
  invitation policy allows then **invites**, and the person accepts, exactly as before (`invite_only`).

The default follows Mattermost, where every member holds the Add Team Members permission and an admin can restrict it
to team administrators; Slack likewise lets members invite by default and lets admins restrict it (below).

## Readiness (GET)

`directAdd`: `allowed` (may add), `invite_only` (may invite, may not add), `not_allowed` (neither).
`assignableRoles` is what an add or invitation may grant this caller (`["member"]`, or `["member","admin"]` for the
owner; empty when nothing is allowed). `rosterRemaining` is how many more people the company can take (limit 100).
Any active member may read it; a non-member gets the usual `matrix_403`.

A desktop shows **Add** when capabilities say `directAdd: ready` and readiness says `allowed`, shows **Invite** when
readiness says `invite_only`, and neither otherwise.

## Add (POST)

Request: `{requestId, target, role}`. `target` is `{kind:"matrixUser", memberMatrixUser}` (a Matrix ID taken from
directory results; `role` is `member` or `admin`) or `{kind:"email", email, locale}` (`role` is `member` only: the schema
rejects an email/admin request, as the route does). The client never sends a principal.

### Request IDs

`requestId` is reserved for **every** completed answer, not only `added`, in one namespace shared by both target kinds.
The receipt stores the full normalized input (target kind and value, role; an email target by its keyed fingerprint,
never the address). Then:

- the same input again returns the stored answer with `replayed: true`, and never mutates, whatever changed in between
  (a policy that opened, a person who was removed, room that appeared in a full roster). To retry after a refusal that
  has since cleared, send a **new** `requestId`;
- any change under the same ID (a different person or address, a switched target kind, a different role) or the same
  ID from another caller is a `matrix_409` (`invitation_changed_input`), including when two callers race on one ID;
- replaying a receipt needs the caller to still be an active member of the company.

Every answer below carries `replayed`.

The answer is HTTP 200 with one `outcome`:

| outcome | meaning |
|---|---|
| `added` | The person is now an active member (admission epoch advanced, authority generation bumped, a history row recorded as an already-accepted invitation by the actual adder with the admitted role, an audit row written). A pending invitation for the person is converted: it stays in history as `superseded` with its own inviter and role and points at the add, the membership takes the add's role (within the adder's ceiling) and does not grow the roster. A removed person is added back with a new admission epoch. |
| `already_member` | Already active. Names the member. |
| `invited` | Email target only: see below. |
| `not_allowed` | `admins_only`: policy says the caller invites instead. `owner_only_role`: only the owner adds an admin. |
| `roster_full` | The company is at 100 people (active, invited or being removed). |
| `unknown_user` | No addable person. See below. |

The caller's own authority is decided before the target is looked at, so a caller who may not add learns nothing
about anyone: `not_allowed` is identical for a real and a made-up Matrix ID.

## Account-existence privacy

- `unknown_user` is deliberately one answer for: no such person, a person outside this company's identity
  issuer, a person at their own limit of 10 companies, and a person mid-removal. It carries no detail field.
- `roster_full` depends on the company only, never on the target, so it cannot be used to probe whether a person exists.
- The caller's authority is decided before the target is looked at, and the refusal takes no target-dependent lock.
- **Same lock set for every target.** After authority passes, the server takes the same locks in the same order for a
  real person, an ID that resolves to nobody, a person at their limit and a person mid-removal: two request locks, one
  person-keyed advisory lock (the person's principal when the ID resolves, a key derived from the requested ID when it
  does not), the company row, and one membership-row statement of identical shape. Person before company is the
  existing admission order, so concurrent admissions of the same person from different companies still serialize.
  **Recorded and accepted** (coordinator, 2026-11-06, PR #801 round 2): arbitrary Matrix-ID probing remains supported
  (the ID normally comes from directory results). The accepted residual is latency only: while another company is
  changing that same real person's membership at that moment, a probe of that real person can wait where a probe of a
  missing ID does not. It is inherent to keeping the 10-company cap consistent. It can be observed passively as well as
  by a prober who controls the competing operation, no reliable remote inference was demonstrated, and it is not padded away.
- An **email target never adds** and **never looks the address up**. There is no MAS call, no verified/unverified branch
  and no account-dependent branch anywhere on this path, so status, body and timing class are the same for an address
  with an account, one without, and one MAS cannot verify. The address is queued as an address-bound invitation; identity
  is verified at claim (see `spec/company-invites/v2`). The `invited` answer has the same shape every time. An email
  target needs the invitation policy to allow the caller (`not_allowed` otherwise) and is subject to the email limits.
  (The older wire 1.9 `email-invitations` route behaves the same way since PR #801 round 2: it no longer resolves the address either.)

## Budget

A caller may create **120 new request IDs per hour** (fixed hourly window, per actor, on `atum.check_rate_limit`), because
every completed answer, a refusal included, stores a receipt. Replays of an existing ID are free and still conflict on
changed input, at the limit as well. Over the budget the answer is `matrix_429` with `details.reason: member_add_limited`
and `Retry-After`; it is raised before the target is looked at (so it is identical for a real and an unknown target),
writes no receipt and is not itself counted. Old receipts are never deleted, so an old ID cannot be reused to mutate.

## Legacy wire 1.9 email route

`POST /companies/{id}/email-invitations` (wire 1.9, `spec/company-workspace/v1.9`) used to look the address up through
MAS and answered 503 for an unverified match and 200 for an absent address. Since round 2 it never looks the address up:
every address is queued as an address-bound invitation and the response bytes are unchanged. An existing account now
receives the address-bound mail and claims it at sign-in (when verified-email claim is active) instead of getting a
directory invitation plus a notice mail.

## Notification

No new notice channel. The added person gets what an accepted invitation gives: the company appears in their company
list, and the channel/room reconcilers (which key off the admission epoch and authority generation 0409 advances) invite
them to the default channels. The history row names who added them. Push or mail for "you were added" is not part of this
version.

## Research (patterns only; nothing copied)

- Mattermost: adding members is a permission, `Add Team Members`, held by every member by default and removable per
  scheme so only Team Administrators add; the add is direct (the person joins without accepting). Its team settings also
  carry an open-invite switch and an allowed-email-domain list. CVE-2025-3446 (a user able to invite non-guests could add
  guests) is why an admin-grade role stays owner-only here even when members may add.
  <https://docs.mattermost.com/administration-guide/onboard/advanced-permissions>,
  <https://support.mattermost.com/hc/en-us/articles/51691053955988-Restricting-Team-Email-Invitations-to-Team-Administrators-Only>,
  <https://docs.mattermost.com/end-user-guide/collaborate/team-settings.html>,
  <https://nvd.nist.gov/vuln/detail/CVE-2025-3446>. (Mattermost server is AGPL: read for patterns only.)
- Slack: who may invite is a workspace setting (members by default; owners and admins can require admin approval);
  guests are invited by owners and admins only. <https://slack.com/help/articles/115004854783>,
  <https://slack.com/help/articles/201330256>.
- Conclusion: one company setting whose default follows Mattermost (members add) and that a company can restrict to
  admins, a role ceiling (members never grant admin), and an invitation path that keeps working for everyone else.
