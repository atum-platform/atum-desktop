# Canonical desktop build

The desktop product is Atum Matrix Candidate. Run commands from the repository
root after the root workspace install, with a supported Node release (CI uses 24).

```sh
npm run build --workspace apps/desktop
npm run dev --workspace apps/desktop
npm run pack --workspace apps/desktop
```

`build` and the compatibility alias `matrix:build` emit `dist-matrix` using
`scripts/build-matrix-candidate.mjs`. The app manifest starts `matrix-main.mjs`.
`dev`/`start` rebuild and launch that same directory with
`--matrix-config=matrix-public-config.json`, the checked-in public service config.
No operator config is required for a clean development checkout. This connects
to public Atum services; it does not supply credentials. For a separate service,
build and run `electron dist-matrix --matrix-config=/absolute/path/dev-config.json`
from `apps/desktop`. `npm run preview --workspace apps/desktop` serves the built
`dist-matrix` renderer (without the Electron capability bridge).
There is no alternate legacy Electron target or hot-reload authority. For fixture UI iteration, run Vite from
the desktop workspace and open `/matrix-playground.html`. Playground source is
retained but excluded from the shipped renderer.

The build includes Matrix chat, management pages, pet overlay, SDK, all Matrix
preloads and the Work sidecar preload. Its module manifests reject legacy
authority imports. macOS builds compile the native helpers; Linux CI verifies
the JavaScript/renderer bundles without packaging or signing.

`pack` (`matrix:pack`) creates a local directory with `matrix-builder.json`.
`package` (`dist`) uses `matrix-release-builder.json`, requires signing, and
never publishes. It does not replace the private release coordinator: signed
release, notarization, provenance and update-feed publication remain private.
The private coordinator injects its own afterSign hook and calls its private
build driver against the assembled public tree. The public release config has
no missing private afterSign path. Both configs claim `atum://` for native login.

Private driver source preflight requires these public files:

- `apps/desktop/package.json` and the root `package-lock.json`, with aligned versions;
- `apps/desktop/matrix-release-builder.json`, requiring signing and DMG + ZIP;
- `apps/desktop/scripts/stage-atum-app-window.mjs`;
- `apps/desktop/scripts/stage-atum-keys.mjs`;
- `apps/desktop/scripts/stage-atum-device-key.mjs`;
- `apps/desktop/scripts/stage-atum-disclaim-launcher.mjs`;
- `apps/desktop/scripts/matrix-after-pack.mjs` and its transitive helpers.

The public build entry is restored at `apps/desktop/scripts/build-matrix-candidate.mjs`.
The private coordinator also validates its source lock, overlay, native inputs,
release notes, disk floors, exact revision checks and signing inputs. Changing
this repository does not refresh that private lock or certify release eligibility.

The dependency inventory is reproducible with:

```sh
node apps/desktop/scripts/legacy-dependency-closure.mjs matrix-closure.json
```

It starts at Matrix HTML/native entries and retained scripts, then conservatively
protects surviving presentation/type imports. Test-only Matrix fixtures and the
recovery/update suites remain. Candidates are inventoried, never auto-deleted.
Legacy Electron E2E/performance/installer harnesses were removed with their
retired target; the existing Matrix playground proof scripts remain. Signed
install, upgrade, hardware recovery and installed-client HTTP route usage are
separate acceptance work, not inferred from this source closure.
