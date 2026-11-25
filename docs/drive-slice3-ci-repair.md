# Drive slice 3 CI repair

Built locally, not live. Merged latest main into the feature branch before the pin repair; merge assembled without conflicts. Retained-source verification still reproduces local_brain_package_invalid after the merge. No push, CI rerun or deployment.

The vendored service and state files changed while their retained public hashes still described earlier bytes. Refreshed only those two hash/size entries to the checked-in public source; source-only schema and release refusal remain enforced. No archives belong to this public projection.

Verification: Node 22 retained-source verification and release-preparation refusal passed (exit 0). scripts/stage-local-brain.test.mjs passed all 12 tests with Vitest 4.0.18 and a minimal Node-only config (exit 0). Fresh fetch followed by python3 scripts/public_guard.py --base origin/main --head HEAD passed (exit 0): nine new commits; raw paths/modes, ancestry, identifiers, secrets and metadata checked.
