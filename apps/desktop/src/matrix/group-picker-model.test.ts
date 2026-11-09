import { describe, expect, it } from 'vitest'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { groupPickerCopy } from './group-picker-copy'
import {
  assistantsInGroup,
  filterCandidates,
  foundCandidate,
  type GroupCandidate,
  groupCandidates,
  groupCreationPlan,
  groupNameFor,
  groupPickerSections,
  sectionLetter,
  selectionBlock,
  toggleCandidate
} from './group-picker-model'
import { MATRIX_GROUP_INVITE_LIMIT } from './people'

const ME = '@me:test'

const agent = (principal: string, userId: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId,
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  ...extra
})

const ATUM = agent('atum-principal', '@atum:test', { isDefault: true })
const BEA = agent('bea-principal', '@bea:test', { name: 'Bea' })

const direct = (userId: string, name: string, lastActiveAt: number): MatrixRoom => ({
  id: `!${userId.slice(1)}`,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  lastActiveAt,
  participants: [
    { userId: ME, membership: 'join' },
    { userId, membership: 'join' }
  ]
})

const assistantRoom = (who: MatrixAgentView, lastActiveAt: number): MatrixRoom => ({
  id: `!${who.principal}`,
  name: who.name ?? 'Atum',
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: who.principal,
  lastActiveAt,
  participants: [
    { userId: ME, membership: 'join' },
    { userId: who.userId, membership: 'join' }
  ]
})

const app = (slug: string, order: number, extra: Partial<AppDescriptor> = {}): AppDescriptor => ({
  app: slug,
  app_id: `app-${slug}`,
  app_version_id: `version-${slug}`,
  name: { en: slug[0].toUpperCase() + slug.slice(1) },
  subtitle: null,
  description: null,
  icon: null,
  accent: '#2c8078',
  affiliation: 'first_party',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: order,
  supported_modes: ['direct'],
  matrix_room_context: null,
  has_surface: true,
  link: { mode: 'external_account', state: 'linked' },
  ...extra
})

// Moon is installed but can't join a group yet; River is approved for addressed-only group
// context and connected; Ledger is approved but not connected.
const MOON = app('moon', 1)
const RIVER = app('river', 2, { matrix_room_context: 'addressed_only', roster_default: false })

const LEDGER = app('ledger', 3, {
  matrix_room_context: 'addressed_only',
  roster_default: false,
  link: { mode: 'external_account', state: 'never_linked' }
})

const SNAPSHOT: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: ME, deviceId: 'D' },
  assistant: { userId: ATUM.userId, deviceId: 'A' },
  agents: [ATUM, BEA],
  rooms: [
    assistantRoom(ATUM, 90),
    assistantRoom(BEA, 80),
    direct('@linh:test', 'Linh', 30),
    direct('@dung:test', 'Đức', 50),
    direct('@an:test', 'Ân', 10),
    direct('@zed:test', 'Zed', 0)
  ],
  roomId: null,
  messages: [],
  error: null,
  apps: { state: 'ready', apps: [MOON, RIVER, LEDGER], connections: {} },
  appShortcuts: { [MOON.app_id]: { visibility: 'default', status: 'ready' } }
}

const candidates = (snapshot = SNAPSHOT, extra: Partial<Parameters<typeof groupCandidates>[0]> = {}) =>
  groupCandidates({ snapshot, mode: 'create', locale: 'vi', assistantName: 'Atum', ...extra })

const byName = (list: readonly GroupCandidate[], name: string) => {
  const found = list.find(each => each.name === name)

  if (!found) {
    throw new Error(`No ${name}`)
  }

  return found
}

describe('who a group can be made of', () => {
  it('lists people, your assistants and your apps as members alike, each with its kind', () => {
    const list = candidates()
    expect(list.filter(each => each.kind === 'person').map(each => each.name)).toEqual(['Đức', 'Linh', 'Ân', 'Zed'])
    expect(list.filter(each => each.kind === 'assistant').map(each => each.name)).toEqual(['Atum', 'Bea'])
    expect(list.filter(each => each.kind === 'app').map(each => each.name)).toEqual(['Moon', 'River', 'Ledger'])
    expect(new Set(list.map(each => each.key)).size).toBe(list.length)
  })

  it('says why a member can’t join instead of hiding them', () => {
    const list = candidates()
    // Your own assistants join groups when they run on this Mac (their host joins for them).
    expect(list.filter(each => each.kind === 'assistant').every(each => each.blocked === undefined)).toBe(true)
    const away = agent('away-principal', '@away:test', { name: 'Away', ready: false })
    expect(byName(candidates({ ...SNAPSHOT, agents: [ATUM, away] }), 'Away').blocked).toBe('assistantNotReady')
    expect(byName(list, 'Moon').blocked).toBe('appSoon')
    expect(byName(list, 'River').blocked).toBeUndefined()
    expect(byName(list, 'Ledger').blocked).toBe('appConnect')
    expect(byName(list, 'Linh').blocked).toBeUndefined()
  })

  // The operator-set room context (`matrix_room_context`) admits per-person app participants; an
  // official bot's group behaviour is its own bot row's (atum-app-bots v1 §6.2).
  it('offers an official bot for a new group whatever the operator-set room context', () => {
    const bot = (groups: boolean) => ({
      v: 1 as const,
      user_id: groups ? '@app-moon:atumplatform.com' : '@app-andy:atumplatform.com',
      handle: groups ? 'moon_bot' : 'andy_bot',
      display_name: groups ? 'Moon' : 'Andy',
      avatar: { url: 'https://cdn.test/bot.png', sha256: 'a'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'BOT_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active' as const,
      groups,
      consent: 'accepted' as const,
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: groups,
      purchase_route_id: 'chat'
    })

    const moon = app('moon', 1, { bot: bot(true) })
    const andy = app('andy', 4, { bot: bot(false) })
    const list = candidates({ ...SNAPSHOT, apps: { state: 'ready', apps: [moon, andy, RIVER], connections: {} } })

    expect(byName(list, 'Moon').blocked).toBeUndefined()
    // Andy chats one-on-one: listed with its honest note, never "coming soon".
    expect(byName(list, 'Andy').blocked).toBe('appUnavailable')
  })

  it('marks who is already in a conversation, and keeps app groups to new ones, when adding', () => {
    const list = candidates(SNAPSHOT, {
      mode: 'add',
      members: [
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false },
        { userId: '@an:test', name: 'Ân', membership: 'leave', canRemove: false }
      ]
    })

    expect(byName(list, 'Linh').blocked).toBe('member')
    expect(byName(list, 'Ân').blocked).toBeUndefined()
    expect(byName(list, 'River').blocked).toBe('appNewGroupOnly')
    expect(
      foundCandidate({ userId: '@linh:test', name: '@linh', handle: 'linh' }, [
        { userId: '@linh:test', name: 'Linh', membership: 'invite', canRemove: false }
      ]).blocked
    ).toBe('member')
  })
})

describe('a cloud assistant in the picker (0.19.4 Q4)', () => {
  const CLOUD = agent('cloud-principal', '@cloud:test', { name: 'Mây', ready: false, answering: 'cloud' })

  const withCloud: MatrixSnapshot = {
    ...SNAPSHOT,
    agents: [ATUM, BEA, CLOUD],
    rooms: [...SNAPSHOT.rooms, assistantRoom(CLOUD, 70)]
  }

  it('is not offered at all, rather than shown with a reason that names where it answers', () => {
    const list = candidates(withCloud)
    expect(list.some(each => each.id === CLOUD.userId)).toBe(false)

    // Nothing that could be picked would make main refuse the join.
    for (const each of list.filter(row => row.kind === 'assistant' && !row.blocked)) {
      expect(each.agent?.ready).toBe(true)
      expect(each.agent?.answering).not.toBe('cloud')
    }
  })

  it('is still shown as a member when it is already in the conversation', () => {
    const list = candidates(withCloud, {
      mode: 'add',
      members: [{ userId: CLOUD.userId, name: 'Mây', membership: 'join', canRemove: false }]
    })

    expect(byName(list, 'Mây').blocked).toBe('member')
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'blocks an assistant still being set up without naming a place (%s)',
    locale => {
      const copy = groupPickerCopy(locale)
      expect(copy.block.assistantNotReady).toBeTruthy()
      expect(copy.block.assistantNotReady).not.toMatch(/Mac|đám mây|cloud|クラウド|云|雲/i)
    }
  )
})

describe('picking members', () => {
  it('never ticks a blocked row, and unticks a ticked one', () => {
    const list = candidates()
    const linh = byName(list, 'Linh')
    const picked = toggleCandidate([], linh)
    expect(picked).toEqual([linh])
    expect(toggleCandidate(picked, byName(list, 'Moon'))).toEqual([linh])
    expect(toggleCandidate(picked, linh)).toEqual([])
  })

  it('keeps an app group to you and that one app', () => {
    const list = candidates()
    const river = byName(list, 'River')
    const linh = byName(list, 'Linh')
    expect(selectionBlock(river, [linh])).toBe('appWithPeople')
    expect(selectionBlock(linh, [river])).toBe('appAlone')
    expect(selectionBlock({ ...river, key: 'app:other', id: 'other' }, [river])).toBe('appAlone')
    expect(selectionBlock(river, [])).toBeUndefined()
    // Your assistants are members like people: not in a you-and-this-app group.
    const bea = byName(list, 'Bea')
    expect(selectionBlock(river, [bea])).toBe('appWithPeople')
    expect(selectionBlock(bea, [river])).toBe('appAlone')
  })

  it('mixes people and your assistants, five assistants at most, counting those already in', () => {
    const list = candidates()
    const people = [byName(list, 'Linh'), byName(list, 'Đức')]

    const crew = Array.from({ length: 5 }, (_, index) => ({
      ...byName(list, 'Bea'),
      key: `assistant:@crew${index}:test`,
      id: `@crew${index}:test`,
      name: `Crew ${index}`
    }))

    expect(selectionBlock(byName(list, 'Atum'), people)).toBeUndefined()
    expect(selectionBlock(byName(list, 'Atum'), [...people, ...crew.slice(0, 4)])).toBeUndefined()
    expect(selectionBlock(byName(list, 'Atum'), [...people, ...crew])).toBe('agentsFull')
    expect(toggleCandidate(crew, byName(list, 'Atum'))).toHaveLength(5)
    // Adding to a group that holds three already: two more, then full.
    expect(selectionBlock(byName(list, 'Atum'), crew.slice(0, 1), 3)).toBeUndefined()
    expect(selectionBlock(byName(list, 'Atum'), crew.slice(0, 2), 3)).toBe('agentsFull')
    // People are not counted against the five.
    expect(selectionBlock(people[0]!, crew)).toBeUndefined()
  })

  it('sends at most twenty invitations at once, people and assistants together', () => {
    const list = candidates()

    const people = Array.from({ length: MATRIX_GROUP_INVITE_LIMIT - 1 }, (_, index) =>
      foundCandidate({ userId: `@p${index}:test`, name: `P${index}` })
    )

    const withOne = [...people, byName(list, 'Bea')]
    expect(selectionBlock(foundCandidate({ userId: '@extra:test', name: 'Extra' }), withOne)).toBe('full')
    expect(selectionBlock(byName(list, 'Atum'), withOne)).toBe('full')
    expect(selectionBlock(byName(list, 'Atum'), people)).toBeUndefined()
    // The plan they make fits one creation's invitations.
    expect(groupCreationPlan('Big', withOne)).toMatchObject({ invite: expect.any(Array) })
    expect((groupCreationPlan('Big', withOne) as { invite: string[] }).invite).toHaveLength(MATRIX_GROUP_INVITE_LIMIT)
  })

  it('counts your assistants already in a group when adding to it', () => {
    const list = candidates(SNAPSHOT, {
      mode: 'add',
      members: [
        { userId: ATUM.userId, name: 'Atum', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
      ]
    })

    expect(byName(list, 'Atum').blocked).toBe('member')
    expect(byName(list, 'Bea').blocked).toBeUndefined()
    expect(assistantsInGroup(list)).toBe(1)
  })

  it('stops at the invitation cap and says so', () => {
    const people = Array.from({ length: MATRIX_GROUP_INVITE_LIMIT }, (_, index) =>
      foundCandidate({ userId: `@p${index}:test`, name: `P${index}` })
    )

    const one = foundCandidate({ userId: '@extra:test', name: 'Extra' })
    expect(selectionBlock(one, people)).toBe('full')
    expect(toggleCandidate(people, one)).toHaveLength(MATRIX_GROUP_INVITE_LIMIT)
    expect(selectionBlock(people[0], people)).toBeUndefined()
  })
})

describe('the list as it is drawn', () => {
  it('files names under their letter without accents, others under #', () => {
    expect(sectionLetter('Đức')).toBe('D')
    expect(sectionLetter('ân')).toBe('A')
    expect(sectionLetter('@lan')).toBe('L')
    expect(sectionLetter('42 Club')).toBe('#')
  })

  it('leads with recent chats you can pick, then everyone else A–Z, each once', () => {
    const sections = groupPickerSections(candidates(), { locale: 'vi', query: '' })
    const names = (key: string) => sections.find(section => section.key === key)?.candidates.map(each => each.name)

    // Your assistants can be picked, and you talked to them last: they lead, then people.
    expect(names('recent')).toEqual(['Atum', 'Bea', 'Đức', 'Linh', 'Ân'])
    expect(sections.map(section => section.key)).toEqual(['recent', 'L', 'M', 'R', 'Z'])
    expect(names('A')).toBeUndefined()
    const all = sections.flatMap(section => section.candidates.map(each => each.key))
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(candidates().length)
  })

  it('drops recents while searching, and filters by kind and accent-free name or @name', () => {
    const list = candidates()
    expect(filterCandidates(list, 'all', 'duc').map(each => each.name)).toEqual(['Đức'])
    expect(filterCandidates(list, 'assistant', '').map(each => each.name)).toEqual(['Atum', 'Bea'])
    expect(filterCandidates(list, 'person', 'bea')).toEqual([])
    const found = foundCandidate({ userId: '@lan:test', name: '@lan', handle: 'lan' })
    expect(filterCandidates([found], 'all', '@la')).toEqual([found])
    expect(groupPickerSections(list, { locale: 'vi', query: 'a' }).some(section => section.key === 'recent')).toBe(
      false
    )
  })
})

describe('creating', () => {
  it('names a group after its members when it has no name, and needs a name or a member', () => {
    const list = candidates()
    const picked = [byName(list, 'Linh'), byName(list, 'Đức')]
    expect(groupNameFor('  ', picked)).toBe('Linh, Đức')
    expect(groupNameFor(' Book club ', picked)).toBe('Book club')
    expect(groupNameFor('', [])).toBe('')
    expect(groupCreationPlan('', [])).toBeNull()
    expect(groupCreationPlan('Just me', [])).toEqual({ kind: 'room', name: 'Just me', invite: [] })
    expect(groupCreationPlan('', picked)).toEqual({
      kind: 'room',
      name: 'Linh, Đức',
      invite: ['@linh:test', '@dung:test']
    })
  })

  it('invites the people and then your assistants picked, in one group', () => {
    const list = candidates()

    expect(groupCreationPlan('Trip', [byName(list, 'Bea'), byName(list, 'Linh'), byName(list, 'Atum')])).toEqual({
      kind: 'room',
      name: 'Trip',
      invite: ['@linh:test', BEA.userId, ATUM.userId]
    })
  })

  it('makes an app group for the one app picked', () => {
    expect(groupCreationPlan('', [byName(candidates(), 'River')])).toEqual({
      kind: 'appGroup',
      name: 'River',
      appId: RIVER.app_id
    })
  })
})
