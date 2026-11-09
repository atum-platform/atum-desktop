# `atum.cloud-home-read/1`: bounded committed cloud-home reads

This frozen data-only pack defines one owner-authorized, cloud-to-Mac read surface. It creates no route, object, lease, upload, delete, merge, writeback, or production read.

## Routes and authority

`GET /api/matrix/v1/agents/{agentPrincipal}/cloud-home` returns the latest committed generation manifest or no home (`204` empty body or `200 null`). `POST /api/matrix/v1/agents/{agentPrincipal}/cloud-home/file` reads one exact manifest-bound file. Both are `no-store` and must activate together; `404`, `405`, or `501` remains the client’s not-shipped capability outcome.

The MAS bearer derives the owner and the route derives the agent. A read is allowed only when the agent belongs to that owner, has a live cloud enrollment, and one current Mac v2 lease belonging to the same owner holds that agent. The request cannot nominate a Mac, executor, term, bucket, key, generation authority, or alternate owner/agent. Foreign agent, home, generation, object and encryption existence are not disclosed.

Malformed requests use `matrix_400/invalid`; a latest committed home whose complete allowed projection exceeds any read bound uses stable `matrix_409/home_too_large`; temporary provider or verification failure uses `matrix_503/unavailable`. Authentication, ownership and not-found behavior keeps the surrounding Matrix API’s closed 401/403/404 forms without distinguishing a foreign agent from a missing home. Failures never return partial manifests or content.

## Committed manifest and immutable file binding

The manifest is the latest committed generation only; staging/orphan object-store data is invisible. Committed home manifests use a `hermes/` root. The read API strips exactly one leading `hermes/` and exposes HERMES_HOME-relative paths; file lookup re-adds that exact prefix before binding the immutable committed entry. The server never substitutes a newer current generation. `content` is canonical standard base64 plaintext; its decoded byte count matches the manifest size, and lowercase SHA-256 matches both response and manifest.

Only `USER.md` and regular non-symlink files below `memories/` or `skills/` are served after prefix stripping. Root `USER.md` is a reserved allowance for a future committed `hermes/USER.md`; it is never synthesized or remapped from `memories/USER.md`. Paths are relative POSIX, at most 512 UTF-8 bytes, with no backslash, NUL, empty, dot, dot-dot, or dot-prefixed segment. The manifest omits disallowed entries. Bounds are 4,000 unique files, 8 MiB each, and 64 MiB total plaintext. If the complete allowed projection exceeds any bound, the entire read is `matrix_409/home_too_large`; it is never truncated.

API paths are byte-exact and case-sensitive. If distinct paths collide under the receiving filesystem’s case or Unicode-normalization semantics, the consumer aborts the whole hydration instead of overwriting, normalizing, or choosing one.

The controller alone decrypts the existing sealed objects and verifies the committed manifest and plaintext digest without symlink traversal. Responses expose no object/storage keys, encryption metadata, lease material, credentials, prompts, unrelated files, or other generation. Logs contain only closed outcomes and counts—never content, path, digest, bearer, lease, or storage location.

## Rollout boundary

The pack defines no home merge/writeback, schedule import, Stop, progress/received records, or production activation. Platform, controller and desktop conformance, a synthetic end-to-end proof, rollback proof, exact-head CI, an explicit owner go, and serialized production receipts are all required before enablement.

Run `pnpm verify:cloud-home-read-contract`.
