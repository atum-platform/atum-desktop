# Contributing to Atum

Atum is a desktop client and a Hermes-derived agent runtime. Use this repository's [issues](../../issues) and [pull requests](../../pulls) for Atum bugs, changes and documentation. Search existing issues, pull requests and the source before starting a duplicate change. Describe the affected behavior, a reproduction and the result you expect.

## Scope and licences

Read [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD-PARTY.json](THIRD-PARTY.json) before contributing. Atum-owned source is all rights reserved subject to the viewing/forking rights described there. Inherited Hermes and other third-party licences and attribution remain intact. A contribution does not change those grants.

Keep changes focused. Preserve conversation caching, runtime isolation and the existing client/backend contracts. Extend an existing module or plugin interface before adding a parallel mechanism. Avoid unrelated formatting changes and preserve upstream credit.

## Local checks

Use a supported Node version from `package.json` and the pinned Python/uv environment. Install JavaScript dependencies with `npm ci --ignore-scripts`; then run `npm run typecheck --workspace apps/desktop`. Run affected desktop tests from `apps/desktop` with `../../node_modules/.bin/vitest run <changed-test-files>`. Run affected Python tests with `bash scripts/run_tests.sh <test-paths> -j 3`. Read the tests' platform/service requirements before enabling integration checks. Never use production accounts, credentials or user data as test fixtures.

Describe your changes and the checks you ran in the pull request. Distinguish skipped or unavailable checks from passing ones. Release signing, infrastructure, production secrets and publication are outside ordinary contribution checks. The mobile project currently needs Xcode 27; its simulator CI job remains disabled until a standard hosted image provides that toolchain.

## Security

Do not open a public issue containing a vulnerability or credentials. Use [private vulnerability reporting for this repository](../../security/advisories/new) or **security@atumplatform.com**. See [SECURITY.md](SECURITY.md).

## Upstream credit

Atum is derived from [Hermes Agent by Nous Research](https://github.com/NousResearch/hermes-agent). Preserve its MIT notice and third-party notices when changing inherited code. Atum-specific contributions and support stay in this Atum repository.
