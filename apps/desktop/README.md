# Atum Desktop

Atum Desktop is the Electron client in this source tree. Its renderer uses React and shared client contracts; native services and the Hermes-derived runtime are separate boundaries.

From the repository root, run `npm ci --ignore-scripts` and `npm run typecheck --workspace apps/desktop`. From this directory, run `../../node_modules/.bin/vitest run <test-files>` for affected tests. Integration tests declare their own platform and service requirements. Do not supply production credentials or user data to tests.

See the [root README](../../README.md), [contribution guide](../../CONTRIBUTING.md), [security policy](../../SECURITY.md) and [design overview](DESIGN.md). Use this Atum repository for Atum issues and pull requests. Release signing and deployment are separate maintainer operations.

Atum derives from [Hermes Agent by Nous Research](https://github.com/NousResearch/hermes-agent). Its inherited MIT notice and other third-party notices remain in [LICENSES](../../LICENSES/) and [THIRD-PARTY.json](../../THIRD-PARTY.json); Atum-owned code retains the scope stated in [LICENSE](../../LICENSE).
