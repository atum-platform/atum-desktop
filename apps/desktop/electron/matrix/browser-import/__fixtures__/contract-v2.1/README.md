# Contract conformance fixtures (copied byte for byte)

These are the platform's own conformance data for the browser-import contract, copied unchanged so the desktop
is held to exactly what the controller and the platform are held to. Do not edit, reformat or hand-write them
(`prettier --write` on this folder rewrites them: the root `.prettierignore` covers a run from the repo root, and
`contract.test.ts` checks every file against `SHA256SUMS`).

| Files | Source in `atum-platform` | Pack pin (`PINNED-SHA256`) |
| --- | --- | --- |
| Everything except the next row | `spec/cloud-execution/v2.1/fixtures/<same name>` | `ece15ff7a401021390346f614a39a0d7854a5e3a8ff66d1f3d8ee952e732211c` (`atum.cloud-execution/2.1`) |
| `device-service-v3.signatures.vectors.json` | `spec/device-service/v3/fixtures/signatures.vectors.json` | `3b91faa104672cf761b3109b653807c9ebc430dc9a695714b5e94972864bd513` (`atum.device-service/3`) |

Taken from PR #654 (`feat/browser-import-contract`, commit `b849d062`, protocol 0.7.36). Only the files the desktop
needs are here: the known-answer vector, the accept and reject bundles and envelopes, the cookie-site-filter cases,
the recipient-key cases, the 20 admission cases, and the `device-service/3` signature vectors.

To refresh after the contract changes: copy the same names again from the new pack, run
`shasum -a 256 *.json > SHA256SUMS` here, and run the tests; they will say what moved.
