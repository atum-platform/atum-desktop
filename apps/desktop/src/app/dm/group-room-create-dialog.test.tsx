import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $atumAppCatalog, clearAtumAppCatalog } from '@/lib/atum-app-catalog'

import type {
  GroupCapabilities,
  GroupOperationInput,
  GroupOperationResult
} from '../../../shared/atum-group-conversations'

import { GroupRoomCreateDialog } from './group-room-create-dialog'

const queued = (operationId: string): GroupOperationResult => ({
  operationId,
  state: 'queued',
  conversationId: null,
  errorCode: null
})

function capabilities(shared = true): GroupCapabilities {
  return {
    available: true,
    creationEnabled: true,
    createDefaults: true,
    humanMemberLimit: 3,
    addressing: {
      enabled: true,
      mentionCardinality: 1,
      quoteLimit: 1,
      specialistMemberLimit: 4,
      specialistCatalog: [{ specialist: 'moon', displayName: 'Moon', avatar: '', roomSupported: true }]
    },
    advisory: {
      enabled: true,
      advisorLimit: 4,
      advisorCatalog: [
        { target: { type: 'specialist', id: 'moon' }, displayName: 'Moon', avatar: '', availability: 'available' },
        {
          target: { type: 'assistant', id: 'marketing' },
          displayName: 'Marketing',
          avatar: '',
          availability: 'available'
        }
      ]
    },
    sharedAgents: {
      enabled: shared,
      assistantMemberLimit: 4,
      ownAssistantOnly: true,
      assistantCatalog: [
        {
          assistantId: 'marketing',
          displayName: 'Marketing',
          ownerUserId: 'me',
          membershipEpoch: 1,
          availability: 'available'
        },
        {
          assistantId: 'other',
          displayName: 'Other agent',
          ownerUserId: 'other',
          membershipEpoch: 1,
          availability: 'assistant_not_owned'
        }
      ]
    }
  }
}

function renderDialog(overrides: Partial<ComponentProps<typeof GroupRoomCreateDialog>> = {}) {
  const onOperate = vi
    .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
    .mockResolvedValue(queued('create-1'))

  const props: ComponentProps<typeof GroupRoomCreateDialog> = {
    capabilities: capabilities(),
    contacts: [{ userId: 'lan', displayName: 'Lan', handle: 'lan' }],
    createOperationId: () => 'create-1',
    onOpenChange: vi.fn(),
    onOperate,
    open: true,
    ...overrides
  }

  const content = (next: typeof props) => (
    <I18nProvider configClient={null} initialLocale="en">
      <GroupRoomCreateDialog {...next} />
    </I18nProvider>
  )

  const view = render(content(props))

  return {
    onOperate,
    props,
    rerender: (changes: Partial<typeof props>) => view.rerender(content({ ...props, ...changes }))
  }
}

beforeEach(() => {
  $atumAppCatalog.set({ accountId: 'me', state: 'ready', apps: [{
    app: 'moon', app_id: '00000000-0000-4000-8000-e79acd97ac88',
    app_version_id: '00000000-0000-4000-8000-5ba39b7cfa53',
    name: { en: 'Moon', vi: 'Moon' },
    subtitle: { en: 'Astrology specialist', vi: 'Chuyên gia chiêm tinh' },
    icon: null, verified: true, availability: 'available',
    supported_modes: ['direct', 'private_group', 'shared_group'],
    link: { mode: 'external_account', state: 'linked' }
  }] })
})

afterEach(() => {
  cleanup()
  clearAtumAppCatalog()
})

describe('GroupRoomCreateDialog', () => {
  it.each(['private_advisory', 'shared_group', 'ordinary'] as const)(
    'creates or opens %s without requiring a name',
    async mode => {
      const onCreated = vi.fn()

      const existing = {
        operationId: 'create-1',
        state: 'sent' as const,
        conversationId: 'existing-room',
        errorCode: null
      }

      const onOperate = vi.fn().mockResolvedValue(existing)
      renderDialog({ capabilities: capabilities(mode !== 'ordinary'), onCreated, onOperate })
      expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByLabelText(/Moon/))

      if (mode !== 'private_advisory') {fireEvent.click(screen.getByLabelText(/Lan/))}
      expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
      await waitFor(() => expect(onOperate).toHaveBeenCalledWith(expect.objectContaining({ title: '' })))
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(existing))
    }
  )

  it('shows People, Apps, and Agents together with app identity metadata', () => {
    renderDialog()
    expect(screen.getByRole('group', { name: 'People' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Apps' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Agents' })).toBeTruthy()
    expect(screen.getByText('Astrology specialist')).toBeTruthy()
    expect(screen.getByText('Your apps and agents use private context only in this owner-only meeting.')).toBeTruthy()
  })

  it('keeps named legacy creation when the server does not advertise defaults', async () => {
    const { onOperate } = renderDialog({ capabilities: { ...capabilities(), createDefaults: undefined } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Moon/ }))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(onOperate).toHaveBeenCalledOnce())
    expect(onOperate.mock.calls[0][0]).not.toHaveProperty('reuseExisting')
  })

  it('creates an owner-only private meeting when no other person is selected', async () => {
    const { onOperate } = renderDialog()
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Private plan' } })
    fireEvent.click(screen.getByLabelText(/Moon/))
    fireEvent.click(screen.getByLabelText(/Marketing/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'create',
        reuseExisting: true,
        contextMode: 'private_advisory',
        clientOperationId: 'create-1',
        title: 'Private plan',
        memberUserIds: [],
        advisors: [
          { type: 'specialist', id: 'moon' },
          { type: 'assistant', id: 'marketing' }
        ]
      })
    )
  })

  it('uses a fresh shared-group create context when a person joins the selection', async () => {
    const { onOperate } = renderDialog()
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Launch' } })
    fireEvent.click(screen.getByLabelText(/Marketing/))
    expect(screen.getByText('Your apps and agents use private context only in this owner-only meeting.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect(
      screen.getByText(
        'Everyone uses group context and approved shared identities. Apps and agents do not use private tools.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'create',
        reuseExisting: true,
        contextMode: 'shared_group',
        clientOperationId: 'create-1',
        title: 'Launch',
        memberUserIds: ['lan'],
        assistantIds: ['marketing']
      })
    )
  })

  it('uses the ordinary legacy payload for people and apps when shared agents are unavailable', async () => {
    const { onOperate } = renderDialog({ capabilities: capabilities(false) })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Launch' } })
    fireEvent.click(screen.getByLabelText(/Lan/))
    fireEvent.click(screen.getByLabelText(/Moon/))
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'create',
        reuseExisting: true,
        clientOperationId: 'create-1',
        title: 'Launch',
        memberUserIds: ['lan'],
        specialistIds: ['moon']
      })
    )
  })

  it('keeps a frozen shared create payload across a capability refresh and retry', async () => {
    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockResolvedValue(queued('create-1'))

    const renderContent = (shared: boolean) => (
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomCreateDialog
          capabilities={capabilities(shared)}
          contacts={[{ userId: 'lan', displayName: 'Lan', handle: 'lan' }]}
          createOperationId={() => 'create-1'}
          onOpenChange={vi.fn()}
          onOperate={onOperate}
          open
        />
      </I18nProvider>
    )

    const view = render(renderContent(true))
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Launch' } })
    fireEvent.click(screen.getByLabelText(/Lan/))
    fireEvent.click(screen.getByLabelText(/Marketing/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await screen.findByText('This group is queued and has not been created yet.')
    const first = onOperate.mock.calls[0]?.[0]
    view.rerender(renderContent(false))
    expect(
      screen.getByText(
        'Everyone uses group context and approved shared identities. Apps and agents do not use private tools.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(onOperate).toHaveBeenCalledTimes(2))
    expect(onOperate.mock.calls[1]?.[0]).toEqual(first)
    expect(first).toMatchObject({ contextMode: 'shared_group', assistantIds: ['marketing'] })
  })

  it('shows loading, unavailable, and empty states without selecting anyone automatically', () => {
    const { rerender } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomCreateDialog
          capabilities={null}
          contacts={[]}
          createOperationId={() => 'create-1'}
          onOpenChange={vi.fn()}
          onOperate={vi.fn()}
          open
        />
      </I18nProvider>
    )

    expect(screen.getByText('Loading people, apps, and agents…')).toBeTruthy()
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomCreateDialog
          capabilities={{ available: false, creationEnabled: false, humanMemberLimit: 3 }}
          contacts={[]}
          createOperationId={() => 'create-1'}
          onOpenChange={vi.fn()}
          onOperate={vi.fn()}
          open
        />
      </I18nProvider>
    )
    expect(screen.getByText('Group rooms are unavailable in this desktop version.')).toBeTruthy()
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomCreateDialog
          capabilities={{
            available: true,
            creationEnabled: true,
            humanMemberLimit: 3,
            advisory: { enabled: true, advisorLimit: 2, advisorCatalog: [] }
          }}
          contacts={[]}
          createOperationId={() => 'create-1'}
          onOpenChange={vi.fn()}
          onOperate={vi.fn()}
          open
        />
      </I18nProvider>
    )
    expect(screen.getByText('No apps are available yet.')).toBeTruthy()
    expect(screen.getByText('No agents are available yet.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses private availability without requiring shared-persona approval', () => {
    const catalog = capabilities()
    catalog.sharedAgents!.assistantCatalog[0]!.availability = 'assistant_not_approved'
    renderDialog({ capabilities: catalog })
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(false)
  })

  it('leaves a rejected draft editable before a durable operation exists', async () => {
    renderDialog({ onOperate: vi.fn().mockRejectedValue(new Error('group_operation_not_queued')) })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Moon/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).disabled).toBe(false)
    )
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Corrected plan' } })
    expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).value).toBe('Corrected plan')
  })

  it('enforces the private participant limit across apps and agents together', () => {
    const catalog = capabilities()
    catalog.advisory!.advisorLimit = 1
    renderDialog({ capabilities: catalog })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Moon/))
    fireEvent.click(screen.getByLabelText(/Marketing/))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Marketing/))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('freezes an ambiguous create and retries the same operation ID and payload', async () => {
    const onOperate = vi
      .fn()
      .mockRejectedValueOnce(new Error('ledger_unavailable'))
      .mockResolvedValue(queued('create-1'))

    const createOperationId = vi.fn().mockReturnValueOnce('create-1').mockReturnValueOnce('create-2')
    renderDialog({ onOperate, createOperationId })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Moon/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create group' })).toBeTruthy())
    expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(onOperate).toHaveBeenCalledTimes(2))
    expect(onOperate.mock.calls[1]).toEqual(onOperate.mock.calls[0])
    expect(createOperationId).toHaveBeenCalledTimes(1)
  })

  it('unlocks terminal failure and ignores its late response while a new create is pending', async () => {
    let resolve!: (value: GroupOperationResult) => void

    const onOperate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GroupOperationResult>(done => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(queued('create-2'))

    const onCreated = vi.fn()
    const createOperationId = vi.fn().mockReturnValueOnce('create-1').mockReturnValueOnce('create-2')
    const { rerender } = renderDialog({ onOperate, onCreated, createOperationId })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Moon/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    rerender({ operationResults: [{ ...queued('create-1'), state: 'failed_terminal', errorCode: 'denied' }] })
    await waitFor(() =>
      expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).disabled).toBe(false)
    )
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'New plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(onOperate).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolve({ ...queued('create-1'), state: 'sent', conversationId: 'old-room' })
    })
    expect(onCreated).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).value).toBe('New plan')
    expect(onOperate.mock.calls[1][0].clientOperationId).toBe('create-2')
  })

  it.each(['limit', 'contact'] as const)('revalidates selected people when their %s changes', change => {
    const { rerender, props } = renderDialog()
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false)
    rerender(change === 'limit' ? { capabilities: { ...props.capabilities!, humanMemberLimit: 1 } } : { contacts: [] })
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes a vanished contact from an editable draft so the remaining selection can be submitted', async () => {
    const { rerender, onOperate } = renderDialog()
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Plan' } })
    fireEvent.click(screen.getByLabelText(/Lan/))
    fireEvent.click(screen.getByLabelText(/Moon/))
    rerender({ contacts: [] })
    expect(screen.queryByLabelText(/Lan/)).toBeNull()
    expect(screen.getByText('Your apps and agents use private context only in this owner-only meeting.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith(
        expect.objectContaining({
          memberUserIds: [],
          contextMode: 'private_advisory',
          advisors: [{ type: 'specialist', id: 'moon' }]
        })
      )
    )
  })

  it('does not let room support grant private context to an unavailable app', () => {
    const catalog = capabilities()
    catalog.advisory!.advisorCatalog[0]!.availability = 'unlinked'
    renderDialog({ capabilities: catalog })
    expect((screen.getByLabelText(/Moon/) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByLabelText(/Moon/) as HTMLInputElement).disabled).toBe(false)
  })

  it('does not grant shared availability from a private-only agent catalog', () => {
    const catalog = capabilities()
    catalog.sharedAgents!.assistantCatalog = []
    renderDialog({ capabilities: catalog })
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByLabelText(/Marketing/) as HTMLInputElement).disabled).toBe(true)
  })

  it('requires a selected participant to be available in the new audience', () => {
    const catalog = capabilities()
    catalog.sharedAgents!.assistantCatalog[0]!.availability = 'assistant_not_approved'
    renderDialog({ capabilities: catalog })
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Private plan' } })
    fireEvent.click(screen.getByLabelText(/Marketing/))
    fireEvent.click(screen.getByLabelText(/Lan/))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true)
    // An unavailable selection must remain removable.
    fireEvent.click(screen.getByLabelText(/Marketing/))
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('starts a fresh owner-only draft after completion and ignores a late response from the old create', async () => {
    let resolve!: (value: GroupOperationResult) => void

    const onOperate = vi.fn(
      () =>
        new Promise<GroupOperationResult>(done => {
          resolve = done
        })
    )

    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    const completed: GroupOperationResult = { ...queued('create-1'), state: 'sent', conversationId: 'room-1' }

    const content = (open: boolean, operationResults: GroupOperationResult[] = []) => (
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomCreateDialog
          capabilities={capabilities()}
          contacts={[{ userId: 'lan', displayName: 'Lan', handle: 'lan' }]}
          createOperationId={() => 'create-1'}
          onCreated={onCreated}
          onOpenChange={onOpenChange}
          onOperate={onOperate}
          open={open}
          operationResults={operationResults}
        />
      </I18nProvider>
    )

    const view = render(content(true))
    fireEvent.change(screen.getByLabelText('Group name (optional)'), { target: { value: 'Shared plan' } })
    fireEvent.click(screen.getByLabelText(/Lan/))
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    view.rerender(content(true, [completed]))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    view.rerender(content(false, [completed]))
    view.rerender(content(true, [completed]))
    await act(async () => {
      resolve(completed)
    })
    expect((screen.getByLabelText('Group name (optional)') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Your apps and agents use private context only in this owner-only meeting.')).toBeTruthy()
    expect(screen.queryByText('Group created.')).toBeNull()
    expect(onCreated).toHaveBeenCalledTimes(1)
  })
})
