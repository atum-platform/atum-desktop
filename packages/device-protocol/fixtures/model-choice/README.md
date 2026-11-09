# `atum.model-choice/1.3`: destination/source choice and daily cap

- **Base:** `atum.model-choice/1.2`, pinned `5e687bef3c3d9b28e1ce1471b048fd3c01728377ccbae55990c774a7e6a5ab09`; every 1.2 fixture is carried byte for byte.
- **Scope:** contract-first records only. Desktop, phone, Shell, admission and gateway consumers land separately.

## Destination choice

The server stores one choice per agent and destination. A destination is `cloud` or `mac:<device-service-id>`. Cloud accepts only `source: atum`; ChatGPT-plan and own-key sources are local to a Mac and no credential crosses this contract. The owner and agent are derived from authentication and route binding. The same revision-fenced server record is read and written by desktop and phone, so startup never overwrites another device's choice.

Sources are `atum`, `chatgpt_plan`, or `own_key:<provider>`. Secrets stay in the Mac's existing custody. If a choice is absent or unavailable, the consumer uses the server recommendation and says so; it never silently changes the billing source.

The normative rule is one choice per destination, even when two entries differ in source or model. The generic pack check's `unique` keyword catches only byte-identical entries; protocol consumers must also enforce uniqueness by the `destination` field, as the TypeScript mirror and reject fixture do.

## Daily cap

The default is 200,000 Protons per agent per day; 0 means uncapped and always reports `normal`. Only Atum-billed spend counts. The day resets at 00:00 `Asia/Ho_Chi_Minh`. For a non-zero cap, spend below 80% is `normal`, spend from 80% through below 100% is `warning`, and spend at or above 100% is `exhausted` after the in-flight call finishes. The agent posts one quiet notice at 80%; on exhaustion the turn ends gracefully with what it has, later turns refuse plainly, and routines skip with a recorded reason. None of these states is `couldnt_confirm`.

The `daily_cap` state machine records the one-time warning, exhaustion after a call, and reset. Execution refusal reasons belong to the later `cloud-execution/1.10` contract.
