import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAllBindings } from '@/store/keybinds'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixFounderContactResult } from '../../../shared/matrix-founder'
import { MatrixApp } from '../app'

import { closeFounderProfile } from './founder-store'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,ZmFrZQ==') } }))

const OWNER = '@owner:test'
const FOUNDER = '@user-0f1e2d3c4b5a69788796a5b4c3d2e1f0:test'

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

beforeEach(() => {
  resetAllBindings()
  vi.stubGlobal('innerWidth', 1220)
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  closeFounderProfile()
  resetAllBindings()
  vi.unstubAllGlobals()

  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }

  Reflect.deleteProperty(window, 'atumMatrix')
  window.localStorage.clear()
})

const founderChat: MatrixRoom = {
  id: '!founder:test',
  name: 'Founder',
  membership: 'join',
  encrypted: true,
  direct: true,
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: FOUNDER, membership: 'invite' }
  ]
}

const lookAlike: MatrixRoom = {
  ...founderChat,
  id: '!impostor:test',
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: '@founder:elsewhere.test', membership: 'join' }
  ]
}

const hello: MatrixMessage = {
  id: '$hello',
  sender: OWNER,
  body: 'Hello Founder',
  timestamp: 1,
  own: true,
  encrypted: true,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false
}

function signedIn(extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: OWNER, deviceId: 'OWNER' },
    rooms: [founderChat, lookAlike],
    roomId: '!founder:test',
    messages: [],
    canSend: true,
    error: null,
    founder: { userId: FOUNDER, verification: 'official', roomId: '!founder:test', handle: 'founder' },
    officialAccounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }],
    displayPreferences: {
      appearance: { value: 'system', writable: true },
      textSize: { value: 100, writable: true },
      language: { value: 'en', writable: true }
    },
    ...extra
  }
}

/** The real Matrix window on a fixed snapshot, with every native capability answered harmlessly. */
function open(state: MatrixSnapshot, contact?: () => Promise<MatrixFounderContactResult>) {
  window.localStorage.setItem('io.atum.desktop.language', 'en')
  window.localStorage.setItem('io.atum.welcome.played', '1')
  const command = vi.fn(async () => null)
  const noop = vi.fn(async () => {})

  const bridge = {
    windowFacts: vi.fn(async () => ({
      platform: 'darwin',
      isFullscreen: false,
      windowButtonPosition: { x: 12, y: 13 },
      overlayWidth: 0
    })),
    subscribeWindow: vi.fn(() => vi.fn()),
    setWindowMode: noop,
    snapshot: async () => state,
    signIn: noop,
    cancelSignIn: noop,
    signOut: noop,
    retry: noop,
    endDeviceSession: noop,
    document: noop,
    arrangeWord: noop,
    previewDocument: vi.fn(async () => ({ token: 't', name: 'n.txt', kind: 'text' as const, text: '' })),
    closeDocumentPreview: noop,
    pdf: { show: vi.fn(async () => ({ shown: true })), hide: noop, close: noop },
    readDomain: vi.fn(async () => ({ issuer: 'https://id.test/', subject: 'owner', principal: 'principal' })),
    cancelDomain: noop,
    enrollment: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    enrollHermes: vi.fn(async () => ({ state: 'ready' as const, identity: null })),
    setupAssistant: noop,
    revokeHermes: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    connectHermes: noop,
    invokeHermes: vi.fn(async () => ({ state: 'cancelled' as const })),
    sendAssistant: vi.fn(async () => ({ eventId: '$sent', result: { state: 'published' as const } })),
    recoverHermes: vi.fn(async () => ({ state: 'unknown' as const })),
    sendTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-11e594f48195' })),
    retryTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-e79acd97ac88' })),
    retryReadiness: noop,
    openTopUp: noop,
    cancelHermes: noop,
    createAgent: vi.fn(async () => ({ principal: 'p', roomId: '!a:test' })),
    importAgent: vi.fn(async () => ({ principal: 'p', roomId: '!a:test' })),
    retireAgent: vi.fn(async () => ({ sessionCleanup: 'complete' as const })),
    listenHermes: noop,
    setContinuousListening: noop,
    stopListeningHermes: noop,
    respondHermes: noop,
    configureHermes: vi.fn(async () => ({ state: 'ready' as const })),
    command,
    openLink: noop,
    subscribe: vi.fn(() => vi.fn()),
    ...(contact ? { founder: { contact: vi.fn(contact) } } : {})
  }

  window.atumMatrix = bridge as unknown as MatrixUiBridge
  render(<MatrixApp />)

  return bridge
}

const header = () => window.document.querySelector<HTMLElement>('[data-matrix-header-identity]')!

describe('the Founder chat in the Matrix window', () => {
  it('opens on the intro card, under a header with the raven, the mark and who they are', async () => {
    open(signedIn())

    await waitFor(() => expect(window.document.querySelector('[data-founder-intro]')).toBeTruthy())
    expect(window.document.querySelector('[data-founder-intro-text]')?.textContent).toBe(
      'Questions, ideas or problems? Message me here. I usually reply within a day.'
    )
    const identity = within(header()).getByRole('button', { name: 'Founder, Official Atum account, Atum founder' })
    expect(identity.querySelector('[data-founder-avatar]')).toBeTruthy()
    expect(identity.querySelector('[data-verified-mark="official"]')).toBeTruthy()

    fireEvent.click(identity)
    const sheet = await screen.findByRole('dialog', { name: /Founder/ })
    expect(within(sheet).getByText('Usually replies within a day')).toBeTruthy()
  })

  it('draws no intro card once the chat has a message', async () => {
    open(signedIn({ messages: [hello] }))

    await screen.findByText('Hello Founder')
    expect(window.document.querySelector('[data-founder-intro]')).toBeNull()
    expect(within(header()).getByRole('button', { name: 'Founder, Official Atum account, Atum founder' })).toBeTruthy()
  })

  it('treats a look-alike as an ordinary chat: no intro card, no raven, no mark', async () => {
    open(signedIn({ roomId: '!impostor:test' }))

    await waitFor(() => expect(header().textContent).toContain('Founder'))
    expect(window.document.querySelector('[data-founder-intro]')).toBeNull()
    expect(header().querySelector('[data-founder-header]')).toBeNull()
    expect(header().querySelector('[data-verified-mark]')).toBeNull()
  })

  it('offers Contact us in Settings › Help, which opens the Founder chat', async () => {
    const bridge = open(signedIn({ roomId: null }), async () => ({ roomId: '!founder:test' }))

    await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    const account = await screen.findByRole('dialog', { name: 'Account' })
    fireEvent.click(within(within(account).getByRole('navigation')).getByRole('button', { name: 'Help' }))
    const settings = await screen.findByRole('dialog', { name: 'Help' })
    const contact = settings.querySelector<HTMLElement>('[data-founder-contact]')!
    expect(contact.querySelector('[data-founder-contact-title]')?.textContent).toBe('Founder')
    expect(contact.querySelector('[data-founder-contact-title] [data-verified-mark="official"]')).toBeTruthy()
    // A name and its mark, like every Settings row: no face.
    expect(contact.querySelector('[data-founder-avatar]')).toBeNull()

    await act(async () => {
      fireEvent.click(within(contact).getByRole('button', { name: 'Message' }))
    })
    expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!founder:test' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull())
  })
})
