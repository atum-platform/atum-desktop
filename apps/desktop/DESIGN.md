# Atum Desktop design overview

The client presents chats, people, agents, connected services and local execution in one desktop shell. Product copy should describe the action or state a person can understand. Keep transport names and implementation details out of ordinary user flows unless they help the person make a decision.

## Application structure

`src/app` owns routes, pages and page components. `src/store` owns shared state; feature state stays beside its feature. Shared pure helpers live in `src/lib`. Route roots compose the shell and remain thin. Prefer existing primitives and shared stores over duplicate state or deeply threaded props.

The renderer consumes the typed client contracts under `shared/`. Native services under `electron/` own local process, filesystem, credential and device boundaries. Renderer state is not authority to perform a protected native action. Preserve the existing approval, identity and ownership checks.

## Interaction

Keep the active conversation and composer stable across connection changes. Preserve unsent input and show a useful recovery action when a request cannot finish. Use the existing localization keys for all supported locales. Maintain keyboard focus, accessible names and predictable navigation.

Agent presentation and local/cloud placement are distinct. Read execution policy and current lease state for placement; avoid inferring ownership or availability from a display label. Display names and avatar changes must not change the underlying participant identity.

## Verification

Use focused renderer/native Vitest tests for changed behavior and the desktop typecheck for shared contracts. Tests use invented people, devices and endpoints. Service, installed-app and platform boundary checks are separate opt-in validations; a skipped check is not evidence of acceptance. See the repository contribution and security guides for reporting and contribution scope.
