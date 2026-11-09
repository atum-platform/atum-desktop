import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { macSourceGateEnabled, macSourceGates, macSourcesPolicy, writeMacSourcesPolicy } from './policy'

const roots: string[] = []
const consent = {
  google: true,
  folders: false,
  messages: true,
  browser: false,
  location: true,
  teamSpaces: false
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('projects the encrypted camel-case record into descriptor gate names', () => {
  expect(macSourcesPolicy(consent)).toEqual({
    version: 1,
    google: true,
    folders: false,
    messages: true,
    browser: false,
    location: true,
    team_spaces: false
  })
  expect(macSourceGateEnabled(consent, 'google')).toBe(true)
  expect(macSourceGateEnabled(consent, 'team_spaces')).toBe(false)
  expect(macSourceGateEnabled(consent, 'app:slug')).toBe(false)
  expect(macSourceGates(consent)).toEqual({
    google: true,
    folders: false,
    messages: true,
    browser: false,
    location: true,
    team_spaces: false
  })
})

it('writes a private atomic policy file for live per-call revocation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-source-policy-'))
  roots.push(root)
  const file = path.join(root, 'nested', 'policy.json')

  writeMacSourcesPolicy(file, consent)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(macSourcesPolicy(consent))
})

it('refuses a relative policy target', () => {
  expect(() => writeMacSourcesPolicy('policy.json', consent)).toThrow('matrix_mac_sources_policy_invalid')
})
