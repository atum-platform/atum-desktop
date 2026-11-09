/**
 * hermes-home.ts
 *
 * Pure, DI-testable resolution of the desktop's HERMES_HOME and of the shared
 * subscription-credential directory. Extracted from main.ts so the packaged
 * product-isolation ladder is data, tested, and owned in exactly one place
 * (see the "observable ladder" rule in apps/desktop/AGENTS.md).
 *
 * Product isolation contract (packaged Atum):
 *   Packaged builds NEVER use the mutable CLI product home (~/.hermes on
 *   POSIX, %LOCALAPPDATA%\hermes on Windows) for sessions, profiles, memory,
 *   cron, plugins, skills state, logs, caches, runtime installs, update
 *   markers, or the source checkout. The packaged engine home defaults to
 *   app.getPath('userData')/hermes-home. An inherited HERMES_HOME and the
 *   Windows User-scoped registry HERMES_HOME are CLI-product inputs and are
 *   ignored in packaged builds.
 *
 * Packaged precedence (first match wins):
 *   1. Managed test sandbox (HERMES_DESKTOP_USER_DATA_DIR set):
 *      a. HERMES_HOME when the sandbox also pins one (test:desktop:fresh and
 *         the e2e fixtures set both — honoring it keeps the historical
 *         sandbox contract byte-identical);
 *      b. otherwise <sandbox userData>/hermes-home.
 *   2. HERMES_DESKTOP_HERMES_HOME — explicit product-scoped support override.
 *   3. app.getPath('userData')/hermes-home (the default).
 *
 * Development precedence (unchanged from the historical inline resolver):
 *   1. HERMES_HOME env.
 *   2. HERMES_DESKTOP_USER_DATA_DIR sandbox → <sandbox>/hermes-home.
 *   3. Windows User-scoped registry HERMES_HOME (a GUI app launched from
 *      Explorer inherits the login-time environment block, so a setx done
 *      after login is invisible in process.env — #45471).
 *   4. Windows %LOCALAPPDATA%\hermes, preferring a legacy ~/.hermes when it
 *      exists and LOCALAPPDATA does not (pre-installer setups).
 *   5. ~/.hermes.
 *
 * The ONE intentional cross-product share is the subscription credential
 * plane (Codex / Nous OAuth): hermes_cli/auth.py stores single-use refresh
 * tokens in <CLI home>/shared and serializes refresh with a cross-process
 * file lock. Packaged Atum re-homes HERMES_HOME, which would silently fork
 * that store (get_default_hermes_root() follows HERMES_HOME), so the main
 * process pins HERMES_SHARED_AUTH_DIR to the platform-native CLI shared dir
 * for every backend child — both products then refresh the SAME credential
 * instead of duplicating a single-use token. resolveSharedAuthDirEnv()
 * computes that pin; it is a no-op in dev, in managed sandboxes, and when
 * the user already set an explicit shared-dir override.
 */

import path from 'node:path'

import { normalizeHermesHomeRoot } from './backend-env'

function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * The platform-native CLI product home. Mirrors
 * hermes_constants._get_platform_default_hermes_home() exactly:
 *   win32 → %LOCALAPPDATA%\hermes (fallback ~\AppData\Local\hermes)
 *   posix → ~/.hermes
 * This Node process cannot import the Python module, so the rule is mirrored
 * here — keep the two in sync.
 */
function nativeHermesProductHome({ platform = process.platform, env = process.env, homeDir }: any = {}) {
  const pm = pathModuleForPlatform(platform)

  if (platform === 'win32') {
    const localAppData = String(env?.LOCALAPPDATA || '').trim()
    const base = localAppData || pm.join(homeDir, 'AppData', 'Local')

    return pm.join(base, 'hermes')
  }

  return pm.join(homeDir, '.hermes')
}

/**
 * Resolve the desktop's engine home. See the module header for the exact
 * packaged/dev ladders. `userDataPath` is app.getPath('userData') AFTER any
 * HERMES_DESKTOP_USER_DATA_DIR override has been applied; `directoryExists`
 * and `readWindowsUserEnvVar` are injected so tests exercise every rung
 * without touching the real filesystem or registry.
 */
function resolveDesktopHermesHome({
  isPackaged,
  platform = process.platform,
  env = process.env,
  userDataPath,
  homeDir,
  readWindowsUserEnvVar,
  directoryExists = () => false
}: any) {
  const pm = pathModuleForPlatform(platform)
  const sandboxUserData = String(env?.HERMES_DESKTOP_USER_DATA_DIR || '').trim()

  if (isPackaged) {
    if (sandboxUserData) {
      // Managed sandbox: honor the sandbox-pinned HERMES_HOME when present
      // (test:desktop:fresh / e2e fixtures set both), else derive from the
      // sandbox userData. Never consult the inherited environment beyond this.
      if (env?.HERMES_HOME) {
        return normalizeHermesHomeRoot(env.HERMES_HOME, { pathModule: pm })
      }

      return pm.join(pm.resolve(sandboxUserData), 'hermes-home')
    }

    const supportOverride = String(env?.HERMES_DESKTOP_HERMES_HOME || '').trim()

    if (supportOverride) {
      return normalizeHermesHomeRoot(supportOverride, { pathModule: pm })
    }

    return pm.join(pm.resolve(userDataPath), 'hermes-home')
  }

  // --- development ladder (historical behavior, byte-for-byte) ---
  if (env?.HERMES_HOME) {
    return normalizeHermesHomeRoot(env.HERMES_HOME, { pathModule: pm })
  }

  if (sandboxUserData) {
    return pm.join(pm.resolve(sandboxUserData), 'hermes-home')
  }

  if (platform === 'win32') {
    const fromRegistry = readWindowsUserEnvVar?.('HERMES_HOME')

    if (fromRegistry) {
      return normalizeHermesHomeRoot(fromRegistry, { pathModule: pm })
    }
  }

  if (platform === 'win32' && env?.LOCALAPPDATA) {
    const localappdata = pm.join(env.LOCALAPPDATA, 'hermes')
    const legacy = pm.join(homeDir, '.hermes')

    // Migrate transparently to LOCALAPPDATA, but honour an existing legacy
    // ~/.hermes setup (no LOCALAPPDATA install yet) so users don't lose state.
    if (!directoryExists(localappdata) && directoryExists(legacy)) {
      return legacy
    }

    return localappdata
  }

  return pm.join(homeDir, '.hermes')
}

/**
 * Candidate directories for the shared subscription-credential store, most
 * authoritative first. The CLI's default is <native home>/shared; a Windows
 * CLI install that predates the LOCALAPPDATA migration keeps its store under
 * ~/.hermes/shared, so that legacy location is the second rung (existence-
 * checked by the caller).
 */
function sharedAuthDirCandidates({ platform = process.platform, env = process.env, homeDir }: any = {}) {
  const pm = pathModuleForPlatform(platform)
  const roots = [nativeHermesProductHome({ platform, env, homeDir })]

  if (platform === 'win32') {
    roots.push(pm.join(homeDir, '.hermes'))
  }

  return roots.map(root => pm.join(root, 'shared'))
}

/**
 * The env pin that keeps packaged Atum on the CLI's shared credential plane.
 * Returns {} (no pin) when:
 *   - not packaged (dev keeps the historical HERMES_HOME-follows behavior),
 *   - the user explicitly set HERMES_SHARED_AUTH_DIR / HERMES_CODEX_SHARED_AUTH_DIR
 *     (their choice wins; it is already in process.env), or
 *   - a managed test sandbox is active (sandboxes stay hermetic — a packaged
 *     test run must not touch the real shared credential store).
 */
function resolveSharedAuthDirEnv({
  isPackaged,
  platform = process.platform,
  env = process.env,
  homeDir,
  directoryExists = () => false
}: any = {}) {
  if (!isPackaged) {
    return {}
  }

  if (String(env?.HERMES_SHARED_AUTH_DIR || '').trim() || String(env?.HERMES_CODEX_SHARED_AUTH_DIR || '').trim()) {
    return {}
  }

  if (String(env?.HERMES_DESKTOP_USER_DATA_DIR || '').trim()) {
    return {}
  }

  const candidates = sharedAuthDirCandidates({ platform, env, homeDir })

  return { HERMES_SHARED_AUTH_DIR: candidates.find(candidate => directoryExists(candidate)) || candidates[0] }
}

/**
 * The CLI home to seed FROM. The platform-native home normally; on Windows a
 * legacy-only ~/.hermes setup (pre-installer CLI installs) wins when the
 * LOCALAPPDATA home doesn't exist — the same preference the dev ladder uses.
 */
function resolveCliHomeForSeed({
  platform = process.platform,
  env = process.env,
  homeDir,
  directoryExists = () => false
}: any = {}) {
  const native = nativeHermesProductHome({ platform, env, homeDir })

  if (platform === 'win32' && !directoryExists(native)) {
    const legacy = pathModuleForPlatform(platform).join(homeDir, '.hermes')

    if (directoryExists(legacy)) {
      return legacy
    }
  }

  return native
}

export {
  nativeHermesProductHome,
  resolveCliHomeForSeed,
  resolveDesktopHermesHome,
  resolveSharedAuthDirEnv,
  sharedAuthDirCandidates
}
