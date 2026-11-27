# T3 updater sources

The Work 0.1.19 source pin and the upstream comparison pin are in
[manifest.json](manifest.json). Each entry names the original path, Git blob
and exact output hash. Source-relative paths are preserved except where the
host uses a narrow contract export. The numbered line edits in the manifest
apply to the pinned original and are included only where Atum selects a
subsystem or binds a host interface. Product policy lives in
`electron/t3-updates/`.

Run `python3 apps/desktop/vendor/t3-updates/sync.py ~/Projects/atum-work`
from the desktop checkout to check the pins and reproduce the overlays in
a temporary directory. Add `--write` to restore missing files. A changed
destination or source blob is a failure. Run the desktop typecheck and
renderer/native build after refreshing the allowlist to check imports.

Copyright (c) 2026 T3 Tools Inc. See the full [MIT license](LICENSE).
The desktop installer also includes this text in its third-party licenses.
