# Work runtime 0.1.22 (2026-11-28)

Desktop pins the macOS arm64 Work runtime built from atum-work commit `22b8701ba65f87fcda25de0d2d2ac6e9f904c7d9` on `feat/work-runtime-0.1.16` with Node `26.13.1`. The hosted macOS build and archive smoke test passed. [Archive workflow run 46149039914](https://github.com/atum-platform/atum-work/actions/runs/46149039914)

- Unsent Work drafts refresh to the inherited default model. [atum-work #11](https://github.com/atum-platform/atum-work/pull/11)
- Settled threads no longer light the Work rail dot. [atum-work #12](https://github.com/atum-platform/atum-work/pull/12)
- Cowork-style Work adds a project and folder picker, groups sessions by project, and updates Work wording. [atum-work #13](https://github.com/atum-platform/atum-work/pull/13)
- Stable replay CI runs for fork maintenance. [atum-work #18](https://github.com/atum-platform/atum-work/pull/18)

The workflow artifact `atum-work-v0.1.22-darwin-arm64` contains `atum-work-0.1.22-darwin-arm64.tar.gz` and `SHA256SUMS`. The tarball's pinned SHA-256 is `77a0e923606a4e1f4dee51911eaaa2c4803b9247a12e1a82711be68e8c8ecc27`. Desktop packaging takes the tarball path from `ATUM_WORK_ARCHIVE` and verifies the digest before extracting it.

The downloaded tarball matched `SHA256SUMS`. Desktop staging verified the digest and arm64 executable, wrote `pin.json` for `0.1.22`, and the staged `t3 --version` returned `t3 v0.1.22`. All 46 tests in the bundled runtime and Matrix after-pack suites passed.
