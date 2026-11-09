/**
 * Desktop bundles ship precompiled renderer assets. Returning false here tells
 * electron-builder to skip the node_modules collector/install step, which
 * avoids workspace dependency graph explosions and keeps packaging
 * deterministic across environments. macOS stages its pinned Python/Hermes
 * payload later in `after-pack.mjs`, when the target architecture and final
 * `.app` Resources directory are known. Other targets keep the historical
 * first-launch install/bootstrap flow. See `electron/main.ts`.
 */
export default async function beforeBuild() {
  return false
}
