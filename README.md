# Atum Desktop — source-visible code

Atum-owned code is all rights reserved. No licence is granted beyond the
viewing and forking rights required by GitHub's terms for public repositories.
Inherited Hermes code remains MIT-licensed, including inherited portions of
modified files. Every other third-party licence and its notices are preserved.
See LICENSE, NOTICE, LICENSES/ and THIRD-PARTY.json. This is source-visible,
not an open-source licence.
This repository contains the published source for Atum Desktop.

Desktop checks: from the root install dependencies with `npm ci --ignore-scripts`,
then `npm run typecheck --workspace apps/desktop`. Run focused tests with
`npm exec --workspace apps/desktop -- vitest run --project electron shared/matrix-assistant-name.test.ts shared/app-bot-status.test.ts`.
The public model-client workspace supplies the local broker boundary.

Deployment configuration must be supplied
by the integrator. No production configuration is provided by this tree.

For Atum issues and contributions, use this repository's [issue tracker](../../issues) and [contribution guide](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

Atum is derived from [Hermes Agent by Nous Research](https://github.com/NousResearch/hermes-agent); inherited licence and attribution remain preserved.
