import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import { REQUIRED_SETUP_RPC_METHODS } from './setup-methods'

it('registers every desktop setup/readiness dependency in the real Hermes gateway', () => {
  const root = resolve(import.meta.dirname, '../../..')
  const home = mkdtempSync(resolve(tmpdir(), 'atum-setup-catalog-'))

  try {
    // Importing the server in the test environment registers
    // real handlers and validates their declared contracts. No provider calls or installs.
    const venvPython = resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
    const python = process.env.ATUM_SYNC_PYTHON || process.env.HERMES_PYTHON || (existsSync(venvPython) ? venvPython : 'python3')

    const output = execFileSync(python, [
      '-c',
      'import json; from tui_gateway import server; server._real_stdout.write(json.dumps(sorted(server._methods)))'
    ], {
      cwd: root,
      env: { ...process.env, HERMES_HOME: home, HERMES_TEST_ISOLATION: '1' },
      encoding: 'utf8',
      timeout: 120_000
    })

    const registered = JSON.parse(output.trim().split('\n').at(-1)!) as string[]

    expect(REQUIRED_SETUP_RPC_METHODS.filter(method => !registered.includes(method))).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
