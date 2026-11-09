# `atum.app-catalog/1` transport-mode amendment

- **Status:** frozen additive amendment, 2026-10-28.
- **Protocol release:** `@atum/protocol` 0.7.55.
- **Platform migration:** `0340_app_catalog_transport_mode.sql`.
- **Profiles:** the wire profiles remain `atum.app-catalog/1` and
  `atum.app-workspace/1`; older clients ignore the new field.

## Contract

Every row produced by the authenticated SQL user bot catalog carries
`transport_mode: "legacy_turn" | "bot_api"`. The value comes from
`atum_private.bot_api_apps.transport_mode`, which is also the authenticated
host catalog's source of truth. An app with no authority row is an existing
legacy app and is projected as `legacy_turn`.

The Shell copies that row through `publishedBot` into the signed descriptor at
`descriptor.bot.transport_mode`. A new parser accepts an older catalog with the
field absent and defaults it to `legacy_turn`. A future or malformed transport
value is rejected; it is never guessed into Bot API. Message metadata remains
the authority for Bot API message/photo rendering.

Desktop and phone clients read this field before the room has its first
authenticated `io.atum.bot_api/1` reply. For `bot_api`, the exact direct bot
room uses ordinary Matrix sending and does not show or invoke legacy Start,
consent, Connect, or legacy-turn setup. No room membership, device pin,
message-format trust, provider identity, account merge, or group capability is
granted by the field.

## Registration default and rollback

`atum.bot_api_app_register` inserts a new authority row with
`transport_mode='bot_api'`. `ON CONFLICT DO NOTHING` preserves every existing
row, including an audited `legacy_turn` compatibility exception. Rollback
restores the 0315 registration body and the pre-0339 user catalog body without
deleting or rewriting authority data. Both functions remain service-role only;
PUBLIC, `anon`, and `authenticated` have no execute grant.

Checked by `pnpm verify:app-catalog-contract`, the protocol and Shell catalog
tests, and `scripts/test-app-catalog-transport-mode-native.sh`.
