# `atum.company-workspace/1.9`: verified-email invitations

Status: frozen additive email-invitation contract. Base:
`atum.company-workspace/1.8` at `8ca943f6bf6b16c2c153246f51b0a64e94326c52c856ad54eb7f878634f2c4c2`. Select it with
`Atum-Company-Wire: 1.9`. Every 1–1.8 message stays byte-identical; only the
messages introduced here use `schemaVersion: 10`.

## Create and privacy

`POST /api/matrix/v1/companies/{companyId}/email-invitations` accepts one
complete email, locale and idempotency UUID. The authenticated owner/admin is
always derived by the server. The response is the same `accepted` envelope
whether the address resolves to an existing account or creates a pending,
email-bound invitation. It contains no email, fingerprint, token, Matrix ID,
profile or account-existence bit.

Directory privacy and invitation resolution are separate facts. A verified
account with discovery disabled is `verified_match` plus
`directoryVisibility: hidden`; it is never converted to `absent`. Only a
complete, authoritative MAS result may be `absent`. Ambiguous, malformed,
truncated, unavailable and unverified results fail closed and remain retryable;
none creates a pending invitation.

## Verified MAS facts

The stock MAS 1.24 user-email resource has no verification or provenance field.
It is therefore not a verified fact by itself. Auto-claim accepts only a
server-produced `mas-verified-email.fact` naming one of three proved paths:
password registration after email authentication, an upstream verified-email
claim, or a privileged assertion made under an operator procedure that provides
equivalent ownership proof. The fact contains an HMAC fingerprint and key
version, never the address.

The deployed Atum config requires password-registration email verification,
imports Google email only behind `email_verified`, and disables self-service
email changes. MAS administrators can nevertheless add an address directly.
Until production proves that privileged path is equivalently verified (or
supplies provenance to this seam), capability discovery reports
`emailAutoClaim: verification_required` and claim returns a retryable
verification-unavailable refusal.

## Claim and legacy links

`POST /api/matrix/v1/email-invitations/claim` accepts only a request UUID. It
derives the current MAS actor, issuer and all eligible verified facts on the
server. Each company settles independently and each invitation appears once.
No email or token is client input.

An email-bound invitation is not a bearer share link. The 1.2 preview/redeem
RPCs must return `email_invite_claim_required`; knowing the legacy token never
bypasses verified-email claim. Ordinary share links retain their 1.2 behavior.

The initial P1 outbox is private and unsent. `mailStatus: accepted` means the
command was durably accepted, not that SES sent mail. P2 owns delivery states,
resend, suppression and sender/feedback behavior.
