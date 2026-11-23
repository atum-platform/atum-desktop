import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $accountConnect, resetAccountConnectionsForTest } from '@/app/connections/store'
import { I18nProvider } from '@/i18n'

import { ACCOUNT_CONNECTIONS_FIXTURE, type AccountConnectionsView } from '../../shared/account-connections'
import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixOwnerLocationView } from '../../shared/matrix-owner-location'
import {
  MATRIX_SETTINGS_DESTINATIONS,
  MATRIX_SETTINGS_GROUPS,
  matrixSettingsRevampCopy,
  phoneSettingsCopy
} from '../../shared/matrix-settings-revamp-copy'

import { $assistantCard } from './assistant-card/store'
import { scenarioSnapshot } from './playground/fixtures'
import {
  normalizeMatrixSettingsPane,
  settingsLocalRuntimeControlsShown,
  settingsPageOf,
  SettingsRevampPane
} from './settings-revamp'
import { type MatrixSettingsPane, MatrixSettingsSheet } from './settings-sheet'

vi.mock('./alias-settings', () => ({ MatrixAliasSettings: () => <button>Public handle</button> }))
vi.mock('./app-bots/settings', () => ({ AppBotSettings: () => <button>Installed apps</button> }))
vi.mock('./cloud-device-settings', () => ({ MatrixCloudDeviceSettings: () => <button>Cloud devices</button> }))
vi.mock('./desktop-settings', () => ({
  $matrixFeedbackOpen: atom(false),
  MatrixDesktopSettings: () => (
    <div>
      <button>Software update</button>
      <button>Usage sharing and feedback</button>
    </div>
  )
}))
vi.mock('./display-settings', () => ({
  MatrixDisplaySettings: () => <button>Display controls</button>,
  MatrixNotificationSettings: () => <button>Notification controls</button>,
  useMatrixDisplaySetting: () => ({
    change: vi.fn(async () => true),
    copy: { failed: 'Failed', waiting: 'Waiting', readonly: 'Read only' },
    disabled: false,
    notice: null,
    readonly: false
  })
}))
vi.mock('./domain', () => ({
  AssistantRepair: () => <button>Repair assistant</button>,
  DomainIdentity: () => <button>Technical identity</button>
}))
vi.mock('./founder/contact-us', () => ({ FounderContactUs: () => <button>Contact Atum</button> }))
vi.mock('./google-connection-settings', () => ({
  MatrixGoogleConnectionSettings: () => <button>Google connection</button>
}))
vi.mock('./hermes-setup', () => ({ HermesSetup: () => <button>Providers and ChatGPT</button> }))
vi.mock('./ignored-people', () => ({ IgnoredPeople: () => <button>Blocked people</button> }))
vi.mock('./keep-awake-settings', () => ({ MatrixKeepAwakeSettings: () => <button>Keep awake</button> }))
vi.mock('./language', () => ({ MatrixLanguageSettings: () => <button>Language</button> }))
vi.mock('./legal-settings', () => ({
  MatrixDeleteAccount: () => <button>Request account deletion</button>,
  MatrixLegalSettings: () => <button>Legal</button>
}))
vi.mock('./login-startup-settings', () => ({ MatrixLoginStartupSettings: () => <button>Start at login</button> }))
const mounts = vi.hoisted(() => ({ recovery: 0 }))

vi.mock('./security-panel', async () => {
  const { useEffect } = await import('react')

  return {
    DevicesPanel: () => <button>Trusted devices</button>,
    RecoveryKeyPanel: () => {
      useEffect(() => {
        mounts.recovery += 1
      }, [])

      return <button>Recovery key</button>
    }
  }
})
vi.mock('./store/protons-pane', () => ({ MatrixProtonsPane: () => <button>Wallet activity</button> }))
vi.mock('./workplace', () => ({
  workplacePageText: (page: string) => ({ title: page === 'mcp' ? 'MCP' : 'Scheduled tasks', help: 'Existing page' })
}))
vi.mock('./workplace-nav', () => ({
  workplaceDeveloperPages: (agent: { answering?: string } | undefined, cloudOnly = true) =>
    cloudOnly && agent?.answering === 'cloud' ? [] : ['scheduled', 'mcp']
}))

const fixtureSnapshot = scenarioSnapshot('chat')

const baseSnapshot: MatrixSnapshot = {
  ...fixtureSnapshot,
  displayPreferences: {
    appearance: { value: 'system', writable: true },
    textSize: { value: 100, writable: true },
    shareActivity: { value: true, writable: true }
  }
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

function view(node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )
}

function Harness({
  initial = 'account',
  onClosed,
  snapshot = baseSnapshot
}: {
  initial?: MatrixSettingsPane
  onClosed?(): void
  snapshot?: MatrixSnapshot
}) {
  const [open, setOpen] = useState(true)
  const [pane, setPane] = useState<MatrixSettingsPane>(initial)

  return (
    <MatrixSettingsSheet
      fail={() => {}}
      onClose={() => {
        setOpen(false)
        onClosed?.()
      }}
      onEditProfile={() => {}}
      onOpenAdvancedPage={() => {}}
      onPaneChange={setPane}
      open={open}
      pane={pane}
      snapshot={snapshot}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  $assistantCard.set(null)
  window.atumMatrix = {
    command: vi.fn(async () => []),
    endDeviceSession: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
    pages: {},
    retry: vi.fn(async () => undefined)
  } as unknown as MatrixUiBridge
})

afterEach(() => {
  $assistantCard.set(null)
  cleanup()
  vi.restoreAllMocks()
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the fixed Settings information architecture', () => {
  it('publishes the same complete key contract in all five phone-export locales', () => {
    const locales = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const
    const english = matrixSettingsRevampCopy('en')

    for (const locale of locales) {
      const localized = matrixSettingsRevampCopy(locale)

      expect(Object.keys(localized)).toEqual(Object.keys(english))
      expect(Object.keys(localized.destinations)).toEqual(MATRIX_SETTINGS_DESTINATIONS)
      expect(Object.keys(localized.groups)).toEqual(MATRIX_SETTINGS_GROUPS.map(group => group.id))
      expect(Object.values(localized).every(value => typeof value === 'object' || value.length > 0)).toBe(true)
      expect(Object.values(localized.destinations).every(label => label.length > 0)).toBe(true)
    }
  })

  it('writes the phone-only Settings words in all five phone-export locales', () => {
    const locales = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const

    for (const locale of locales) {
      expect(Object.keys(phoneSettingsCopy[locale])).toEqual(Object.keys(phoneSettingsCopy.en))
      expect(Object.values(phoneSettingsCopy[locale]).every(word => word.trim().length > 0)).toBe(true)
    }
  })

  it('groups every destination exactly once, in the shared reading order', () => {
    expect(MATRIX_SETTINGS_GROUPS.flatMap(group => group.destinations)).toEqual(MATRIX_SETTINGS_DESTINATIONS)
  })

  it('draws the six Atum Kit pages in named groups; Protons, Privacy and This Mac are sections', () => {
    const { container } = view(<Harness />)

    const ids = [...container.querySelectorAll('[data-matrix-settings-pane]')].map(row =>
      row.getAttribute('data-matrix-settings-pane')
    )

    expect(ids).toEqual(['account', 'assistants', 'connections', 'general', 'help', 'advanced'])
    // Every shared destination still lands on a page.
    expect(new Set(MATRIX_SETTINGS_DESTINATIONS.map(settingsPageOf))).toEqual(new Set(ids))

    const groups = within(screen.getByRole('navigation')).getAllByRole('group')
    const english = matrixSettingsRevampCopy('en')

    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual([
      english.groups.you,
      english.groups.app,
      english.groups.support
    ])
    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy()
  })

  it('shows the signed-in identity above separated navigation groups', () => {
    const { container } = view(<Harness />)
    const identity = container.querySelector('[data-matrix-settings-identity]')!

    expect(identity.textContent).toContain('minh')
    expect(container.querySelectorAll('nav > [role="separator"]')).toHaveLength(2)
  })

  it('orders General as Appearance, Text size, Language and uses kit section anatomy', () => {
    const { container } = view(<Harness initial="general" />)
    const pane = container.querySelector('[data-matrix-settings-destination="general"]')!
    const controls = [...pane.querySelectorAll('button')].map(button => button.textContent)

    expect(controls.indexOf('Display controls')).toBeLessThan(controls.indexOf('Language'))
    expect(pane.querySelector('.ak-section')?.textContent).toBe('Look')
    expect(pane.querySelector('.ak-group')).toBeTruthy()
    expect(screen.queryByText(/model choice/iu)).toBeNull()
  })

  it('keeps assistant rows free of placement/runtime copy and drops the repeated section title', () => {
    const { container } = view(<Harness initial="assistants" />)
    const pane = container.querySelector('[data-matrix-settings-destination="assistants"]')!

    expect(pane.querySelector('.ak-section')).toBeNull()
    expect(pane.textContent).not.toMatch(/Answers on this Mac|Answers in the cloud|Ready/u)
    expect(pane.textContent).toContain('Your main assistant')
  })

  it('keeps account-wide subscriptions in Connections while Advanced stays assistant-specific', () => {
    const { container } = view(<Harness initial="connections" />)
    const pane = container.querySelector('[data-matrix-settings-destination="connections"]')!
    const headings = [...pane.querySelectorAll('.ak-section')].map(section => section.textContent)

    expect(headings[0]).toContain('Subscriptions')
    expect(pane.querySelector('[data-atum-connection="codex"]')).toBeTruthy()
    expect(pane.textContent).not.toMatch(/runs on this Mac|answers with Atum’s AI/iu)

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    const advanced = container.querySelector('[data-matrix-settings-destination="advanced"]')!
    expect(advanced.querySelector('[data-atum-connection]')).toBeNull()
  })

  it('keeps the adjudicated controls at their single destination', () => {
    const { container } = view(<Harness />)
    const nav = screen.getByRole('navigation')

    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Request account deletion' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Public handle' })).toBeNull()
    // The assistants list has one home now: Assistants, not Account as well.
    expect(window.document.querySelectorAll('[data-matrix-settings-assistant]').length).toBe(0)

    fireEvent.click(within(nav).getByRole('button', { name: 'Assistants' }))
    expect(window.document.querySelectorAll('[data-matrix-settings-assistant]').length).toBeGreaterThan(0)

    fireEvent.click(within(nav).getByRole('button', { name: 'General' }))
    expect(screen.getByRole('button', { name: 'Language' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Display controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notification controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start at login' })).toBeTruthy()

    // Connections is account-wide: subscriptions and shared sources, never an assistant page.
    fireEvent.click(within(nav).getByRole('button', { name: 'Connections' }))
    expect(screen.getByRole('button', { name: 'Google connection' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Installed apps' })).toBeTruthy()
    expect(
      container.querySelector('[data-matrix-settings-destination="connections"] [data-atum-connection="codex"]')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep awake' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cloud devices' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mac permissions' })).toBeNull()

    // Account holds Privacy & security below the account itself.
    fireEvent.click(within(nav).getByRole('button', { name: 'Account' }))
    expect(screen.getByText('How Atum answers')).toBeTruthy()
    expect(
      container.querySelector('[data-matrix-settings-destination="account"] [data-atum-connection]')
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Recovery key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trusted devices' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Share activity' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Blocked people' })).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('button', { name: 'Software update' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Usage sharing and feedback' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Contact Atum' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Legal' })).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: 'Advanced' }))
    expect(
      container.querySelector('[data-matrix-settings-destination="advanced"] [data-atum-connection]')
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Providers and ChatGPT' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Repair assistant' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Technical identity' })).toBeTruthy()
    expect(screen.getByText('For developers')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Scheduled tasks/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /MCP/u })).toBeTruthy()
  })

  it('keeps local model and repair controls only when the cloud-only switch is off', () => {
    expect(settingsLocalRuntimeControlsShown()).toBe(false)
    expect(settingsLocalRuntimeControlsShown(false)).toBe(true)

    view(
      <SettingsRevampPane
        cloudOnly={false}
        current="advanced"
        fail={() => {}}
        onClose={() => {}}
        onOpenAdvancedPage={() => {}}
        open
        snapshot={baseSnapshot}
      />
    )

    expect(screen.getByRole('button', { name: 'Providers and ChatGPT' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Repair assistant' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Technical identity' })).toBeTruthy()
  })

  it('hides Mac-hosted developer pages for the selected cloud assistant', () => {
    const cloud = {
      ...baseSnapshot,
      agents: baseSnapshot.agents?.map(agent => ({ ...agent, answering: 'cloud' as const }))
    }

    view(<Harness initial="advanced" snapshot={cloud} />)

    expect(screen.queryByRole('button', { name: /Scheduled tasks/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /MCP/u })).toBeNull()
    expect(screen.queryByText('For developers')).toBeNull()
    expect(screen.getByRole('button', { name: 'Technical identity' })).toBeTruthy()
  })

  it('offers only a Mac-homed straggler in the assistant picker when the primary is cloud-only', async () => {
    const primary = baseSnapshot.agents?.[0]!
    const snapshot: MatrixSnapshot = {
      ...baseSnapshot,
      agents: [
        { ...primary, name: 'Atum', isDefault: true, answering: 'cloud' },
        {
          ...primary,
          principal: 'local-agent',
          userId: '@local:atum.chat',
          name: 'Research',
          isDefault: false,
          answering: undefined
        }
      ]
    }

    view(<Harness initial="advanced" snapshot={snapshot} />)

    expect(screen.getByText('For developers')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Scheduled tasks/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'Assistants' }))
    expect(await screen.findByRole('option', { name: 'Research' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Atum' })).toBeNull()
  })

  it('lands the recovery and device-review links on the pane that holds both', () => {
    view(<Harness initial="privacy" />)

    expect(screen.getByRole('heading', { name: 'Privacy & security' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recovery key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trusted devices' })).toBeTruthy()
  })

  it('leads Privacy & security with your devices, then what is true for everyone, and puts the key last', () => {
    view(<Harness initial="privacy" />)
    const copy = matrixSettingsRevampCopy('en')
    const pane = window.document.querySelector('[data-matrix-settings-destination="privacy"]')!
    const order = (node: Element) => Array.from(pane.querySelectorAll('*')).indexOf(node)

    // Chats are plain by default and encryption is opt-in: said first, in plain words.
    expect(copy.chatsStoredHelp).toMatch(/aren’t end-to-end encrypted by default/u)
    expect(copy.chatsStoredHelp).toMatch(/turn encryption on for a single chat/u)
    const chats = screen.getByText(copy.chatsStored)
    const memory = screen.getByText('Atum remembers')
    const key = screen.getByRole('button', { name: 'Recovery key' })
    const devices = screen.getByRole('button', { name: 'Trusted devices' })

    // Atum Kit board (Account › Devices): devices sit right under how Atum answers.
    expect(order(devices)).toBeLessThan(order(chats))
    expect(order(chats)).toBeLessThan(order(memory))
    expect(order(memory)).toBeLessThan(order(key))
    // The key's section says who it is for.
    expect(screen.getByText(copy.recoveryHelp)).toBeTruthy()
  })

  it('shows the owner’s coarse location and turns reporting off with one switch', async () => {
    const read = vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City', country: 'VN' }))
    const setEnabled = vi.fn(async () => ({ enabled: false }))
    window.atumMatrix = {
      ...(window.atumMatrix as MatrixUiBridge),
      ownerLocation: { read, setEnabled }
    } as unknown as MatrixUiBridge

    view(<Harness initial="privacy" />)
    const toggle = await screen.findByRole('switch', { name: 'Approximate location' })

    await waitFor(() => expect(screen.getByText('Around Ho Chi Minh City, Vietnam. Used to make answers fit your day.')).toBeTruthy())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false))
    await waitFor(() => expect(screen.getByText('Off. Assistants use your time zone only.')).toBeTruthy())
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('shows a default-on people discovery switch and saves an opt-out', async () => {
    const privacy = vi.fn(async () => ({ ok: true as const, enabled: true }))
    const setPrivacy = vi.fn(async (enabled: boolean) => ({ ok: true as const, enabled }))
    window.atumMatrix = { ...(window.atumMatrix as MatrixUiBridge), people: {
      search: vi.fn(), privacy, setPrivacy
    } } as unknown as MatrixUiBridge
    view(<Harness initial="privacy" />)
    const toggle = await screen.findByRole('switch', { name: 'Let people find me by name and email' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(toggle)
    await waitFor(() => expect(setPrivacy).toHaveBeenCalledWith(false))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('keeps the location switch disabled and not claiming on until the platform read lands', async () => {
    let resolveView!: (value: MatrixOwnerLocationView) => void
    const read = vi.fn(() => new Promise<MatrixOwnerLocationView>(resolve => { resolveView = resolve }))
    window.atumMatrix = {
      ...(window.atumMatrix as MatrixUiBridge),
      ownerLocation: { read, setEnabled: vi.fn() }
    } as unknown as MatrixUiBridge

    view(<Harness initial="privacy" />)
    const toggle = await screen.findByRole('switch', { name: 'Approximate location' })

    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-busy')).toBe('true')

    resolveView({ enabled: true, city: 'Ho Chi Minh City', country: 'VN' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
    expect(toggle.getAttribute('aria-busy')).toBeNull()
  })

  it('names the country in the owner’s UI language, not always English', async () => {
    const read = vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City', country: 'VN' }))
    window.atumMatrix = {
      ...(window.atumMatrix as MatrixUiBridge),
      ownerLocation: { read, setEnabled: vi.fn() }
    } as unknown as MatrixUiBridge

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <Harness initial="privacy" />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(screen.getByText('Ở Ho Chi Minh City, Việt Nam. Dùng để câu trả lời hợp với ngày của bạn.')).toBeTruthy()
    )
  })

  it('shows no location row when the host does not expose the bridge', () => {
    expect((window.atumMatrix as MatrixUiBridge).ownerLocation).toBeUndefined()
    view(<Harness initial="privacy" />)
    expect(screen.queryByRole('switch', { name: 'Approximate location' })).toBeNull()
  })

  it('brings the key forward only while this Mac cannot open the assistant without it, without remounting it', () => {
    const blocked: MatrixSnapshot = {
      ...baseSnapshot,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 }
    }

    const { rerender } = view(<Harness initial="privacy" />)
    const pane = () => window.document.querySelector('[data-matrix-settings-destination="privacy"]')!
    const position = (name: string) => Array.from(pane().querySelectorAll('*')).indexOf(screen.getByText(name))

    const mountedBefore = mounts.recovery
    expect(position('Recovery key')).toBeGreaterThan(position(matrixSettingsRevampCopy('en').chatsStored))

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <Harness initial="privacy" snapshot={blocked} />
      </I18nProvider>
    )

    expect(position('Recovery key')).toBeLessThan(position(matrixSettingsRevampCopy('en').chatsStored))
    // Moving the group is a reorder, never an unmount: a key being typed or shown stays put.
    expect(mounts.recovery).toBe(mountedBefore)
  })

  it('keeps legacy pane ids as compatibility aliases without adding destinations', () => {
    expect(normalizeMatrixSettingsPane('assistant')).toBe('advanced')
    expect(normalizeMatrixSettingsPane('cloud')).toBe('devices')
    expect(normalizeMatrixSettingsPane('apps')).toBe('connections')
    expect(normalizeMatrixSettingsPane('subscriptions')).toBe('connections')
  })
})

describe('honest unavailable states', () => {
  it('shows memory as not available yet: no switch, no destructive action, the disclosure kept', () => {
    view(<Harness initial="privacy" />)

    expect(screen.queryByRole('switch', { name: 'Atum remembers' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Forget/u })).toBeNull()
    expect(screen.getByText('Atum remembers')).toBeTruthy()
    expect(screen.getByText(matrixSettingsRevampCopy('en').memoryDisclosure)).toBeTruthy()
    // Where chats are kept is a plain statement, never a control.
    expect(screen.getByText('Kept on Atum’s servers')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kept on Atum’s servers' })).toBeNull()
  })

  it('keeps Protons in How Atum answers without a second balance pane', () => {
    const { container } = view(<Harness initial="protons" />)

    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy()
    expect(screen.getByText('Proton balance and activity will appear here when the wallet is available.')).toBeTruthy()
    expect(container.querySelector('[data-proton-amount]')).toBeNull()
    expect(container.querySelector('[data-matrix-balance]')).toBeNull()
  })

  it('does not revive a separate This Mac section inside Connections', () => {
    view(<Harness snapshot={{ ...baseSnapshot, state: 'error' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
    expect(screen.queryByText('This Mac')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry|Reconnect/u })).toBeNull()
  })
})

describe('navigation and overlay lifecycle', () => {
  it('opens every assistant in its canonical card and closes Settings first', async () => {
    const onClosed = vi.fn()
    view(<Harness initial="assistants" onClosed={onClosed} />)
    const first = baseSnapshot.agents![0]!

    fireEvent.click(window.document.querySelector(`[data-matrix-settings-assistant="${first.principal}"]`)!)

    expect(onClosed).toHaveBeenCalledOnce()
    await waitFor(() => expect($assistantCard.get()).toEqual({ kind: 'agent', principal: first.principal }))
  })

  it('focuses the sheet, closes one layer on Escape, and restores the invoking control', async () => {
    function FocusHarness() {
      const [open, setOpen] = useState(false)

      return (
        <>
          <button onClick={() => setOpen(true)}>Open Settings</button>
          <MatrixSettingsSheet
            fail={() => {}}
            onClose={() => setOpen(false)}
            onPaneChange={() => {}}
            open={open}
            pane="account"
            snapshot={baseSnapshot}
          />
        </>
      )
    }

    view(<FocusHarness />)
    const opener = screen.getByRole('button', { name: 'Open Settings' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog')

    expect(window.document.activeElement).toBe(dialog)
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => expect(window.document.activeElement).toBe(opener))
  })

  it('uses list then detail state with Back instead of squeezing both columns', () => {
    const { container } = view(<Harness />)
    const sheet = container.querySelector('.atum-settings-revamp')!

    expect(sheet.hasAttribute('data-narrow-detail')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    expect(sheet.hasAttribute('data-narrow-detail')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(sheet.hasAttribute('data-narrow-detail')).toBe(false)
  })

  it('returns a surviving sheet to Account when the signed-in account changes', async () => {
    function SwitchingHarness({ snapshot }: { snapshot: MatrixSnapshot }) {
      const [pane, setPane] = useState<MatrixSettingsPane>('privacy')

      return (
        <MatrixSettingsSheet
          fail={() => {}}
          onClose={() => {}}
          onPaneChange={setPane}
          open
          pane={pane}
          snapshot={snapshot}
        />
      )
    }

    const rendered = view(<SwitchingHarness snapshot={baseSnapshot} />)

    const next = {
      ...baseSnapshot,
      identity: { ...baseSnapshot.identity!, userId: '@other:example.invalid', deviceId: 'OTHER' }
    }

    rendered.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <SwitchingHarness snapshot={next} />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy())
  })
})

describe('Settings › Connections', () => {
  function useSubscriptions(opencode = false) {
    let connected = opencode

    const bridge = {
      status: vi.fn(async () => ({
        scope: 'account' as const,
        providers: [
          { id: 'openai-codex' as const, connected: false },
          { id: 'opencode-go' as const, connected }
        ]
      })),
      catalog: vi.fn(),
      connectOpenCode: vi.fn(async () => {
        connected = true

        return { status: 'applied' as const }
      }),
      disconnectOpenCode: vi.fn(async () => {
        connected = false
      })
    }

    window.atumMatrix = { ...window.atumMatrix, subscriptions: bridge } as unknown as MatrixUiBridge

    return bridge
  }

  function useWork(view: AccountConnectionsView | null = ACCOUNT_CONNECTIONS_FIXTURE) {
    const work = {
      read: vi.fn(async () => null),
      subscribe: vi.fn(() => () => {}),
      readConnections: vi.fn(async () => view),
      openPlanConnect: vi.fn(async () => {}),
      readPlanConsent: vi.fn(),
      setPlanConsent: vi.fn(),
      setPlan: vi.fn(async () => {})
    }

    window.atumMatrix = { ...window.atumMatrix, work } as unknown as MatrixUiBridge

    return work
  }

  const plan = (id: string) => within(window.document.querySelector<HTMLElement>(`[data-atum-connection="${id}"]`)!)

  beforeEach(() => resetAccountConnectionsForTest())

  it('lists every plan, connected or not, with one Connect each, and no Subscriptions pane anywhere else', async () => {
    useSubscriptions()
    const { container } = view(<Harness initial="subscriptions" />)
    const pane = container.querySelector('[data-matrix-settings-destination="connections"]')!

    expect([...pane.querySelectorAll('[data-atum-connection]')].map(row => row.getAttribute('data-atum-connection'))).toEqual([
      'codex',
      'claude',
      'antigravity',
      'opencode_go',
      'owner_chats'
    ])
    expect(plan('claude').getByText('Not connected')).toBeTruthy()

    fireEvent.click(plan('claude').getByRole('button', { name: 'Connect' }))
    expect($accountConnect.get()).toEqual({ plan: 'claude', mode: 'connect' })
    // No device-code sign-in, terms text or per-assistant list is drawn here.
    expect(pane.textContent).not.toMatch(/one-time code|device code|Assistants named|Allow/u)
  })

  it('reads the account registry: where each plan runs, Manage on this Mac opens its screen in Work, home tools listed', async () => {
    useSubscriptions()
    const work = useWork()
    const closed = vi.fn()
    view(<Harness initial="connections" onClosed={closed} />)

    expect(await plan('codex').findByText('On this Mac')).toBeTruthy()
    expect(plan('claude').getByText('Last seen on Mac mini')).toBeTruthy()
    expect(plan('claude').queryByRole('button')).toBeNull()
    expect(plan('antigravity').getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.getByText('Strap')).toBeTruthy()
    expect(screen.getByText('Every assistant knows your chats.')).toBeTruthy()

    fireEvent.click(plan('codex').getByRole('button', { name: 'Manage' }))
    await waitFor(() => expect(work.openPlanConnect).toHaveBeenCalledWith('codex'))
    expect(closed).toHaveBeenCalledOnce()
  })

  it('saves an OpenCode Go key through native main and clears the field', async () => {
    const bridge = useSubscriptions()
    view(<Harness initial="connections" />)

    fireEvent.click(plan('opencode_go').getByRole('button', { name: 'Connect' }))
    const field = await screen.findByLabelText('OpenCode Go key')
    fireEvent.change(field, { target: { value: 'synthetic-opencode-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.connectOpenCode).toHaveBeenCalledWith('synthetic-opencode-key'))
    await waitFor(() => expect(screen.queryByLabelText('OpenCode Go key')).toBeNull())
    expect(window.document.body.innerHTML).not.toContain('synthetic-opencode-key')
  })

  it('shows a connected OpenCode Go in the cloud, and Disconnect removes it', async () => {
    const bridge = useSubscriptions(true)
    view(<Harness initial="connections" />)

    expect(await plan('opencode_go').findByText('In the cloud')).toBeTruthy()
    fireEvent.click(plan('opencode_go').getByRole('button', { name: 'Manage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(bridge.disconnectOpenCode).toHaveBeenCalledOnce())
  })
})
