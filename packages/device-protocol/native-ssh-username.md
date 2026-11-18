# Native SSH username contract

The public username projection in `fixtures/native-ssh-username-v1.6.json` carries the authoritative 1.6 schema, positive/negative cases, source commit and full source pack digest. The public desktop shared package has no native-registry 1.3 consumer. Its legacy 1.1/1.2 frame packs keep their current pins.

Accept exact-case ASCII `[A-Za-z_][A-Za-z0-9_-]{0,31}` on enrollment and native route metadata. Preserve uppercase, including NM. Reject whitespace, newline, shell syntax, path syntax, Unicode, leading digits/options, empty values and values longer than 32 characters.

Validation runs from this package with `../../node_modules/.bin/vitest run test/native-username.test.ts canonical.test.ts` and `../../node_modules/.bin/tsc -p . --noEmit`. The 15 projection cases and existing vendored pack pins pass (87 assertions). The desktop native SSH adapter suite passes 78 assertions. The desktop native SSH adapter already covers case preservation in its own suite.

Release the compatible controller validator before activating uppercase enrollment at the authority, then release the desktop adapter and verify enrollment plus fresh discovery end to end. Local artifact validation is complete. Live release verification remains pending.
