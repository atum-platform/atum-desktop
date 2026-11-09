import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import {
  forgetMatrixAccountCodex,
  forgetMatrixAccountCodexSignIn,
  matrixAccountCodexScope,
  matrixHermesEnvironment
} from './hermes-runtime'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function profiles() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-codex-'))
  roots.push(root)

  return { python: '/fixture/python', source: '/fixture/source', profiles: root }
}

it("forgets one account's ChatGPT sign-in at sign-out and leaves every other account's", () => {
  const config = profiles()
  const mine = matrixAccountCodexScope(config, 'owner-a')
  const theirs = matrixAccountCodexScope(config, 'owner-b')

  for (const scope of [mine, theirs]) {
    mkdirSync(scope.authDir, { recursive: true })
    writeFileSync(path.join(scope.authDir, 'codex_auth.json'), '{"access_token":"synthetic"}')
  }

  forgetMatrixAccountCodex(config, 'owner-a')
  expect(existsSync(path.dirname(mine.authDir))).toBe(false)
  expect(existsSync(path.join(theirs.authDir, 'codex_auth.json'))).toBe(true)
  // Repeating a finished sign-out is harmless.
  expect(() => forgetMatrixAccountCodex(config, 'owner-a')).not.toThrow()
})

it('disconnecting ChatGPT removes only the stored sign-in', () => {
  const config = profiles()
  const scope = matrixAccountCodexScope(config, 'owner-a')
  mkdirSync(scope.authDir, { recursive: true })
  writeFileSync(path.join(scope.authDir, 'codex_auth.json'), '{}')
  writeFileSync(path.join(scope.authDir, 'codex_auth.lock'), '')
  forgetMatrixAccountCodexSignIn(config, 'owner-a')
  expect(readdirSync(scope.authDir)).toEqual(['codex_auth.lock'])
  expect(() => forgetMatrixAccountCodexSignIn(config, 'owner-a')).not.toThrow()
})

it("keeps the account folders out of the agents' homes, which are 64-hex folders beside them", () => {
  const config = profiles()
  const scope = matrixAccountCodexScope(config, 'owner-a')
  const top = path.relative(config.profiles, scope.authDir).split(path.sep)[0]
  expect(top).toBe('accounts')
  expect(/^[a-f0-9]{64}$/.test(top!)).toBe(false)
})

it('never leaves the shared store or the Codex CLI folder to the shell, even for a launch with no account', () => {
  const config = profiles()
  const home = path.join(config.profiles, 'a'.repeat(64))

  const env = matrixHermesEnvironment(config, home, home, {
    PATH: '/usr/bin',
    CODEX_HOME: path.join(os.homedir(), '.codex'),
    HERMES_CODEX_SHARED_AUTH_DIR: '/somewhere/shared'
  })

  expect(env.HERMES_CODEX_SHARED_AUTH_DIR).toBe(path.join(home, 'desktop-runtime', 'codex-auth'))
  expect(env.CODEX_HOME).toBe(path.join(home, 'desktop-runtime', 'codex-home'))
})
