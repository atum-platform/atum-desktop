# Invite readiness profile 1

GET `/api/matrix/v1/company-capabilities` with `Atum-Company-Wire: 1.3` and
`Atum-Company-Invites: 1` returns `schemaVersion: 1`, `directoryInvite`,
`emailInvite`, `emailCreation`, `emailDelivery`, `inviteLink`, and `emailAutoClaim`. Ready means server configuration
permits the operation, subject to current company policy and per-request authority.
Inactive means team administration is disabled. Not configured means prerequisite
configuration is missing. Directory uses wire 1.10, email uses 1.9, links use 1.3.
Email creation readiness validates the feature flag, encryption key, fingerprint key,
MAS adapter and invite pepper. Email invite reports `delivery_unavailable` when
creation is configured, because this revision has no sender. `emailDelivery` is
`not_implemented`. A desktop must not present queued acceptance as delivered mail.
No new Company wire or protocol package version is needed.

Email create accepts an address, locale, and request ID. Its `accepted` response
means durable acceptance, not delivery or membership. Existing verified accounts
get pending directory invitations. Unknown addresses get an email-bound link and
encrypted outbox. Delivery and claim are separate states. Email-bound tokens never
redeem through ordinary share-link redemption. Automatic claim requires a proven
server-issued verified email fact and remains verification_required in production
source. No email, bearer, fingerprint or account-existence result is returned.
