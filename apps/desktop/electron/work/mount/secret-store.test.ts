import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { T3Sessions } from '../gate/sessions'

import { createKeychainSecretStore, workSecretsPath } from './secret-store'

// A test-only safeStorage: reversible but not plaintext, so a test can tell encrypted bytes from clear text.
const reverse = (value: string) => [...value].reverse().join('')

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(reverse(value)),
  decryptString: (value: Buffer) => reverse(value.toString())
}

let root: string

afterEach(() => rmSync(root, { recursive: true, force: true }))

function account(): { root: string } {
  root = mkdtempSync(join(tmpdir(), 'work-secrets-'))

  return { root }
}

describe('keychain secret store', () => {
  it('round-trips a bearer, never writes it in the clear, and keeps the file private', () => {
    const a = account()
    const secrets = createKeychainSecretStore({ account: a, safeStorage })

    secrets.set('agent:luna', JSON.stringify({ token: 'T3-BEARER-VALUE', sessionId: 's1' }))

    expect(JSON.parse(secrets.get('agent:luna')!)).toEqual({ token: 'T3-BEARER-VALUE', sessionId: 's1' })
    expect(readFileSync(workSecretsPath(a), 'utf8')).not.toContain('T3-BEARER-VALUE')
    expect(statSync(workSecretsPath(a)).mode & 0o077).toBe(0)

    secrets.delete('agent:luna')
    expect(secrets.get('agent:luna')).toBeUndefined()
  })

  it('is per account, so another account never sees these secrets', () => {
    const a = account()
    createKeychainSecretStore({ account: a, safeStorage }).set('owner', 'x')

    const other = mkdtempSync(join(tmpdir(), 'work-secrets-other-'))

    try {
      expect(createKeychainSecretStore({ account: { root: other }, safeStorage }).get('owner')).toBeUndefined()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('fails closed: no write when the keychain is unavailable, and an unreadable value reads as none with a stable code', () => {
    const a = account()
    createKeychainSecretStore({ account: a, safeStorage }).set('agent:luna', 'secret')

    const locked = { ...safeStorage, isEncryptionAvailable: () => false }
    const onFailure = vi.fn()
    const closed = createKeychainSecretStore({ account: a, safeStorage: locked, onFailure })

    expect(() => closed.set('agent:nova', 'other')).toThrow('auth_storage_unavailable')
    expect(closed.get('agent:luna')).toBeUndefined()
    expect(onFailure).toHaveBeenCalledWith('auth_storage_unavailable')
    expect(readFileSync(workSecretsPath(a), 'utf8')).not.toContain('other')
  })

  it('is the store the T3 sessions keep an agent’s bearer in', () => {
    const a = account()
    const secrets = createKeychainSecretStore({ account: a, safeStorage })

    const sessions = new T3Sessions({
      origin: () => undefined,
      pairing: { create: async () => 'unused' },
      auth: { sessionIds: async () => [], revokeSession: async () => undefined },
      store: secrets,
      agentName: () => 'Luna',
      knownAgents: () => ['luna'],
      unfinished: () => false
    })

    secrets.set('agent:luna', JSON.stringify({ token: 'bearer-1', sessionId: 'session-1' }))

    expect(sessions.agentSessionId('luna')).toBe('session-1')
  })
})
