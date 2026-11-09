# Invite readiness profile 3

Successor to profile 2 (frozen, unchanged). A client that sends `Atum-Company-Invites: 1` or `2` gets the
old bytes. A client that wants the direct-add signal sends `Atum-Company-Invites: 3`
(GET `/api/matrix/v1/company-capabilities`, `Atum-Company-Wire: 1.3`).

`schemaVersion: 3` is profile 2 plus `directAdd`: `ready` when team administration is active on this
install (so company-workspace/1.12 `member-add` is served), else `inactive`. It is install-level only.
Whether this caller may add in a given company is the per-company readiness read
(`spec/company-direct-add/v1`): the policy and the caller's role decide that, not the install.
A desktop offers "Add" when `directAdd` is `ready` and the company readiness says `allowed`, offers
"Invite" when it says `invite_only` (and `directoryInvite` is `ready`), and offers neither when `not_allowed`
or the install is `inactive`.
