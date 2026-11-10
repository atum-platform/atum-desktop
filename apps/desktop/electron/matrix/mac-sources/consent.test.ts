import { describe, expect, it } from 'vitest'

import { macSourceConsentScope, MacSourcesConsentStore } from './consent'

const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)

describe('Mac source consent', () => {
  it('fails closed until an existing account is classified, then persists explicit off choices', () => {
    const values = new Map<string, string>()
    let scope = { accountKey: ACCOUNT_A, generation: 1 }

    const store = new MacSourcesConsentStore(
      {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
      },
      () => scope
    )

    expect(store.read()).toEqual({ google: false, folders: false, messages: false, browser: false, location: false, teamSpaces: false })
    expect(store.initializeExistingOpen()).toEqual({ google: true, folders: true, messages: true, browser: true, location: true, teamSpaces: true })
    expect(store.set('messages', false).messages).toBe(false)

    scope = { accountKey: ACCOUNT_B, generation: 1 }
    expect(store.read()).toEqual({ google: false, folders: false, messages: false, browser: false, location: false, teamSpaces: false })
    expect(store.setAll(false)).toEqual({ google: false, folders: false, messages: false, browser: false, location: false, teamSpaces: false })
    scope = { accountKey: ACCOUNT_A, generation: 2 }
    expect(store.read()).toEqual({ google: true, folders: true, messages: false, browser: true, location: true, teamSpaces: true })
  })

  it('migrates slice-1 records without reviving any explicit off choice', () => {
    const values = new Map<string, string>([
      [`matrix-mac-sources-consent.${ACCOUNT_A}`, JSON.stringify({ version: 1, messages: false, browser: true, location: false })]
    ])

    const store = new MacSourcesConsentStore(
      { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      () => ({ accountKey: ACCOUNT_A, generation: 1 })
    )

    expect(store.read()).toEqual({ google: true, folders: true, messages: false, browser: true, location: false, teamSpaces: true })
  })

  it('starts a new account with every prompt-free source on, once, and never overwrites a later choice', () => {
    const values = new Map<string, string>()

    const store = new MacSourcesConsentStore(
      { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      () => ({ accountKey: ACCOUNT_A, generation: 1 })
    )

    expect(store.initializeFirstRunDefaults()).toEqual({
      google: true,
      folders: false,
      messages: false,
      browser: false,
      location: true,
      teamSpaces: true
    })
    expect(store.set('folders', true).folders).toBe(true)
    store.set('location', false)
    expect(store.initializeFirstRunDefaults()).toBeNull()
    expect(store.read().location).toBe(false)
    expect(store.read().folders).toBe(true)
    expect(store.read().google).toBe(true)
    store.set('google', false)
    store.initializeExistingOpen()
    expect(store.read().google).toBe(false)
  })

  it('fails closed on corrupt, missing, or invalid account state', () => {
    const store = new MacSourcesConsentStore(
      { getItem: () => '{bad', setItem: () => {} },
      () => ({ accountKey: 'owner', generation: 1 })
    )

    expect(store.read()).toEqual({ google: false, folders: false, messages: false, browser: false, location: false, teamSpaces: false })
    expect(() => store.set('browser', true)).toThrow('matrix_mac_sources_consent_unavailable')
  })
})


it('migrates a legacy connected Google default once and preserves subsequent opt-out', () => {
  const key = `matrix-mac-sources-consent.${ACCOUNT_A}`

  const values = new Map([[key, JSON.stringify({
    version: 2, google: false, folders: false, messages: false, browser: false, location: false, teamSpaces: false
  })]])

  const store = new MacSourcesConsentStore({
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value) }
  }, () => ({ accountKey: ACCOUNT_A, generation: 1 }))

  expect(store.initializeConnectedGoogle(false)).toBeNull()
  expect(store.read().google).toBe(false)
  expect(store.initializeConnectedGoogle(true)?.google).toBe(true)
  expect(store.read().folders).toBe(false)
  expect(JSON.parse(values.get(key)!).version).toBe(3)
  store.set('google', false)
  expect(store.initializeConnectedGoogle(true)).toBeNull()
  expect(store.read().google).toBe(false)
})

it('persists a frozen import across restart, fences accounts, and never recycles a consumed receipt', () => {
  const values = new Map<string, string>()
  let scope = { accountKey: ACCOUNT_A, generation: 1 }
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  let store = new MacSourcesConsentStore(storage, () => scope)
  store.initializeExistingOpen()
  store.set('messages', false)
  const seed = store.accountGatesImport()
  store.set('messages', true)
  store = new MacSourcesConsentStore(storage, () => scope)
  expect(store.accountGatesImport()).toEqual(seed)
  store.markAccountGatesMerged()
  expect(store.accountGatesMerged()).toBe(true)
  scope = { accountKey: ACCOUNT_B, generation: 2 }
  expect(store.accountGatesMerged()).toBe(false)
  expect(store.accountGatesImport().mergeId).not.toBe(seed.mergeId)
  scope = { accountKey: ACCOUNT_A, generation: 3 }
  expect(store.accountGatesMerged()).toBe(true)
})

it('keeps pending OFF and overridden opt-outs across restarts, with disclosure per account AND Mac', () => {
  const values = new Map<string, string>()
  let scope = { accountKey: ACCOUNT_A, generation: 1 }
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  let store = new MacSourcesConsentStore(storage, () => scope)
  store.queueNarrow('browser')
  store.presented('mac-a', 100)
  expect(store.presentedAt('mac-a')).toBe(100)
  expect(store.presentedAt('mac-b')).toBeNull()
  store = new MacSourcesConsentStore(storage, () => scope)
  expect(store.pendingNarrow()).toEqual(['browser'])
  store.recordOverriddenOptOuts(['messages'], 'mac-a')
  expect(store.overriddenOptOuts()).toEqual(['messages'])
  expect(store.presentedAt('mac-a')).toBeNull()
  store.presented('mac-a', 200)
  store.recordOverriddenOptOuts(['messages'], 'mac-a')
  expect(store.presentedAt('mac-a')).toBe(200)
  scope = { accountKey: ACCOUNT_B, generation: 2 }
  expect(store.presentedAt('mac-a')).toBeNull()
  expect(store.pendingNarrow()).toEqual([])
  expect(store.overriddenOptOuts()).toEqual([])
  scope = { accountKey: ACCOUNT_A, generation: 3 }
  store.clearPendingNarrow(['browser'])
  expect(store.pendingNarrow()).toEqual([])
})


it('allows domain-less local toggles without borrowing a signed-out account scope', () => {
  const values = new Map<string, string>()
  const local = macSourceConsentScope(null, false, 'installation')
  expect(local?.accountKey).toMatch(/^[0-9a-f]{64}$/)
  expect(macSourceConsentScope(null, true, 'installation')).toBeNull()
  expect(macSourceConsentScope({ accountKey: ACCOUNT_A, generation: 7 }, false, 'installation')).toEqual({ accountKey: ACCOUNT_A, generation: 7 })
  const store = new MacSourcesConsentStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }, () => local)
  store.initializeExistingOpen()

  for (const source of ['google', 'folders', 'teamSpaces'] as const) {
    expect(store.set(source, false)[source]).toBe(false)
    store.queueNarrow(source)
  }

  expect(store.pendingNarrow()).toEqual(['google', 'folders', 'teamSpaces'])
  expect(macSourceConsentScope(null, false, 'another-installation')).not.toEqual(local)
})

it('invalidates shown state before persisting newly overridden opt-outs, including a write failure', () => {
  const values = new Map<string, string>()
  let failNoticeWrite = false

  const store = new MacSourcesConsentStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => {
    if (failNoticeWrite && key.endsWith('.overridden-opt-outs')) {throw new Error('disk failed')}
    values.set(key, value)
  } }, () => ({ accountKey: ACCOUNT_A, generation: 1 }))

  store.presented('mac-a', 100)
  failNoticeWrite = true
  expect(() => store.recordOverriddenOptOuts(['messages'], 'mac-a')).toThrow('disk failed')
  expect(store.presentedAt('mac-a')).toBeNull()
})
