import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { EncryptedStore } from '../encrypted-store'

import {
  forgetSubscriptionChatGpt,
  matrixChatGptGrant,
  matrixSubscriptionEnvironment,
  matrixSubscriptionKeyStore,
  type MatrixSubscriptionKeyStore,
  matrixSubscriptionsStatus
} from './account-subscriptions'
import { matrixCodexSignInFile } from './hermes-runtime'

function fakeStore(value?: string): MatrixSubscriptionKeyStore & { values: Map<string, string> } {
  const values = new Map<string, string>()

  if (value !== undefined) {
    values.set('opencode-go.api-key', value)
  }

  return {
    values,
    has: () => values.has('opencode-go.api-key'),
    read: () => values.get('opencode-go.api-key') ?? null,
    save: next => void values.set('opencode-go.api-key', next),
    clear: () => void values.delete('opencode-go.api-key')
  }
}

describe('account subscription custody', () => {
  it('scopes the OpenCode Go key to the Atum account and clears it on disconnect', () => {
    const entries = new Map<string, string>()

    const scoped = {
      keys: (prefix = '') => [...entries.keys()].filter(key => key.startsWith(prefix)),
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key)
    }

    const root = {
      scope: (namespace: string) => ({
        keys: (prefix = '') => scoped.keys(namespace + prefix).map(key => key.slice(namespace.length)),
        getItem: (key: string) => scoped.getItem(namespace + key),
        setItem: (key: string, value: string) => scoped.setItem(namespace + key, value),
        removeItem: (key: string) => scoped.removeItem(namespace + key)
      })
    } as unknown as EncryptedStore

    const store = matrixSubscriptionKeyStore(root, 'account-a')

    expect(store.has()).toBe(false)
    store.save('synthetic-key')
    expect(store.has()).toBe(true)
    expect(store.read()).toBe('synthetic-key')
    expect(entries.has('subscriptions:account-a:opencode-go.api-key')).toBe(true)
    expect(matrixSubscriptionEnvironment(store)).toEqual({ OPENCODE_GO_API_KEY: 'synthetic-key' })

    store.clear()
    expect(store.has()).toBe(false)
    expect(matrixSubscriptionEnvironment(store)).toEqual({})
  })

  it('puts the OpenCode Go key only in the launch environment', () => {
    const store = fakeStore('synthetic-key-never-logged')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(matrixSubscriptionEnvironment(store)).toEqual({ OPENCODE_GO_API_KEY: 'synthetic-key-never-logged' })
    expect(matrixSubscriptionEnvironment(fakeStore())).toEqual({})
    expect(matrixSubscriptionEnvironment(undefined)).toEqual({})
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('reads the account sign-in home and the key store, never a value', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-subscriptions-'))
    const home = path.join(root, 'account-home')

    const config = {
      profiles: root,
      bundled: { browserBin: '', nodeBin: '', chromium: '', sharedAuthDir: path.join(root, 'shared') }
    }

    mkdirSync(home, { recursive: true })
    writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({
        version: 1,
        active_provider: 'openai-codex',
        providers: {
          'openai-codex': { tokens: { access_token: 'secret-at', refresh_token: 'secret-rt' } },
          'other-plan': { tokens: { access_token: 'keep-at' } }
        },
        credential_pool: {
          'openai-codex': [{ source: 'device_code', access_token: 'secret-at', refresh_token: 'secret-rt' }],
          copilot: [{ source: 'gh_cli' }]
        }
      })
    )

    // The retired pre-11-04 file proves nothing on its own.
    const legacy = matrixCodexSignInFile(config, 'owner', false)
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ access_token: 'secret-token' }))

    const status = matrixSubscriptionsStatus({ accountAuthHome: home, keys: fakeStore('secret-key') })

    expect(status).toEqual({
      scope: 'account',
      providers: [
        { id: 'openai-codex', connected: true },
        { id: 'opencode-go', connected: true }
      ]
    })
    expect(JSON.stringify(status)).not.toMatch(/secret/)
    expect(matrixSubscriptionsStatus({ accountAuthHome: path.join(root, 'nowhere'), keys: fakeStore() }).providers[0])
      .toEqual({ id: 'openai-codex', connected: false })

    // Disconnect here removes only the retired file; the account store is Hermes's to clear under
    // its own lock (clearMatrixAccountChatGpt), so this never rewrites it.
    const before = readFileSync(path.join(home, 'auth.json'), 'utf8')
    forgetSubscriptionChatGpt({ config, owner: 'owner', sharedCodex: false })
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe(before)

    rmSync(root, { recursive: true, force: true })
  })

  it('names a sign-in Hermes quarantined as needing sign-in, not as never connected', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'atum-subscriptions-'))
    const write = (store: unknown) => writeFileSync(path.join(home, 'auth.json'), JSON.stringify(store))

    write({
      providers: {
        'openai-codex': { tokens: {}, last_auth_error: { relogin_required: true, code: 'invalid_grant' } }
      }
    })
    expect(matrixChatGptGrant(home)).toBe('needs_sign_in')
    expect(matrixSubscriptionsStatus({ accountAuthHome: home, keys: fakeStore() }).providers[0]).toEqual({
      id: 'openai-codex',
      connected: false,
      needsSignIn: true
    })

    // Exactly what Hermes leaves after a terminal rejection of the account grant: singleton pair gone
    // with the relogin marker, the same generation's pool row still holding its pair but DEAD.
    write({
      active_provider: 'openai-codex',
      providers: {
        'openai-codex': { tokens: {}, last_auth_error: { relogin_required: true, code: 'invalid_grant' } }
      },
      credential_pool: {
        'openai-codex': [{ id: 'acct-row', source: 'device_code', access_token: 'a', refresh_token: 'r', last_status: 'dead' }]
      }
    })
    expect(matrixChatGptGrant(home)).toBe('needs_sign_in')

    // A dead pool row is not a live grant.
    write({ credential_pool: { 'openai-codex': [{ access_token: 'a', refresh_token: 'r', last_status: 'dead' }] } })
    expect(matrixChatGptGrant(home)).toBe('needs_sign_in')

    // A live pool row alone answers (Hermes reads the pool first).
    write({ credential_pool: { 'openai-codex': [{ access_token: 'a', refresh_token: 'r' }] } })
    expect(matrixChatGptGrant(home)).toBe('saved')

    write('not json at all')
    expect(matrixChatGptGrant(home)).toBe('none')
    expect(matrixChatGptGrant(undefined)).toBe('none')

    rmSync(home, { recursive: true, force: true })
  })

  it('names the account home in every launch environment, with or without a key', () => {
    expect(matrixSubscriptionEnvironment(undefined, '/account/home')).toEqual({ ATUM_ACCOUNT_AUTH_HOME: '/account/home' })
    expect(matrixSubscriptionEnvironment(fakeStore('k'), '/account/home')).toEqual({
      ATUM_ACCOUNT_AUTH_HOME: '/account/home',
      OPENCODE_GO_API_KEY: 'k'
    })
  })

  it('never throws when the key store is unreadable', () => {
    const broken: MatrixSubscriptionKeyStore = {
      has: () => {
        throw new Error('auth_storage_read_failed')
      },
      read: () => {
        throw new Error('auth_storage_read_failed')
      },
      save: () => undefined,
      clear: () => undefined
    }

    expect(matrixSubscriptionEnvironment(broken)).toEqual({})
    expect(
      matrixSubscriptionsStatus({ accountAuthHome: undefined, keys: broken }).providers
    ).toEqual([
      { id: 'openai-codex', connected: false },
      { id: 'opencode-go', connected: false }
    ])
  })
})
