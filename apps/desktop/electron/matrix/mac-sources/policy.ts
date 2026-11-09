import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { MacSourceConsentSnapshot } from './contract'

export const ATUM_SOURCE_POLICY_ENV = 'ATUM_SOURCE_POLICY_FILE'

/** Non-secret gate projection read by local Hermes tool handlers before every source read. */
export interface MacSourcesPolicyFile {
  version: 1
  google: boolean
  folders: boolean
  messages: boolean
  browser: boolean
  location: boolean
  team_spaces: boolean
}

export type MacSourceGates = Omit<MacSourcesPolicyFile, 'version'>

export function macSourcesPolicy(consent: MacSourceConsentSnapshot): MacSourcesPolicyFile {
  return {
    version: 1,
    google: consent.google,
    folders: consent.folders,
    messages: consent.messages,
    browser: consent.browser,
    location: consent.location,
    team_spaces: consent.teamSpaces
  }
}

export function macSourceGates(consent: MacSourceConsentSnapshot): MacSourceGates {
  const { version: _version, ...gates } = macSourcesPolicy(consent)

  return gates
}

const GATE = /^[a-z][a-z0-9_]{0,63}$/u

/** Resolve trusted descriptor gate data without branching on a source or app identity. */
export function macSourceGateEnabled(consent: MacSourceConsentSnapshot, gate: string): boolean {
  if (!GATE.test(gate)) {
    return false
  }

  const policy = macSourcesPolicy(consent) as unknown as Record<string, unknown>

  return typeof policy[gate] === 'boolean' && policy[gate] === true
}

/** Atomic and private: a transient partial write must never turn an explicit off back on. */
export function writeMacSourcesPolicy(file: string, consent: MacSourceConsentSnapshot): void {
  if (!path.isAbsolute(file)) {
    throw new Error('matrix_mac_sources_policy_invalid')
  }

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`

  writeFileSync(temporary, `${JSON.stringify(macSourcesPolicy(consent))}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  renameSync(temporary, file)
}
