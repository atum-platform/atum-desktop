# Phone copy export, wave 4j: W4-W Work plan readiness

The phone's Settings › Connections now reads Work plan readiness
(`atum.work-plan-readiness/1`) and shows each plan in one of four states. The phone's
state contract is in atum-mobile-client `docs/ports/w4-w-plan-readiness.md`. This wave
gives the phone desktop-sourced words for those states.

Branch `feat/mobile-export-w4w-readiness`, from desktop main `1003a107`. It is not
stacked on waves 4g–4i, which are still unmerged (PR #135 and `feat/mobile-export-wave4i`).
The base dist is main's, manifest `2f1c4ea3…`, which is also what the phone pins today
(`atum-design.lock`).

## Adopt first: what desktop already had

Desktop does not read readiness. It shows a plan from the registry (`app/connections/view.ts`
`AccountPlanState`: connected, stale, needs_attention, not_connected), and on a Mac you
renew a plan's grant to cloud assistants with the same Connect that first granted it
(`grantAccountPlanUse`). So almost every word the phone needs already exists in
`connectionsCopy` (`app/connections/copy.ts`). Wave 4c mirrored those words into
`mobileScreensCopy.connections` (`src/matrix/mobile-copy.ts`) and exported them.

| Phone state | Row line | Action / handoff | Source |
|---|---|---|---|
| 1. `.connected` (ready before `validUntil`) | `onMacs(names)`, or `lastSeen(names)` when every Mac is stale, or `inCloud` when there are no Mac details | none | existing (wave 4c) |
| 2. `.needsRenew` (`grant_missing`, `grant_expired`, or cached `ready` at or after `validUntil`) | **`needsRenew`** (new) | `connect`, then the connect sheet: `sheet.title(plan)`, `sheet.needsMac`, `sheet.close` | new line, existing handoff |
| 3. `.notConnected` | `notConnected` | `connect`, then the same sheet with `sheet.needsMac` | existing (wave 4c) |
| 4. Readiness unknown (loading or unavailable) | registry lines: `.signedIn` → `onMacs` / `lastSeen` / `inCloud`, `.stale` → `lastSeen`, `.needsAttention` → `needsAttention`, `.notConnected` → `notConnected` | the existing registry action (`connect` for needsAttention and notConnected) | existing (wave 4c) |

All keys are under `src.matrix.mobile-copy.mobileScreensCopy.connections.`:

| Key | Source | en | vi |
|---|---|---|---|
| `needsRenew` | **new in this wave** | Connect again | Cần kết nối lại |
| `onMacs` (`%1$@`) | existing, `connectionsCopy.onMacs` | On %1$@ | Trên %1$@ |
| `lastSeen` (`%1$@`) | existing, `connectionsCopy.lastSeen` | Last seen on %1$@ | Lần cuối trên %1$@ |
| `inCloud` | existing, `connectionsCopy.inCloud` | In the cloud | Trên đám mây |
| `needsAttention` | existing, `connectionsCopy.needsAttention` | Sign in again | Cần đăng nhập lại |
| `notConnected` | existing, `connectionsCopy.notConnected` | Not connected | Chưa kết nối |
| `connect` | existing, `connectionsCopy.connect` | Connect | Kết nối |
| `sheet.needsMac` | existing, `connectionsCopy.sheet.needsMac` | Open Atum on your Mac to connect. | Mở Atum trên máy Mac để kết nối. |
| `sheet.title.plan={codex,claude,antigravity}` | existing, `connectionsCopy.sheet.title` | Connect ChatGPT / Claude / Antigravity | Kết nối ChatGPT / Claude / Antigravity |
| `sheet.close` | existing, `connectionsCopy.sheet.close` | Close | Đóng |

Only `needsRenew` changes the catalog. The rest are already in the pinned snapshot. ja, zh
and zh-Hant repeat the English for every one of these keys, as this table always has
(desktop writes Connections in en and vi only).

## Decisions

- **One new key, `connections.needsRenew`: "Connect again" / "Cần kết nối lại".** Before
  this, the phone's `.needsRenew` row line reused `sheet.needsMac`, the sheet's whole
  sentence. A row line should be a short status like its neighbours. Desktop has no
  renew state. Its nearest words are `needsAttention` ("Sign in again"), but that would
  be wrong here: the plan is still signed in, and only the grant to cloud assistants
  lapsed. On a Mac the fix is Connect, so the new line names that action and follows
  `needsAttention`'s pattern (vi "Cần … lại"). It is defined in `mobileScreensCopy`, not
  in `app/connections/copy.ts`, because desktop never draws this state. A comment marks it
  phone only. Desktop's own UI is unchanged.
- **No new handoff sentence.** The Mac handoff for a renew is the existing connect sheet
  with `sheet.needsMac` ("Open Atum on your Mac to connect."). That is accurate, because
  renewing is connecting on the Mac. A separate "renew on your Mac" sentence would add a
  verb desktop never uses.
- **No "Checking…" word for state 4.** Readiness unknown covers loading and unavailable
  alike. A read that is unavailable for good would leave "Checking…" up forever, so the
  phone keeps the registry's sign-in line, as the contract says. If the UI lane still
  wants a transient spinner label, `shared.matrix-alias-copy.copy.checking` ("Checking…" /
  "Đang kiểm tra…") is already exported. It is the handle checker's word, so reusing it
  is a UI-lane choice.
- **`FIRST_RUN_CONNECTIONS_COPY.inUse` ("{plan} · your assistants use it") is not
  re-exported.** It is the closest desktop words for a granted plan. But wave 4i exports
  it, and that wave is not on main. Exporting it here too would make the two branches
  collide on the same key. The phone can adopt it once wave 4i lands.

## Producer run (reproduction)

The producer is the private atum-app `packages/mobile-design-exports`. This lane left
atum-app untouched and ran everything in a scratch root:

1. Scratch root: `git archive HEAD apps/desktop packages/atum-kit` from this branch, with
   the edited `mobile-copy.ts` laid over it, plus `git archive chore/mobile-export-wave4i-keys
   packages/mobile-design-exports` (atum-app `0e98878e`). Wave 4i is the newest producer.
   Wave 4f's producer (`1615ed8e`) fails on main's tree, because it still requires the
   attention-copy disk keys that `e8ce4357` removed, and wave 4g+ records them as deprecated.
2. Run dependencies, at desktop's lockfile versions: typescript 6.0.3, esbuild 0.28.1,
   @phosphor-icons/core 2.1.1, zod 4.6.6, nanostores 1.3.0, @nanostores/react 1.1.0 and
   react 19.2.7.
3. Producer inputs changed (scratch only):
   - `phone-export-keys.json`: +1 key, `src.matrix.mobile-copy.mobileScreensCopy.connections.needsRenew`,
     inserted after `connections.needsAttention`.
   - `glyph-map.json`: the eight unmapped aliases (Checks, Forward, Laptop, LayoutGallery,
     LayoutGroups, Paperclip, PenNib, UserPlus) got throwaway `circle` entries for the run
     only, as in waves 4e–4i. `glyphs.json` is not spliced, so none of them ship.
   - `wave4w/spec.json`: one family with the one key, plus `"refresh": {}` and `"remove": {}`.
4. `node scripts/export.mjs`: exit 0. `node scripts/export.mjs --check`: exit 0. `node --test
   test/*.test.mjs`: 49 of 49 pass.
5. `node wave4/splice4.mjs <root> <this dist> wave4w/spec.json` →
   `{"added":1,"refreshed":0,"removed":0,"strings":4139}`. The trial splice into a copy came
   out byte-identical to this one.

To move this into atum-app, commit those three input changes on a
`chore/mobile-export-w4w-keys` branch from `chore/mobile-export-wave4i-keys`.

## Result

- Catalog 4138 → 4139 entries. `copy-contract.json` gains one entry (no arguments).
- `copy-inventory.json` is the producer's, as `splice4.mjs` always takes it. It now matches
  wave 4i's inventory byte for byte (`71e8e5df…`), because main's desktop tree has the
  sources that 4g–4i added: the `surfaces` and `matrixShell` i18n scopes,
  `first-run-copy.ts`, `rail-badge-copy.ts`, and the Google write card as an
  English-fallback table. The inventory lists sources only. It adds no keys.
- Copy map and glyphs: unchanged. `schemaVersion` 1, 44 manifest members, and all 44 hashes
  match their files.
- Rekeys and removals: none. On main, the public catalog still carries the three
  attention-copy disk keys, which the producer no longer emits. They are left alone, as
  waves 4g–4i dealt with them on their own branch.

### For the phone repin

- **Manifest SHA-256: `84ef91aab829568005c9338924954c9b4e1226e3a7cfabffe2ad5be32be459a8`**
  (was `2f1c4ea3c95f4b9612817198956306851e2951b123d3873cc851b8d59fa64dc1`).
- `Localizable.xcstrings`: `f0f912430867b79e84483cb9e61980ad85ebe17e3ad762805b986c189b8f87c3`
- `copy-contract.json`: `26333fae05942f0de5f33b1bfbf18de50a623af08ef28801b40ef3df1002fde2`
- `copy-inventory.json`: `71e8e5dff0d0e01b4d2928fa9d3dde53500d392b68307ab6b6d363ef45e1d8bc`
- Phone change: map `AccountPlanLine.needsRenew` to
  `src.matrix.mobile-copy.mobileScreensCopy.connections.needsRenew` in place of `needsMac`.
  Keep `needsMac` in the connect sheet.

### Merge order with waves 4g–4i

Each of those branches and this one adds entries to the same canonical JSON files. Whichever
lands second should re-run `splice4.mjs` with its spec on top of the merged dist. Hand
resolution won't do, because the manifest hashes must come from the spliced files.

## Checks

The desktop checks and the outbound guard results are in the commit message.
