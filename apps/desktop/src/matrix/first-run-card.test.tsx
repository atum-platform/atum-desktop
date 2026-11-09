// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { matrixFirstRunCopy } from '../../shared/matrix-first-run-copy'
import type { MatrixGoogleConnectionBridge } from '../../shared/matrix-google-connections'

import { MatrixFirstRunCard, matrixFirstRunPlace, MatrixFolderAccessRecovery } from './first-run-card'
import { resetMatrixGoogleNudgeDismissals } from './google-connection-settings'
import { AssistantGreeting } from './greeting'

const owner = { userId: '@minh:test', deviceId: 'MAC' }
const atum = { userId: '@atum:test', deviceId: 'ATUM' }
const moon = { userId: '@moon:test', deviceId: 'MOON' }
const ATUM_PRINCIPAL = '00000000-0000-4000-8000-576f18824476'
const MOON_PRINCIPAL = '00000000-0000-4000-8000-951c747b3afc'

const chat = (id: string, agent = atum.userId): MatrixRoom => ({
  id,
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: owner.userId, membership: 'join' },
    { userId: agent, membership: 'invite' }
  ]
})

const base: MatrixSnapshot = {
  state: 'ready',
  identity: owner,
  assistant: atum,
  ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  firstRunMarker: 'unseen',
  firstRunWelcome: 'open',
  firstRun: 'offer',
  firstRunOpen: true,
  googleAssistant: { state: 'connect' },
  agents: [
    {
      principal: ATUM_PRINCIPAL,
      userId: atum.userId,
      name: 'Atum',
      isDefault: true,
      ready: true,
      hermes: 'ready',
      atumModel: true
    },
    {
      principal: MOON_PRINCIPAL,
      userId: moon.userId,
      name: 'Moon',
      isDefault: false,
      ready: true,
      hermes: 'ready',
      atumModel: true
    }
  ]
}

function googleBridge(): MatrixGoogleConnectionBridge & { connect: ReturnType<typeof vi.fn> } {
  const status = {
    available: true,
    sources: [
      {
        id: 'mail',
        groupId: 'account',
        provider: 'google' as const,
        kind: 'email' as const,
        label: 'minh@example.com',
        state: 'connected' as const,
        enabled: true
      }
    ]
  }

  return {
    status: vi.fn(async () => ({ status })),
    connect: vi.fn(async () => ({ status })),
    disconnect: vi.fn(async () => ({ status })),
    setSourcePreferences: vi.fn(async () => ({ status }))
  }
}

function bridge(google = googleBridge()) {
  const start = vi.fn(async () => {})
  const decline = vi.fn(async () => {})
  let sourceView = {
    gates: { google: false, folders: false, messages: false, browser: false, location: false, team_spaces: false },
    sources: [
      { kind: 'google.mail', optOutGate: 'google', availability: 'unavailable' as const, grantable: true },
      { kind: 'mac.files', optOutGate: 'folders', availability: 'unavailable' as const, grantable: true }
    ]
  }
  const set = vi.fn(async (gate: keyof typeof sourceView.gates, enabled: boolean) => {
    sourceView = { ...sourceView, gates: { ...sourceView.gates, [gate]: enabled } }
    return sourceView
  })
  const value = {
    agentSources: { read: vi.fn(async () => sourceView), set },
    googleConnections: google,
    firstRun: { start, allow: vi.fn(), decline, finish: vi.fn() },
    permissions: {
      status: vi.fn(async () => ({
        platform: 'macos',
        permissions: {
          accessibility: 'not-granted',
          screen: 'not-granted',
          microphone: 'not-determined',
          automation: 'manual-check',
          files: 'manual-check',
          fullDisk: 'granted',
          location: 'not-determined'
        }
      })),
      openSettings: vi.fn(async () => {}),
      watch: vi.fn(() => () => {})
    }
  } as unknown as MatrixUiBridge
  window.atumMatrix = value

  return { decline, google, set, start, value }
}

function show(snapshot = base, locale: Locale = 'en', assistantName?: string) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixFirstRunCard assistantName={assistantName} roomId="!atum:test" snapshot={snapshot} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  resetMatrixGoogleNudgeDismissals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('first-run account and conversation fences', () => {
  it('shows only in the new account primary conversation, never an answered or unknown marker', () => {
    expect(matrixFirstRunPlace(base)).toBe(true)

    const first = { ...base, rooms: [chat('!first:test')], roomId: '!first:test' }
    expect(matrixFirstRunPlace(first, '!first:test')).toBe(true)

    const second = { ...first, rooms: [chat('!first:test'), chat('!second:test')], roomId: '!second:test' }
    expect(matrixFirstRunPlace(second, '!second:test')).toBe(false)
    expect(matrixFirstRunPlace(second, '!first:test')).toBe(false)

    const moonsChat = {
      ...base,
      assistant: moon,
      rooms: [chat('!moon:test', moon.userId)],
      roomId: '!moon:test'
    }

    expect(matrixFirstRunPlace(moonsChat, '!moon:test')).toBe(false)
    expect(matrixFirstRunPlace({ ...base, firstRunMarker: 'unknown' })).toBe(false)
    expect(matrixFirstRunPlace({ ...base, firstRunOpen: undefined })).toBe(false)
  })

  it('belongs only to an account whose durable welcome record says open', () => {
    for (const firstRunWelcome of ['done', 'dismissed', 'unseen', 'unknown', undefined] as const) {
      expect(matrixFirstRunPlace({ ...base, firstRunWelcome }), String(firstRunWelcome)).toBe(false)
    }
  })

  it('is independent of where the primary assistant answers', () => {
    expect(matrixFirstRunPlace({ ...base, firstRun: undefined })).toBe(true)
  })
})

describe('the greeting and inline connect card', () => {
  it('keeps naming conversational and puts the source checklist inline', async () => {
    const { google } = bridge()
    const view = show()

    expect(screen.getByText(/^Hi Minh, I’m Atum\./)).toBeTruthy()
    expect(view.container.querySelector('input, textarea, form')).toBeNull()
    expect(view.container.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
    expect(view.container.querySelector('[data-checklist-row]')).toBeNull()
    expect(view.container.querySelector('[data-matrix-first-run-connect-card]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Let me get to know your world' })).toBeTruthy()
    expect(screen.queryByText('This Mac')).toBeNull()
    expect(await screen.findByText('Mac folders')).toBeTruthy()
    expect(google.status).not.toHaveBeenCalled()
  })

  it('uses the real assistant name and localized greeting in every locale', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[]) {
      bridge()
      const snapshot = { ...base, agents: [{ ...base.agents![0]!, name: 'Mây' }, base.agents![1]!] }
      const view = show(snapshot, locale)
      const greeting = view.container.querySelector('p')!.textContent!

      expect(greeting).toBe(matrixFirstRunCopy(locale).greeting('Minh', 'Mây'))
      cleanup()
    }
  })

  it('runs the approved registry-fed Continue sequence', async () => {
    const { google, set, start } = bridge()
    show()

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(google.connect).toHaveBeenCalledExactlyOnceWith('google'))
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith({ locale: 'en', ending: 'done', roomId: '!atum:test' })
    )
  })

  it('settles without learning and keeps the greeting usable on Not now', async () => {
    const { decline, set, start } = bridge()
    show()

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(decline).toHaveBeenCalledOnce())
    expect(start).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Let me get to know your world' })).toBeNull()
    expect(screen.getByText(/^Hi Minh, I’m Atum\./)).toBeTruthy()
  })

  it('keeps the registry row when Google is already connected', async () => {
    bridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFirstRunCard
          snapshot={{
            ...base,
            googleAssistant: {
              state: 'ready',
              services: { gmail: true, send: true, calendar: true, drive: true }
            }
          }}
        />
      </I18nProvider>
    )
    await screen.findByText('Google')
    expect(window.document.querySelector('[data-atum-ask="google"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Let me get to know your world' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  })

  it('keeps the registry row visible when connecting would not help yet', async () => {
    bridge()
    show({ ...base, googleAssistant: { state: 'unavailable', reason: 'route' } })
    await screen.findByRole('heading', { name: 'Let me get to know your world' })
    expect(window.document.querySelector('[data-atum-ask="google"]')).not.toBeNull()
  })

  it('replaces the initial card with the small chip after skip', () => {
    bridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFirstRunCard roomId="!atum:test" skipped snapshot={base} />
      </I18nProvider>
    )

    expect(window.document.querySelector('[data-matrix-first-run-connect-card]')).toBeNull()
    expect(window.document.querySelector('[data-matrix-google-nudge][data-placement="greeting"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeTruthy()
  })
})

describe('just-in-time folder recovery', () => {
  it('shows one short line and one System Settings action only after macOS refuses the read', async () => {
    const openSettings = vi.fn(async () => {})
    const permissions = { status: vi.fn(), openSettings }

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFolderAccessRecovery bridge={{ permissions }} snapshot={{ ...base, firstRun: 'offer' }} />
      </I18nProvider>
    )

    expect(view.container.querySelector('[data-matrix-folder-access-recovery]')).toBeNull()
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFolderAccessRecovery bridge={{ permissions }} snapshot={{ ...base, firstRun: 'blocked' }} />
      </I18nProvider>
    )

    expect(screen.getByText('macOS kept those folders closed.')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    await waitFor(() => expect(openSettings).toHaveBeenCalledExactlyOnceWith('files'))
  })
})

describe('ordinary empty chats', () => {
  it('do not repeat the first-run naming invitation', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      render(
        <I18nProvider configClient={null} initialLocale={locale}>
          <AssistantGreeting brand id="atum" name="Atum" />
        </I18nProvider>
      )

      expect(window.document.querySelector('[data-matrix-greeting]')).not.toBeNull()
      expect(window.document.body.textContent).not.toContain('You can rename me anytime')
      cleanup()
    }
  })
})
