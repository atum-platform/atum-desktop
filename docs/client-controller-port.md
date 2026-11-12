# Company SDK interoperability

The company SDK exposes authenticated Matrix user IDs with human history entries. Content fields and display names do not determine attribution. Completed dialogue remains the only continuity seed.

The shared model grant registry admits native company v2 grants with explicit request and concurrency bounds while retaining company wallet, alias and source restrictions. Native profiles remain unavailable to locally minted grants.

The shared presentation publisher identity aliases the renderer turn identity. Publisher operations are additive; strict parsing, sender binding, terminal memory and expiry rules remain intact.

Contract packs remain under `apps/desktop/contracts` because consumers import the cleanup helper there. Contract fixtures use synthetic hexadecimal UUIDs. Upstream documentation with restricted operational paths is omitted from the cleanup pack, and its vendor manifest lists only retained files. Missing renderer rejection vectors are restored alongside the existing agent-turns vectors.

Verification: nine focused desktop suites pass (1,022 tests); canonical JSON passes (72 tests); model grants pass (12 tests), including v2 admission boundaries. Desktop typecheck and the app suite require the declared markdown rendering dependency to be present in the dependency environment. No dependencies were installed. All changed TypeScript, including retained vendor helpers, passes ESLint. Vendor manifests record formatting adaptations. The outbound guard passes with the base branch policy.

This change requires a new consumer source pin before use. Source tree, manifest digest, desktop producer and public dependency digests must be regenerated together. Client copies in other source trees must no longer override the pinned modules. Local assembly audits do not satisfy protected-branch or remote status gates.
