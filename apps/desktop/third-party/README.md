# Open-source notices (FD3)

The Atum app ships one open-source notice, `Contents/Resources/licenses/THIRD-PARTY-NOTICES.txt`,
next to the licence texts it refers to. Settings › General › Legal › Open-source licences opens it
in a window of the app. This folder holds what the notice is made from. Only `licenses/` ships.

| Path | Ships | What it is |
| --- | --- | --- |
| `licenses/texts/` | yes | Standard licence texts: GPL-2.0, GPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0, Apache-2.0, CC0-1.0, MIT, MPL-2.0, OFL-1.1, Unicode-3.0 |
| `licenses/engine/` | yes | Licence files of the Drive engine's bundled libraries and of the code built into its own libraries, as each project ships them, and `qt-third-party.txt` |
| `licenses/app/` | yes | Hermes Agent (the base of the app and the agent) and the frameworks Electron adds to `Contents/Frameworks` (Squirrel.Mac, Mantle, ReactiveObjC) |
| `licenses/runtime/python/` | yes | The libraries python-build-standalone builds into the bundled Python |
| `licenses/local-brain/` | yes | Bun (compiled into the `gbrain` binary) and PostgreSQL (inside PGlite) |
| `licenses/rust/` | yes | Generated: the licences of every Rust crate in a shipped Rust build (`scripts/rust-crate-notices.mjs`) |
| `engine-components.json` | no | The engine's components: which bundle files each covers, its version, licence, copyright, source (with the exact archives for the LGPL libraries) and licence texts |
| `app-components.json` | no | The rest of the app: its base, every `Contents/Frameworks` entry, the Rust notices of npm packages, and the bundles under `Resources` with the versions they must have |

`matrix-builder.json` and `matrix-release-builder.json` copy `licenses/` to `Resources/licenses`
(`mac.extraResources`). `scripts/matrix-after-pack.mjs` then runs `writeThirdPartyNotices` from
`scripts/third-party-notices.mjs`, which writes into that folder:

- `THIRD-PARTY-NOTICES.txt` (UTF-8 with a byte-order mark, so the in-app window reads it as
  UTF-8), opening with the written source offer, in five sections: the Drive engine (its source,
  how to replace its LGPL libraries, and every bundle item), Electron with Chromium, FFmpeg and
  the rest of `Contents/Frameworks`, the app (Hermes Agent and the npm packages), the bundles
  under `Resources` (`runtime/`, `local-brain/`), then every referenced licence text in full. The
  `rust/` notices are named, not repeated, because of their length.
- `electron/LICENSE.electron.txt` and `electron/LICENSES.chromium.html`, copied from the installed
  `electron` package. electron-builder deletes both from a macOS app. The script refuses to copy
  them unless that package is the `electronVersion` being packaged.
- `third-party-notices.json`, the inventory: the engine items and revision, the
  `Contents/Frameworks` entries, the bundles and the licence files they ship, the npm packages,
  and the SHA-256 of the notice and of every licence text.

`assertThirdPartyNotices` checks the result. It runs in three places: after packing (after-pack),
on the packaged app before release (`writeMatrixCandidateLicenseInventory` in
`release-matrix-mac.mjs`), and in the release receipt (`npm run matrix:audit:ship`, issue
`third_party_notices_invalid`). A package fails the check if the notice is missing, edited or
stale, if a licence text is missing or changed, if Electron's notices are missing, if the staged
engine or `Contents/Frameworks` has any entry the inventory does not cover, or if a licence file a
bundle ships is gone.

## What decides the contents

- **Drive engine.** Every entry of `AtumDriveEngine.app/Contents` must match exactly one
  component pattern in `engine-components.json`: each `MacOS`, `Frameworks` and `Resources`
  entry, and every file under `PlugIns`. `Info.plist`, `PkgInfo` and the code signature are not
  components. Every pattern must also match something. The catalog is pinned to the engine's
  `sourceCommit`, so a different engine revision refuses the package until the catalog has
  been reviewed. The versions come from `.craft.shelf` in the engine source, checked against the
  shipped libraries' install names and current versions (`otool -L`). Code compiled into the
  engine's own libraries (QProgressIndicator, the Font Awesome and Remix Icon fonts) is listed
  under `includes`.
- **The LGPL libraries (Qt, GLib, libintl).** KDE Craft patches Qt's qtbase, so each LGPL
  component names its exact sources as `sourceArchives`: assets of the `drive-engine-0.18`
  release of `atum-platform/atum-drive-companion`, with their SHA-256 (the upstream tarballs,
  which match what Qt and GNOME publish, and GNU's signature for gettext; plus the Craft recipes
  and patches). The notice gives the steps to replace one of them in an installed app: replace,
  re-sign the engine ad hoc, update `sha256` and `bundleSha256` in
  `Resources/drive-engine/manifest.json` (the check in `electron/matrix/drive-engine.ts`), and
  re-sign Atum ad hoc. `BUILDING.md` on that repository's `main` gives them as commands.
- **`Contents/Frameworks`.** Every entry must match exactly one framework in
  `app-components.json`, the way the engine's items do. Electron's own framework and the helper
  apps are covered by Electron's notices. `app-components.json` also pins the Electron version,
  with the Chromium and FFmpeg revisions it names, to the one being packaged.
- **Code adapted into `app.asar`.** `base.includes` in `app-components.json`
  records source incorporated into Atum itself, pinned to an exact revision with
  its licence and relevant NOTICE files. These files are printed with the app's
  notices and their digests are audited like every other referenced text.
- **Bundles under `Resources`.** A bundle of `app-components.json` is listed when its folder
  exists. Its `pins` must match what was staged (`runtime/runtime-manifest.json`,
  `local-brain/pin.json`), and the files it names (`shippedFiles`, `files`) must be there, so a
  new Python, Node.js, agent-browser, Chromium or GBrain refuses the package until the catalog is
  reviewed.
- **npm.** The packages are the production dependency closure of `apps/desktop` in
  `package-lock.json`, plus every package the Matrix build bundled. The build records the
  bundled packages (`build-matrix-candidate.mjs`) as `matrix-bundled-packages.json` in `app.asar`,
  taken from the Vite module graph (CSS included) and the esbuild metafiles. That second set
  catches devDependencies that end up in the bundle, such as `matrix-js-sdk` and `openid-client`.
  Each package's own `LICENSE*`, `LICENCE*`, `COPYING*` and `NOTICE*` files are copied word for
  word, and each distinct text is printed once. A package with no licence file may rely only on a
  standard text that names no copyright holder (MIT, Apache-2.0, MPL-2.0, CC0-1.0); any other
  licence without a licence file refuses the package. Packaging is also refused if a package is
  missing, at a different version than the lockfile, or has no licence information.
- **Rust.** `rust/` holds the crate notices of `@matrix-org/matrix-sdk-crypto-wasm` (in
  `app.asar`) and agent-browser (in `runtime/`). A shipped npm package at another version than
  its notice refuses the package.
- **Qt.** `engine/qt-third-party.txt` lists the third-party code built into the Qt modules the
  engine ships, taken from the `qt_attribution.json` files of qtbase and qtdeclarative at
  `v6.11.1` (MD4C and WebGradients included). It leaves out three kinds of code: code the build
  takes from separately bundled libraries instead (zlib, libpng, FreeType, HarfBuzz, PCRE2,
  BLAKE2), modules the engine does not ship, and code for other platforms.

## Where the texts come from

Each file is copied word for word:

- `texts/GPL-2.0.txt`: `COPYING` of the engine source.
- `texts/LGPL-2.1.txt`: GLib 2.86.0 `COPYING`.
- `texts/GPL-3.0.txt`, `LGPL-3.0.txt`, `CC0-1.0.txt`, `Unicode-3.0.txt`: `LICENSES/` of qtbase
  `v6.11.1`.
- `texts/MIT.txt`: the SPDX MIT text. `texts/MPL-2.0.txt`: mozilla.org. `texts/OFL-1.1.txt`:
  openfontlicense.org. `texts/LGPL-2.0.txt`: `Source/JavaScriptCore/COPYING.LIB` of oven-sh/WebKit
  at the commit Bun 1.4.2 pins.
- `texts/Apache-2.0.txt`: libre-graph-api-cpp-qt-client `v1.0.7` `LICENSE`.
- `engine/*`: each project's licence file at the tag named in `engine-components.json`
  (`remixicon-License.txt`, `fontawesome-LICENSE.txt` and `qprogressindicator-LICENSE.txt` from the
  engine source tag).
- `app/*`: Hermes Agent's `LICENSE`; Squirrel.Mac, Mantle and ReactiveObjC at the commits Electron
  `v44.10.1` pins in its `DEPS`.
- `runtime/python/*`: python-build-standalone's licence files at release `20260901`.
- `local-brain/bun-LICENSE.md`: Bun's `LICENSE.md` at `bun-v1.4.2`.
  `local-brain/pglite-POSTGRES-LICENSE.txt`: PGlite's `POSTGRES-LICENSE` at `@electric-sql/pglite@0.4.3`.
- `rust/*`: generated by `node scripts/rust-crate-notices.mjs --lock <Cargo.lock of the release>
  --package <name@version> --binary <what ships> --out third-party/licenses/rust/<name>-<version>.txt`,
  which downloads every crate of that lockfile from crates.io, checks it against the lockfile
  checksum and copies its licence files.

## A new engine, Electron or runtime

1. Package nothing; preview the notice against an app (an installed one works) and, for a new
   engine, its staged engine:
   `node scripts/third-party-notices.mjs --preview /tmp/notices --app "<path>/Atum Matrix Candidate.app" [--engine <dir with manifest.json and the .app>]`.
2. Any unlisted item, unmatched pattern, changed pin or revision error points to what has changed.
   Update `engine-components.json` (components, versions, licence files, source archives, then
   `sourceCommit`, `sourceUrl`, `sourceTag`, `sourceTagCommit`, `buildingUrl` and `releaseUrl` for
   the new public source tag and release) or `app-components.json`, and add licence files for new
   libraries. Publish the exact sources of any LGPL library on the new release first.
3. Move `ATUM_LINKS.driveEngineSource` (`src/matrix/atum-links.ts`) to the same tag. A test
   requires the two to match.
4. Run `npx vitest run --project electron scripts/third-party-notices.test.mjs`.

To check a packaged app: `node scripts/third-party-notices.mjs --audit "<path>/Atum Matrix Candidate.app"`.
