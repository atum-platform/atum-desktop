import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixMember, MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import type { VerificationTier } from '../../../shared/verification'
import { $founderProfileOpen } from '../founder/founder-store'

/**
 * The Founder account and the verification marks on fixture data (dev only; plan
 * ). A person with Atum as their only
 * assistant, their Founder chat (made, the founder joined, nothing written yet), friends and a
 * group, and Atum's own apps (Moon and Andy: official) beside a verified partner (Atlas) and
 * an unverified app (River). The person is a neutral fixture, never the owner.
 */
export const PLAYGROUND_FOUNDER_SCENARIOS = [
  'founder-roster',
  'founder-chat',
  'founder-profile',
  'founder-settings'
] as const

export type PlaygroundFounderScenario = (typeof PLAYGROUND_FOUNDER_SCENARIOS)[number]

export const PLAYGROUND_FOUNDER_LABELS: Record<PlaygroundFounderScenario, string> = {
  'founder-roster': 'Founder: the row below Atum, app marks',
  'founder-chat': 'Founder: the empty chat (intro card)',
  'founder-profile': 'Founder: the profile sheet',
  'founder-settings': 'Founder: Settings › Account › Contact us (⌘, opens it)'
}

const ME = { userId: '@an:example.invalid', deviceId: 'MACBOOK' }
const ATUM = { userId: '@atum_bot:example.invalid', deviceId: 'ATUMMINI' }
export const PLAYGROUND_FOUNDER = '@synthetic-user-0016:example.invalid'
export const PLAYGROUND_FOUNDER_ROOM = '!founder:example.invalid'
const ATUM_ROOM = '!assistant:example.invalid'
const LINH_ROOM = '!linh:example.invalid'
const NOW = Date.now()

const minutes = (count: number) => NOW - count * 60_000

const direct = (id: string, name: string, userId: string, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  participants: [
    { userId: ME.userId, membership: 'join' },
    { userId, membership: 'join' }
  ],
  ...extra
})

const rooms: MatrixRoom[] = [
  {
    id: ATUM_ROOM,
    name: 'Atum',
    membership: 'join',
    encrypted: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'agent-atum',
    firstLine: 'Plan a weekend in Hội An for two',
    createdAt: minutes(40),
    lastActiveAt: minutes(3),
    preview: { own: false, sender: 'Atum', kind: 'text', text: 'Here is a calm two days in Hội An.', at: minutes(3) },
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: ATUM.userId, membership: 'join' }
    ]
  },
  // Made at first sign-in by this account's own client; the founder joined; nothing written yet.
  direct(PLAYGROUND_FOUNDER_ROOM, 'Founder', PLAYGROUND_FOUNDER, { lastActiveAt: minutes(60 * 24) }),
  direct(LINH_ROOM, 'Linh', '@linh:example.invalid', {
    unreadNotifications: 2,
    unread: true,
    lastActiveAt: minutes(12),
    preview: {
      own: false,
      sender: 'Linh',
      kind: 'text',
      text: 'Perfect. Can you book a table for four?',
      at: minutes(12)
    }
  }),
  {
    id: '!design:example.invalid',
    name: 'Design team',
    membership: 'join',
    encrypted: true,
    canInvite: true,
    lastActiveAt: minutes(45),
    preview: { own: false, sender: 'Quân', kind: 'file', text: 'menu-october-v2.pdf', at: minutes(45) },
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@linh:example.invalid', membership: 'join' },
      { userId: '@quan:example.invalid', membership: 'join' }
    ]
  },
  direct('!quan:example.invalid', 'Quân', '@quan:example.invalid', {
    lastActiveAt: minutes(26 * 60),
    preview: { own: true, kind: 'text', text: 'I’ll send the draft tomorrow morning.', at: minutes(26 * 60) }
  })
]

const message = (id: string, sender: string, body: string, minutesAgo: number): MatrixMessage => ({
  id,
  sender,
  body,
  timestamp: minutes(minutesAgo),
  own: sender === ME.userId,
  encrypted: true,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false
})

const linhConversation: MatrixMessage[] = [
  message('$f1', '@linh:example.invalid', 'Are we still on for dinner Saturday?', 30),
  message('$f2', ME.userId, 'Yes! 7pm at the usual place?', 28),
  message('$f3', '@linh:example.invalid', 'Perfect. Can you book a table for four?', 12)
]

const linhMembers: MatrixMember[] = [
  { userId: ME.userId, name: 'An', membership: 'join', canRemove: false },
  { userId: '@linh:example.invalid', name: 'Linh', membership: 'join', canRemove: false }
]

const app = (
  slug: string,
  name: Record<string, string>,
  description: Record<string, string>,
  accent: string,
  order: number,
  verification: VerificationTier | null,
  affiliation: 'first_party' | 'partner' | null
): AppDescriptor => ({
  app: slug,
  app_id: `00000000-0000-4000-8000-0000000001${String(order).padStart(2, '0')}`,
  app_version_id: `00000000-0000-4000-9000-0000000001${String(order).padStart(2, '0')}`,
  name,
  subtitle: description,
  description,
  icon: null,
  accent,
  affiliation,
  verified: verification !== null,
  verification,
  availability: 'available',
  roster_default: false,
  roster_order: order,
  supported_modes: ['direct'],
  matrix_room_context: null,
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' }
})

/** Atum's own apps are official (a filled check), a partner verified (a hollow one), the rest
 * nothing. */
const apps: AppDescriptor[] = [
  app(
    'moon',
    { en: 'Moon', vi: 'Moon' },
    { en: 'Astrology readings', vi: 'Xem chiêm tinh' },
    '#5b4fc4',
    0,
    'official',
    'first_party'
  ),
  app(
    'andy',
    { en: 'Andy', vi: 'Andy' },
    { en: 'A friend to talk to', vi: 'Người bạn để trò chuyện' },
    '#c8613a',
    1,
    'official',
    'first_party'
  ),
  app(
    'atlas',
    { en: 'Atlas', vi: 'Atlas' },
    { en: 'Travel plans', vi: 'Lên kế hoạch du lịch' },
    '#3a62c9',
    2,
    'verified',
    'partner'
  ),
  app(
    'river',
    { en: 'River', vi: 'River' },
    { en: 'Notes and lists', vi: 'Ghi chú và danh sách' },
    '#2c8078',
    3,
    null,
    null
  )
]

const shown = Object.fromEntries(
  apps.map(each => [each.app_id, { visibility: 'shown' as const, status: 'ready' as const }])
)

/** One of the playground's founder scenarios, on the window's signed-in base. The profile sheet
 * is the founder module's own state, so a scenario opens or closes it as it starts. */
export function founderScenarioSnapshot(scenario: PlaygroundFounderScenario, base: MatrixSnapshot): MatrixSnapshot {
  $founderProfileOpen.set(scenario === 'founder-profile')
  const inFounderChat = scenario === 'founder-chat' || scenario === 'founder-profile'

  return {
    ...base,
    identity: ME,
    assistant: ATUM,
    ownProfile: { userId: ME.userId, displayName: 'An Trần', avatarMxc: null },
    agents: [
      {
        principal: 'agent-atum',
        userId: ATUM.userId,
        deviceId: ATUM.deviceId,
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        readiness: { phase: 'ready', since: NOW },
        atumModel: true
      }
    ],
    rooms,
    roomId: inFounderChat ? PLAYGROUND_FOUNDER_ROOM : LINH_ROOM,
    messages: inFounderChat ? [] : linhConversation,
    members: inFounderChat ? [] : linhMembers,
    apps: { state: 'ready', apps, connections: {} },
    appShortcuts: shown,
    founder: {
      userId: PLAYGROUND_FOUNDER,
      verification: 'official',
      roomId: PLAYGROUND_FOUNDER_ROOM,
      handle: 'founder'
    },
    officialAccounts: [{ userId: PLAYGROUND_FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }],
    founderChat: { state: 'present', founder: PLAYGROUND_FOUNDER, roomId: PLAYGROUND_FOUNDER_ROOM }
  }
}
