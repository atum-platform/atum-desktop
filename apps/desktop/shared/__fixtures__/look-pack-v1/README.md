# Look Pack v1 desktop conformance fixtures

Copied without modification from `atum-platform` commit
`8a1ae58663c60e661c1b51e6dba1b6696df6a4cd`, directory
`spec/look-pack/v1/`.

- Frozen `contract.json` PINNED-SHA256:
  `286f5fdd635e66a12e43fb4c2e73497bd908a09b69f06382990671eab84f31d1`
- `assets/moon-gravity-well-atum.svg` SHA-256:
  `7b6e946ecb9cbbe0dd1fe6ea799150b2394694f608f5350223265509d34c62dc`
- `assets/script.svg` and `assets/external.svg` are the frozen unsafe-SVG
  refusal vectors (`3a6d368f…a8b8` and `b72fecfc…b363`).
- `fixtures/moon.published.json` is the frozen published pack.
- `fixtures/acme.submission.json` is the frozen unknown-app submission used
  to prove the renderer has no app-name branch. Tests add only the published
  envelope that L1 would supply.

The source platform worktree is read-only for this lane. Do not regenerate or
edit these copies; update them only by pinning a newer frozen platform commit.
