# Invite readiness profile 2 and email-invitation mail state

Successor to profile 1 (frozen, unchanged). A client that sends `Atum-Company-Invites: 1` gets
the old bytes, including `emailDelivery: "not_implemented"`. A client that wants real delivery
state sends `Atum-Company-Invites: 2`.

## Capabilities (GET `/api/matrix/v1/company-capabilities`, wire 1.3, invites 2)

`schemaVersion: 2`. `emailDelivery` is `ready` when the SES sender is configured, else
`not_configured`. `emailInvite` is the one field a desktop checks before offering the email method:

| value | meaning |
|---|---|
| `ready` | creation ready, sender configured, and automatic claim active |
| `delivery_unavailable` | creation ready, sender not configured |
| `verification_required` | creation and sender ready, automatic claim not active |
| `inactive` / `not_configured` | team administration off / creation prerequisites missing |

`emailAutoClaim` stays `verification_required` until the MAS verified-email provenance gate is
closed (see the 2026-11-06 invite-email session log). Until then `emailInvite` is never `ready`.

## Mail status (GET `/api/matrix/v1/companies/{companyId}/email-invitations/{invitationId}`)

Wire 1.9 plus `Atum-Company-Invites: 2`. Authority: the inviter who created the invitation, or an
owner/admin, and the caller must still be allowed to invite. `invitationId` is the id returned by
create. Unknown ids and unauthorized callers receive the same refusal.

`mailStatus`: `queued` (accepted, not yet handed to the mail provider), `sent` (the provider accepted
it; this is not inbox delivery), `failed` (`failure`: `rejected`, `exhausted` after 5 attempts, or
`unconfirmed` when the outcome was unknowable and the system deliberately did not resend),
`cancelled` (claimed, revoked or expired before sending). `sentAt` is epoch seconds when sent.
A failed invitation frees the address: create again with a new `requestId`. An existing-account request that
needs no mail (already a member, roster full) reads `cancelled`. A repeat request for an address with a pending
invitation returns that invitation (`replayed: false`, no new mail) whether or not the address has an account.

The response never carries the address, token or fingerprint, and is identical in shape for an
address that already has an Atum account (which receives a token-free notice mail) and one that does not.
Create's `mailStatus: "accepted"` stays a durable-acceptance acknowledgement, not a delivery claim.

## Join page and recovery flow (`https://<account origin>/j#<token>`, public)

Link form: the token is in the URL **fragment** (`/j#<token>`), so it is never sent to a server or hosting log.
Share links (`link.url` of company-workspace/1.2 create) and email invites both use it. The schema accepts the
older `https://<host>/j/<token>` form too (already-issued links); the page lifts the token out of that path and
immediately rewrites the address bar to the fragment form, never logging it. The company-workspace/1.2 pack
(`spec/company-workspace/v1.2`, pinned) still describes the path form; this pack supersedes only that URL shape.
`atum://join/<token>` is unchanged.

Localized (vi default, en) by `Accept-Language`, or `?lang=en|vi` on first load (the in-page switch is client-side
and keeps the fragment). The page reads the fragment in the browser and asks one content-free question,
`POST /j/lookup` with `{"token": "..."}` in the **body** (`share` | `email` | `unavailable`; rate limited per source
and in aggregate, 429 on excess, which shows the neutral page), and shows:

1. `share` link: **Open in Atum** (`atum://join/<token>`) and **Download Atum**. The desktop previews and asks.
2. `email` invite: the same two actions, plus: sign in or create an account with the address the invite
   was sent to. The server adds the account only if that address is verified and matches; the bearer
   token itself never joins anyone (email-bound tokens refuse ordinary redemption).
3. `unavailable`: expired, revoked or used. Ask the sender for a new invite. No detail about why.
4. Lookup failure: the neutral page (1) is shown, never a false "expired".

Finite post-install recovery, with no hidden storage: installing Atum does not carry the token. The
page instructs the reader to return to the same link (the email, or wherever it was shared) and press
**Open in Atum** again. There is no server-side or clipboard copy of the bearer; a clipboard or
paste-field handoff, if the desktop adds one, must be an explicit user action (S3b).
