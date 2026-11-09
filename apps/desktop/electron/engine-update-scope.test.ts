/**
 * Tests for electron/engine-update-scope.ts — the guard that keeps packaged
 * Atum's in-app engine update from ever driving the CLI product's checkout.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { planEngineUpdate } from './engine-update-scope'

const ATUM_ROOT = '/home/example/Library/Application Support/Atum/hermes-home/hermes-agent'
const CLI_HERMES = '/home/example/.hermes/hermes-agent/venv/bin/hermes'

test('packaged with no own engine checkout: app-managed, never the PATH CLI', () => {
  const plan = planEngineUpdate({
    isPackaged: true,
    updateRoot: ATUM_ROOT,
    fileExists: () => false,
    findOnPath: () => CLI_HERMES
  })

  assert.equal(plan.kind, 'app-managed')
  assert.equal(plan.command, null)
})

test('packaged with a venv shim inside its own home updates through it', () => {
  const shim = path.join(ATUM_ROOT, 'venv', 'bin', 'hermes')

  const plan = planEngineUpdate({
    isPackaged: true,
    updateRoot: ATUM_ROOT,
    fileExists: candidate => candidate === shim,
    findOnPath: () => CLI_HERMES
  })

  assert.equal(plan.kind, 'cli')
  assert.equal(plan.command, shim)
  assert.ok(plan.command.startsWith(ATUM_ROOT), 'update must stay inside the Atum home')
})

test('dev keeps the historical PATH fallback', () => {
  const plan = planEngineUpdate({
    isPackaged: false,
    updateRoot: ATUM_ROOT,
    fileExists: () => false,
    findOnPath: () => CLI_HERMES
  })

  assert.equal(plan.kind, 'cli')
  assert.equal(plan.command, CLI_HERMES)
})

test('dev with nothing usable stays manual', () => {
  const plan = planEngineUpdate({ isPackaged: false, updateRoot: ATUM_ROOT })

  assert.equal(plan.kind, 'manual')
  assert.equal(plan.command, null)
})

test('Windows update roots use the Scripts/hermes.exe venv shim', () => {
  const shim = 'C:\\Atum\\hermes-home\\hermes-agent\\venv\\Scripts\\hermes.exe'

  const plan = planEngineUpdate({
    isPackaged: true,
    updateRoot: 'C:\\Atum\\hermes-home\\hermes-agent',
    platform: 'win32',
    joinPath: path.win32.join,
    fileExists: candidate => candidate === shim
  })

  assert.equal(plan.kind, 'cli')
  assert.equal(plan.command, shim)
})
