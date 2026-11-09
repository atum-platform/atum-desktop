import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { MATRIX_COMPANY_CONVERSATION_TYPE } from '../../../shared/matrix-company-channel-room'
import { companyRoomsBadge } from '../company-chrome'
import { directPartner, groupConversations } from '../people'
import { projectMatrixRoster } from '../roster-model'

import { companyUnread } from './company-badge'
import { ConversationMenu, ConversationTitleFor, ReadOnlyConversationBanner } from './conversation-chrome'
import { $companyConversations, $companySelfRefs, conversationViewForRoom } from './conversations-store'
import { clearTeamSpaceDiscovery } from './discovery-store'
import { $teamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import { COMPANY_ID, CONVERSATION_IDS, conversationRoom, conversationRoomId, REFS } from './test-support'
import { useCompanyChannelFacts } from './use-channel-facts'
import type { CompanyConversationView } from './views'

afterEach(cleanup)

const KEY = 'acct'
const key = teamSpaceKey(KEY, COMPANY_ID)

beforeEach(() => {
  clearTeamSpaceDiscovery()
  $companyConversations.set({})
  $companySelfRefs.set({})
  $teamSpaceIntent.set(undefined)
})

const mount = (node: ReactNode) => render(<I18nProvider configClient={null} initialLocale="en">{node}</I18nProvider>)

const view = (over: Partial<CompanyConversationView> = {}): CompanyConversationView => ({
  id: CONVERSATION_IDS.dm,
  companyId: COMPANY_ID,
  kind: 'dm',
  state: 'active',
  participants: [
    { memberRef: REFS.owner, handle: 'minh', displayName: 'Minh' },
    { memberRef: REFS.admin, handle: 'bao', displayName: 'Bảo' }
  ],
  hidden: false,
  room: { state: 'ready', roomId: conversationRoomId(CONVERSATION_IDS.dm) },
  conversationGeneration: 4,
  ...over
})

const list = (...conversations: CompanyConversationView[]) =>
  $companyConversations.setKey(key, { conversations, loading: false })

describe('what the platform says about the open conversation room', () => {
  function Facts({ room = conversationRoom(CONVERSATION_IDS.dm) }: { room?: MatrixRoom }) {
    const facts = useCompanyChannelFacts(KEY, room)

    return (
      <>
        <p data-testid="state">{facts.state}</p>
        <p data-testid="closed">{String(facts.archived)}</p>
        <p data-testid="attach">{String(facts.attachments)}</p>
        <p data-testid="listed">{String(Boolean(facts.conversation))}</p>
      </>
    )
  }

  const read = (id: string) => screen.getByTestId(id).textContent

  it('is unknown, and takes no message, until the directory lists the conversation', () => {
    mount(<Facts />)

    expect(read('state')).toBe('unknown')
    expect(read('listed')).toBe('false')
    // "Not read-only yet" is not "not read-only": the box stays closed rather than letting a post through.
    expect(read('closed')).toBe('false')
  })

  it('follows the platform: active takes protected files, read-only takes neither messages nor files', () => {
    list(view())
    mount(<Facts />)
    expect(read('state')).toBe('active')
    expect(read('closed')).toBe('false')
    expect(read('attach')).toBe('true')

    act(() => list(view({ state: 'read_only' })))
    expect(read('state')).toBe('archived')
    expect(read('closed')).toBe('true')
    expect(read('listed')).toBe('true')
    expect(read('attach')).toBe('false')
  })

  it('does not believe a room that merely claims to be the conversation', () => {
    list(view())
    // The directory puts this conversation in another room: the claim in this room's own metadata is not enough.
    mount(<Facts room={conversationRoom(CONVERSATION_IDS.dm, { id: '!forged:atum.example' })} />)

    expect(read('state')).toBe('unknown')
    expect(read('listed')).toBe('false')
    expect(conversationViewForRoom({ conversations: [view()], loading: false }, { id: '!forged:atum.example', companyConversation: { companyId: COMPANY_ID, conversationId: CONVERSATION_IDS.dm } })).toBeUndefined()
  })

  it('is unknown, with no file and no box, for a room that claims the type with no readable binding, however the directory reads', () => {
    list(view())
    const typeOnly: MatrixRoom = {
      id: conversationRoomId(CONVERSATION_IDS.dm), name: 'x', membership: 'join', encrypted: false, roomType: MATRIX_COMPANY_CONVERSATION_TYPE
    }

    mount(<Facts room={typeOnly} />)

    expect(read('state')).toBe('unknown')
    expect(read('listed')).toBe('false')
    expect(read('attach')).toBe('false')
  })

  it('is unknown while the directory is stale or refused: stale or failed authority posts nothing', () => {
    $companyConversations.setKey(key, { conversations: [view()], loading: false, stale: true })
    mount(<Facts />)
    expect(read('state')).toBe('unknown')
    expect(read('listed')).toBe('false')

    act(() => $companyConversations.setKey(key, { conversations: [], loading: false, error: 'denied' }))
    expect(read('state')).toBe('unknown')

    act(() => list(view()))
    expect(read('state')).toBe('active')
  })

  it('is no business of a room that is no conversation', () => {
    mount(<Facts room={{ id: '!x:y', name: 'x', membership: 'join', encrypted: false }} />)

    expect(read('state')).toBe('active')
    expect(read('closed')).toBe('false')
  })
})

describe('the open conversation’s header and banner', () => {
  const room = conversationRoom(CONVERSATION_IDS.dm)

  it('is named for the other people, from the platform’s record', () => {
    list(view({ kind: 'group_dm', participants: [
      { memberRef: REFS.owner, handle: 'minh', displayName: 'Minh' },
      { memberRef: REFS.admin, handle: 'bao', displayName: 'Bảo' },
      { memberRef: REFS.member, handle: 'lan_nguyen', displayName: null }
    ] }))
    $companySelfRefs.setKey(key, REFS.owner)

    mount(<p data-testid="title"><ConversationTitleFor accountKey={KEY} fallback="room name" room={room} /></p>)

    expect(screen.getByTestId('title').textContent).toBe('Bảo, @lan_nguyen')
  })

  it('shows the Matrix room name only before the record is read', () => {
    mount(<p data-testid="title"><ConversationTitleFor accountKey={KEY} fallback="room name" room={room} /></p>)

    expect(screen.getByTestId('title').textContent).toBe('room name')
  })

  it('says why a read-only conversation takes no message, in place of the box', () => {
    mount(<ReadOnlyConversationBanner />)

    const banner = screen.getByRole('status')

    expect(banner.getAttribute('data-matrix-conversation-read-only')).not.toBeNull()
    expect(banner.textContent).toBe('Read-only because someone left the company.')
  })

  function openMenu() {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
  }

  it('offers add people and hide, and no leave, delete or removal', () => {
    list(view())
    mount(<ConversationMenu accountKey={KEY} room={room} />)
    openMenu()

    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Add people',
      'Mute notifications',
      'Hide conversation'
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide conversation' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'conversation-hide', conversationId: CONVERSATION_IDS.dm })
  })

  it('does not offer to add people to a read-only conversation, which can only be hidden', () => {
    list(view({ state: 'read_only' }))
    mount(<ConversationMenu accountKey={KEY} room={room} />)
    openMenu()

    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Mute notifications', 'Hide conversation'])
  })

  it('uses the existing room notification command for a DM', async () => {
    const command = vi.fn().mockResolvedValue(null)
    window.atumMatrix = { command } as unknown as typeof window.atumMatrix
    list(view())
    mount(<ConversationMenu accountKey={KEY} room={room} />)
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute notifications' }))

    expect(command).toHaveBeenCalledWith({ kind: 'mute', roomId: room.id, muted: true })
  })

  it('closes while the directory is stale, so nothing can be hidden or widened on stale authority', () => {
    $companyConversations.setKey(key, { conversations: [view()], loading: false, stale: true })
    mount(<ConversationMenu accountKey={KEY} room={room} />)

    expect(screen.queryByRole('button', { name: 'Conversation options' })).toBeNull()
  })

  it('draws nothing for a room the platform does not list', () => {
    mount(<ConversationMenu accountKey={KEY} room={room} />)

    expect(screen.queryByRole('button', { name: 'Conversation options' })).toBeNull()
    expect(within(document.body).queryByText('Add people')).toBeNull()
  })
})

describe('a company conversation is never a Personal chat', () => {
  const owner = '@owner:test'

  const snapshot = (rooms: MatrixRoom[]): MatrixSnapshot => ({
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [{ principal: 'default', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true }],
    rooms,
    roomId: null,
    messages: [],
    error: null
  })

  const plain: MatrixRoom = { id: '!plain:test', name: 'Plain chat', membership: 'join', encrypted: true, direct: true,
    participants: [{ userId: owner, membership: 'join' }, { userId: '@lan:test', membership: 'join' }] }

  const company = (over: Partial<MatrixRoom> = {}): MatrixRoom => ({
    id: '!dm:test', name: 'Bảo', membership: 'join', encrypted: false, direct: true,
    participants: [{ userId: owner, membership: 'join' }, { userId: '@bao:test', membership: 'join' }],
    roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
    companyConversation: { companyId: COMPANY_ID, conversationId: CONVERSATION_IDS.dm },
    ...over
  })

  it('stays out of the chat roster, whether its binding reads or it only claims the type', () => {
    const bound = company()
    const claimed = company({ id: '!claimed:test', companyConversation: undefined })
    const roster = projectMatrixRoster(snapshot([plain, bound, claimed]))

    expect(roster.rest.map(room => room.id)).toEqual(['!plain:test'])
    expect(roster.groups.flatMap(group => group.rooms)).toEqual([])
  })

  it('is no known person and no group conversation of the personal lists', () => {
    const bound = company()
    const group = company({ id: '!group:test', direct: false, name: 'Team' })

    expect(directPartner(plain, owner)).toBe('@lan:test')
    expect(directPartner(bound, owner)).toBeUndefined()
    expect(groupConversations(snapshot([plain, bound, group])).map(room => room.id)).toEqual([])
  })

  it('counts toward its company’s unread, but not toward another company’s', () => {
    const unread = company({ highlights: 2, unread: true, unreadNotifications: 3 })

    expect(companyUnread([unread], COMPANY_ID)).toEqual({ mentions: 2, unread: true })
    expect(companyUnread([unread], '00000000-0000-4000-8000-125dd8ac0406')).toEqual({ mentions: 0, unread: false })
    // The Workplace icon sums the company's rooms by the personal roster's own rule.
    expect(companyRoomsBadge([unread], COMPANY_ID)).toMatchObject({ kind: 'mention' })
    expect(companyRoomsBadge([unread], '00000000-0000-4000-8000-125dd8ac0406')).toBeNull()
  })
})
