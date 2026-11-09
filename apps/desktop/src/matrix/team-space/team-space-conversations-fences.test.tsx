import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyRequest } from '../../../shared/matrix-company'

import { $companyConversations, loadCompanyConversations } from './conversations-store'
import { loadTeamSpaceDiscovery } from './discovery-store'
import { requestTeamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  CONVERSATION_IDS,
  conversationRoom,
  conversationRoomId,
  OTHER_COMPANY_ID,
  type Platform,
  platform,
  renderTeamSpace,
  rerenderTeamSpace,
  resetTeamSpace,
  type ScriptedConversation,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(cleanup)

const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }
const withBao: ScriptedConversation = { id: CONVERSATION_IDS.dm, others: ['admin'] }
const section = () => document.querySelector('[data-matrix-company-conversations]') as HTMLElement
const fast = { convergenceDelayMs: 5, convergenceAttempts: 4 }
const flush = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 60)))

const sectionReady = async () => {
  await waitFor(() => expect(section()).toBeTruthy())

  return section()
}

const row = async (title: string) => within(await sectionReady()).findByRole('button', { name: `Open conversation with ${title}` })
const newMessage = async () => within(await sectionReady()).getByRole('button', { name: 'New message' }) as HTMLButtonElement
const conversationCalls = (source: Platform, action: string) => source.calls(action) as Array<Record<string, unknown>>

/** The same platform, with the answer to one action held until `release` is called. */
function holding(source: Platform, action: string) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const held: MatrixCompanyRequest[] = []

  const bridge: Platform['bridge'] = {
    ...source.bridge,
    request: (async (input: MatrixCompanyRequest) => {
      if (input.action === action) {
        held.push(input)
        await gate
      }

      return source.bridge.request(input)
    }) as Platform['bridge']['request']
  }

  return { held, release, source: { ...source, bridge } satisfies Platform }
}

describe('a directory the platform refused no longer authorizes anything', () => {
  const key = teamSpaceKey('account-a', COMPANY_ID)
  const load = (source: Platform, quiet = true) =>
    loadCompanyConversations(source.bridge, 'account-a', COMPANY_ID, { conversations: true }, { quiet })

  it.each(['denied', 'missing', 'invalid'] as const)('a quiet read answered %s empties the directory, it does not keep the last good one', async error => {
    const source = platform({ conversationsOn: true, conversations: [withBao] })

    await load(source, false)
    expect($companyConversations.get()[key]?.conversations).toHaveLength(1)

    source.state.mutations.conversations = () => ({ ok: false, error })
    await load(source)

    expect($companyConversations.get()[key]).toMatchObject({ conversations: [], error, loading: false })
  })

  it('a transient failure keeps the rows on screen but marks them stale, and the next good read clears the mark', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao] })

    await load(source, false)
    source.state.mutations.conversations = () => ({ ok: false, error: 'unavailable' })
    await load(source)

    expect($companyConversations.get()[key]).toMatchObject({ stale: true })
    expect($companyConversations.get()[key]?.conversations).toHaveLength(1)

    delete source.state.mutations.conversations
    await load(source)
    expect($companyConversations.get()[key]?.stale).toBeUndefined()
  })

  it('closes the New message control the moment the authority is stale or gone, while a stale list stays readable', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao], channels: [general] })
    renderTeamSpace(source, { rooms: [conversationRoom(withBao.id)] })
    await row('Bảo')
    expect((await newMessage()).disabled).toBe(false)

    source.state.mutations.conversations = () => ({ ok: false, error: 'unavailable' })
    await act(() => load(source))
    expect(await row('Bảo')).toBeTruthy()
    expect((await newMessage()).disabled).toBe(true)

    source.state.mutations.conversations = () => ({ ok: false, error: 'denied' })
    await act(() => load(source))
    await waitFor(() => expect(within(section()).queryByRole('button', { name: 'Open conversation with Bảo' })).toBeNull())
    expect((await newMessage()).disabled).toBe(true)
  })

  it('sends no change while the directory is stale: a hide waits for a successful read', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao], channels: [general] })
    renderTeamSpace(source, { rooms: [conversationRoom(withBao.id)] })
    await row('Bảo')

    source.state.mutations.conversations = () => ({ ok: false, error: 'unavailable' })
    await act(() => load(source))

    requestTeamSpaceIntent({ kind: 'conversation-hide', conversationId: withBao.id })
    await flush()

    expect(source.calls('conversation-hidden')).toHaveLength(0)
  })
})

describe('a picker left open under a directory that went stale', () => {
  it('sends nothing, and says why in the picker rather than blaming a role', async () => {
    const source = platform({ conversationsOn: true, channels: [general] })
    renderTeamSpace(source, { rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    fireEvent.click(within(section()).getByRole('button', { name: 'New message' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    source.state.mutations.conversations = () => ({ ok: false, error: 'unavailable' })
    await act(() => loadCompanyConversations(source.bridge, 'account-a', COMPANY_ID, { conversations: true }, { quiet: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))

    expect(await within(dialog).findByText('Direct messages aren’t available right now.')).toBeTruthy()
    expect(source.calls('conversation-open')).toHaveLength(0)
    expect(within(dialog).queryByText(/role changed/)).toBeNull()
  })
})

describe('Retry obeys the 1.5 probe', () => {
  const lost = () => ({ ok: false as const, error: 'unavailable' as const })

  async function lostOpen(source: Platform) {
    renderTeamSpace(source, { ...fast, rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    fireEvent.click(within(section()).getByRole('button', { name: 'New message' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))

    return screen.findByRole('button', { name: 'Retry' })
  }

  it('does not replay a conversation request once the family is switched off, and says why', async () => {
    const source = platform({ conversationsOn: true, channels: [general], mutations: { 'conversation-open': lost } })
    const retry = await lostOpen(source)

    expect(conversationCalls(source, 'conversation-open')).toHaveLength(1)

    source.state.conversationsOn = false
    await act(() => loadTeamSpaceDiscovery(source.bridge, 'account-a', { force: true }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New message' })).toBeNull())
    expect(screen.getByText('Direct messages')).toBeTruthy()

    fireEvent.click(retry)
    await flush()

    expect(conversationCalls(source, 'conversation-open')).toHaveLength(1)
    expect(screen.getByText('Direct messages aren’t available right now.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the very same request id for when the family comes back', async () => {
    const source = platform({ conversationsOn: true, channels: [general], mutations: { 'conversation-open': lost } })
    await lostOpen(source)
    const first = conversationCalls(source, 'conversation-open')[0]!

    source.state.conversationsOn = false
    await act(() => loadTeamSpaceDiscovery(source.bridge, 'account-a', { force: true }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New message' })).toBeNull())
    expect(screen.getByText('Direct messages')).toBeTruthy()

    delete source.state.mutations['conversation-open']
    source.state.conversationsOn = true
    await act(() => loadTeamSpaceDiscovery(source.bridge, 'account-a', { force: true }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(conversationCalls(source, 'conversation-open')).toHaveLength(2))
    expect(conversationCalls(source, 'conversation-open')[1]!.requestId).toBe(first.requestId)
  })
})

describe('a company switch fences every conversation flow', () => {
  const BETA = { id: OTHER_COMPANY_ID, displayName: 'Beta Works' }
  const ATUM = { id: COMPANY_ID, displayName: 'Atum Studio' }

  it('does not move the window to Atum’s default channel after a hide finishes once Beta is the company on screen', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const base = platform({ companies: [ATUM, BETA], conversationsOn: true, conversations: [withBao], channels: [general] })
    const { held, release, source } = holding(base, 'conversation-hidden')

    const props = {
      ...fast,
      activeRoomId: conversationRoomId(withBao.id),
      onOpenChannel,
      preferredCompanyId: COMPANY_ID,
      rooms: [conversationRoom(withBao.id), channelRoom(general.id, 'general')]
    }

    const view = renderTeamSpace(source, props)
    await row('Bảo')

    requestTeamSpaceIntent({ kind: 'conversation-hide', conversationId: withBao.id })
    await waitFor(() => expect(held).toHaveLength(1))

    // A notification into Beta's room moves the window to Beta while the hide is still in flight.
    rerenderTeamSpace(view, source, { ...props, preferredCompanyId: OTHER_COMPANY_ID })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))

    release()
    await flush()

    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it('does not open a hidden conversation’s room after Beta became the company on screen while it was being shown again', async () => {
    const hidden: ScriptedConversation = { ...withBao, hidden: true }
    const onOpenChannel = vi.fn(async () => {})
    const base = platform({ companies: [ATUM, BETA], conversationsOn: true, conversations: [hidden], channels: [general] })
    const { held, release, source } = holding(base, 'conversation-hidden')
    const props = { ...fast, onOpenChannel, preferredCompanyId: COMPANY_ID, rooms: [conversationRoom(hidden.id)] }

    const view = renderTeamSpace(source, props)
    await waitFor(() => expect(document.querySelector('[data-matrix-company-conversations-hidden]')).toBeTruthy())
    const folded = document.querySelector('[data-matrix-company-conversations-hidden]') as HTMLElement

    fireEvent.click(within(folded).getByRole('button', { name: 'Hidden' }))
    fireEvent.click(within(folded).getByRole('button', { name: 'Open conversation with Bảo' }))
    await waitFor(() => expect(held).toHaveLength(1))

    rerenderTeamSpace(view, source, { ...props, preferredCompanyId: OTHER_COMPANY_ID })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))

    release()
    await flush()

    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it('does not load, join or select the old company’s new conversation when its create answer arrives after Beta became the company on screen', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const base = platform({ companies: [ATUM, BETA], conversationsOn: true, conversations: [], channels: [general] })
    const { held, release, source } = holding(base, 'conversation-open')
    const props = { ...fast, onOpenChannel, preferredCompanyId: COMPANY_ID, rooms: [] as never[] }

    const view = renderTeamSpace(source, props)
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    fireEvent.click(within(section()).getByRole('button', { name: 'New message' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(held).toHaveLength(1))

    rerenderTeamSpace(view, source, { ...props, preferredCompanyId: OTHER_COMPANY_ID })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))
    const readsBefore = base.calls('conversations').length

    release()
    await flush()

    expect(onOpenChannel).not.toHaveBeenCalled()
    // Nothing of the old company is read on its behalf after the switch: no directory read for its room.
    expect(conversationCalls(base, 'conversations').slice(readsBefore).filter(call => call.companyId === COMPANY_ID)).toHaveLength(0)
    expect(base.calls('conversation-hidden')).toHaveLength(0)
  })

  it('does the same for an expand: the old company’s wider conversation is not opened under Beta', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const base = platform({ companies: [ATUM, BETA], conversationsOn: true, conversations: [withBao], channels: [general] })
    const { held, release, source } = holding(base, 'conversation-expand')
    const props = { ...fast, onOpenChannel, preferredCompanyId: COMPANY_ID, rooms: [conversationRoom(withBao.id)] }

    const view = renderTeamSpace(source, props)
    await row('Bảo')
    requestTeamSpaceIntent({ kind: 'conversation-add-people', conversationId: withBao.id })
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Lan Nguyễn' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start new conversation' }))
    await waitFor(() => expect(held).toHaveLength(1))

    rerenderTeamSpace(view, source, { ...props, preferredCompanyId: OTHER_COMPANY_ID })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))
    const readsBefore = base.calls('conversations').length

    release()
    await flush()

    expect(onOpenChannel).not.toHaveBeenCalled()
    expect(conversationCalls(base, 'conversations').slice(readsBefore).filter(call => call.companyId === COMPANY_ID)).toHaveLength(0)
  })

  it('hands the owner a way to see the selection has moved: the open is told, after every await, whether it is still the one asked for', async () => {
    const base = platform({ companies: [ATUM, BETA], conversationsOn: true, conversations: [withBao], channels: [general] })
    const seen: Array<(() => boolean) | undefined> = []

    const onOpenChannel = vi.fn(async (_roomId: string, isCurrent?: () => boolean) => { seen.push(isCurrent) })
    const props = { ...fast, onOpenChannel, preferredCompanyId: COMPANY_ID, rooms: [conversationRoom(withBao.id)] }

    const view = renderTeamSpace(base, props)

    fireEvent.click(await row('Bảo'))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledTimes(1))
    const stillCurrent = seen[0]!

    expect(stillCurrent()).toBe(true)

    rerenderTeamSpace(view, base, { ...props, preferredCompanyId: OTHER_COMPANY_ID })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))
    expect(stillCurrent()).toBe(false)
  })
})
