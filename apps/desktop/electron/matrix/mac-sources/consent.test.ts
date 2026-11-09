import { describe, expect, it } from 'vitest'

import { MacSourcesConsentStore } from './consent'

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
