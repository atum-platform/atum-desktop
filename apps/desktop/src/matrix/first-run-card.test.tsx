// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FIRST_RUN_GREETING_RETRY_MS } from '@/app/connections/first-run-controller'
import { resetFirstRunForTests } from '@/app/connections/first-run-store'
import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import type { MatrixGoogleConnectionBridge } from '../../shared/matrix-google-connections'

import { MatrixFirstRunCard, matrixFirstRunPlace, MatrixFolderAccessRecovery } from './first-run-card'
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

const WELCOME = 'Hi, I’m Atum. Connect what you’d like me to learn from.'

function show(snapshot = base, locale: Locale = 'en', props: Partial<Parameters<typeof MatrixFirstRunCard>[0]> = { greeting: WELCOME }) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixFirstRunCard roomId="!atum:test" snapshot={snapshot} {...props} />
    </I18nProvider>
  )
}

const row = (gate: string) => window.document.querySelector<HTMLElement>(`[data-atum-ask="${gate}"]`)
const askState = () => window.document.querySelector<HTMLElement>('[data-atum-first-run-ask]')?.dataset.atumFirstRunAsk

/** Choose what to connect: the full list in place of the ask row. */
async function choose() {
  fireEvent.click(await screen.findByRole('button', { name: 'Choose what to connect' }))
  await waitFor(() => expect(row('google')).not.toBeNull())
}

const permissionsSnapshot = (fullDisk: string) => ({
  platform: 'macos',
  permissions: {
    accessibility: 'not-granted',
    screen: 'not-granted',
    microphone: 'not-determined',
    automation: 'manual-check',
    files: 'manual-check',
    fullDisk,
    location: 'not-determined'
  }
})

/** A Mac where folders and Messages still need macOS: Documents not asked yet, Full Disk Access not granted. */
function macBridge() {
  const made = bridge()
  const value = made.value as unknown as Record<string, unknown>
  let fullDisk = 'not-granted'
  let listener: ((snapshot: ReturnType<typeof permissionsSnapshot>) => void) | undefined
  const order: string[] = []

  const folders = (mac: 'not-asked' | 'granted') => ({ platform: 'macos' as const, folders: [{ id: 'documents', kind: 'documents' as const, shared: true, mac }] })

  const apply = vi.fn(async () => {
    order.push('folders prompt')

    return folders('granted')
  })

  value.folderAccess = { read: vi.fn(async () => folders('not-asked')), apply, add: vi.fn(), remove: vi.fn() }

  const openSettings = vi.fn(async () => {
    order.push('full disk pane')
  })

  value.permissions = {
    status: vi.fn(async () => permissionsSnapshot(fullDisk)),
    openSettings,
    watch: vi.fn((next: typeof listener) => {
      listener = next

      return () => {
        listener = undefined
      }
    })
  }

  const agentSources = value.agentSources as { read: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }
  type View = { sources: unknown[] }
  const read = agentSources.read.getMockImplementation() as () => Promise<View>
  const set = agentSources.set.getMockImplementation() as (gate: string, enabled: boolean) => Promise<View>

  const withMessages = <T extends { sources: unknown[] }>(view: T) => ({
    ...view,
    sources: [...view.sources, { kind: 'mac.message-metadata', optOutGate: 'messages', availability: 'unavailable', grantable: true }]
  })

  agentSources.read.mockImplementation(async () => withMessages(await read()))
  agentSources.set.mockImplementation(async (gate: string, enabled: boolean) => withMessages(await set(gate, enabled)))

  made.google.connect.mockImplementation(async () => {
    order.push('google browser')

    return made.google.status()
  })

  return {
    ...made,
    apply,
    openSettings,
    order,
    grantFullDisk() {
      fullDisk = 'granted'
      listener?.(permissionsSnapshot('granted'))
    }
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetFirstRunForTests()
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

describe('the welcome and the one Connections list', () => {
  it('flows the assistant’s own welcome into one action row, and Choose what to connect opens the list in three groups', async () => {
    const { google } = bridge()
    const view = show()

    expect(screen.getByText(WELCOME)).toBeTruthy()
    expect(view.container.querySelector('input, textarea, form')).toBeNull()
    expect(view.container.querySelectorAll('[data-atum-first-run-connections]')).toHaveLength(1)
    // The agent asked in its welcome; the window only answers it: Sure, a quiet Not now, and the list one tap away.
    expect(screen.getByRole('button', { name: 'Sure' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    expect(row('google')).toBeNull()

    await choose()
    expect(screen.queryByRole('button', { name: 'Sure' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'AI plans' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'This Mac' })).toBeTruthy()
    expect(row('folders')).not.toBeNull()
    expect(view.container.querySelector('[data-matrix-google-nudge], [data-matrix-starter-notice]')).toBeNull()
    expect(google.status).not.toHaveBeenCalled()
  })

  it('never stands in a ready-made greeting: a typing bubble, then a retry, then one quiet line', async () => {
    vi.useFakeTimers()
    bridge()
    const resend = vi.fn(async () => {})
    const view = show(base, 'en', { greetingPending: true, resendGreeting: resend })

    expect(view.container.querySelector('[data-matrix-first-run-greeting="pending"]')).not.toBeNull()
    expect(view.container.querySelector('[data-atum-first-run-connections]')).toBeNull()
    expect(view.container.textContent).not.toMatch(/Hi Minh|rename me/u)

    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS))
    expect(resend).toHaveBeenCalledOnce()
    expect(screen.getByText('Taking a little longer…')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS))
    expect(screen.getByText('Atum isn’t answering yet.')).toBeTruthy()
    // Nobody is stuck behind a silent assistant: the list shows with the quiet line.
    expect(view.container.querySelector('[data-atum-first-run-connections]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(resend).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Taking a little longer…')).toBeTruthy()
  })

  it('a welcome that arrives late replaces the waiting state', () => {
    vi.useFakeTimers()
    bridge()
    const resend = vi.fn(async () => {})
    const view = show(base, 'en', { greetingPending: true, resendGreeting: resend })

    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS * 2))
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFirstRunCard greeting={WELCOME} roomId="!atum:test" snapshot={base} />
      </I18nProvider>
    )

    expect(screen.getByText(WELCOME)).toBeTruthy()
    expect(screen.queryByText('Atum isn’t answering yet.')).toBeNull()
  })

  it('Google is one browser trip from its own row, and the first connected source admits first learning once', async () => {
    const { google, set, start } = bridge()
    show()

    await choose()
    fireEvent.click(within(row('google')!).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(google.connect).toHaveBeenCalledExactlyOnceWith('google'))
    await waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith('google', true))
    await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith({ locale: 'en', ending: 'done', roomId: '!atum:test' }))
    await waitFor(() => expect(row('google')!.dataset.atumFirstRunState).toBe('connected'))

    fireEvent.click(within(row('folders')!).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('folders', true))
    expect(start).toHaveBeenCalledOnce()
    expect(google.connect).toHaveBeenCalledOnce()
  })

  it('Skip the rest marks the open rows skipped and declines learning when nothing was connected', async () => {
    const { decline, set, start } = bridge()
    show()

    await choose()
    fireEvent.click(screen.getByRole('button', { name: 'Skip the rest' }))
    await waitFor(() => expect(decline).toHaveBeenCalledOnce())
    expect(start).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(row('google')!.dataset.atumFirstRunState).toBe('skipped')
    expect(screen.queryByRole('button', { name: 'Skip the rest' })).toBeNull()
    // A skipped row can still be connected from the list.
    expect(within(row('google')!).getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.getByText(WELCOME)).toBeTruthy()
  })

  it('connects an already-signed-in Google account automatically, before the welcome, and learning waits for the answer', async () => {
    const { google, set, start } = bridge()
    const signedIn = { ...base, googleAssistant: { state: 'ready' as const, services: { gmail: true, send: true, calendar: true, drive: true } } }
    const view = show(signedIn, 'en', { greetingPending: true })

    // Nothing to ask: the hidden list connects it while the welcome is written, so the welcome can name it.
    await waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith('google', true))
    expect(google.connect).not.toHaveBeenCalled()
    // Learning would close the welcome before it arrives: it starts with the person's answer instead.
    expect(start).not.toHaveBeenCalled()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFirstRunCard greeting={WELCOME} roomId="!atum:test" snapshot={signedIn} />
      </I18nProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Sure' }))
    await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith({ locale: 'en', ending: 'done', roomId: '!atum:test' }))
    await waitFor(() => expect(askState()).toBe('done'))
    // Sure ran what was left (folders, with no macOS prompt on this bridge); the summary names everything connected.
    expect(set.mock.calls).toEqual([['google', true], ['folders', true]])
    expect(screen.getByText('Connected Google and Mac folders')).toBeTruthy()
  })

  it('Sure runs each native macOS step in turn, Messages waits for Full Disk Access, and Google comes last as one tap', async () => {
    const { apply, google, grantFullDisk, openSettings, order, set, start } = macBridge()
    show()

    fireEvent.click(await screen.findByRole('button', { name: 'Sure' }))

    // Folders first: one macOS prompt; that first connected source admits first learning.
    await waitFor(() => expect(apply).toHaveBeenCalledOnce())
    await waitFor(() => expect(set).toHaveBeenCalledWith('folders', true))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())

    // Messages: the Full Disk Access pane, and nothing else opens over it until it is answered.
    await waitFor(() => expect(openSettings).toHaveBeenCalledExactlyOnceWith('fullDisk'))
    expect(screen.getByRole('status').textContent).toBe('Allow Full Disk Access in System Settings · Google next')
    expect(google.connect).not.toHaveBeenCalled()
    expect(askState()).toBe('running')

    act(() => grantFullDisk())
    await waitFor(() => expect(set).toHaveBeenCalledWith('messages', true))

    // Google never opens the browser by itself: one tap, last.
    await waitFor(() => expect(askState()).toBe('google'))
    expect(google.connect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }))
    await waitFor(() => expect(askState()).toBe('done'))

    expect(order).toEqual(['folders prompt', 'full disk pane', 'google browser'])
    expect(screen.getByText('Connected Google, Documents and Messages')).toBeTruthy()
    expect(start).toHaveBeenCalledOnce()
  })

  it('a step the person leaves settles quietly and the next one runs', async () => {
    const { google, openSettings } = macBridge()
    show()

    fireEvent.click(await screen.findByRole('button', { name: 'Sure' }))
    await waitFor(() => expect(openSettings).toHaveBeenCalledOnce())

    // Back in Atum without the grant: the step settles (Messages asks for a restart in the list) and Google is offered.
    act(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(askState()).toBe('google'))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(askState()).toBe('done'))
    expect(google.connect).not.toHaveBeenCalled()
  })

  it('Not now asks nothing more, declines learning when nothing is connected, and keeps the list one tap away', async () => {
    const { decline, google, set, start } = bridge()
    show()

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(decline).toHaveBeenCalledOnce())
    expect(askState()).toBe('later')
    expect(screen.queryByRole('button', { name: 'Sure' })).toBeNull()
    expect(start).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(google.connect).not.toHaveBeenCalled()

    await choose()
    expect(row('google')!.dataset.atumFirstRunState).toBe('skipped')
  })

  it('keeps the same list after a skip, with no separate Google chip', async () => {
    bridge()
    show(base, 'en', { greeting: WELCOME, skipped: true })

    await waitFor(() => expect(row('google')).not.toBeNull())
    expect(window.document.querySelector('[data-matrix-first-run="skipped"]')).not.toBeNull()
    expect(window.document.querySelector('[data-matrix-google-nudge]')).toBeNull()
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
