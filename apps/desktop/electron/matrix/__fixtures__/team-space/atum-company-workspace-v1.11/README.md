# `atum.company-workspace/1.11`: funded-wallet leave refusal

Status: frozen additive leave-error contract. Base:
`atum.company-workspace/1.10` at `b80919b5cd99f2a24e2cc525e6f03ad49a1c8a801efde0a2ccf14fa02e0c36d3`. Select it with
`Atum-Company-Wire: 1.11` on the leave route only.

## Refusal

When the authenticated person is the company's last active member and the
company wallet has any balance or open hold, leaving is refused with HTTP 409:

```json
{"error":"matrix_409","details":{"reason":"company_wallet_not_empty"}}
```

The code is terminal for that leave attempt. The client should keep the person
in the company and explain that the company wallet must be emptied first.

## Compatibility

Successful leave answers keep the 1.1 `schemaVersion: 2` body. The existing
named `last_admin` refusal and every plain Matrix error body are unchanged.
Frozen 1.1 clients are not widened: they still receive a plain `matrix_409` for
this new database refusal. No non-leave route selects 1.11.
