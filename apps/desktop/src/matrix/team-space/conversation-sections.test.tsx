import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import {
  MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE
} from '../../../shared/matrix-company-private-cos'
import type { MatrixNotesSelfSnapshot } from '../../../shared/matrix-notes-self'

import { ConversationSections } from './conversation-sections'
import type { CompanyPrivateCosState } from './private-cos-store'
import type { CompanyConversationView } from './views'

afterEach(cleanup)

const notes: MatrixNotesSelfSnapshot = {
  state: 'ready',
  roomId: '!notes:test',
  duplicates: [],
  quarantinedRoomIds: [],
  retiredRoomIds: [],
  pointerWritable: true
}

const conversation: CompanyConversationView = {
  id: '00000000-0000-4000-8000-ccee3c97274b',
  companyId: '00000000-0000-4000-8000-830c819b26f5',
  kind: 'dm',
  state: 'active',
  participants: [
    { memberRef: 'self', handle: 'me', displayName: 'Me' },
    { memberRef: 'other', handle: 'linh', displayName: 'Linh' }
  ],
  hidden: false,
  room: { state: 'ready', roomId: '!dm:test' },
  conversationGeneration: 1
}

const privateCos = (availability: CompanyPrivateCosState['availability']): CompanyPrivateCosState => ({
  served: true,
  profile: MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  capability: {
    schemaVersion: 3,
    profile: MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
    capability: 'company.private-cos',
    supportedProfiles: [
      'atum.company-private-cos/1',
      MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
      MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE
    ],
    wire: { header: 'Atum-Company-Wire', value: '1.2' },
    displayName: 'Chief of Staff',
    teamDmPosition: 2,
    lazyCreation: true,
    fundingKind: 'company_wallet',
    separatePrice: false,
    purgeAfterDays: 30,
    userExport: false,
    roomType: 'io.atum.assistant',
    roomName: 'Chief of Staff',
    roomEncrypted: false,
    greetingVersion: 2
  },
  availability,
  loading: false,
  view: {
    schemaVersion: 2,
    profile: MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
    state: 'preparing',
    pair: {
      companyPrincipal: '00000000-0000-4000-8000-fa2b298ca938',
      memberPrincipal: '00000000-0000-4000-8000-1399762cf502',
      membershipIncarnation: '00000000-0000-4000-8000-ef0a78a27144'
    },
    greetingState: 'pending',
    operationId: '00000000-0000-4000-8000-7d4ef186dc5c'
  }
})

function mount(accountKey: string, onOpenNotesSelf: () => Promise<void>, chief?: CompanyPrivateCosState) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ConversationSections
        activeRoomId={notes.roomId}
        busy={false}
        conversations={[conversation]}
        failed={false}
        loading={false}
        notesAccountKey={accountKey}
        notesSelf={notes}
        notesSelfAvatar={<span data-testid="owner-notes-avatar">M</span>}
        onOpen={vi.fn()}
        onOpenNotesSelf={onOpenNotesSelf}
        onOpenPrivateCos={vi.fn(async () => {})}
        privateCos={chief}
        privateCosAccountKey={accountKey}
        rooms={[]}
        selfMemberRef="self"
        showingOverview={false}
      />
    </I18nProvider>
  )
}

it('pins You first in Direct messages and resolves every company shortcut to the same room', async () => {
  const openAcme = vi.fn(async () => {})
  const first = mount('account/acme', openAcme)
  const section = first.container.querySelector('[data-matrix-company-conversations]')!
  const rows = section.querySelectorAll('[data-team-space-sidebar-row]')

  expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Your personal notes' })).toBeTruthy()
  expect(within(rows[0] as HTMLElement).getByTestId('owner-notes-avatar').textContent).toBe('M')
  expect((rows[0] as HTMLElement).getAttribute('data-selected')).toBe('true')

  fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Your personal notes' }))
  await waitFor(() => expect(openAcme).toHaveBeenCalledTimes(1))

  first.unmount()
  const openBeta = vi.fn(async () => {})
  const second = mount('account/beta', openBeta)
  fireEvent.click(screen.getByRole('button', { name: 'Your personal notes' }))
  await waitFor(() => expect(openBeta).toHaveBeenCalledTimes(1))

  expect(notes.roomId).toBe('!notes:test')
  expect(second.container.querySelectorAll('[data-matrix-company-notes-self-row]')).toHaveLength(1)
})

it('pins the private Chief of Staff second after You only when the platform capability is served', () => {
  const without = mount('account/no-capability', vi.fn(async () => {}))
  expect([...without.container.querySelectorAll('[data-team-space-sidebar-row]')]
    .map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('You'),
      expect.stringContaining('Linh')
    ]))
  expect(without.container.querySelector('[data-company-private-cos-row]')).toBeNull()
  without.unmount()

  const withCapability = mount('account/capability', vi.fn(async () => {}), privateCos('preparing'))
  const rows = [...withCapability.container.querySelectorAll('[data-team-space-sidebar-row]')]

  expect(rows.map(row => row.textContent)).toEqual([
    expect.stringContaining('You'),
    expect.stringContaining('Chief of Staff'),
    expect.stringContaining('Linh')
  ])
  expect(rows[1]?.closest('[data-company-private-cos-row]')).toBeTruthy()
})

it.each([
  ['preparing', 'setting_up', 'Setting up…'],
  ['paused', 'paused', 'Paused'],
  ['unavailable', 'not_available', 'Not available yet']
] as const)('shows the platform-derived %s row state in one short line', (state, status, label) => {
  mount(`account/${state}`, vi.fn(async () => {}), privateCos(state))
  const row = document.querySelector('[data-company-private-cos-row]')

  expect(row?.getAttribute('data-company-private-cos-state')).toBe(status)
  expect(row?.textContent).toContain(label)
})

it('shows the Chief of Staff row before the platform serves a view: Setting up…, then Not available yet with Retry', async () => {
  const retry = vi.fn(async () => {})

  const sections = (status: 'setting_up' | 'not_available') => (
    <I18nProvider configClient={null} initialLocale="en">
      <ConversationSections
        busy={false}
        conversations={[conversation]}
        failed={false}
        loading={false}
        onOpen={vi.fn()}
        onRetryPrivateCos={retry}
        privateCosAccountKey="account/unserved"
        privateCosStatus={status}
        rooms={[]}
        selfMemberRef="self"
        showingOverview={false}
      />
    </I18nProvider>
  )

  const view = render(sections('setting_up'))
  const row = () => view.container.querySelector<HTMLElement>('[data-company-private-cos-row]')!

  expect(row().getAttribute('data-company-private-cos-state')).toBe('setting_up')
  expect(row().textContent).toContain('Setting up…')
  expect(within(row()).getByRole('button', { name: 'Chief of Staff' }).hasAttribute('disabled')).toBe(true)

  view.rerender(sections('not_available'))
  expect(row().textContent).toContain('Not available yet')
  fireEvent.click(within(row()).getByRole('button', { name: 'Chief of Staff · Retry' }))
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
})

it('moves the reserved row from Preparing to Ready after the joined pair becomes ready', () => {
  const view = mount('account/transition', vi.fn(async () => {}), privateCos('preparing'))
  const row = () => view.container.querySelector('[data-company-private-cos-row]')

  expect(row()?.getAttribute('data-company-private-cos-state')).toBe('setting_up')
  expect(row()?.textContent).toContain('Setting up…')

  view.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <ConversationSections
        busy={false}
        conversations={[conversation]}
        failed={false}
        loading={false}
        notesAccountKey="account/transition"
        notesSelf={notes}
        onOpen={vi.fn()}
        onOpenPrivateCos={vi.fn(async () => {})}
        privateCos={privateCos('ready')}
        privateCosAccountKey="account/transition"
        rooms={[]}
        selfMemberRef="self"
        showingOverview={false}
      />
    </I18nProvider>
  )

  expect(row()?.getAttribute('data-company-private-cos-state')).toBe('ready')
  expect(row()?.textContent).not.toContain('Ready')
})

it('clears a pending shortcut when the account changes', async () => {
  let finish: (() => void) | undefined
  const pending = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
  const view = mount('account-a', pending)
  const button = screen.getByRole('button', { name: 'Your personal notes' })

  fireEvent.click(button)
  expect((button as HTMLButtonElement).disabled).toBe(true)

  view.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <ConversationSections
        busy={false}
        conversations={[]}
        failed={false}
        loading={false}
        notesAccountKey="account-b"
        notesSelf={{ ...notes, roomId: '!other-notes:test' }}
        onOpen={vi.fn()}
        onOpenNotesSelf={vi.fn(async () => {})}
        rooms={[]}
        showingOverview={false}
      />
    </I18nProvider>
  )

  await waitFor(() => expect((screen.getByRole('button', { name: 'Your personal notes' }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => finish?.())
})

it('keeps a notes open failure inline with You', async () => {
  mount('account-a/company-a', vi.fn(async () => {throw new Error('offline')}))

  fireEvent.click(screen.getByRole('button', { name: 'Your personal notes' }))

  const alert = await screen.findByRole('alert')
  expect(alert.getAttribute('data-matrix-company-notes-error')).not.toBeNull()
  expect(alert.textContent).toContain('Couldn’t open this conversation')
})
