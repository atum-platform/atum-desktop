import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCompanyRequest } from '../../../shared/matrix-company'

import { CONVERSATION_MAX_OTHERS, ConversationDialog } from './conversation-dialog'
import { $companyConversations, loadCompanyConversations } from './conversations-store'
import { requestTeamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import {
  CHANNEL_IDS,
  channelRoom,
  CONVERSATION_IDS,
  conversationRoom,
  conversationRoomId,
  platform,
  REFS,
  renderTeamSpace,
  resetTeamSpace,
  type ScriptedConversation,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(cleanup)

const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }

/** The viewer (Minh) and Bảo. */
const withBao: ScriptedConversation = { id: CONVERSATION_IDS.dm, others: ['admin'] }
/** The viewer, Bảo and Lan: a group. */
const withBaoAndLan: ScriptedConversation = { id: CONVERSATION_IDS.group, others: ['admin', 'member'] }

const roomsFor = (...items: ScriptedConversation[]) => items.map(item => conversationRoom(item.id))

const section = () => document.querySelector('[data-matrix-company-conversations]') as HTMLElement
/** The section is drawn once the company is read; wait for it, then hand it back. */
const sectionReady = async () => {
  await waitFor(() => expect(section()).toBeTruthy())

  return section()
}

const rowOf = async (title: string) =>
  within(await sectionReady()).findByRole('button', { name: `Open conversation with ${title}` })

const conversationMutations = (source: ReturnType<typeof platform>) =>
  source.mutations().filter(input => input.action.startsWith('conversation-')) as Array<Record<string, unknown>>

/** Faster convergence than the real one-and-a-half seconds, so a created conversation opens inside a test. */
const fast = { convergenceDelayMs: 5, convergenceAttempts: 6 }

async function startFlow() {
  fireEvent.click(within(await sectionReady()).getByRole('button', { name: 'New message' }))

  return screen.findByRole('dialog')
}

describe('Direct messages in the sidebar', () => {
  it('lists company DMs and group DMs, each named for the other people, from the platform’s directory', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao, withBaoAndLan] })
    renderTeamSpace(source, { rooms: roomsFor(withBao, withBaoAndLan) })

    await rowOf('Bảo')
    await rowOf('Bảo, Lan Nguyễn')

    expect(within(section()).getByText('Direct messages')).toBeTruthy()
    expect(
      [...document.querySelectorAll('[data-matrix-company-conversation-row]')].map(row => row.getAttribute('data-conversation-kind'))
    ).toEqual(['dm', 'group_dm'])
    expect(source.calls('conversations')[0]).toMatchObject({ companyId: expect.any(String) })
  })

  it('opens the conversation’s room through the same owner as a channel', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ conversationsOn: true, conversations: [withBao] })
    renderTeamSpace(source, { onOpenChannel, rooms: roomsFor(withBao) })

    fireEvent.click(await rowOf('Bảo'))

    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith(conversationRoomId(withBao.id), expect.any(Function)))
  })

  it('says a conversation is read-only or still being set up on its row, and a read-only one still opens', async () => {
    const readOnly: ScriptedConversation = { id: CONVERSATION_IDS.dm, others: ['admin'], state: 'read_only' }
    const settingUp: ScriptedConversation = { id: CONVERSATION_IDS.group, others: ['admin', 'member'], ready: false }
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ conversationsOn: true, conversations: [readOnly, settingUp] })
    renderTeamSpace(source, { onOpenChannel, rooms: roomsFor(readOnly) })

    const done = await rowOf('Bảo')

    expect(within(done).getByText('Read-only')).toBeTruthy()
    // A room that is not made yet has nothing to open, and says so instead of failing.
    const waiting = within(section()).getByText('Bảo, Lan Nguyễn').closest('button')!

    expect(waiting.hasAttribute('disabled')).toBe(true)
    expect(within(waiting).getByText('Setting up…')).toBeTruthy()

    fireEvent.click(done)
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith(conversationRoomId(readOnly.id), expect.any(Function)))
  })

  it('shows an empty section with the way in, and a failed read in place, without taking the channels away', async () => {
    const source = platform({ conversationsOn: true, conversations: [], channels: [general] })
    renderTeamSpace(source, { rooms: [channelRoom(general.id, 'general')] })

    expect(await within(await sectionReady()).findByRole('button', { name: 'New message' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open # general' })).toBeTruthy()

    cleanup()
    resetTeamSpace()
    const failing = platform({ conversationsOn: true, channels: [general], mutations: { conversations: () => ({ ok: false, error: 'unavailable' }) } })
    renderTeamSpace(failing, { rooms: [channelRoom(general.id, 'general')] })

    expect(await within(await sectionReady()).findByText('Conversations couldn’t be loaded.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open # general' })).toBeTruthy()
  })

  it('shows a plus action at the Direct messages heading', async () => {
    const source = platform({ conversationsOn: true, channels: [general] })
    renderTeamSpace(source, { rooms: [] })

    const action = await within(await sectionReady()).findByRole('button', { name: 'New message' })
    expect(action.querySelector('.atum-icon-plus')).toBeTruthy()
    expect(action.closest('[data-team-space-section-action]')).toBeTruthy()
  })
})

describe('wire 1.5 absent', () => {
  it.each([
    ['a 1.4 server', { conversationsOn: false }],
    ['a server that names 1.5 but has the feature off', { conversationsOn: 'wire-only' as const }],
    ['a server that predates discovery', { discovery: 'missing' as const, conversationsOn: false }]
  ])('%s: only the assistant placeholder remains and nothing is asked on 1.5', async (_name, over) => {
    // A directory the script holds but the server must never be asked for.
    const source = platform({ ...over, conversations: [withBao], channels: [general] })
    renderTeamSpace(source, { rooms: [channelRoom(general.id, 'general'), ...roomsFor(withBao)] })

    await screen.findByRole('button', { name: 'Open # general' })
    await waitFor(() => expect(source.calls('capabilities').length).toBeGreaterThan(0))

    expect(document.querySelector('[data-matrix-company-conversations]')).toBeTruthy()
    expect(screen.getByText('Direct messages')).toBeTruthy()
    expect(screen.getByText('Direct messages')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull()
    expect(source.calls('conversations')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('New message', () => {
  it('starts a direct message with one person: one atomic open of this person and that one, then opens the room', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ conversationsOn: true, conversations: [], channels: [general] })
    renderTeamSpace(source, { ...fast, onOpenChannel, rooms: [] })

    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    onOpenChannel.mockClear()
    const dialog = await startFlow()

    // Nobody yet: Start waits for a person. The viewer is not offered to themselves.
    expect((within(dialog).getByRole('button', { name: 'Start conversation' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).queryByRole('checkbox', { name: 'Minh' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(conversationMutations(source)).toHaveLength(1))

    const [open] = conversationMutations(source)

    expect(open).toMatchObject({ action: 'conversation-open' })
    expect(new Set(open!.participantMemberRefs as string[])).toEqual(new Set([REFS.owner, REFS.admin]))
    expect(open!.requestId).toMatch(/^[0-9a-f-]{36}$/)

    // The platform made the conversation; its room is opened once the hosted manager has it here.
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledTimes(1))
    expect(onOpenChannel).toHaveBeenCalledWith(conversationRoomId(source.state.conversations[0]!.id), expect.any(Function))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('starts a group with several people in one open, and a second pick of the same people finds the same conversation', async () => {
    const source = platform({ conversationsOn: true, conversations: [], channels: [general] })
    renderTeamSpace(source, { ...fast, rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })

    let dialog = await startFlow()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Lan Nguyễn' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    expect(within(dialog).getByText('Selected: 2')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(conversationMutations(source)).toHaveLength(1))

    const [first] = conversationMutations(source)

    expect(new Set(first!.participantMemberRefs as string[])).toEqual(new Set([REFS.owner, REFS.admin, REFS.member]))
    expect(source.state.conversations).toHaveLength(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // The same people again, in the other order: the platform answers the conversation it already has.
    dialog = await startFlow()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Lan Nguyễn' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(conversationMutations(source)).toHaveLength(2))

    expect(source.state.conversations).toHaveLength(1)
    expect(conversationMutations(source)[1]!.requestId).not.toBe(first!.requestId)
  })

  it('filters people by name, and says when nobody matches', async () => {
    const source = platform({ conversationsOn: true, channels: [general] })
    renderTeamSpace(source, { rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    const dialog = await startFlow()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search people' }), { target: { value: 'nguyen' } })
    expect(within(dialog).getByRole('checkbox', { name: 'Lan Nguyễn' })).toBeTruthy()
    expect(within(dialog).queryByRole('checkbox', { name: 'Bảo' })).toBeNull()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search people' }), { target: { value: 'zzz' } })
    expect(within(dialog).getByText('No one matches that.')).toBeTruthy()
  })

  it('says why a refusal happened and keeps the picker open, without opening anything', async () => {
    const source = platform({
      conversationsOn: true,
      channels: [general],
      mutations: { 'conversation-open': () => ({ ok: false, error: 'conflict', reason: 'participant_set_conflict' }) }
    })

    const onOpenChannel = vi.fn(async () => {})
    renderTeamSpace(source, { ...fast, onOpenChannel, rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    onOpenChannel.mockClear()
    const dialog = await startFlow()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))

    expect(await within(dialog).findByText('This group changed while you were choosing. Try again.')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it('leaves an answer that was lost to the workspace’s Retry, which replays the very same request', async () => {
    let attempts = 0

    const source = platform({
      conversationsOn: true,
      channels: [general],
      mutations: {
        'conversation-open': input => {
          attempts += 1

          if (attempts === 1) {return { ok: false, error: 'unavailable' }}

          return { ok: true, value: { schemaVersion: 6, replayed: true, conversation: {
            id: CONVERSATION_IDS.dm, companyId: (input as { companyId: string }).companyId, kind: 'dm', state: 'active',
            participants: [{ memberRef: REFS.owner, admissionEpoch: 1, handle: 'minh', displayName: 'Minh' },
              { memberRef: REFS.admin, admissionEpoch: 2, handle: 'bao', displayName: 'Bảo' }],
            participantSetDigest: '0'.repeat(64), authorityGeneration: 7, conversationGeneration: 1,
            room: { state: 'ready', roomId: conversationRoomId(CONVERSATION_IDS.dm) }, hidden: false } } }
        }
      }
    })

    renderTeamSpace(source, { ...fast, rooms: [] })
    await within(await sectionReady()).findByRole('button', { name: 'New message' })
    const dialog = await startFlow()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bảo' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start conversation' }))

    // The answer was lost: the picker closes and the banner offers Retry.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(attempts).toBe(2))

    const [first, second] = source.request.mock.calls
      .map(([input]) => input as MatrixCompanyRequest)
      .filter(input => input.action === 'conversation-open') as Array<{ requestId: string }>

    expect(second!.requestId).toBe(first!.requestId)
  })
})

describe('Add people to a conversation', () => {
  it('opens another conversation with the larger group without a non-event explanation', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao], channels: [general] })
    renderTeamSpace(source, { ...fast, rooms: roomsFor(withBao) })
    await rowOf('Bảo')

    requestTeamSpaceIntent({ kind: 'conversation-add-people', conversationId: withBao.id })
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).queryByText('Starts a new chat; this chat stays unchanged.')).toBeNull()
    expect(within(dialog).queryByRole('checkbox', { name: 'Bảo' })).toBeNull()
    expect(within(dialog).queryByRole('checkbox', { name: 'Minh' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Lan Nguyễn' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start new conversation' }))

    await waitFor(() => expect(conversationMutations(source)).toHaveLength(1))

    const [expand] = conversationMutations(source)

    expect(expand).toMatchObject({ action: 'conversation-expand', sourceConversationId: withBao.id })
    expect(new Set(expand!.participantMemberRefs as string[])).toEqual(new Set([REFS.owner, REFS.admin, REFS.member]))

    // The source conversation is untouched and the new one stands beside it.
    await waitFor(() => expect(source.state.conversations).toHaveLength(2))
    expect(source.state.conversations[0]).toMatchObject({ id: withBao.id, others: ['admin'] })
  })
})

describe('Hide and show again', () => {
  it('hides a conversation as only this person’s presentation, and folds it under Hidden', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao, withBaoAndLan], channels: [general] })
    renderTeamSpace(source, { ...fast, rooms: roomsFor(withBao, withBaoAndLan) })
    await rowOf('Bảo')

    requestTeamSpaceIntent({ kind: 'conversation-hide', conversationId: withBao.id })

    await waitFor(() => expect(conversationMutations(source)).toHaveLength(1))
    expect(conversationMutations(source)[0]).toMatchObject({ action: 'conversation-hidden', conversationId: withBao.id, hidden: true })

    // It leaves the section; the other conversation stays; Hidden is collapsed until asked for.
    await waitFor(() => expect(within(section()).queryByRole('button', { name: 'Open conversation with Bảo' })).toBeNull())
    expect(within(section()).getByRole('button', { name: 'Open conversation with Bảo, Lan Nguyễn' })).toBeTruthy()

    const hidden = document.querySelector('[data-matrix-company-conversations-hidden]') as HTMLElement

    expect(within(hidden).queryByRole('button', { name: 'Open conversation with Bảo' })).toBeNull()
    fireEvent.click(within(hidden).getByRole('button', { name: 'Hidden' }))
    expect(within(hidden).getByRole('button', { name: 'Open conversation with Bảo' })).toBeTruthy()
    // Nothing about who is in the conversation changed.
    expect(source.state.conversations.find(item => item.id === withBao.id)?.others).toEqual(['admin'])
  })

  it('moves to the default channel when the conversation on screen is hidden', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ conversationsOn: true, conversations: [withBao], channels: [general] })

    renderTeamSpace(source, {
      ...fast,
      activeRoomId: conversationRoomId(withBao.id),
      onOpenChannel,
      rooms: [...roomsFor(withBao), channelRoom(general.id, 'general')]
    })

    await rowOf('Bảo')
    requestTeamSpaceIntent({ kind: 'conversation-hide', conversationId: withBao.id })

    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith(channelRoom(general.id, 'general').id, expect.any(Function)))
  })

  it('shows a hidden conversation again when it is opened', async () => {
    const hidden: ScriptedConversation = { ...withBao, hidden: true }
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ conversationsOn: true, conversations: [hidden], channels: [general] })
    renderTeamSpace(source, { ...fast, onOpenChannel, rooms: roomsFor(hidden) })

    await waitFor(() => expect(document.querySelector('[data-matrix-company-conversations-hidden]')).toBeTruthy())
    const folded = document.querySelector('[data-matrix-company-conversations-hidden]') as HTMLElement
    fireEvent.click(within(folded).getByRole('button', { name: 'Hidden' }))
    fireEvent.click(within(folded).getByRole('button', { name: 'Open conversation with Bảo' }))

    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith(conversationRoomId(hidden.id), expect.any(Function)))
    expect(conversationMutations(source)[0]).toMatchObject({ action: 'conversation-hidden', conversationId: hidden.id, hidden: false })
    await waitFor(() =>
      expect(within(section()).getByRole('button', { name: 'Open conversation with Bảo' })).toBeTruthy()
    )
  })
})

describe('the picker', () => {
  const people = Array.from({ length: 10 }, (_, index) => ({ memberRef: `${String.fromCharCode(66 + index)}`.repeat(43), name: `Person ${index + 1}` }))
  const SELF = 'A'.repeat(43)

  function mount(over: Partial<ComponentProps<typeof ConversationDialog>> = {}) {
    const mutate = vi.fn(async () => undefined)

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <ConversationDialog
          begin={() => () => true}
          companyId="00000000-0000-4000-8000-72805976e3a7"
          mode={{ kind: 'new' }}
          mutate={mutate}
          onClose={vi.fn()}
          onOpened={vi.fn()}
          open
          people={people}
          selfMemberRef={SELF}
          {...over}
        />
      </I18nProvider>
    )

    return mutate
  }

  it('takes at most eight other people (nine in all), and says so', () => {
    mount()
    const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[]

    for (const box of boxes().slice(0, CONVERSATION_MAX_OTHERS)) {fireEvent.click(box)}

    expect(boxes().filter(box => box.checked)).toHaveLength(CONVERSATION_MAX_OTHERS)
    expect(boxes().filter(box => !box.checked).every(box => box.disabled)).toBe(true)
    expect(screen.getByText('A group can have up to 8 other people.')).toBeTruthy()

    // Taking one off frees a place.
    fireEvent.click(boxes()[0]!)
    expect(boxes().filter(box => !box.checked).some(box => !box.disabled)).toBe(true)
  })

  it('offers nothing while the viewer’s own place is not known, rather than guessing a set', () => {
    const mutate = mount({ selfMemberRef: undefined })

    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect((screen.getByRole('button', { name: 'Start conversation' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('says when there is no one else in the company', () => {
    mount({ people: [] })
    expect(screen.getByText('No one else is in this company yet.')).toBeTruthy()
  })
})

describe('a vietnamese window', () => {
  it('words the section and the picker in vi', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao], channels: [general] })

    renderTeamSpace(source, { rooms: roomsFor(withBao) }, 'vi')

    expect(await screen.findByText('Tin nhắn trực tiếp')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tin nhắn mới' })).toBeTruthy()
  })
})

describe('the conversation directory store', () => {
  const key = teamSpaceKey('account-a', '00000000-0000-4000-8000-72805976e3a7')
  const company = '00000000-0000-4000-8000-72805976e3a7'

  it('asks nothing, and keeps nothing, while the family is off', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao] })

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true })
    expect($companyConversations.get()[key]?.conversations).toHaveLength(1)

    const asked = source.calls('conversations').length

    // Discovery now says it is off (a rollback): the earlier list leaves the screen and no 1.5 request is sent.
    expect(await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: false })).toBeUndefined()
    expect($companyConversations.get()[key]).toBeUndefined()
    expect(source.calls('conversations')).toHaveLength(asked)
  })

  it('replaces the directory wholesale: a conversation that left the answer leaves the screen', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao, withBaoAndLan] })

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true })
    expect($companyConversations.get()[key]?.conversations).toHaveLength(2)

    source.state.conversations = [withBaoAndLan]
    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true }, { quiet: true })

    expect($companyConversations.get()[key]?.conversations.map(item => item.id)).toEqual([withBaoAndLan.id])
  })

  it('keeps the last good list through a failed quiet read, and says why after a failed foreground one', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao] })

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true })
    source.state.mutations.conversations = () => ({ ok: false, error: 'unavailable' })

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true }, { quiet: true })
    expect($companyConversations.get()[key]?.conversations).toHaveLength(1)
    expect($companyConversations.get()[key]?.error).toBeUndefined()

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true })
    expect($companyConversations.get()[key]).toMatchObject({ conversations: [], error: 'unavailable' })
  })

  it('does not take an answer from another wire family as a conversation list', async () => {
    const source = platform({ conversationsOn: true })
    source.state.mutations.conversations = () => ({ ok: true, value: { schemaVersion: 5, channels: [] } as never })

    await loadCompanyConversations(source.bridge, 'account-a', company, { conversations: true })
    expect($companyConversations.get()[key]).toMatchObject({ conversations: [], error: 'invalid' })
  })
})
