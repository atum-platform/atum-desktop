import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'

import type { AtumAgent } from './agents'
import type { AtumAssistantChat } from './assistant-chats'
import { buildAtumRoster, filterRoster, foldSearchText, toDisplayTitle } from './roster'

const conversation = (overrides: Partial<AtumMessagingConversation> = {}): AtumMessagingConversation => ({
  id: 'c1',
  title: 'Moon',
  kind: 'specialist',
  participantIds: ['moon'],
  updatedAt: '2026-08-12T00:00:00.000Z',
  lastMessageAt: '2026-08-12T00:00:00.000Z',
  unreadCount: 0,
  payload: { specialist: 'moon' },
  ...overrides
})

const SELF = '00000000-0000-4000-8000-cd7cefa51808'
const PEER = '00000000-0000-4000-8000-f99bd2c2b0ae'

const agent = (overrides: Partial<AtumAgent> = {}): AtumAgent => ({
  id: 'default',
  identityId: '',
  lifecycleRevision: 0,
  title: '',
  avatar: '',
  description: '',
  isDefault: true,
  isManaged: true,
  pinned: false,
  ...overrides
})

const base = {
  accountId: SELF,
  agents: [agent()],
  assistantHint: 'Bắt đầu trò chuyện mới',
  assistantTitle: 'Atum',
  locale: 'vi' as const,
  catalog: [{ app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: { en: 'Astrology specialist', vi: 'Chuyên gia chiêm tinh' }, icon: { url: 'https://assets.example/moon.png', sha256: 'a'.repeat(64) }, verified: true, availability: 'available' as const, supported_modes: ['direct' as const], link: { mode: 'none' as const, state: 'never_linked' as const } }],
  people: [] as AtumSocialProjection[],
  untitledChat: 'Trò chuyện chưa có tên'
}

const directThread = (overrides: Partial<AtumMessagingConversation> = {}): AtumMessagingConversation =>
  conversation({
    id: 'thread-1',
    kind: 'direct',
    title: null,
    participantIds: [SELF, PEER],
    payload: {
      participants: [
        { type: 'user', id: SELF, display_name: 'Sample Self' },
        { type: 'user', id: PEER, display_name: 'Sample Peer' }
      ]
    },
    ...overrides
  })

const connectedPeer = (directThreadId: string, displayName = 'Sample Member', avatar: string | null = null): AtumSocialProjection => ({
  availability: 'available',
  profile: { profileId: PEER, displayName, handle: 'sample-peer', verified: false, avatar },
  state: 'connected',
  version: 3,
  canMessage: true,
  directThreadId
})

const chat = (overrides: Partial<AtumAssistantChat> = {}): AtumAssistantChat => ({
  id: 'sess-1',
  agentId: 'default',
  sessionIds: ['sess-1'],
  title: 'Kế hoạch tuần',
  preview: 'Lập kế hoạch cho tuần tới',
  activityAt: '2026-09-02T08:00:00.000Z',
  unread: false,
  route: '/sess-1',
  ...overrides
})

describe('buildAtumRoster', () => {
  it('always leads with the local assistant, even with no hosted conversations', () => {
    const roster = buildAtumRoster({ ...base, chats: [], conversations: [], dmsAvailable: true })

    expect(roster).toHaveLength(2)
    expect(roster[0]).toMatchObject({ id: 'agent:default', kind: 'assistant', route: '/' })
    expect(roster[1]).toMatchObject({
      id: 'app:moon',
      appId: 'moon',
      conversationId: null,
      kind: 'app',
      title: 'Moon'
    })
  })

  it('always routes the pinned assistant at the new-chat route', () => {
    const roster = buildAtumRoster({ ...base, chats: [chat()], conversations: [], dmsAvailable: true })

    expect(roster[0]).toMatchObject({ id: 'agent:default', kind: 'assistant', route: '/' })
  })

  it('gives a named agent the same way in as the master, so its row is not inert', () => {
    // The bug this pins: a named agent's row carried no route, so clicking it
    // did nothing and a person who had just made an assistant could not reach
    // it. Every agent leads to the composer; which agent it talks to is what
    // the click decides.
    const roster = buildAtumRoster({
      ...base,
      agents: [agent(), agent({ id: 'marketing', title: 'Marketing', isDefault: false })],
      chats: [],
      conversations: [],
      dmsAvailable: false
    })

    expect(roster.map(entry => entry.id)).toEqual(['agent:default', 'agent:marketing'])
    expect(roster[1]).toMatchObject({ agentId: 'marketing', kind: 'assistant', route: '/', title: 'Marketing' })
  })

  it('hangs a chat whose agent has not loaded under the master, never headless', () => {
    // Every cold boot passes through this: sessions arrive before profiles, so
    // a named agent's chats briefly belong to an agent with no row. Keeping
    // their own agent id would group them under nothing.
    const roster = buildAtumRoster({
      ...base,
      agents: [agent()],
      chats: [chat({ agentId: 'marketing', id: 'sess-m', route: '/sess-m', sessionIds: ['sess-m'], title: 'Chiến dịch' })],
      conversations: [],
      dmsAvailable: false
    })

    expect(roster.map(entry => entry.agentId)).toEqual(['default', 'default'])
    expect(roster[1]).toMatchObject({ kind: 'chat', title: 'Chiến dịch' })
  })

  it('lists assistant chats after the pinned row, in the order they arrive, before apps', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [chat(), chat({ id: 'sess-2', route: '/sess-2', sessionIds: ['sess-2', 'root-2'], title: '', preview: 'Viết email' })],
      conversations: [],
      dmsAvailable: true
    })

    expect(roster.map(entry => entry.kind)).toEqual(['assistant', 'chat', 'chat', 'app'])
    expect(roster[1]).toMatchObject({
      id: 'chat:default:sess-1',
      route: '/sess-1',
      sessionIds: ['sess-1'],
      title: 'Kế hoạch tuần',
      preview: 'Lập kế hoạch cho tuần tới',
      activityAt: '2026-09-02T08:00:00.000Z',
      unread: false,
      unreadCount: 0
    })
    // Untitled chats read as their preview so the row is never blank.
    expect(roster[2]).toMatchObject({ id: 'chat:default:sess-2', title: 'Viết email', preview: '', sessionIds: ['sess-2', 'root-2'] })
  })

  it('falls back to the untitled copy when a chat has neither title nor preview and carries unread state', () => {
    const roster = buildAtumRoster({ ...base, chats: [chat({ title: '', preview: '', unread: true })], conversations: [], dmsAvailable: true })

    expect(roster[1]).toMatchObject({ title: 'Trò chuyện chưa có tên', unread: true })
  })

  it('keeps assistant chats visible while hosted DMs are unavailable', () => {
    const roster = buildAtumRoster({ ...base, chats: [chat()], conversations: [conversation()], dmsAvailable: false })

    expect(roster.map(entry => entry.kind)).toEqual(['assistant', 'chat'])
  })

  it('searches assistant chats by title and preview with folded diacritics', () => {
    const roster = buildAtumRoster({ ...base, chats: [chat()], conversations: [], dmsAvailable: true })

    expect(filterRoster(roster, 'ke hoach').map(entry => entry.id)).toEqual(['chat:default:sess-1'])
    expect(filterRoster(roster, 'tuan toi').map(entry => entry.id)).toEqual(['chat:default:sess-1'])
  })

  it('omits hosted DMs entirely when the account cannot serve them', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [conversation()],
      dmsAvailable: false
    })

    expect(roster.map(entry => entry.kind)).toEqual(['assistant'])
  })

  it('maps app chats after the assistant in curated product order', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [
        conversation({ id: 'c1', title: 'Taylor', unreadCount: 2, payload: { specialist: 'taylor', preview: 'Chào Minh' } }),
        conversation({ id: 'c2', title: 'Moon' })
      ],
      dmsAvailable: true
    })

    expect(roster.map(entry => entry.id)).toEqual(['agent:default', 'c2', 'c1'])
    expect(roster[2]).toMatchObject({ kind: 'app', preview: 'Chào Minh', route: '/dm/c1', unreadCount: 2 })
  })

  it('suppresses the Moon catalog entry once its hosted conversation exists', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [conversation({ id: 'moon-conversation', title: 'Moon' })],
      dmsAvailable: true
    })

    expect(roster.filter(entry => entry.appId === 'moon')).toEqual([
      expect.objectContaining({
        id: 'moon-conversation',
        conversationId: 'moon-conversation',
        route: '/dm/moon-conversation'
      })
    ])
    expect(roster.some(entry => entry.id === 'app:moon')).toBe(false)
  })

  it('keeps a title-only legacy specialist row generic and openable', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [conversation({ id: 'legacy-moon', title: 'Moon', participantIds: ['moon'], payload: {} })],
      dmsAvailable: true
    })

    expect(roster.find(entry => entry.id === 'legacy-moon')).toMatchObject({
      appId: null,
      conversationId: 'legacy-moon',
      kind: 'direct',
      route: '/dm/legacy-moon',
      title: 'Moon'
    })
    expect(roster.find(entry => entry.id === 'legacy-moon')?.participant).toBeUndefined()
  })

  it('drops a direct thread whose peer cannot be named rather than listing a chat with nobody', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [
        conversation({
          kind: 'direct',
          title: null,
          participantIds: ['00000000-0000-4000-8000-c26cc3086da0']
        })
      ],
      dmsAvailable: true
    })

    expect(roster.some(entry => entry.kind === 'direct')).toBe(false)
    expect(roster.map(entry => entry.title)).not.toContain('Cuộc trò chuyện')
  })

  it('names a direct thread after its peer from the hosted participant projection', () => {
    const roster = buildAtumRoster({ ...base, chats: [], conversations: [directThread()], dmsAvailable: true })
    const row = roster.find(entry => entry.kind === 'direct')!

    expect(row).toMatchObject({ id: 'thread-1', title: 'Sample Peer', route: '/dm/thread-1' })
    expect(row.title).not.toContain(SELF.slice(0, 8))
  })

  it('prefers the connected relationship profile over the wire participant name', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [directThread()],
      dmsAvailable: true,
      people: [connectedPeer('thread-1')]
    })

    expect(roster.find(entry => entry.kind === 'direct')!.title).toBe('Sample Member')
  })

  it('shows the peer avatar the social profile carries', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [directThread()],
      dmsAvailable: true,
      people: [connectedPeer('thread-1', 'Sample Member', 'https://cdn.atum.test/minh.png')]
    })

    expect(roster.find(entry => entry.kind === 'direct')!.avatarUrl).toBe('https://cdn.atum.test/minh.png')
  })

  it('names the peer from the relationship even when the wire row carries no participant names', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [directThread({ payload: {} })],
      dmsAvailable: true,
      people: [connectedPeer('thread-1')]
    })

    expect(roster.find(entry => entry.kind === 'direct')!.title).toBe('Sample Member')
  })

  it('cannot tell self from peer without an account id, so it lists nothing rather than guessing', () => {
    const roster = buildAtumRoster({ ...base, accountId: null, chats: [], conversations: [directThread()], dmsAvailable: true })

    expect(roster.some(entry => entry.kind === 'direct')).toBe(false)
  })

  it('never surfaces a participant id disguised as a display name', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [
        directThread({
          payload: { participants: [{ type: 'user', id: SELF, display_name: 'Me' }, { type: 'user', id: PEER, display_name: PEER }] }
        })
      ],
      dmsAvailable: true
    })

    expect(roster.some(entry => entry.kind === 'direct')).toBe(false)
  })

  it('title-cases lowercase hosted names but leaves self-cased titles alone', () => {
    expect(toDisplayTitle('taylor')).toBe('Taylor')
    expect(toDisplayTitle('mary jane')).toBe('Mary Jane')
    expect(toDisplayTitle('Trò chuyện nhóm')).toBe('Trò chuyện nhóm')
  })

  it('uses the approved first-party app presentation while presence remains hosted truth', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [
        conversation({
          id: 'c1',
          payload: { specialist: 'moon', preview: 'Chào Minh', role: 'Kế toán trưởng', avatar_url: 'https://x/a.png', presence: 'online' }
        }),
        conversation({ id: 'c2', title: 'Ben', payload: { specialist: 'ben' } })
      ],
      dmsAvailable: true
    })

    expect(roster[1]).toMatchObject({
      role: 'Kế toán trưởng',
      avatarUrl: 'https://assets.example/moon.png',
      presence: 'online',
      preview: 'Chào Minh',
      verified: true
    })
    expect(roster.find(entry => entry.appId === 'ben')).toMatchObject({
      role: '',
      avatarUrl: '',
      presence: null,
      verified: false
    })
  })

  it('keeps direct chats after app chats and orders people by recent activity', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [
        conversation({
          id: 'p-old',
          title: 'Lan',
          kind: 'direct',
          lastMessageAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z'
        }),
        conversation({ id: 'moon', title: 'Moon', kind: 'specialist', payload: { specialist: 'moon' } }),
        conversation({
          id: 'p-new',
          title: 'Sample Peer',
          kind: 'direct',
          lastMessageAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z'
        })
      ],
      dmsAvailable: true
    })

    expect(roster.map(entry => [entry.id, entry.kind])).toEqual([
      ['agent:default', 'assistant'],
      ['moon', 'app'],
      ['p-new', 'direct'],
      ['p-old', 'direct']
    ])
  })

  it('uses an explicit specialist slug even after a conversation title is renamed', () => {
    const roster = buildAtumRoster({
      ...base,
      chats: [],
      conversations: [conversation({ id: 'renamed', title: 'Moon', payload: { specialist: 'taylor' } })],
      dmsAvailable: true
    })

    expect(roster.find(entry => entry.id === 'renamed')).toMatchObject({ appId: 'taylor', title: 'Taylor' })
    expect(roster.some(entry => entry.id === 'app:moon')).toBe(true)
  })

  it('keeps an untitled legacy specialist conversation visible without inferring its app', () => {
    const roster = buildAtumRoster({
      ...base, chats: [], dmsAvailable: true,
      conversations: [conversation({ id: 'legacy-untitled', title: '', participantIds: ['moon'], payload: {} })]
    })

    expect(roster.find(entry => entry.id === 'legacy-untitled')).toMatchObject({
      conversationId: 'legacy-untitled', route: '/dm/legacy-untitled'
    })
    expect(roster.find(entry => entry.id === 'legacy-untitled')?.appId).toBeNull()
  })

})

describe('roster search', () => {
  it('folds Vietnamese diacritics so an unaccented query still matches', () => {
    expect(foldSearchText('Trò chuyện')).toBe('tro chuyen')
    expect(foldSearchText('Đăng nhập')).toBe('dang nhap')
  })

  const entries = buildAtumRoster({
    ...base,
    chats: [],
    conversations: [
      conversation({ id: 'c1', title: 'Trò chuyện nhóm', kind: 'direct', payload: {} }),
      conversation({ id: 'c2', title: 'Moon' })
    ],
    dmsAvailable: true
  })

  it('matches on folded title and preview', () => {
    expect(filterRoster(entries, 'tro chuyen').map(entry => entry.id)).toEqual(['c1'])
    expect(filterRoster(entries, 'MOON').map(entry => entry.id)).toEqual(['c2'])
  })

  it('returns everything for an empty or whitespace query', () => {
    expect(filterRoster(entries, '')).toHaveLength(entries.length)
    expect(filterRoster(entries, '   ')).toHaveLength(entries.length)
  })

  it('returns nothing rather than falling back to the full list on no match', () => {
    expect(filterRoster(entries, 'zzzz')).toEqual([])
  })
})

describe('product-model containment', () => {
  // The visible Atum product is one assistant with many chats, plus hosted DMs.
  // Chats arrive already projected by `assistant-chats.ts` (which has its own
  // fence). If a future change reaches for the Hermes session/profile/project
  // stores from the roster adapter itself, the Hermes organisation is back in
  // the product — this test is the tripwire for that, not a style rule.
  const source = readFileSync(resolve(__dirname, 'roster.ts'), 'utf8')

  it.each(['store/session', 'store/profile', 'store/projects', 'store/cron', 'store/layout'])(
    'does not import %s',
    module => {
      expect(source).not.toContain(module)
    }
  )

  it.each(['$sessions', '$profiles', '$projects', '$cronSessions', 'worktree', 'pinned'])(
    'never mentions the Hermes noun %s',
    noun => {
      // Comments explaining what is deliberately absent are allowed; code is not.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')

      expect(code).not.toContain(noun)
    }
  )
})
