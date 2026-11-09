# Company policy 1.2

Use existing administration GET and policy POST with `Atum-Company-Wire: 1.3`
and `Atum-Company-Policy: 1.2`. Extends 1.1 with required `companyInvitations`,
`members` (default, including existing companies) or `admins`. Owners/admins edit
with the existing request ID and authority-generation fence. Old profiles preserve
this setting when updating their own fields. Invite-as-admin remains owner-only.
Admitted channel members may read rosters. Private non-admitted owners cannot.
Channel admission/removal mutation policy and creator exceptions remain as in 1.1.
