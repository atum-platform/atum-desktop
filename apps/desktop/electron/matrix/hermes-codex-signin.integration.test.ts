import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, expect, test } from 'vitest'

import { matrixCodexStoreMode } from './codex-accounts'
import { matrixAccountCodexScope, matrixHermesEnvironment, matrixHermesHome } from './hermes-runtime'

/**
 * Where an approved ChatGPT sign-in lands, with the real Hermes split OAuth owner and
 * profile-local native auth store under the environment Atum launches it with, in a temporary
 * person's home and userData. Opt in with the repository's Python:
 * `ATUM_SYNC_PYTHON=<repo>/.venv/bin/python npx vitest run --project electron electron/matrix/hermes-codex-signin`.
 */
const python = process.env.ATUM_SYNC_PYTHON
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const scratch = mkdtempSync(path.join(tmpdir(), 'atum-codex-signin-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The Connections sign-in's save, then what the assistant's Hermes reads back. */
const SAVE = `
import json
from hermes_cli.auth import _save_codex_tokens, _read_codex_tokens
from hermes_cli.web_routers import oauth
sid, sess = oauth._new_oauth_session("openai-codex", "device_code", profile="default")
with oauth._profile_scope(sess["profile"]), oauth._oauth_sessions_lock:
    assert oauth._oauth_sessions.get(sid) is sess
    assert sess["status"] == "pending"
    _save_codex_tokens({"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"})
    sess["status"] = "approved"
read = _read_codex_tokens()
print(json.dumps({"status": sess["status"], "refresh": read["tokens"]["refresh_token"]}))
`

function mac(label: string, accounts: string[]) {
  const root = path.join(scratch, label)
  const person = path.join(root, 'person')
  const userData = path.join(root, 'userData')
  mkdirSync(person, { recursive: true })

  // A packaged build: the shared folder pinned to the person's Hermes CLI (runtime-selection.ts).
  const config = {
    python: python!,
    source: repository,
    profiles: path.join(userData, 'hermes'),
    bundled: {
      browserBin: '/fixture/browser',
      nodeBin: '/fixture/node',
      chromium: '/fixture/chromium',
      sharedAuthDir: path.join(person, '.hermes', 'shared')
    }
  }

  let mode = matrixCodexStoreMode(userData)

  for (const key of accounts) {
    mode = matrixCodexStoreMode(userData, key)
  }

  const home = matrixHermesHome(config, 'owner-a', 'executor-a')
  mkdirSync(home, { recursive: true })

  const env = matrixHermesEnvironment(
    config,
    home,
    home,
    { PATH: '/usr/bin:/bin', HOME: person },
    mode === 'shared' ? null : matrixAccountCodexScope(config, 'owner-a')
  )

  const save = () =>
    JSON.parse(
      execFileSync(python!, ['-s', '-P', '-B', '-c', SAVE], { cwd: home, env, encoding: 'utf8', timeout: 120_000 })
    )

  return { config, person, home, mode, save }
}

test.skipIf(!python)(
  "one account: the sign-in is saved to the assistant's profile-local native auth store",
  () => {
    const m = mac('single', ['a'.repeat(64)])
    expect(m.mode).toBe('shared')

    expect(m.save()).toEqual({ status: 'approved', refresh: 'synthetic-refresh' })

    const shared = path.join(m.person, '.hermes', 'shared', 'codex_auth.json')
    expect(existsSync(shared)).toBe(false)
    expect(readFileSync(path.join(m.home, 'auth.json'), 'utf8')).toContain('synthetic-refresh')
    // Nothing in a legacy account folder, and never the person's Codex CLI folder.
    expect(existsSync(path.join(m.config.profiles, 'accounts'))).toBe(false)
    expect(existsSync(path.join(m.person, '.codex'))).toBe(false)
  },
  180_000
)

test.skipIf(!python)(
  "two accounts: the sign-in remains in the assistant's profile-local native auth store",
  () => {
    const m = mac('two', ['a'.repeat(64), 'b'.repeat(64)])
    expect(m.mode).toBe('account')

    expect(m.save()).toEqual({ status: 'approved', refresh: 'synthetic-refresh' })

    const legacyAccountStore = path.join(matrixAccountCodexScope(m.config, 'owner-a').authDir, 'codex_auth.json')
    expect(existsSync(legacyAccountStore)).toBe(false)
    expect(readFileSync(path.join(m.home, 'auth.json'), 'utf8')).toContain('synthetic-refresh')
    expect(existsSync(path.join(m.person, '.hermes', 'shared', 'codex_auth.json'))).toBe(false)
    expect(existsSync(path.join(m.person, '.codex'))).toBe(false)
  },
  180_000
)
