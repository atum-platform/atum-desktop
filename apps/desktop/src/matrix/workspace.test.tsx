import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixMessageLinkTarget } from '../../shared/matrix-message-link'

import { $companySpacePreferences } from './company-space-store'
import { $matrixHistoryReveal, clearMatrixHistoryReveal, revealMatrixHistoryMessage } from './history-search'
import { clearCompanyChannels } from './team-space/channels-store'
import { clearCompanyConversations } from './team-space/conversations-store'
import { clearTeamSpaceDiscovery } from './team-space/discovery-store'
import { teamSpaceAccountKey } from './team-space/keys'
import {
  $matrixMessageLinkRequest,
  requestMatrixMessageLink
} from './team-space/message-links'
import { MatrixWorkspace } from './workspace'

const COMPANY_ID = '00000000-0000-4000-8000-2b472dd5bd8b'

vi.mock('./workplace', () => ({
  MatrixWorkplace: ({ header }: { header?: ReactNode }) => (
    <>
      {header}
      <h2>Personal agent tools</h2>
    </>
  )
}))

afterEach(() => {
  cleanup()
  clearMatrixHistoryReveal(undefined, 'company')
  $matrixMessageLinkRequest.set(null)
  Reflect.deleteProperty(window, 'atumMatrix')
})

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function mount(enabled = false, initialPage?: 'runtime') {
  const request = vi.fn(async () => ({
    ok: true as const,
    value: { schemaVersion: 1 as const, companies: [], invitations: [] }
  }))

  const pending = vi.fn(async () => ({ ok: true as const, request: null }))
  window.atumMatrix = { companies: { pending, request } } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        initialPage={initialPage}
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: enabled }}
      />
    </I18nProvider>
  )

  return request
}

it('keeps the normal Personal surface and performs no company call when the rollout gate is off', () => {
  const request = mount()
  expect(screen.getByRole('heading', { name: 'Personal agent tools' })).toBeTruthy()
  // No company workspace, no switch: nothing to choose between.
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

it('opens Team Space directly in company mode without the personal assistant workspace switch', async () => {
  const request = mount(true)
  await screen.findByText('Create your company')
  expect(screen.queryByRole('heading', { name: 'Personal agent tools' })).toBeNull()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(screen.getByRole('complementary', { name: 'Channels' })).toBeTruthy()
  expect(request).toHaveBeenCalledWith({ action: 'list' })
})

it('keeps a model-picker request on the explicitly selected Personal settings page', () => {
  const request = mount(true, 'runtime')
  expect(screen.getByRole('heading', { name: 'Personal agent tools' })).toBeTruthy()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

it('keeps an uncertain company mutation in Team Space without exposing Personal navigation', async () => {
  const request = vi.fn(async () => ({
    ok: true as const,
    value: { schemaVersion: 1 as const, companies: [], invitations: [] }
  }))

  const mutation = {
    action: 'create' as const,
    requestId: '00000000-0000-4000-8000-36f351e7fa6d',
    displayName: 'Recovered company'
  }

  const pending = vi.fn(async () => ({ ok: true as const, request: mutation }))
  window.atumMatrix = { companies: { pending, request } } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace obstructed={false} snapshot={{ ...snapshot, companyWorkspaceEnabled: true }} />
    </I18nProvider>
  )

  await screen.findByRole('button', { name: 'Retry' })
  expect(screen.queryByRole('heading', { name: 'Personal agent tools' })).toBeNull()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(pending).toHaveBeenCalledTimes(1)
})

function companyChannelBridge(extra?: { name: string; roomId: string }) {
  const company = { id: COMPANY_ID, displayName: 'Acme', role: 'member' as const, authorityGeneration: 1 }

  const channel = {
    schemaVersion: 1 as const,
    channel: {
      id: '00000000-0000-4000-8000-676a3a34ff0f', companyId: company.id, displayName: 'decisions', visibility: 'company' as const,
      state: 'active' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1
    },
    memberPrincipals: ['00000000-0000-4000-8000-47942475323f'],
    room: { state: 'ready' as const, roomId: '!decisions:test' }
  }

  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === 'list') {return { ok: true as const, value: { schemaVersion: 1 as const, companies: [company], invitations: [] } }}

    if (input.action === 'read') {return { ok: true as const, value: { schemaVersion: 1 as const, company, members: [], projects: [] } }}

    if (input.action === 'list-channels') {
      const more = extra ? [{ ...channel, channel: { ...channel.channel, id: '00000000-0000-4000-8000-e7b998607ca3', displayName: extra.name },
        room: { state: 'ready' as const, roomId: extra.roomId } }] : []

      return { ok: true as const, value: { schemaVersion: 1 as const, channels: [channel, ...more] } }
    }

    return { ok: false as const, error: 'missing' as const }
  })

  return { request }
}

function openCompanyChannel(membership: 'invite' | 'join', command = vi.fn(async () => null)) {
  const { request } = companyChannelBridge()
  const onOpenConversation = vi.fn()
  window.atumMatrix = { companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }, command } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, rooms: [{ id: '!decisions:test', name: 'decisions', membership, encrypted: false }] }}
      />
    </I18nProvider>
  )

  return { command, onOpenConversation, request }
}

it('joins an invited ready channel, selects it, and stays in Team Space', async () => {
  const { command, onOpenConversation } = openCompanyChannel('invite')
  fireEvent.click(await screen.findByRole('button', { name: 'Open # decisions' }))
  await waitFor(() => expect(command).toHaveBeenNthCalledWith(1, { kind: 'join', roomId: '!decisions:test' }))
  await waitFor(() => expect(command).toHaveBeenNthCalledWith(2, { kind: 'select', roomId: '!decisions:test' }))
  expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ roomId: '!decisions:test' })
  expect(screen.getByRole('complementary', { name: 'Channels' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Personal agent tools' })).toBeNull()
})

it('selects a joined ready channel without issuing a redundant join', async () => {
  const { command, onOpenConversation } = openCompanyChannel('join')
  revealMatrixHistoryMessage('!old:test', '$old', 'company', undefined, '@alice:test:A')
  fireEvent.click(await screen.findByRole('button', { name: 'Open # decisions' }))
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!decisions:test' }))
  expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ roomId: '!decisions:test' })
  expect($matrixHistoryReveal.get()).toBeNull()
  expect(screen.getByRole('complementary', { name: 'Channels' })).toBeTruthy()
})

it('opens Activity in the joined room and reveals a thread reply by exact event id', async () => {
  const { request } = companyChannelBridge()
  const command = vi.fn(async () => null)
  const onOpenConversation = vi.fn()

  const room = {
    id: '!decisions:test',
    name: 'decisions',
    membership: 'join' as const,
    encrypted: false,
    companyChannel: { companyId: COMPANY_ID, channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
  }

  const activity = [{
    companyId: COMPANY_ID,
    roomId: room.id,
    eventId: '$reply',
    kind: 'thread_reply' as const,
    body: 'Decision updated',
    senderId: '@linh:test',
    sentAt: 10,
    unread: true,
    threadRootId: '$root'
  }]

  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request },
    command
  } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyActivity: activity, companyWorkspaceEnabled: true, rooms: [room] }}
      />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Activity' }))
  fireEvent.click(await screen.findByRole('button', { name: /Decision updated/ }))

  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: room.id }))
  expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ roomId: room.id, threadRootId: '$root' })
  expect($matrixHistoryReveal.get()).toEqual({
    roomId: room.id,
    eventId: '$reply',
    owner: 'company',
    threadRootId: '$root',
    accountKey: '@alice:test:A'
  })
})

it('does not reveal a stale Activity row after the platform directory de-authorizes its room', async () => {
  const {
    channelRoom,
    CHANNEL_IDS,
    COMPANY_ID,
    platform,
    resetTeamSpace,
    TestResizeObserver
  } = await import('./team-space/test-support')
  const { $companyChannels } = await import('./team-space/channels-store')
  const { teamSpaceKey } = await import('./team-space/keys')

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  resetTeamSpace()
  const source = platform()
  let releaseSelect!: () => void
  const selectGate = new Promise<void>(resolve => { releaseSelect = resolve })
  const command = vi.fn(async (value: { kind: string }) => {
    if (value.kind === 'select') {await selectGate}

    return null
  })
  const onOpenConversation = vi.fn()
  const room = channelRoom(CHANNEL_IDS.general, 'general')
  const activity = [{
    companyId: COMPANY_ID,
    roomId: room.id,
    eventId: '$stale',
    kind: 'mention' as const,
    body: 'This access is about to be revoked',
    senderId: '@linh:test',
    sentAt: 10,
    unread: true
  }]

  window.atumMatrix = { companies: source.bridge, command } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyActivity: activity, companyWorkspaceEnabled: true, rooms: [room] }}
      />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Activity' }))
  fireEvent.click(await screen.findByRole('button', { name: /This access is about to be revoked/ }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: room.id }))

  source.state.channels.splice(0)
  act(() => $companyChannels.setKey(teamSpaceKey('@alice:test:A', COMPANY_ID), {
    wire: '1.4',
    channels: [],
    loading: false
  }))
  await waitFor(() => expect(screen.queryByText('This access is about to be revoked')).toBeNull())

  releaseSelect()
  await act(() => selectGate)
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

  expect($matrixHistoryReveal.get()).toBeNull()
  resetTeamSpace()
})

const messageLinkTarget: MatrixMessageLinkTarget = {
  companyId: COMPANY_ID,
  roomId: '!decisions:test',
  eventId: '$linked-reply',
  threadRootId: '$linked-root'
}

function messageLinkWorkspace(options: {
  membership?: 'join' | 'leave'
  open?: NonNullable<NonNullable<MatrixUiBridge['companies']>['open']>
} = {}) {
  const { request } = companyChannelBridge()
  const open = options.open ?? vi.fn(async () => ({ ok: true as const }))
  const onOpenConversation = vi.fn()
  const onMessageLinkFailure = vi.fn()
  const room = {
    id: messageLinkTarget.roomId,
    name: 'decisions',
    membership: options.membership ?? 'join',
    encrypted: false,
    companyChannel: { companyId: COMPANY_ID, channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
  }

  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request, open }
  } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onMessageLinkFailure={onMessageLinkFailure}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, rooms: [room] }}
      />
    </I18nProvider>
  )

  return { onMessageLinkFailure, onOpenConversation, open }
}

it('opens a valid message link only after native revalidation, preserving thread and highlight context', async () => {
  const value = messageLinkWorkspace()
  act(() => {requestMatrixMessageLink(messageLinkTarget)})

  await waitFor(() => expect(value.open).toHaveBeenCalledExactlyOnceWith({
    companyId: COMPANY_ID,
    channelId: '00000000-0000-4000-8000-676a3a34ff0f',
    roomId: messageLinkTarget.roomId,
    eventId: messageLinkTarget.eventId,
    threadRootId: messageLinkTarget.threadRootId
  }))
  await waitFor(() => expect(value.onOpenConversation).toHaveBeenCalledExactlyOnceWith({
    roomId: messageLinkTarget.roomId,
    threadRootId: messageLinkTarget.threadRootId
  }))
  expect($matrixHistoryReveal.get()).toEqual({
    roomId: messageLinkTarget.roomId,
    eventId: messageLinkTarget.eventId,
    owner: 'company',
    threadRootId: messageLinkTarget.threadRootId,
    accountKey: '@alice:test:A'
  })
  expect(value.onMessageLinkFailure).not.toHaveBeenCalled()
})

it('refuses a message link after current room membership is revoked without asking Matrix for the event', async () => {
  const value = messageLinkWorkspace({ membership: 'leave' })
  act(() => {requestMatrixMessageLink(messageLinkTarget)})

  await waitFor(() => expect(value.onMessageLinkFailure).toHaveBeenCalledExactlyOnceWith('membership'))
  expect(value.open).not.toHaveBeenCalled()
  expect(value.onOpenConversation).not.toHaveBeenCalled()
  expect($matrixHistoryReveal.get()).toBeNull()
})

it('reports a deleted or invisible linked event as unavailable without navigating or retaining its reveal', async () => {
  const open = vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const }))
  const value = messageLinkWorkspace({ open })
  act(() => {requestMatrixMessageLink(messageLinkTarget)})

  await waitFor(() => expect(value.onMessageLinkFailure).toHaveBeenCalledExactlyOnceWith('unavailable'))
  expect(open).toHaveBeenCalledOnce()
  expect(value.onOpenConversation).not.toHaveBeenCalled()
  expect($matrixHistoryReveal.get()).toBeNull()
})

describe('OB1: a clicked channel never leaves the pane empty', () => {
  // Earlier tests leave this account's Team Space reads, page and last channel behind.
  beforeEach(() => {
    window.localStorage.clear()
    $companySpacePreferences.set({})
    clearTeamSpaceDiscovery()
    clearCompanyChannels(teamSpaceAccountKey(snapshot.identity))
    clearCompanyConversations(teamSpaceAccountKey(snapshot.identity))
  })

  const decisions = { id: '!decisions:test', name: 'decisions', encrypted: false }
  const pane = () => document.querySelector('[data-matrix-company-content]') as HTMLElement
  // Plain polling: while the workspace's own default-channel convergence is retrying a room this Mac does not hold,
  // Testing Library's act-wrapped polling never lets the directory read settle.
  const settled = async <T,>(read: () => T | null | undefined, ms = 8_000): Promise<T> => {
    for (const start = Date.now(); Date.now() - start < ms;) {
      const value = read()

      if (value) {return value}
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    throw new Error('not settled')
  }

  const row = () => settled(() => screen.queryByRole('button', { name: 'Open # decisions' }))

  function mountChannel(rooms: MatrixSnapshot['rooms'], command: MatrixUiBridge['command'], roomId: string | null = null,
    extra?: { name: string; roomId: string }) {
    const { request } = companyChannelBridge(extra)
    window.atumMatrix = { companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }, command } as unknown as MatrixUiBridge
    const ui = (value: MatrixSnapshot['rooms'], selected: string | null) => (
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkspace obstructed={false} snapshot={{ ...snapshot, companyWorkspaceEnabled: true, rooms: value, roomId: selected }} />
      </I18nProvider>
    )
    const view = render(ui(rooms, roomId))

    return { rerender: (value: MatrixSnapshot['rooms'], selected: string | null = null) => view.rerender(ui(value, selected)) }
  }

  it('opens a channel the directory names before this Mac has synced its invitation', async () => {
    const command = vi.fn(async (_input: { kind: string; roomId?: string }) => null)
    const { rerender } = mountChannel([], command as unknown as MatrixUiBridge['command'])

    fireEvent.click(await row())
    // The invitation arrives with the next sync, after the click.
    rerender([{ ...decisions, membership: 'invite' }])

    await settled(() => command.mock.calls.some(([value]) => value.kind === 'select'))
    expect(command).toHaveBeenNthCalledWith(1, { kind: 'join', roomId: decisions.id })
    expect(command).toHaveBeenNthCalledWith(2, { kind: 'select', roomId: decisions.id })
  })

  it('opens the channel clicked last while an earlier channel is still retrying, and never the earlier one', async () => {
    const general = { id: '!general:test', name: 'general', encrypted: false, membership: 'join' as const }
    const command = vi.fn(async (_input: { kind: string; roomId?: string }) => null)
    const { rerender } = mountChannel([general], command as unknown as MatrixUiBridge['command'], null,
      { name: 'general', roomId: general.id })

    // # decisions is not on this Mac yet, so its open keeps retrying; the person clicks # general meanwhile.
    fireEvent.click(await row())
    fireEvent.click(await settled(() => screen.queryByRole('button', { name: 'Open # general' })))
    await settled(() => command.mock.calls.some(([value]) => value.kind === 'select' && value.roomId === general.id))

    // The earlier room arrives after the person moved on: the stale retry must not take the pane back.
    rerender([general, { ...decisions, membership: 'invite' }])
    await new Promise(resolve => setTimeout(resolve, 5_000))
    expect(command.mock.calls.filter(([value]) => value.roomId === decisions.id)).toEqual([])
  }, 20_000)

  it('says in the pane, inline, that a channel could not open when its room never arrives', async () => {
    const command = vi.fn(async () => null)
    mountChannel([], command)

    fireEvent.click(await row())

    const failed = await settled(() => within(pane()).queryByRole('alert'))
    expect(failed.textContent).toBe('Couldn’t open this channel. It may have changed; try again in a moment.')
    expect(command).not.toHaveBeenCalled()
  }, 15_000)

  it('says the channel is still being prepared when Matrix opened it but the window is not shown it yet', async () => {
    // main holds a selected channel back (roomId null, no transcript) until the platform directory confirms it.
    const command = vi.fn(async () => null)
    mountChannel([{ ...decisions, membership: 'join' }], command)

    fireEvent.click(await row())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: decisions.id }))

    expect((await within(pane()).findByRole('status')).textContent)
      .toBe('The channel is still being prepared. You can open it when it is ready.')
  })
})

it('keeps the selected company channel content beside the Team Space sidebar', async () => {
  const { request } = companyChannelBridge()
  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
  } as unknown as MatrixUiBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        channelContent={<div data-testid="company-channel-content">Channel transcript</div>}
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, roomId: '!decisions:test',
          rooms: [{ id: '!decisions:test', name: 'decisions', membership: 'join', encrypted: false,
            companyChannel: { companyId: COMPANY_ID, channelId: '00000000-0000-4000-8000-676a3a34ff0f' } }] }}
      />
    </I18nProvider>
  )

  expect(await screen.findByRole('complementary', { name: 'Channels' })).toBeTruthy()
  expect(await screen.findByTestId('company-channel-content')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Personal agent tools' })).toBeNull()
})

it('opens You in the company-scoped notes room instead of the account-wide room', async () => {
  const { request } = companyChannelBridge()
  const command = vi.fn(async input => input.kind === 'notesSelfOpen' ? { roomId: '!company-notes:test' } : null)
  const onOpenConversation = vi.fn()
  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request },
    command
  } as unknown as MatrixUiBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true }}
      />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Your personal notes' }))

  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'notesSelfOpen', companyId: COMPANY_ID }))
  expect(onOpenConversation).toHaveBeenCalledWith({ roomId: '!company-notes:test' })
})

it('does not offer company message search in this release', async () => {
  const { request } = companyChannelBridge()
  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
  } as unknown as MatrixUiBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true,
          rooms: [{ id: '!decisions:test', name: 'decisions', membership: 'join', encrypted: false }] }}
      />
    </I18nProvider>
  )
  expect(await screen.findByRole('button', { name: 'Open # decisions' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: 'Search company messages' })).toBeNull()
})

it('does not finish opening an old account’s channel after an account switch', async () => {
  let resolveJoin!: () => void
  const join = new Promise<void>(resolve => { resolveJoin = resolve })
  const command = vi.fn((input: { kind: string }) => input.kind === 'join' ? join : Promise.resolve(null))
  const { request } = companyChannelBridge()
  window.atumMatrix = { companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }, command } as unknown as MatrixUiBridge

  const { rerender } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, rooms: [{ id: '!decisions:test', name: 'decisions', membership: 'invite', encrypted: false }] }}
      />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Open # decisions' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'join', roomId: '!decisions:test' }))

  rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, identity: { userId: '@bob:test', deviceId: 'B' }, rooms: [] }}
      />
    </I18nProvider>
  )
  await act(async () => resolveJoin())
  expect(command).not.toHaveBeenCalledWith({ kind: 'select', roomId: '!decisions:test' })
})

it('does not select a company room after the company on screen changed while its invitation was being accepted', async () => {
  const { MATRIX_COMPANY_CONVERSATION_TYPE } = await import('../../shared/matrix-company-channel-room')
  const { platform, COMPANY_ID, CONVERSATION_IDS, conversationRoomId, OTHER_COMPANY_ID, resetTeamSpace, TestResizeObserver } =
    await import('./team-space/test-support')

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  resetTeamSpace()

  const source = platform({
    companies: [{ id: COMPANY_ID, displayName: 'Atum Studio' }, { id: OTHER_COMPANY_ID, displayName: 'Beta Works' }],
    conversationsOn: true,
    conversations: [{ id: CONVERSATION_IDS.dm, others: ['admin'] }]
  })

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const command = vi.fn(async (value: { kind: string }) => { if (value.kind === 'join') {await gate}; return null })

  window.atumMatrix = { companies: source.bridge, command } as unknown as MatrixUiBridge

  const roomId = conversationRoomId(CONVERSATION_IDS.dm)

  const rooms = [{
    id: roomId, name: 'conversation', membership: 'invite' as const, encrypted: false, roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    companyConversation: { companyId: COMPANY_ID, conversationId: CONVERSATION_IDS.dm }
  }]

  const ui = (preferred: string) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        snapshot={{ ...snapshot, companyWorkspaceEnabled: true, identity: { userId: '@owner:test', deviceId: 'A' }, rooms, roomId: preferred === COMPANY_ID ? null : null }}
      />
    </I18nProvider>
  )

  const view = render(ui(COMPANY_ID))

  fireEvent.click(await screen.findByRole('button', { name: /Open conversation with/ }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'join', roomId }))

  // The window moves to Beta (from the name menu) while the invitation is still being accepted.
  fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Beta Works · / }))
  await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))
  release()
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 60)))

  expect(command).not.toHaveBeenCalledWith({ kind: 'select', roomId })
  view.unmount()
})

it('opens the company Threads inbox and reuses the existing read, follow and thread navigation commands', async () => {
  const { request } = companyChannelBridge()
  const command = vi.fn(async () => null)
  const onOpenConversation = vi.fn()
  const room = {
    id: '!decisions:test',
    name: 'decisions',
    membership: 'join' as const,
    encrypted: false,
    companyChannel: { companyId: COMPANY_ID, channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
  }
  const thread = {
    companyId: COMPANY_ID,
    roomId: room.id,
    root: {
      id: '$root', sender: '@linh:test', body: 'Decision thread', timestamp: 10, own: false,
      encrypted: true, decryptionFailed: false, pending: false, failed: false, attachment: false
    },
    replies: [],
    participantIds: ['@linh:test'],
    replyCount: 3,
    lastActivityAt: 20,
    unread: true,
    highlights: 0,
    followed: false
  }

  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request },
    command
  } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...snapshot, companyThreads: [thread], companyWorkspaceEnabled: true, rooms: [room] }}
      />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Threads' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Mark read' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'threadRead', roomId: room.id, rootId: '$root' }))

  fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({
    kind: 'threadFollow',
    roomId: room.id,
    rootId: '$root',
    followed: true
  }))

  fireEvent.click(screen.getByRole('button', { name: /Open thread in decisions: Decision thread/ }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: room.id }))
  expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ roomId: room.id, threadRootId: '$root' })
})
