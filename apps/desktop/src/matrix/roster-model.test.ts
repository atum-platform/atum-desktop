import { describe, expect, it } from 'vitest'

import type { AppDescriptor } from '../../shared/app-catalog'
import { ACME, ACME_GUEST, botApp, botUserOf, Demoza } from '../../shared/app-catalog.test-support'
import type { AppShortcutState } from '../../shared/app-shortcuts'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  filterMatrixRoster,
  matrixLocalpart,
  matrixPrimaryAgentName,
  matrixRosterAgentName,
  normalizeMatrixRosterQuery,
  projectMatrixRoster
} from './roster-model'

const owner = '@owner:test'

function agent(principal: string, userId: string, isDefault = false): MatrixAgentView {
  return { principal, userId, isDefault, ready: true, hermes: 'ready', atumModel: true }
}

function privateRoom(id: string, agentId: string, extra: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    participants: [
      { userId: owner, membership: 'join' },
      { userId: agentId, membership: 'join' }
    ],
    ...extra
  }
}

function snapshot(rooms: MatrixRoom[]): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [agent('default', '@atum:test', true), agent('moon', '@moon:test')],
    rooms,
    roomId: null,
    messages: [],
    error: null
  }
}

describe('Matrix roster projection', () => {
  it('nests only validated private histories, latest first, and leaves every other room once', () => {
    const defaultOlder = privateRoom('!default-old:test', '@atum:test', { lastActiveAt: 1 })
    const defaultLatest = privateRoom('!default-new:test', '@atum:test', { lastActiveAt: 9 })
    const moon = privateRoom('!moon:test', '@moon:test', { agentPrincipal: 'moon', lastActiveAt: 4 })

    const multiHuman = privateRoom('!group:test', '@moon:test', {
      agentPrincipal: 'moon',
      participants: [
        { userId: owner, membership: 'join' },
        { userId: '@moon:test', membership: 'join' },
        { userId: '@friend:test', membership: 'join' }
      ],
      lastActiveAt: 12
    })

    const untrusted = privateRoom('!untrusted:test', '@moon:test', { lastActiveAt: 10 })

    const ordinary: MatrixRoom = {
      id: '!ordinary:test',
      name: 'Friends',
      membership: 'join',
      encrypted: true,
      participants: [{ userId: owner, membership: 'join' }],
      lastActiveAt: 8
    }

    const view = projectMatrixRoster(snapshot([defaultOlder, defaultLatest, moon, multiHuman, untrusted, ordinary]))

    expect(view.groups.map(group => [group.agent.principal, group.rooms.map(room => room.id)])).toEqual([
      ['default', ['!default-new:test', '!default-old:test']],
      ['moon', ['!moon:test']]
    ])
    expect(view.rest.map(room => room.id)).toEqual(['!group:test', '!untrusted:test', '!ordinary:test'])
    expect(new Set([...view.groups.flatMap(group => group.rooms), ...view.rest].map(room => room.id)).size).toBe(6)
  })

  it.each([undefined, 'retained-primary-principal'])(
    'keeps a default row before the first roster arrives (principal=%s)',
    principal => {
      const room = privateRoom('!atum:test', '@atum:test', { agentPrincipal: principal })
      const view = projectMatrixRoster({ ...snapshot([room]), agents: undefined })

      expect(view.groups).toHaveLength(1)
      expect(view.groups[0]?.agent.isDefault).toBe(true)
      expect(view.groups[0]?.rooms).toEqual([room])
    }
  )

  it('recognizes the reported default by user id when an older snapshot omitted its default flag', () => {
    const room = privateRoom('!atum:test', '@atum:test')
    const agents = [agent('default-principal', '@atum:test'), agent('moon', '@moon:test')]
    const view = projectMatrixRoster({ ...snapshot([room]), agents })

    expect(
      view.groups.map(group => [group.agent.principal, group.agent.isDefault, group.rooms.map(each => each.id)])
    ).toEqual([
      ['default-principal', true, ['!atum:test']],
      ['moon', false, []]
    ])
  })

  it('puts promoted named Main first and retains the former default history under its own immutable identity', () => {
    const former = { ...agent('root', '@atum:test'), name: 'Original assistant' }
    const main = { ...agent('main', '@main:test', true), name: 'Atum Main' }
    const oldRoom = privateRoom('!old:test', former.userId, { agentPrincipal: former.principal })
    const mainRoom = privateRoom('!main:test', main.userId, { agentPrincipal: main.principal })
    const malformed = privateRoom('!wrong-principal:test', main.userId, { agentPrincipal: former.principal })

    const state = {
      ...snapshot([oldRoom, mainRoom, malformed]),
      assistant: { userId: main.userId, deviceId: 'MAIN' },
      agents: [former, main]
    }

    const view = projectMatrixRoster(state)

    expect(
      view.groups.map(group => [group.agent.principal, group.agent.isDefault, group.rooms.map(room => room.id)])
    ).toEqual([
      ['main', true, [mainRoom.id]],
      ['root', false, [oldRoom.id]]
    ])
    expect(view.rest).toEqual([malformed])
    expect([...view.groups.flatMap(group => group.rooms), ...view.rest]).toHaveLength(state.rooms.length)
    // The promoted primary goes by the name on its record (D1: the primary is renameable).
    expect(matrixRosterAgentName(view.groups[0]!.agent, 'Atum')).toBe('Atum Main')
    expect(state.agents[1]!.name).toBe('Atum Main')
    // Even a transitional singular user cannot relabel or group Main as old custody.
    const stale = projectMatrixRoster({ ...state, assistant: { userId: former.userId, deviceId: 'OLD' } })
    expect(stale).toEqual(view)
    expect(projectMatrixRoster({ ...state, assistant: undefined })).toEqual(view)
  })

  it('assigns a room at most once even if a duplicate roster identity is reported', () => {
    const room = privateRoom('!main:test', '@main:test', { agentPrincipal: 'main' })
    const main = agent('main', '@main:test', true)
    const view = projectMatrixRoster({ ...snapshot([room]), agents: [main, { ...main, isDefault: false }] })

    expect(view.groups.flatMap(group => group.rooms)).toEqual([room])
    expect(view.rest).toEqual([])
  })

  it('keeps favourite order for rooms that do not belong to an agent history', () => {
    const favourite = { ...privateRoom('!pinned:test', '@moon:test'), favourite: true, favouriteOrder: 0 }
    const recent = { ...privateRoom('!recent:test', '@moon:test'), lastActiveAt: 10 }
    const view = projectMatrixRoster(snapshot([recent, favourite]))

    expect(view.rest.map(room => room.id)).toEqual(['!pinned:test', '!recent:test'])
  })

  it('excludes authority-bound Team Space channels from every Home roster group', () => {
    const companyChannel: MatrixRoom = {
      id: '!company-channel:test',
      name: 'decisions',
      membership: 'join',
      encrypted: false,
      companyChannel: {
        companyId: '00000000-0000-4000-8000-576f18824476',
        channelId: '00000000-0000-4000-8000-951c747b3afc'
      }
    }

    const ordinary: MatrixRoom = {
      id: '!ordinary:test',
      name: 'Friends',
      membership: 'join',
      encrypted: true
    }

    const view = projectMatrixRoster(snapshot([companyChannel, ordinary]))

    expect(view.groups.flatMap(group => group.rooms)).not.toContain(companyChannel)
    expect(view.rest).toEqual([ordinary])
  })

  it('uses only a localpart as the display fallback for Matrix identities', () => {
    expect(matrixLocalpart('@moon:matrix.example')).toBe('moon')
    expect(matrixLocalpart('!room:matrix.example')).toBe('')
  })
})

describe('Matrix roster display names', () => {
  it.each([
    { isDefault: true, name: '  Đỗ Hòa  ', userId: '@atum:test', expected: 'Đỗ Hòa' },
    { isDefault: false, name: '  Moon  ', userId: '@moon:test', expected: 'Moon' },
    { isDefault: true, name: undefined, userId: '@atum:test', expected: 'Atum' },
    { isDefault: true, name: ' \t ', userId: '@atum:test', expected: 'Atum' },
    { isDefault: false, name: undefined, userId: '@moon:test', expected: 'moon' },
    { isDefault: false, name: ' \t ', userId: '@moon:test', expected: 'moon' },
    { isDefault: false, name: undefined, userId: '!not-an-agent:test', expected: 'Atum' }
  ])(
    'uses the name the owner gave, the default included (D1), else the honest fallback: $expected (default=$isDefault)',
    value => {
      expect(
        matrixRosterAgentName({ ...agent('agent', value.userId, value.isDefault), name: value.name }, 'Atum')
      ).toBe(value.expected)
    }
  )
})

describe('the primary assistant’s name where no chat shows it', () => {
  it('is its record’s name once it has one (D1: renameable), and Atum until then', () => {
    const base = snapshot([])

    const named = {
      ...base,
      agents: base.agents!.map(each => (each.isDefault ? { ...each, name: 'Linh' } : { ...each, name: 'Moon' }))
    }

    expect(matrixPrimaryAgentName(named, 'Atum')).toBe('Linh')
    expect(matrixPrimaryAgentName(base, 'Atum')).toBe('Atum')
    expect(matrixPrimaryAgentName({ ...base, agents: undefined, assistant: undefined }, 'Atum')).toBe('Atum')
  })
})

describe('Matrix roster query normalization', () => {
  it.each([
    { value: '  ĐIỆN   Toán  ', expected: 'dien toan' },
    { value: 'Đỗ Hòa'.normalize('NFD'), expected: 'do hoa' },
    { value: '  Nguyệt\tThực\nViệt Nam  ', expected: 'nguyet thuc viet nam' },
    { value: 'đ Đ', expected: 'd d' },
    { value: 'Moon', expected: 'moon' },
    { value: ' \t\n ', expected: '' }
  ])('folds case, accents, Đ and whitespace in $value', ({ value, expected }) => {
    expect(normalizeMatrixRosterQuery(value)).toBe(expected)
    expect(normalizeMatrixRosterQuery(normalizeMatrixRosterQuery(value))).toBe(expected)
  })
})

function searchableRoster() {
  const rooms = [
    privateRoom('!default-old:test', '@atum:test', { name: 'Thu nhập', lastActiveAt: 1 }),
    privateRoom('!default-new:test', '@atum:test', { name: 'Kế hoạch quý', lastActiveAt: 9 }),
    privateRoom('!moon-income-old:test', '@moon:test', {
      name: 'Thu nhập dự án',
      agentPrincipal: 'moon',
      lastActiveAt: 2
    }),
    privateRoom('!moon-income-new:test', '@moon:test', {
      name: 'Thu nhập tháng',
      agentPrincipal: 'moon',
      lastActiveAt: 6
    }),
    privateRoom('!moon-other:test', '@moon:test', { name: 'Weekly review', agentPrincipal: 'moon', lastActiveAt: 4 }),
    privateRoom('!private-id-only:test', '@moon:test', {
      name: 'Điện toán mới',
      lastActiveAt: 20
    }),
    privateRoom('!favourite:test', '@moon:test', {
      name: 'Điện toán cũ',
      favourite: true,
      favouriteOrder: 0,
      lastActiveAt: 0
    }),
    privateRoom('!group:test', '@moon:test', {
      name: 'Thu nhập nhóm',
      agentPrincipal: 'moon',
      participants: [
        { userId: owner, membership: 'join' },
        { userId: '@moon:test', membership: 'join' },
        { userId: '@friend:test', membership: 'join' }
      ],
      lastActiveAt: 10
    })
  ]

  return projectMatrixRoster({
    ...snapshot(rooms),
    agents: [
      { ...agent('default', '@atum:test', true), name: '  Đỗ Hòa  ' },
      { ...agent('moon', '@moon:test'), name: 'Moon' },
      { ...agent('private-principal-only', '@private-user-only:test'), name: 'Solo' }
    ]
  })
}

describe('Matrix roster filtering', () => {
  it.each(['', ' \t\n '])('keeps the full projection for an empty normalized query %j', query => {
    const projection = searchableRoster()

    expect(filterMatrixRoster(projection, query, 'Atum')).toBe(projection)
  })

  it.each(['do hoa', '  ĐỖ   HÒA  ', 'Đỗ Hòa'.normalize('NFD')])(
    'keeps every history when the displayed primary name matches %j',
    query => {
      const projection = searchableRoster()
      const filtered = filterMatrixRoster(projection, query, 'Atum')

      expect(filtered.groups).toEqual([projection.groups[0]])
      expect(filtered.groups[0]).toBe(projection.groups[0])
      expect(filtered.groups[0]?.rooms.map(room => room.id)).toEqual(['!default-new:test', '!default-old:test'])
      expect(filtered.rest).toEqual([])
    }
  )

  it('keeps every history when a named parent matches, without changing their order', () => {
    const projection = searchableRoster()
    const filtered = filterMatrixRoster(projection, 'mOoN', 'Atum')

    expect(filtered.groups).toEqual([projection.groups[1]])
    expect(filtered.groups[0]?.rooms.map(room => room.id)).toEqual([
      '!moon-income-new:test',
      '!moon-other:test',
      '!moon-income-old:test'
    ])
    expect(filtered.rest).toEqual([])
  })

  it('keeps an empty parent when its own name matches', () => {
    const projection = searchableRoster()
    const filtered = filterMatrixRoster(projection, 'SOLO', 'Atum')

    expect(filtered.groups).toEqual([projection.groups[2]])
    expect(filtered.groups[0]?.rooms).toEqual([])
    expect(filtered.rest).toEqual([])
  })

  it('retains the right parents for child-only matches without regrouping ordinary rooms', () => {
    const projection = searchableRoster()
    const filtered = filterMatrixRoster(projection, 'thu nhap', 'Atum')

    expect(filtered.groups.map(group => [group.agent.principal, group.rooms.map(room => room.id)])).toEqual([
      ['default', ['!default-old:test']],
      ['moon', ['!moon-income-new:test', '!moon-income-old:test']]
    ])
    expect(filtered.rest.map(room => room.id)).toEqual(['!group:test'])
    expect(filtered.groups[0]?.agent).toBe(projection.groups[0]?.agent)
    expect(filtered.groups[1]?.rooms[0]).toBe(projection.groups[1]?.rooms[0])
  })

  it('filters ordinary room names while preserving the existing favourite and recency order', () => {
    const projection = searchableRoster()
    const filtered = filterMatrixRoster(projection, 'DIEN TOAN', 'Atum')

    expect(filtered.groups).toEqual([])
    expect(filtered.rest.map(room => room.id)).toEqual(['!favourite:test', '!private-id-only:test'])
    expect(filtered.rest[0]).toBe(projection.rest[0])
  })

  it.each(['private-id-only', 'private-principal-only', 'private-user-only', 'test'])(
    'does not add room IDs, principals or hidden Matrix user IDs to name search: %j',
    query => {
      expect(filterMatrixRoster(searchableRoster(), query, 'Atum')).toEqual({ groups: [], rest: [] })
    }
  )

  it('uses the same fallback name for display and search when an agent has no supplied name', () => {
    const projection = projectMatrixRoster(snapshot([]))

    expect(filterMatrixRoster(projection, 'ATUM', 'Atum').groups.map(group => group.agent.principal)).toEqual([
      'default'
    ])
    expect(filterMatrixRoster(projection, 'moon', 'Atum').groups.map(group => group.agent.principal)).toEqual(['moon'])
  })

  it('does not mutate a frozen projection or its nested names and histories', () => {
    const projection = searchableRoster()
    const before = structuredClone(projection)

    for (const group of projection.groups) {
      Object.freeze(group.agent)

      for (const room of group.rooms) {
        Object.freeze(room)
      }

      Object.freeze(group.rooms)
      Object.freeze(group)
    }

    for (const room of projection.rest) {
      Object.freeze(room)
    }

    Object.freeze(projection.groups)
    Object.freeze(projection.rest)
    Object.freeze(projection)

    filterMatrixRoster(projection, 'Moon', 'Atum')
    filterMatrixRoster(projection, 'thu nhap', 'Atum')
    filterMatrixRoster(projection, 'dien toan', 'Atum')
    expect(projection).toEqual(before)
    expect(filterMatrixRoster(projection, '', 'Atum')).toBe(projection)
  })
})

describe('the Founder chat in the roster', () => {
  const founderId = '@user-0f1e2d3c4b5a69788796a5b4c3d2e1f0:test'

  function founderChat(extra: Partial<MatrixRoom> = {}, founderMembership = 'invite'): MatrixRoom {
    return {
      id: '!founder:test',
      name: 'Founder',
      membership: 'join',
      encrypted: true,
      direct: true,
      lastActiveAt: 1,
      participants: [
        { userId: owner, membership: 'join' },
        { userId: founderId, membership: founderMembership }
      ],
      ...extra
    }
  }

  const friend: MatrixRoom = {
    id: '!friend:test',
    name: 'Lan',
    membership: 'join',
    encrypted: true,
    direct: true,
    lastActiveAt: 50,
    participants: [
      { userId: owner, membership: 'join' },
      { userId: '@lan:test', membership: 'join' }
    ]
  }

  function withFounder(rooms: MatrixRoom[], extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
    return {
      ...snapshot(rooms),
      founder: { userId: founderId, verification: 'official', roomId: '!founder:test', handle: 'founder' },
      ...extra
    }
  }

  it("pins the account's Founder chat, never as an assistant's history", () => {
    const view = projectMatrixRoster(withFounder([friend, founderChat()]))

    expect(view.founder?.id).toBe('!founder:test')
    expect(view.groups.flatMap(group => group.rooms.map(room => room.id))).not.toContain('!founder:test')
    // Still listed for the window's other lists (⌘K); the roster draws it once, pinned.
    expect(view.rest.map(room => room.id)).toContain('!founder:test')
  })

  it('is gone when the person left, when the founder left, and on the founder account itself', () => {
    expect(projectMatrixRoster(withFounder([founderChat({ membership: 'leave' })])).founder).toBeUndefined()
    expect(projectMatrixRoster(withFounder([founderChat({}, 'leave')])).founder).toBeUndefined()
    expect(
      projectMatrixRoster(withFounder([founderChat()], { identity: { userId: founderId, deviceId: 'FOUNDER' } }))
        .founder
    ).toBeUndefined()
    // Joined by the founder is as good as invited.
    expect(projectMatrixRoster(withFounder([founderChat({}, 'join')])).founder?.id).toBe('!founder:test')
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    expect(projectMatrixRoster(withFounder([founderChat({ encrypted: false })])).founder?.id).toBe('!founder:test')
  })

  it('gives a look-alike named "Founder" from another account no slot', () => {
    const lookAlike: MatrixRoom = {
      ...friend,
      id: '!impostor:test',
      name: 'Founder',
      participants: [
        { userId: owner, membership: 'join' },
        { userId: '@founder:elsewhere.test', membership: 'join' }
      ]
    }

    // No platform founder, or one whose chat is elsewhere: the look-alike is an ordinary chat.
    expect(projectMatrixRoster(snapshot([lookAlike])).founder).toBeUndefined()
    expect(projectMatrixRoster(withFounder([lookAlike])).founder).toBeUndefined()
    expect(projectMatrixRoster(withFounder([lookAlike])).rest.map(room => room.id)).toEqual(['!impostor:test'])
  })

  it('offers a draft row while no chat exists, and never beside one', () => {
    const offered = {
      ...snapshot([friend]),
      founder: { userId: founderId, verification: 'official' as const, offer: true as const, handle: 'founder' }
    }

    const view = projectMatrixRoster(offered)

    expect(view.founder).toBeUndefined()
    expect(view.founderDraft?.userId).toBe(founderId)
    expect(filterMatrixRoster(view, 'found', 'Atum', ['Founder', 'Atum founder', 'founder']).founderDraft).toBeTruthy()
    expect(filterMatrixRoster(view, 'lan', 'Atum', ['Founder', 'Atum founder', 'founder']).founderDraft).toBeUndefined()

    // The draft is hidden on the Founder's own account, and a real chat always wins.
    expect(
      projectMatrixRoster({ ...offered, identity: { userId: founderId, deviceId: 'FOUNDER' } }).founderDraft
    ).toBeUndefined()
    expect(
      projectMatrixRoster({ ...withFounder([founderChat()]), founder: { ...offered.founder, roomId: '!founder:test' } })
        .founderDraft
    ).toBeUndefined()
  })

  it('is found by its name, its localized subtitle and its handle', () => {
    const view = projectMatrixRoster(withFounder([friend, founderChat({ name: 'Someone' })]))
    const names = ['Founder', 'Nhà sáng lập Atum', 'founder']

    for (const query of ['found', 'nha sang lap', 'FOUNDER']) {
      expect(filterMatrixRoster(view, query, 'Atum', names).founder?.id).toBe('!founder:test')
    }

    expect(filterMatrixRoster(view, 'lan', 'Atum', names).founder).toBeUndefined()
    expect(filterMatrixRoster(view, '', 'Atum', names).founder?.id).toBe('!founder:test')
  })
})

describe('official bots in the roster', () => {
  const moonApp = {
    app: 'moon',
    app_id: '00000000-0000-4000-8000-e79acd97ac88',
    roster_order: 1,
    roster_default: true,
    availability: 'available',
    bot: { user_id: '@app-moon:test', display_name: 'Moon', state: 'active' }
  } as unknown as AppDescriptor

  function moonChat(
    id: string,
    appBot: Partial<NonNullable<MatrixRoom['appBot']>> = {},
    extra: Partial<MatrixRoom> = {}
  ): MatrixRoom {
    return {
      id,
      name: 'Moon',
      membership: 'join',
      encrypted: false,
      direct: true,
      participants: [
        { userId: owner, membership: 'join' },
        { userId: '@app-moon:test', membership: 'join' }
      ],
      appBot: { appId: moonApp.app_id, botUserId: '@app-moon:test', ...appBot },
      ...extra
    }
  }

  const friend: MatrixRoom = {
    id: '!friend:test',
    name: 'Lan',
    membership: 'join',
    encrypted: true,
    direct: true,
    participants: [{ userId: owner, membership: 'join' }]
  }

  function withMoon(rooms: MatrixRoom[], extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
    return {
      ...snapshot(rooms),
      apps: { state: 'ready', apps: [moonApp], connections: {} },
      appShortcuts: { [moonApp.app_id]: { visibility: 'default', status: 'ready' } },
      ...extra
    }
  }

  it('draws Moon once: its row carries the chat it opens, and no Moon chat is listed on its own', () => {
    const current = moonChat('!moon:test', { current: true })
    const older = moonChat('!moon-older:test')
    const deleted = moonChat('!moon-deleted:test', { hidden: true })
    const view = projectMatrixRoster(withMoon([friend, older, current, deleted]))

    expect(view.apps).toEqual([{ app: moonApp, room: current }])
    expect(view.rest.map(room => room.id)).toEqual(['!friend:test'])
  })

  it('lists the encrypted Moon chat from before 0.20 as an ordinary chat once the row opens a plain one', () => {
    const plain = moonChat('!moon:test', { current: true })
    const earlier = moonChat('!moon-earlier:test', {}, { encrypted: true, title: 'Tử vi tháng trước' })
    const view = projectMatrixRoster(withMoon([friend, earlier, plain]))

    expect(view.apps).toEqual([{ app: moonApp, room: plain }])
    expect(view.rest.map(room => room.id).sort()).toEqual(['!friend:test', '!moon-earlier:test'])
    // A listed chat (the roster's rest, which ⌘K lists too) is found by what it holds.
    expect(filterMatrixRoster(view, 'thang truoc', 'Atum').rest.map(room => room.id)).toEqual(['!moon-earlier:test'])
  })

  it('keeps an encrypted Moon chat listed before the plain one exists, and out of sight once deleted', () => {
    const earlier = moonChat('!moon-earlier:test', {}, { encrypted: true })
    const deleted = moonChat('!moon-deleted:test', { hidden: true }, { encrypted: true })
    const view = projectMatrixRoster(withMoon([friend, earlier, deleted]))

    expect(view.apps).toEqual([{ app: moonApp }])
    expect(view.rest.map(room => room.id).sort()).toEqual(['!friend:test', '!moon-earlier:test'])
  })

  it('keeps the row, with no chat, before Moon has one', () => {
    const view = projectMatrixRoster(withMoon([friend]))

    expect(view.apps).toEqual([{ app: moonApp }])
  })

  it('never folds a chat into a bot row the catalog does not name', () => {
    // Another bot's marker, or Moon's marker naming a different bot user, is an ordinary chat.
    const impostor = moonChat('!impostor:test', { current: true, botUserId: '@app-impostor:test' })
    const view = projectMatrixRoster(withMoon([impostor]))

    expect(view.apps).toEqual([{ app: moonApp }])
    expect(view.rest.map(room => room.id)).toEqual(['!impostor:test'])
  })

  it('lists Moon chats as ordinary chats when the person took Moon off the roster, except one they deleted', () => {
    const current = moonChat('!moon:test', { current: true })
    const deleted = moonChat('!moon-deleted:test', { hidden: true })

    const view = projectMatrixRoster(
      withMoon([current, deleted], { appShortcuts: { [moonApp.app_id]: { visibility: 'hidden', status: 'ready' } } })
    )

    expect(view.apps).toBeUndefined()
    expect(view.rest.map(room => room.id)).toEqual(['!moon:test'])
  })

  it('finds Moon by its name and by its chat, but not by a chat the person deleted', () => {
    const view = projectMatrixRoster(withMoon([moonChat('!moon:test', { current: true }, { title: 'Tử vi tuần này' })]))

    expect(filterMatrixRoster(view, 'moon', 'Atum').apps?.map(({ app }) => app.app_id)).toEqual([moonApp.app_id])
    expect(filterMatrixRoster(view, 'tu vi', 'Atum').apps?.map(({ app }) => app.app_id)).toEqual([moonApp.app_id])
    expect(filterMatrixRoster(view, 'lan', 'Atum').apps).toBeUndefined()

    const deleted = projectMatrixRoster(
      withMoon([moonChat('!moon:test', { current: true, hidden: true }, { title: 'Tử vi tuần này' })])
    )

    expect(filterMatrixRoster(deleted, 'tu vi', 'Atum').apps).toBeUndefined()
  })
})

describe('catalog-driven coming-soon apps', () => {
  const slugs = ['vneid', 'vssid', 'etax-mobile', 'that-space'] as const

  const ids: Record<(typeof slugs)[number], string> = {
    vneid: '00000000-0000-4000-8000-a1d6ab74e541',
    vssid: '00000000-0000-4000-8000-b28ae5df2d83',
    'etax-mobile': '00000000-0000-4000-8000-647b416868e2',
    'that-space': '00000000-0000-4000-8000-c4f9a12f3a38'
  }

  const names: Record<(typeof slugs)[number], { en: string; vi: string }> = {
    vneid: { en: 'VNeID', vi: 'VNeID' },
    vssid: { en: 'VssID', vi: 'VssID' },
    'etax-mobile': { en: 'eTax Mobile', vi: 'eTax Mobile' },
    'that-space': { en: 'Thật Space', vi: 'Thật Space' }
  }

  const sha = '154c855bc0d19febb5ab42eb883443ce0f51c5c8b6d3f09e75a3af831385b643'

  function comingSoon(
    slug: (typeof slugs)[number],
    order: number,
    overrides: Partial<AppDescriptor> = {}
  ): AppDescriptor {
    return {
      app: slug,
      app_id: ids[slug],
      app_version_id: ids[slug].replace(/100([1-4])$/u, '110$1'),
      name: names[slug],
      subtitle: null,
      description: null,
      icon: { url: `https://cdn.atum.test/specialists/${slug}.png`, sha256: sha },
      accent: null,
      affiliation: null,
      verified: false,
      verification: null,
      availability: 'unavailable',
      roster_default: true,
      roster_order: order,
      roster_state: 'coming_soon',
      supported_modes: [],
      matrix_room_context: null,
      bot: null,
      has_surface: false,
      has_history: false,
      link: { mode: 'none', state: 'never_linked' },
      ...overrides
    }
  }

  const readyPreference = (apps: readonly AppDescriptor[]): Record<string, AppShortcutState> =>
    Object.fromEntries(apps.map(app => [app.app_id, { visibility: 'default', status: 'ready' }]))

  function withCatalog(apps: AppDescriptor[], appShortcuts = readyPreference(apps)): MatrixSnapshot {
    return { ...snapshot([]), apps: { state: 'ready', apps, connections: {} }, appShortcuts }
  }

  it('draws exactly the catalog rows the effective policy exposes, in effective order', () => {
    const apps = [
      comingSoon('vneid', 6),
      comingSoon('vssid', 5),
      comingSoon('etax-mobile', 4),
      comingSoon('that-space', 1)
    ]

    const view = projectMatrixRoster(withCatalog(apps))

    expect(view.apps).toBeUndefined()
    expect(view.placeholders?.map(placeholder => placeholder.app)).toEqual([
      'that-space',
      'etax-mobile',
      'vssid',
      'vneid'
    ])
    expect(view.placeholders?.map(placeholder => placeholder.name)).toEqual([
      names['that-space'],
      names['etax-mobile'],
      names.vssid,
      names.vneid
    ])
    expect(view.placeholders?.[0]?.icon).toBe('https://cdn.atum.test/specialists/that-space.png')
  })

  it('shows no placeholders without a catalog: loading, unavailable and offline never invent rows', () => {
    expect(projectMatrixRoster(snapshot([])).placeholders).toBeUndefined()
    expect(
      projectMatrixRoster({ ...snapshot([]), apps: { state: 'loading', apps: [], connections: {} } }).placeholders
    ).toBeUndefined()
    expect(
      projectMatrixRoster({ ...snapshot([]), apps: { state: 'unavailable', apps: [], connections: {} } }).placeholders
    ).toBeUndefined()
    expect(projectMatrixRoster({ ...snapshot([]), state: 'offline', apps: undefined }).placeholders).toBeUndefined()
  })

  it('follows the effective roster_default and keeps explicit Matrix choices above it', () => {
    const defaulted = comingSoon('vneid', 6)
    const notDefaulted = comingSoon('vssid', 5, { roster_default: false })
    const ready = readyPreference([defaulted, notDefaulted])

    const view = projectMatrixRoster(
      withCatalog([defaulted, notDefaulted], {
        ...ready,
        [notDefaulted.app_id]: { visibility: 'default', status: 'ready' }
      })
    )

    expect(view.placeholders?.map(placeholder => placeholder.app)).toEqual(['vneid'])

    const userShown = projectMatrixRoster(
      withCatalog([{ ...notDefaulted, roster_default: false }], {
        [notDefaulted.app_id]: { visibility: 'shown', status: 'ready' }
      })
    )

    expect(userShown.placeholders?.map(placeholder => placeholder.app)).toEqual(['vssid'])

    const userHidden = projectMatrixRoster(
      withCatalog([defaulted], { [defaulted.app_id]: { visibility: 'hidden', status: 'ready' } })
    )

    expect(userHidden.placeholders).toBeUndefined()

    // Unknown, loading and read-only preferences do not guess the server default.
    for (const state of [
      { visibility: 'unknown' as const, status: 'ready' as const },
      { visibility: 'default' as const, status: 'loading' as const },
      { visibility: 'default' as const, status: 'readonly' as const }
    ]) {
      expect(projectMatrixRoster(withCatalog([defaulted], { [defaulted.app_id]: state })).placeholders).toBeUndefined()
    }
  })

  it('applies a default toggle for the same binary without rewriting the person preference', () => {
    const app = comingSoon('vneid', 6)
    const preference = { [app.app_id]: { visibility: 'default' as const, status: 'ready' as const } }
    const before = structuredClone(preference)

    expect(projectMatrixRoster(withCatalog([app], preference)).placeholders).toHaveLength(1)

    const toggled = projectMatrixRoster(withCatalog([{ ...app, roster_default: false }], preference))

    expect(toggled.placeholders).toBeUndefined()
    expect(preference).toEqual(before)

    const shownPreference = { [app.app_id]: { visibility: 'shown' as const, status: 'ready' as const } }
    expect(
      projectMatrixRoster(withCatalog([{ ...app, roster_default: false }], shownPreference)).placeholders
    ).toHaveLength(1)
    expect(shownPreference).toEqual({ [app.app_id]: { visibility: 'shown', status: 'ready' } })
  })

  it('keeps the catalog icon and falls back to the owned tile only when it is absent', () => {
    const withIcon = comingSoon('vneid', 6)
    const withoutIcon = comingSoon('vssid', 5, { icon: null })

    const unknownSlug = {
      ...withoutIcon,
      app: 'future-app',
      app_id: '00000000-0000-4000-8000-085984061812',
      roster_order: 7
    }

    const view = projectMatrixRoster(withCatalog([withIcon, withoutIcon, unknownSlug]))

    expect(view.placeholders?.map(placeholder => placeholder.icon)).toEqual([
      './specialists/vssid.png',
      'https://cdn.atum.test/specialists/vneid.png',
      null
    ])
  })

  it('keeps live apps first and never duplicates a coming-soon row as a live app', () => {
    const moon = {
      ...comingSoon('vneid', 0),
      app: 'moon',
      app_id: '00000000-0000-4000-8000-f8d640181f09',
      name: { en: 'Moon' },
      availability: 'available' as const,
      has_surface: true,
      roster_state: undefined
    }

    const placeholder = comingSoon('vneid', 6)
    const view = projectMatrixRoster(withCatalog([placeholder, moon]))

    expect(view.apps?.map(({ app }) => app.app)).toEqual(['moon'])
    expect(view.placeholders?.map(placeholder => placeholder.app)).toEqual(['vneid'])
  })

  it('finds a placeholder by every localized name and its slug', () => {
    const view = projectMatrixRoster(withCatalog(slugs.map((slug, index) => comingSoon(slug, index))))

    expect(filterMatrixRoster(view, 'vneid', 'Atum').placeholders?.map(placeholder => placeholder.app)).toEqual([
      'vneid'
    ])
    expect(filterMatrixRoster(view, 'that space', 'Atum').placeholders?.map(placeholder => placeholder.app)).toEqual([
      'that-space'
    ])
    expect(filterMatrixRoster(view, 'etax', 'Atum').placeholders?.map(placeholder => placeholder.app)).toEqual([
      'etax-mobile'
    ])
    expect(filterMatrixRoster(view, 'moon', 'Atum').placeholders).toBeUndefined()
  })

  it('leaves existing room membership, selection, pin and order untouched when a default toggles', () => {
    const pinned = {
      id: '!pinned:test',
      name: 'Pinned chat',
      membership: 'join',
      encrypted: true,
      favourite: true,
      favouriteOrder: 2,
      lastActiveAt: 10
    }

    const selected = {
      id: '!selected:test',
      name: 'Selected chat',
      membership: 'join',
      encrypted: true,
      lastActiveAt: 5
    }

    const state: MatrixSnapshot = {
      ...snapshot([pinned, selected]),
      roomId: selected.id,
      apps: { state: 'ready', apps: [comingSoon('vneid', 6)], connections: {} },
      appShortcuts: { [ids.vneid]: { visibility: 'default', status: 'ready' } }
    }

    const before = structuredClone(state)

    const view = projectMatrixRoster(state)

    expect(view.placeholders).toHaveLength(1)
    expect(view.rest.map(room => room.id)).toEqual(['!pinned:test', '!selected:test'])
    expect(view.rest.find(room => room.id === pinned.id)).toMatchObject({
      favourite: true,
      favouriteOrder: 2,
      membership: 'join'
    })
    expect(state).toEqual(before)
    expect(state.roomId).toBe('!selected:test')
  })
})

// An app with an official bot is a catalog row, not code: these use an app the client has never
// heard of (`acme`) and the shape production sends for Demoza, with no chat with either yet.
describe.each([
  ['an app the client has no code for', ACME],
  ['a guest-enabled bot (Demoza as production sends it)', Demoza]
])('%s', (_label, seed) => {
  const app = botApp(seed)

  const preference = (visibility: AppShortcutState['visibility'], status: AppShortcutState['status'] = 'ready') => ({
    [app.app_id]: { visibility, status }
  })

  function withCatalog(
    rooms: MatrixRoom[] = [],
    apps: AppDescriptor[] = [app],
    appShortcuts: Record<string, AppShortcutState> = preference('default')
  ): MatrixSnapshot {
    return { ...snapshot(rooms), apps: { state: 'ready', apps, connections: {} }, appShortcuts }
  }

  function dm(id: string, extra: Partial<NonNullable<MatrixRoom['appBot']>> = {}): MatrixRoom {
    return {
      id,
      name: seed.name,
      membership: 'join',
      encrypted: false,
      direct: true,
      participants: [
        { userId: owner, membership: 'join' },
        { userId: botUserOf(seed), membership: 'join' }
      ],
      appBot: { appId: app.app_id, botUserId: botUserOf(seed), ...extra }
    }
  }

  it('is in the roster before the person has any chat with it', () => {
    const view = projectMatrixRoster(withCatalog())

    expect(view.apps).toEqual([{ app }])
    expect(view.rest).toEqual([])
  })

  it('carries its chat in its one row once that chat exists, never as a second chat', () => {
    const chat = dm('!chat:test', { current: true })
    const view = projectMatrixRoster(withCatalog([chat]))

    expect(view.apps).toEqual([{ app, room: chat }])
    expect(view.rest).toEqual([])
  })

  it('follows the person’s own choice over the server default, both ways', () => {
    const added = { ...app, roster_default: false }

    expect(projectMatrixRoster(withCatalog([], [added])).apps).toBeUndefined()
    expect(projectMatrixRoster(withCatalog([], [added], preference('shown'))).apps).toEqual([{ app: added }])
    expect(projectMatrixRoster(withCatalog([], [app], preference('hidden'))).apps).toBeUndefined()
  })

  it('shows nothing until the person’s choices are known, never a guessed default', () => {
    for (const state of ['unknown', 'default'] as const) {
      const status = state === 'default' ? 'loading' : 'ready'

      expect(projectMatrixRoster(withCatalog([], [app], preference(state, status))).apps).toBeUndefined()
    }

    expect(projectMatrixRoster(withCatalog([], [app], {})).apps).toBeUndefined()
  })

  it('is listed while its bot is starting, paused or resting, so the row can say why it is off', () => {
    for (const state of ['starting', 'paused', 'unavailable'] as const) {
      const quiet = botApp(seed, {}, state === 'starting' ? { state, device: null } : { state })

      expect(projectMatrixRoster(withCatalog([], [quiet])).apps?.map(entry => entry.app.app)).toEqual([seed.slug])
    }
  })

  it('is found by its name', () => {
    const view = projectMatrixRoster(withCatalog())

    expect(filterMatrixRoster(view, seed.name.toLowerCase(), 'Atum').apps?.map(entry => entry.app.app_id)).toEqual([
      app.app_id
    ])
    expect(filterMatrixRoster(view, 'nobody', 'Atum').apps).toBeUndefined()
  })

  it('sits among the other apps by the catalog’s order alone', () => {
    const first = botApp({ ...ACME_GUEST, slug: 'zeta', name: 'Zeta', appId: '00000000-0000-4000-8000-646427abfd14' }, {
      roster_order: 1
    })

    const last = botApp(
      { ...ACME_GUEST, slug: 'beta', name: 'Beta', appId: '00000000-0000-4000-8000-553a79af7f8f' },
      { roster_order: 9 }
    )

    const view = projectMatrixRoster(
      withCatalog([], [last, app, first], {
        ...preference('default'),
        [first.app_id]: { visibility: 'default', status: 'ready' },
        [last.app_id]: { visibility: 'default', status: 'ready' }
      })
    )

    expect(view.apps?.map(entry => entry.app.app_id)).toEqual([first.app_id, app.app_id, last.app_id])
  })
})
