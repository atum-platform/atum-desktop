import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { matrixCodexStoreMode } from './codex-accounts'
import type { MatrixHermesRuntimeConfig } from './hermes-runtime'

/** Written to userData once the 0.18.3 Codex migration has finished; it then never runs again. */
export const MATRIX_CODEX_MIGRATION_MARKER = 'matrix-codex-accounts-0.18.3.json'

const CODEX_PROVIDER = 'openai-codex'
const CODEX_STORE = 'codex_auth.json'
/** An agent's home: a 64-hex folder directly inside the profiles folder (hermes-runtime.ts). */
const AGENT_HOME = /^[a-f0-9]{64}$/

/**
 * Where one agent home's Hermes kept its "shared" ChatGPT (Codex) sign-in before 0.18.3,
 * computed as that release did. Its launch environment was the person's own plus, in a
 * packaged build, `HERMES_SHARED_AUTH_DIR` pinned to the Hermes CLI's shared folder
 * (`config.bundled.sharedAuthDir`, runtime-selection.ts). Hermes read it as
 * `_codex_shared_auth_dir` (hermes_cli/auth.py) does: `HERMES_CODEX_SHARED_AUTH_DIR`, then
 * `HERMES_SHARED_AUTH_DIR`, then `get_default_hermes_root()/shared` (hermes_constants.py)
 * with `HERMES_HOME` set to the home. Undefined when it cannot be told (a relative folder).
 */
export function matrixLegacyCodexStore(
  config: Pick<MatrixHermesRuntimeConfig, 'bundled'>,
  home: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const expand = (value: string) =>
    value === '~' || value.startsWith(`~${path.sep}`) || value.startsWith('~/')
      ? path.join(homeDir, value.slice(1))
      : value

  const codex = env.HERMES_CODEX_SHARED_AUTH_DIR?.trim()
  const shared = config.bundled?.sharedAuthDir ?? env.HERMES_SHARED_AUTH_DIR?.trim()
  const named = codex || shared

  if (named) {
    const folder = expand(named)

    return path.isAbsolute(folder) ? path.join(folder, CODEX_STORE) : undefined
  }

  const native =
    platform === 'win32'
      ? path.join(env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local'), 'hermes')
      : path.join(homeDir, '.hermes')

  const inside = path.relative(resolvedPath(native), resolvedPath(home))

  const root =
    !inside.startsWith('..') && !path.isAbsolute(inside)
      ? native
      : path.basename(path.dirname(home)) === 'profiles'
        ? path.dirname(path.dirname(home))
        : home

  return path.join(root, 'shared', CODEX_STORE)
}

/** Python's `Path.resolve(strict=False)`: links resolved as far as the path exists. */
function resolvedPath(value: string): string {
  const absolute = path.resolve(value)
  const parent = path.dirname(absolute)

  try {
    return realpathSync(absolute)
  } catch {
    return parent === absolute ? absolute : path.join(resolvedPath(parent), path.basename(absolute))
  }
}

/** A profile's auth store without its ChatGPT sign-in, as `clear_provider_auth("openai-codex")`
 * (hermes_cli/auth.py) leaves it; undefined when it holds none. A store Hermes would not read
 * (not JSON, no providers or pool) holds none it could use. */
function withoutCodex(text: string): Record<string, unknown> | undefined {
  let store: unknown

  try {
    store = JSON.parse(text)
  } catch {
    return undefined
  }

  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return undefined
  }

  const record = store as Record<string, unknown>
  const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined)
  const providers = object(record.providers) as Record<string, unknown> | undefined
  const pool = object(record.credential_pool) as Record<string, unknown> | undefined
  let cleared = false

  for (const holder of [providers, pool]) {
    if (holder && CODEX_PROVIDER in holder) {
      delete holder[CODEX_PROVIDER]
      cleared = true
    }
  }

  if ((providers || pool) && record.active_provider === CODEX_PROVIDER) {
    record.active_provider = null
    cleared = true
  }

  return cleared ? record : undefined
}

/** Replace a credential file atomically, readable by the person only (as Hermes writes it). */
function writePrivate(file: string, text: string) {
  const temporary = `${file}.atum-${process.pid}-${Date.now()}`

  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * 0.18.3 keeps each Atum account's ChatGPT sign-in in its own folder (matrixAccountCodexScope).
 * Before, every assistant on this Mac read one shared store and Hermes copied its tokens into
 * each assistant's profile, so a profile could hold another account's ChatGPT sign-in, and
 * Hermes would carry it into the new per-account folder at its next refresh. Once, before any
 * Hermes opens: the old shared store is deleted when it lies inside Atum's own Hermes data (only
 * its `codex_auth.json`; never `~/.codex` or the Hermes CLI's own `~/.hermes/shared`)
 * and every assistant profile forgets its ChatGPT sign-in, so each account signs in once more.
 *
 * Never throws and never fails startup. The marker is written only when every step finished;
 * otherwise a closed code is logged and the next start tries again (a repeat is harmless: an
 * account's own sign-in lives in its folder, which this never touches).
 *
 * 0.18.4: only a Mac that has held two or more Atum accounts (codex-accounts.ts) has another
 * account's sign-in to fear. With one, every token here is that account's own and its
 * assistants keep using the shared store, so nothing is cleared and no marker is written
 * (`single`). `accountKey` is the account signed in at this start (main reads it before any
 * Hermes opens), counted first: a second account's first start migrates before its assistants
 * open. One that first signs in while Atum runs is migrated at the next start (its assistants'
 * homes and sign-in folder are its own meanwhile).
 */
export function migrateMatrixCodexAccounts(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles' | 'bundled'>,
  input: {
    userData: string
    accountKey?: string
    env?: NodeJS.ProcessEnv
    homeDir?: string
    platform?: NodeJS.Platform
  }
): 'migrated' | 'already' | 'pending' | 'single' {
  const marker = path.join(input.userData, MATRIX_CODEX_MIGRATION_MARKER)

  try {
    if (existsSync(marker)) {
      return 'already'
    }

    // A folder that cannot be read counts as more than one account: migrate, as 0.18.3 did.
    if (matrixCodexStoreMode(input.userData, input.accountKey) === 'shared') {
      return 'single'
    }

    const env = input.env ?? process.env
    const homeDir = input.homeDir ?? os.homedir()
    const codexCli = resolvedPath(path.join(homeDir, '.codex'))
    let failed = false

    const homes = existsSync(config.profiles)
      ? readdirSync(config.profiles, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && AGENT_HOME.test(entry.name))
          .map(entry => path.join(config.profiles, entry.name))
      : []

    const stores = new Set(
      homes.flatMap(home => matrixLegacyCodexStore(config, home, env, homeDir, input.platform) ?? [])
    )

    // Only a store inside Atum's own Hermes data is Atum's to delete. Packaged 0.18.2 pinned the
    // store to the person's own Hermes CLI folder (~/.hermes/shared): deleting that would sign
    // their Hermes CLI out of ChatGPT, and 0.18.3 never reads it, so clearing the profiles below
    // is what stops the leak.
    const atumHermes = resolvedPath(path.dirname(config.profiles))

    for (const store of stores) {
      const resolved = resolvedPath(store)

      // The person's own Codex CLI folder is never Atum's to change, whatever a setting says.
      if (!path.relative(codexCli, resolved).startsWith('..') || path.relative(atumHermes, resolved).startsWith('..')) {
        continue
      }

      try {
        rmSync(store, { force: true })
      } catch {
        failed = true
      }
    }

    for (const home of homes) {
      const file = path.join(home, 'auth.json')

      try {
        if (!existsSync(file)) {
          continue
        }

        const cleared = withoutCodex(readFileSync(file, 'utf8'))

        if (cleared) {
          writePrivate(file, `${JSON.stringify(cleared, null, 2)}\n`)
        }
      } catch {
        failed = true
      }
    }

    if (failed) {
      console.warn('[Matrix] matrix_codex_migration_pending')

      return 'pending'
    }

    writeFileSync(marker, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`, { mode: 0o600 })

    return 'migrated'
  } catch {
    console.warn('[Matrix] matrix_codex_migration_pending')

    return 'pending'
  }
}
