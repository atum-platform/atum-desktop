/**
 * engine-update-scope.ts
 *
 * Pure decision: may the in-app engine update (`hermes update` + GUI rebuild)
 * run against `updateRoot`, and with which CLI binary?
 *
 * Why this exists: the POSIX in-app update falls back to a `hermes` found on
 * PATH when the update root has no venv shim. In packaged Atum that PATH
 * binary belongs to the CLI product — running `hermes update` through it
 * fetches and mutates the CLI's source checkout (~/.hermes/hermes-agent),
 * which product isolation forbids. The bundled runtime is immutable inside
 * the signed app and its engine updates arrive WITH the app, so a packaged
 * build with no real engine checkout of its own has no in-app engine update
 * to perform.
 *
 * Plans:
 *   - 'cli'         → drive the update with `command` (venv shim inside the
 *                     update root, or — dev/CLI installs only — PATH).
 *   - 'app-managed' → packaged build, no own engine checkout: the engine is
 *                     app-delivered; the UI must say "update the app", never
 *                     point at the CLI's updater.
 *   - 'manual'      → dev/CLI install with no usable binary: show the manual
 *                     command (historical behavior).
 */

import path from 'node:path'

function planEngineUpdate({
  isPackaged,
  updateRoot,
  platform = process.platform,
  fileExists = () => false,
  findOnPath = () => null,
  joinPath = path.join
}: any = {}) {
  // A venv shim inside the update root is always product-scoped: it only
  // exists when THIS product's home holds a real engine checkout (bootstrap
  // fallback install, or an explicit HERMES_DESKTOP_HERMES_ROOT dev pin).
  const venvHermes = updateRoot
    ? platform === 'win32'
      ? joinPath(updateRoot, 'venv', 'Scripts', 'hermes.exe')
      : joinPath(updateRoot, 'venv', 'bin', 'hermes')
    : null

  if (venvHermes && fileExists(venvHermes)) {
    return { command: venvHermes, kind: 'cli' }
  }

  if (isPackaged) {
    return { command: null, kind: 'app-managed' }
  }

  const onPath = findOnPath('hermes')

  if (onPath) {
    return { command: onPath, kind: 'cli' }
  }

  return { command: null, kind: 'manual' }
}

export { planEngineUpdate }
