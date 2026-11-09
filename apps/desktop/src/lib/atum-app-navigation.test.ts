import { readFileSync } from 'node:fs'
import path from 'node:path'

import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureAtumSpecialistConversation, accountScope } = vi.hoisted(() => ({
  ensureAtumSpecialistConversation: vi.fn(async () => 'conversation-moon'),
  accountScope: (() => {
    let value: string | null = 'account-a'
    return { get: () => value, set: (next: string | null) => { value = next } }
  })()
}))

let catalogApps: Array<Record<string, unknown>> = []
const catalogClient = vi.fn(async () => ({ apps: catalogApps }))

vi.mock('@/store/atum-messaging', () => ({ ensureAtumSpecialistConversation, $atumIsAuthenticated: atom(false), $atumAccountScopeId: accountScope, $atumAccountStatus: atom({ account: null }) }))

import { $atumAppCatalog } from './atum-app-catalog'
import { handleAtumAppsNavigation } from './atum-app-navigation'

describe('Atum assistant app navigation', () => {
  beforeEach(() => {
    ensureAtumSpecialistConversation.mockClear()
    accountScope.set('account-a')
    window.history.replaceState(null, '', '/')
    ;(window as unknown as { hermesDesktop: { appSurface: { catalog: typeof catalogClient } } }).hermesDesktop = {
      appSurface: { catalog: catalogClient }
    }
  })

  const catalog = (apps: Array<Record<string, unknown>>) => {
    catalogApps = apps
    $atumAppCatalog.set({ accountId: 'account-a', state: 'ready', apps: apps as never[] })
  }

  beforeEach(() => {
    catalog([{ app: 'moon', availability: 'available', supported_modes: ['direct'], name: { en: 'Moon', vi: 'Moon' }, subtitle: null, icon: null, verified: true, link: { mode: 'none', state: 'never_linked' }, app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002' }])
  })

  it('switches through the existing specialist conversation authority and launcher navigation', async () => {
    const requestGateway = vi.fn(async () => undefined)
    const popstate = vi.fn()
    window.addEventListener('popstate', popstate, { once: true })

    const handled = await handleAtumAppsNavigation(
      {
        type: 'atum.apps.open.request',
        session_id: 'local-assistant',
        payload: { app_id: 'moon', request_id: 'request-1' }
      },
      { activeSessionId: 'local-assistant', requestGateway }
    )

    expect(handled).toBe(true)
    expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon')
    expect(window.location.pathname).toBe('/dm/conversation-moon')
    expect(popstate).toHaveBeenCalledOnce()
    expect(requestGateway).toHaveBeenCalledWith('atum.apps.open.respond', {
      request_id: 'request-1',
      result: JSON.stringify({ switched: true })
    })
  })

  it('rejects an invalid or background sender before touching the routing authority', async () => {
    const requestGateway = vi.fn(async () => undefined)

    await handleAtumAppsNavigation(
      {
        type: 'atum.apps.open.request',
        session_id: 'background',
        payload: { app_id: 'moon', request_id: 'request-2' }
      },
      { activeSessionId: 'local-assistant', requestGateway }
    )

    expect(ensureAtumSpecialistConversation).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith(
      'atum.apps.open.respond',
      expect.objectContaining({ result: expect.stringContaining('Only the active local assistant') })
    )
  })

  it('rejects an unavailable app from the server registration', async () => {
    catalog([{ app: 'andy', availability: 'unavailable', supported_modes: ['direct'], name: { en: 'Andy', vi: 'Andy' }, subtitle: null, icon: null, verified: true, link: { mode: 'none', state: 'never_linked' }, app_id: '00000000-0000-0000-0000-000000000003', app_version_id: '00000000-0000-0000-0000-000000000004' }])
    const requestGateway = vi.fn(async () => undefined)

    await handleAtumAppsNavigation(
      {
        type: 'atum.apps.open.request',
        session_id: 'local-assistant',
        payload: { app_id: 'andy', request_id: 'request-unavailable' }
      },
      { activeSessionId: 'local-assistant', requestGateway }
    )

    expect(ensureAtumSpecialistConversation).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith(
      'atum.apps.open.respond',
      expect.objectContaining({ result: expect.stringContaining('not available') })
    )
  })

  it('does not navigate when an account handoff wins the app open race', async () => {
    let release!: (value: string) => void
    ensureAtumSpecialistConversation.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const requestGateway = vi.fn(async () => undefined)
    const pending = handleAtumAppsNavigation(
      { type: 'atum.apps.open.request', session_id: 'local-assistant', payload: { app_id: 'moon', request_id: 'request-account-race' } },
      { activeSessionId: 'local-assistant', requestGateway }
    )
    await vi.waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon'))
    catalog([{ app: 'moon', availability: 'available', supported_modes: ['direct'], name: { en: 'Moon', vi: 'Moon' }, subtitle: null, icon: null, verified: true, link: { mode: 'none', state: 'never_linked' }, app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002' }])
    $atumAppCatalog.set({ accountId: 'account-b', state: 'ready', apps: $atumAppCatalog.get().apps })
    accountScope.set('account-b')
    release('conversation-moon')
    await pending
    expect(window.location.pathname).toBe('/')
    expect(requestGateway).toHaveBeenCalledWith('atum.apps.open.respond', expect.objectContaining({ result: expect.stringContaining('account changed') }))
  })

  it('does not navigate when the originating assistant loses the foreground while opening', async () => {
    let release!: (value: string) => void
    let activeSessionId: string | null = 'local-assistant'
    ensureAtumSpecialistConversation.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const requestGateway = vi.fn(async () => undefined)
    const pending = handleAtumAppsNavigation(
      { type: 'atum.apps.open.request', session_id: 'local-assistant', payload: { app_id: 'moon', request_id: 'request-foreground-race' } },
      { activeSessionId, getActiveSessionId: () => activeSessionId, requestGateway }
    )

    await vi.waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon'))
    activeSessionId = 'new-foreground'
    release('conversation-moon')
    await pending

    expect(window.location.pathname).toBe('/')
    expect(requestGateway).toHaveBeenCalledWith('atum.apps.open.respond', expect.objectContaining({ result: expect.stringContaining('assistant changed') }))
  })

  it('does not import or touch target conversation content, preview, or workspace stores', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/atum-app-navigation.ts'), 'utf8')

    expect(source).not.toMatch(/atum-dm-workspace|store\/preview|\$atumMessages|loadAtumMessages|artifact|panelTarget/)
  })
})
