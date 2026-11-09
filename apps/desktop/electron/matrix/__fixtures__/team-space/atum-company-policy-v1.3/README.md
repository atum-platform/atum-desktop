# Company policy 1.3

Use the existing administration GET and policy POST with `Atum-Company-Wire: 1.3` and
`Atum-Company-Policy: 1.3`. Extends 1.2 with required `directMemberAdd`: `members` (default, including
existing companies) or `admins`. It governs company-workspace/1.12 direct add (`spec/company-direct-add/v1`).

- `members` (default): a member also adds directly, but only while `companyInvitations` is also `members`
  (direct add is never wider than invitation). With `companyInvitations: admins` the effective rule is `admins`.
- `admins`: only owners and admins add a person directly. A member who the invitation policy allows still
  invites, and the person accepts as before.
- Adding an `admin` stays owner-only under both values.

Owners/admins edit with the existing request ID and authority-generation fence. Profiles 1.1 and 1.2 keep
working and preserve this setting when they update their own fields. Owners and admins can always add
directly; there is no setting that turns that off.

The default follows Mattermost, where every member holds Add Team Members; a company that wants adds to stay with
owners and admins sets `admins`.
