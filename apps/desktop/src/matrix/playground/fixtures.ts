import moonLookFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import { type AppDescriptor, MOON_APP_ONBOARDING_DISCLOSURE_VERSION } from '../../../shared/app-catalog'
import { decodeLookPack, type LookPackPublished } from '../../../shared/look-pack'
import type {
  MatrixAgentView,
  MatrixMember,
  MatrixMessage,
  MatrixReadinessStep,
  MatrixRoom,
  MatrixRoomPreview,
  MatrixSnapshot
} from '../../../shared/matrix'
import { matrixActionCopy } from '../../../shared/matrix-action-copy'
import type { MatrixAliasRequest, MatrixAliasResult } from '../../../shared/matrix-aliases'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../../shared/matrix-company-channel-room'

import { PLAYGROUND_ANDY_LOOK, PLAYGROUND_Demoza_LOOK } from './app-look-fixtures'
import { COMPANY_AI_ANSWER_FIXTURE, PLAYGROUND_PRIVATE_COS_ROOM_ID, playgroundPrivateCosRoom } from './company-ai-fixtures'
import { founderScenarioSnapshot, PLAYGROUND_FOUNDER_LABELS } from './founder-fixtures'
import {
  PLAYGROUND_COMPANY_CHANNEL_ID,
  PLAYGROUND_COMPANY_ID,
  PLAYGROUND_COMPANY_ROOM_ID
} from './places-fixtures'
import { TEAM_COS_USER_ID, TEAM_MEMBERS, TEAM_MESSAGES } from './team-space-fixtures'

/**
 * Design playground fixtures . Plausible, fixed
 * data for looking at the real Matrix window without Electron, Hermes or a network.
 * Dev only: nothing in the Matrix build imports this folder.
 */
export const PLAYGROUND_SCENARIOS = [
  'first-launch',
  'launch',
  'launch-slow',
  'launch-blocked',
  'launch-chat-down',
  'launch-signed-out',
  'launch-runtime',
  'launch-protons',
  'launch-recovery',
  'launch-recovery-first',
  'launch-approval',
  'launch-approval-compare',
  'launch-approval-mismatch',
  'launch-connect',
  'launch-unreachable',
  'sign-in-launch',
  'signed-out',
  'session-ended',
  'account-unavailable',
  'chats-disk-full',
  'launch-disk-full',
  'chat',
  'chat-model-picker',
  'chat-plan-unavailable',
  'chat-plan-fell-back',
  'chat-google-switch',
  'chat-moon-app',
  'chat-andy-app',
  'chat-demoza-app',
  'chat-orbit-app',
  'chat-moon-days',
  'chat-andy-days',
  'chat-group-runs',
  'chat-live',
  'chat-thinking',
  'chat-reasoning',
  'chat-working',
  'chat-rich',
  'chat-handoff',
  'chat-handoff-quiet',
  'empty',
  'chat-unread',
  'chat-group',
  'team-space-threads',
  'team-space-private-cos',
  'chat-group-assistant',
  'chat-people',
  'chat-bubbles-working',
  'chat-bubbles-answered',
  'chat-prompt',
  'chat-degraded',
  'chat-setup',
  'chat-unavailable',
  'chat-disk-full',
  'chat-reconnecting',
  'chat-reconnect',
  'chat-withdrawn',
  'chat-device-damaged',
  'chat-approve-asked',
  'chat-approve',
  'chat-approve-declined',
  'chat-held',
  'chat-pet',
  'chat-long',
  'chat-days',
  'roster',
  'first-run',
  'first-run-chat',
  'first-run-blocked',
  'first-run-google',
  'first-run-skipped',
  'first-learning',
  'founder-roster',
  'founder-chat',
  'founder-profile',
  'founder-settings',
  'quiet-launch',
  'quiet-needs-you',
  'quiet-two'
] as const

export type PlaygroundScenario = (typeof PLAYGROUND_SCENARIOS)[number]

export const PLAYGROUND_SCENARIO_LABELS: Record<PlaygroundScenario, string> = {
  'first-launch': 'First launch: the story',
  launch: 'Launch: five checks',
  'launch-slow': 'Launch: slow AI',
  'launch-blocked': 'Launch: AI unreachable (in the chat)',
  'launch-chat-down': 'Launch: chats unreachable',
  'launch-signed-out': 'Launch: signed out elsewhere',
  'launch-runtime': 'Launch: damaged install (the indicator; the message box names it)',
  'launch-protons': 'Launch: out of Protons (the indicator; the message box names it)',
  'launch-recovery': 'Launch: recovery key on another Mac',
  'launch-recovery-first': 'Launch: no recovery key, account has an identity (rare)',
  'launch-approval': 'Launch: a new Mac asks the person’s other device',
  'launch-approval-compare': 'Launch: a new Mac shows the number code to pick',
  'launch-approval-mismatch': 'Launch: the other device picked a wrong symbol',
  'launch-connect': 'Launch: Atum account unfinished',
  'launch-unreachable': 'Launch: saved account, chats never reached',
  'sign-in-launch': 'Sign in, then the launch',
  'signed-out': 'Signed out',
  'session-ended': 'Signed out: the sign-in server ended this Mac’s session',
  'account-unavailable': 'Signed out: a saved sign-in that can’t be opened',
  'chats-disk-full': 'No account open: the disk is too full to save the sign-in',
  'launch-disk-full': 'Launch: the disk is too full to save the sign-in',
  chat: 'Chat',
  'chat-model-picker': 'Chat: cloud Atum plus this Mac’s model connections',
  'chat-plan-unavailable': 'Chat: chosen ChatGPT model while its Mac is offline, and a fallback answer',
  'chat-plan-fell-back': 'Chat (S2): chosen ChatGPT model, carried to the cloud, whose last turn fell back',
  'chat-google-switch': 'Chat (S2): the once-only line when Google data moved the chat to Nguyệt Thực',
  'chat-moon-app': 'Chat: linked Moon app, history and actions',
  'chat-andy-app': 'Chat: Andy app with a declared light look (side panel proof)',
  'chat-demoza-app': 'Chat: Demoza app, colour-only look, not connected yet',
  'chat-orbit-app': 'Chat: an app this client has never heard of, no look',
  'chat-moon-days': 'Chat: Moon over two days, with the unread line (dark look)',
  'chat-andy-days': 'Chat: Andy over two days, with the unread line (light look)',
  'chat-group-runs': 'Chat: a group of people, an assistant and an app, in runs',
  'chat-live': 'Chat: answer streaming',
  'chat-thinking': 'Chat: thinking, nothing to show yet',
  'chat-reasoning': 'Chat: thoughts streaming',
  'chat-working': 'Chat: steps running (Lan busy too)',
  'chat-rich': 'Chat: an answer with code, a table and a quote',
  'chat-handoff': 'Chat: answered from the other Mac',
  'chat-handoff-quiet': 'Chat: other Mac quiet',
  empty: 'New assistant, empty chat',
  'chat-unread': 'Chat: unread in other chats',
  'chat-group': 'Chat: a group with people',
  'team-space-threads': 'Team Space: threads, company files and attention',
  'team-space-private-cos': 'Team Space: your private chat with the Chief of Staff (with ?company=team)',
  'chat-group-assistant': 'Chat: a group with your assistant (owner-only)',
  'chat-people': 'Chat: replies, reactions, edits, typing',
  'chat-bubbles-working': 'Chat bubbles: acknowledge, typing, working line',
  'chat-bubbles-answered': 'Chat bubbles: the answer, no working line left',
  'chat-prompt': 'Chat: the assistant asks first',
  'chat-degraded': 'Chat: AI briefly unavailable',
  'chat-setup': 'Chat: Atum not set up yet',
  'chat-unavailable': 'Chat: an assistant not ready',
  'chat-disk-full': 'Chat: stopped, the disk is too full to save the sign-in',
  'chat-reconnecting': 'Chat: Moon’s device replaced on this Mac, reconnecting',
  'chat-reconnect': 'Chat: Moon needs Reconnect (today’s automatic tries used up)',
  'chat-withdrawn': 'Chat: Moon withdrawn by the platform, Reconnect offered',
  'chat-device-damaged': 'Chat: this Mac’s own device lost its keys',
  'chat-approve-asked': 'Chat: another device asks; the person says it is them first',
  'chat-approve': 'Chat: another device asks this one to approve it',
  'chat-approve-declined': 'Chat: “This wasn’t me”',
  'chat-held': 'Chat: a phone reply the assistant held',
  'chat-pet': 'Chat: Gigi strolling (older account, nothing chosen)',
  'chat-long': 'Chat: a long transcript scrolling under the floating composer (Gigi strolling)',
  'chat-days': 'Chat: dates, edits, forwarding and the read marker',
  roster: 'Roster: histories, people, every unread kind',
  'first-run': 'First run: launch, first message, review',
  'first-run-chat': 'First run: first message in the chat',
  'first-run-blocked': 'First run: macOS kept the folders closed',
  'first-run-google': 'First run: greeting plus Atum asks card',
  'first-run-skipped': 'First run: skipped card, Google chip',
  'first-learning': 'First run: mid-learning progressive messages',
  ...PLAYGROUND_FOUNDER_LABELS,
  'quiet-launch': 'Quiet launch: six assistants checking trust and starting, nothing shown',
  'quiet-needs-you': 'Quiet launch: Moon needs you (indicator + its row), Atum’s chat open',
  'quiet-two': 'Quiet launch: a new device to confirm and a Mac almost full (one indicator)'
}

const ME = { userId: '@minh:atum.chat', deviceId: 'MACMINI' }
const ATUM = { userId: '@atum_bot:example.invalid', deviceId: 'ATUMMINI' }
const MOON = { userId: '@moon_bot:example.invalid', deviceId: 'MOONMINI' }
const NOW = Date.now()

const ASSISTANT_ROOM = '!assistant:example.invalid'
const MOON_APP_ROOM = '!moon-app:example.invalid'
const MOON_APP_USER = '@moon_app:example.invalid'

// The side panel's look-pack proof: two more official apps and one this client has never heard of.
const APP_CHATS = {
  andy: { room: '!andy-app:example.invalid', user: '@andy_app:example.invalid', name: 'Andy' },
  demoza: { room: '!demoza-app:example.invalid', user: '@demoza_app:example.invalid', name: 'Demoza' },
  orbit: { room: '!orbit-app:example.invalid', user: '@orbit_app:example.invalid', name: 'Orbit' }
} as const

/** The complete standard decimal SAS shown by device approval. */
const PLAYGROUND_SAS: [number, number, number] = [1036, 4349, 6060]

/** A row's latest message, as the SDK previews it (`room-preview.ts`). */
const said = (
  own: boolean,
  text: string,
  minutesAgo: number,
  extra: Partial<MatrixRoomPreview> = {}
): MatrixRoomPreview => ({
  own,
  kind: 'text',
  text,
  at: NOW - minutesAgo * 60_000,
  ...extra
})

const rooms: MatrixRoom[] = [
  {
    id: ASSISTANT_ROOM,
    name: 'Atum',
    membership: 'join',
    encrypted: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'agent-atum',
    firstLine: 'Can you plan a three-day trip to Đà Lạt for two, mid-October?…',
    createdAt: NOW - 20 * 60_000,
    lastActiveAt: NOW - 2 * 60_000,
    preview: said(true, 'Yes, guesthouses please. Under 1.2 million a night.', 2),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: ATUM.userId, membership: 'join' }
    ]
  },
  {
    id: '!moon:example.invalid',
    name: 'Lan',
    membership: 'join',
    encrypted: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'agent-moon',
    firstLine: 'Can you pull the latest numbers from the research folder?',
    createdAt: NOW - 2 * 86_400_000,
    lastActiveAt: NOW - 3_600_000,
    preview: said(false, 'The October folder has three new reports. Revenue is up 12% month on month.', 60, {
      sender: 'Lan'
    }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: MOON.userId, membership: 'join' }
    ]
  },
  {
    id: '!linh:example.invalid',
    name: 'Linh',
    membership: 'join',
    encrypted: true,
    direct: true,
    unreadNotifications: 2,
    unread: true,
    lastActiveAt: NOW - 900_000,
    preview: said(false, 'Perfect. Can you book a table for four?', 15, { sender: 'Linh' }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@linh:example.invalid', membership: 'join' }
    ]
  },
  {
    id: '!design:example.invalid',
    name: 'Design team',
    membership: 'join',
    encrypted: true,
    canInvite: true,
    lastActiveAt: NOW - 7_200_000,
    preview: said(false, 'menu-october-v2.pdf', 120, { sender: 'Quân', kind: 'file' }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@linh:example.invalid', membership: 'join' },
      { userId: '@quan:example.invalid', membership: 'join' }
    ]
  },
  // An older Atum history: no first message loaded, so it goes by its date.
  {
    id: '!assistant-older:example.invalid',
    name: 'Atum',
    membership: 'join',
    encrypted: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'agent-atum',
    createdAt: NOW - 9 * 86_400_000,
    lastActiveAt: NOW - 8 * 86_400_000,
    preview: said(false, 'Done: your reminder is set for 8am every weekday.', 8 * 1440, { sender: 'Atum' }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: ATUM.userId, membership: 'join' }
    ]
  },
  // People and groups for the roster's creation flows (start menu, new group, invite).
  {
    id: '!quan:example.invalid',
    name: 'Quân',
    membership: 'join',
    encrypted: true,
    direct: true,
    lastActiveAt: NOW - 26 * 3_600_000,
    preview: said(true, 'I’ll send the draft tomorrow morning.', 26 * 60),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@quan:example.invalid', membership: 'join' }
    ]
  },
  {
    id: '!hoa:example.invalid',
    name: 'Hoa',
    membership: 'join',
    encrypted: true,
    direct: true,
    // Marked unread by its owner (m.marked_unread): a dot, no count.
    markedUnread: true,
    lastActiveAt: NOW - 3 * 86_400_000,
    preview: said(false, 'See you Sunday!', 3 * 1440, { sender: 'Hoa' }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@hoa:example.invalid', membership: 'join' }
    ]
  },
  {
    id: '!family:example.invalid',
    name: 'Gia đình',
    membership: 'join',
    encrypted: true,
    canInvite: true,
    muted: true,
    // Muted, with new messages that did not notify: a quiet dot, never a count.
    unread: true,
    lastActiveAt: NOW - 30 * 3_600_000,
    preview: { own: false, sender: 'Bảo', kind: 'image', at: NOW - 30 * 3_600_000 },
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: '@hoa:example.invalid', membership: 'join' },
      { userId: '@bao:example.invalid', membership: 'join' },
      { userId: '@my:example.invalid', membership: 'invite' }
    ]
  }
]

/** People who joined after IDs became opaque (`@user-<32 hex>`). */
const PLAYGROUND_LAN = '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:example.invalid'
const PLAYGROUND_LINH_TWO = '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:example.invalid'
const PLAYGROUND_UNNAMED = '@user-0123456789abcdef0123456789abcdef:example.invalid'

/** Who is in each group, for its members dialog (invite people). */
export const PLAYGROUND_MEMBERS: Record<string, MatrixMember[]> = {
  '!trip:example.invalid': [
    { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
    { userId: ATUM.userId, name: 'Atum', membership: 'join', avatarMxc: 'mxc://playground/atum', canRemove: true },
    {
      userId: '@linh:example.invalid',
      name: 'Linh',
      membership: 'join',
      avatarMxc: 'mxc://playground/linh',
      canRemove: true
    },
    {
      userId: '@quan:example.invalid',
      name: 'Quân',
      membership: 'join',
      avatarMxc: 'mxc://playground/quan',
      canRemove: true
    }
  ],
  '!design:example.invalid': [
    { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
    {
      userId: '@linh:example.invalid',
      name: 'Linh',
      membership: 'join',
      avatarMxc: 'mxc://playground/linh',
      canRemove: true
    },
    {
      userId: '@quan:example.invalid',
      name: 'Quân',
      membership: 'join',
      avatarMxc: 'mxc://playground/quan',
      canRemove: true
    },
    // New people have opaque IDs (ledger AC8): Lan's @lan comes from the directory once looked
    // up, a second Linh is told apart by a short mark, and someone unnamed is "Atum user".
    {
      userId: PLAYGROUND_LAN,
      name: 'Lan',
      membership: 'join',
      avatarMxc: 'mxc://playground/lan',
      canRemove: true
    },
    {
      userId: PLAYGROUND_LINH_TWO,
      name: `Linh (${PLAYGROUND_LINH_TWO})`,
      membership: 'join',
      avatarMxc: 'mxc://playground/linh-two',
      canRemove: true
    },
    { userId: PLAYGROUND_UNNAMED, name: PLAYGROUND_UNNAMED, membership: 'invite', canRemove: true }
  ],
  '!linh:example.invalid': [
    { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
    {
      userId: '@linh:example.invalid',
      name: 'Linh',
      membership: 'join',
      avatarMxc: 'mxc://playground/linh',
      canRemove: false
    }
  ]
}

// The selected company room is the same launch group projected through Company authority.
// `PlaygroundStore.select` must therefore restore its people as well as its messages.
PLAYGROUND_MEMBERS[PLAYGROUND_COMPANY_ROOM_ID] = TEAM_MEMBERS
for (const roomId of Object.keys(TEAM_MESSAGES)) {
  PLAYGROUND_MEMBERS[roomId] = TEAM_MEMBERS
}

/** Who is typing in each chat, for the playground's select (Matrix chat, launch night). */
export const PLAYGROUND_TYPING: Record<string, string[]> = {
  '!linh:example.invalid': ['@linh:example.invalid']
}

/**
 * The alias directory, scripted (dev only): @lan is a person you don't talk to yet, @linh
 * one you do, @moon_bot your own assistant, @spa_bot someone else's, @river an app and
 * @nobody nobody; @busy is rate limited and @offline can't be reached.
 */
export async function playgroundAlias(input: MatrixAliasRequest): Promise<MatrixAliasResult> {
  if (input.action === 'current') {
    return { ok: true, value: { kind: 'current', alias: { handle: 'minh', generation: 1 } } }
  }

  if (input.action === 'contacts') {
    // The people the owner shares a chat or a company with (spec/public-handles/v1.1). Anyone
    // else answers null: a stranger and someone without a handle look the same.
    const byUser: Record<string, string> = {
      '@linh:example.invalid': 'linh',
      '@quan:example.invalid': 'quan',
      '@hoa:example.invalid': 'hoa_tran',
      '@bao:example.invalid': 'bao_tran',
      '@my:example.invalid': 'my_le',
      [PLAYGROUND_LAN]: 'lan',
      [MOON.userId]: 'moon_bot'
    }

    await new Promise(resolve => setTimeout(resolve, 300))

    return {
      ok: true,
      value: { kind: 'contacts', contacts: input.matrixUsers.map(matrixUser => ({ matrixUser, handle: byUser[matrixUser] ?? null })) }
    }
  }

  if (input.action !== 'lookup') {
    return { ok: false, error: 'unavailable' }
  }

  await new Promise(resolve => setTimeout(resolve, 450))
  const handle = input.handle.replace(/^@/, '').toLowerCase()

  const holders: Record<string, { principalKind: 'human' | 'agent' | 'app'; matrixUser: string | null }> = {
    lan: { principalKind: 'human', matrixUser: PLAYGROUND_LAN },
    linh: { principalKind: 'human', matrixUser: '@linh:example.invalid' },
    minh: { principalKind: 'human', matrixUser: ME.userId },
    moon_bot: { principalKind: 'agent', matrixUser: MOON.userId },
    spa_bot: { principalKind: 'agent', matrixUser: '@spa_bot:example.invalid' },
    river: { principalKind: 'app', matrixUser: '@river:example.invalid' },
    tuan: { principalKind: 'human', matrixUser: null }
  }

  if (handle === 'busy') {
    return { ok: false, error: 'limit', retryAfterSeconds: 30 }
  }

  if (handle === 'offline') {
    return { ok: false, error: 'unavailable' }
  }

  const holder = holders[handle]

  return holder
    ? { ok: true, value: { kind: 'lookup', handle, state: 'assigned', ...holder } }
    : { ok: true, value: { kind: 'lookup', handle, state: 'available' } }
}

const message = (id: string, own: boolean, body: string, minutesAgo: number, extra: Partial<MatrixMessage> = {}) => ({
  id,
  sender: own ? ME.userId : ATUM.userId,
  body,
  timestamp: NOW - minutesAgo * 60_000,
  own,
  encrypted: true,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false,
  ...extra
})

/** Round 3 of desktop chat bubbles: an acknowledgement (a real interim message) and the one
 * live working line a turn edits in place. Synthetic words, as on a phone screenshot. */
const bubblesConversation: MatrixMessage[] = [
  message('$bq', true, 'Can you find a quiet guesthouse in Đà Lạt for mid-October, under 1.2 million a night?', 4),
  message('$binterim', false, 'Để mình xem vài chỗ yên tĩnh quanh hồ rồi tóm tắt nhé.', 3, { interim: true }),
  message(
    '$bwork',
    false,
    [
      'Đang tìm guesthouse ở Đà Lạt…',
      '✓ Tìm trên web',
      '✓ Đọc giá phòng',
      '• Kiểm tra còn phòng trống'
    ].join('\n'),
    2,
    {
      notice: true,
      progress: {
        profile: 'atum.agent-turns/1.3',
        scope: 'owner_private',
        phase: 'working',
        kind: 'todo',
        revision: 3
      }
    }
  )
]

const bubblesAnswer = message(
  '$banswer',
  false,
  [
    'Mình tìm được ba chỗ yên tĩnh, còn phòng giữa tháng 10:',
    '',
    '1. **Hillside pines homestay** — 950.000₫/đêm, cách hồ Tuyền Lâm 5 phút.',
    '2. **The Lake House** — 1.100.000₫/đêm, có ban công nhìn ra hồ.',
    '3. **Mộc Trà garden** — 780.000₫/đêm, trong một vườn cà phê nhỏ.',
    '',
    'Bạn muốn mình giữ chỗ nào chưa?'
  ].join('\n'),
  1,
  { replyTo: '$bq', resultFor: '$bq' }
)

const conversation: MatrixMessage[] = [
  message('$q1', true, 'Can you plan a three-day trip to Đà Lạt for two, mid-October? Quiet, good coffee.', 12, {
    readBy: [ATUM.userId]
  }),
  message(
    '$a1',
    false,
    [
      "Here's a calm three days in Đà Lạt for mid-October, the start of the dry season.",
      '',
      '**Day 1: settle in**',
      '- Afternoon walk around Xuân Hương Lake',
      '- Coffee at a hillside café in Trại Mát',
      '',
      '**Day 2: pine forests**',
      '- Morning at Tuyền Lâm Lake before the tour buses',
      '- Lunch in the old French quarter',
      '',
      '**Day 3: slow morning**',
      '- The flower market, then an early bus back',
      '',
      'Want me to check trains and a couple of quiet guesthouses?'
    ].join('\n'),
    11,
    // A reaction in your assistant's chat is feedback, never a turn.
    { replyTo: '$q1', reactions: [{ key: '👍', count: 1, own: true, senders: [ME.userId] }] }
  ),
  message('$q2', true, 'Yes, guesthouses please. Under 1.2 million a night.', 2, { sent: true })
]

const person = (sender: string, id: string, body: string, minutesAgo: number, extra: Partial<MatrixMessage> = {}) =>
  message(id, false, body, minutesAgo, { sender, ...extra })

/** A group with people: runs of messages, markdown from a person, a file, one that could
 * not be read here, your own seen by two, and one that did not send. */
const groupConversation: MatrixMessage[] = [
  person('@linh:example.invalid', '$g1', 'Morning! Draft of the **October menu** is in. Thoughts by Friday?', 95, {
    reactions: [
      { key: '👍', count: 2, own: true, senders: [ME.userId, '@quan:example.invalid'] },
      { key: '🙏', count: 1, own: false, senders: ['@quan:example.invalid'] }
    ]
  }),
  person('@linh:example.invalid', '$g2', '- Two new soups\n- The dessert list gets shorter\n- Prices stay the same', 94),
  person('@quan:example.invalid', '$g3', 'menu-october-v2.pdf', 80, { attachment: true, attachmentSize: 482_133 }),
  person('@quan:example.invalid', '$g4', '', 79, { decryptionFailed: true }),
  person(PLAYGROUND_LINH_TWO, '$g4b', 'Thursday works for me too.', 60),
  person(PLAYGROUND_LAN, '$g4c', 'I can bring the printed menus.', 55),
  message('$g5', true, 'Looks good to me. I like the shorter dessert list.', 40, {
    // Four readers: three faces and a count, as Element X folds them.
    readBy: ['@linh:example.invalid', '@quan:example.invalid', PLAYGROUND_LAN, PLAYGROUND_LINH_TWO]
  }),
  message('~!design:example.invalid:m1', true, 'Can we taste the soups on Thursday?', 3, { failed: true })
]

/** A chat with one person, with Matrix's own features in it (launch night): a reaction, an
 * edited message, a deleted one, a reply with a reaction, and Linh typing. */
const linhConversation: MatrixMessage[] = [
  person('@linh:example.invalid', '$l1', 'Are we still on for dinner Saturday?', 30, {
    reactions: [{ key: '👍', count: 1, own: true, senders: [ME.userId] }]
  }),
  message('$l2', true, 'Yes! 7pm at the usual place?', 28, { edited: true }),
  person('@linh:example.invalid', '$l3', 'Perfect. Can you book a table for four?', 27),
  person('@linh:example.invalid', '$l4', '', 26, { redacted: true }),
  message('$l5', true, 'Booked: the window table, 7pm 🙌', 10, {
    replyTo: '$l3',
    readBy: ['@linh:example.invalid'],
    reactions: [{ key: '❤️', count: 1, own: false, senders: ['@linh:example.invalid'] }]
  }),
  // A web link opens in the browser; anything else a message carries stays inert words.
  person(
    '@linh:example.invalid',
    '$l6',
    'Here’s [their menu](https://example.com/menu). Someone also sent me [a prize link](javascript:alert(1)), ignore it.',
    4
  )
]

/** A group with your assistant in it (owner-only assistants in groups, 2026-10-06): its one
 * line when it joined (a notice, said in your language), the group talking, you asking it by
 * name, its answer for everyone, and the group going on. */
const TRIP_ROOM = '!trip:example.invalid'

const tripConversation: MatrixMessage[] = [
  message('$joined-atum', false, matrixActionCopy.en.groupJoined, 32, { notice: true }),
  person('@linh:example.invalid', '$t1', 'Đà Lạt on Oct 17–19, is everyone free?', 30),
  message('$t3', true, '@Atum plan three quiet days for the four of us, with good coffee', 21, {
    readBy: ['@linh:example.invalid', '@quan:example.invalid']
  }),
  message(
    '$t4',
    false,
    [
      '- **Day 1:** settle in, an evening walk around Xuân Hương Lake',
      '- **Day 2:** pine forests at Langbiang, coffee in Trại Mát',
      '- **Day 3:** the flower gardens, a slow lunch, then home'
    ].join('\n'),
    19,
    { replyTo: '$t3' }
  ),
  person('@quan:example.invalid', '$t5', 'Day 2 looks perfect 👌', 12)
]

const moonAppConversation: MatrixMessage[] = [
  message('$moon-app-owner', true, 'Can you give me a grounded reading for the coming month?', 14, {
    encrypted: true
  }),
  person(
    MOON_APP_USER,
    '$moon-app-answer',
    'This month rewards a steady pace: finish the work already in motion before opening a second front.',
    12,
    { encrypted: true, replyTo: '$moon-app-owner' }
  )
]

export const PLAYGROUND_TEAM_SPACE_ROOT = person(
  '@linh:example.invalid',
  '$launch-root',
  'Should we move the launch to Tuesday?',
  32,
  {
    encrypted: false,
    reactions: [{ key: '👍', count: 2, own: true, senders: [ME.userId, '@quan:example.invalid'] }]
  }
)

const teamSpaceOtherRoot = person(
  '@quan:example.invalid',
  '$brief-root',
  'The investor brief needs one final chart.',
  75,
  { encrypted: false }
)

const teamSpaceReplies: MatrixMessage[] = [
  message('$launch-reply-1', true, 'Tuesday gives us a cleaner support window.', 25, {
    encrypted: false,
    thread: true,
    threadRootId: PLAYGROUND_TEAM_SPACE_ROOT.id,
    replyTo: PLAYGROUND_TEAM_SPACE_ROOT.id
  }),
  person('@linh:example.invalid', '$launch-reply-2', '@Minh agreed — I will update the customer email.', 8, {
    encrypted: false,
    thread: true,
    threadRootId: PLAYGROUND_TEAM_SPACE_ROOT.id,
    replyTo: PLAYGROUND_TEAM_SPACE_ROOT.id
  }),
  person('@quan:example.invalid', '$launch-file', 'launch-chart.pdf', 4, {
    encrypted: false,
    attachment: true,
    companyFile: true,
    attachmentSize: 842_311,
    thread: true,
    threadRootId: PLAYGROUND_TEAM_SPACE_ROOT.id,
    replyTo: PLAYGROUND_TEAM_SPACE_ROOT.id
  })
]

// A day of a launch channel, yesterday into this morning: runs from one person read as one block,
// your own messages sit with everyone's (Team Space's Slack layout), and a day line splits them.
const teamSpaceLines: Array<[string, string]> = [
  ['@quan:example.invalid', 'Morning all. Launch checklist is in the pinned doc.'],
  ['@quan:example.invalid', 'Three things still open: pricing page, support rota, the customer email.'],
  ['@linh:example.invalid', 'I can take the customer email.'],
  [ME.userId, 'Thanks Linh. I will do the pricing page today.'],
  [ME.userId, 'Support rota: Quân, can you draft it?'],
  ['@quan:example.invalid', 'On it. **Draft by 5pm.**'],
  ['@linh:example.invalid', 'Email draft v1 is up — comments welcome.'],
  ['@linh:example.invalid', 'Main changes:\n- shorter subject line\n- the launch date up top\n- one clear call to action'],
  [ME.userId, 'Reads well. Keep the price out of the subject.'],
  ['@quan:example.invalid', 'Rota draft: weekdays split by timezone, weekends one person on call.'],
  ['@quan:example.invalid', 'I put myself on the first weekend.'],
  ['@linh:example.invalid', 'Looks fair to me.'],
  [ME.userId, 'Approved. Let us lock it tomorrow morning.'],
  ['@linh:example.invalid', 'Email v2 attached in the doc.'],
  ['@quan:example.invalid', 'Pricing page preview is live on staging.'],
  ['@quan:example.invalid', 'Mobile layout still needs a pass.'],
  [ME.userId, 'I will check it on my phone tonight.'],
  ['@linh:example.invalid', 'Good morning! Customer email is scheduled for Monday 9am.'],
  ['@linh:example.invalid', 'I can move it if the launch moves.'],
  [ME.userId, 'Checked the pricing page on mobile: two small fixes, I pushed them.'],
  ['@quan:example.invalid', 'Rota is locked and shared with the team.'],
  ['@quan:example.invalid', 'Support has the macros ready too.'],
  ['@linh:example.invalid', 'Nice. Only open item is the date itself.'],
  [ME.userId, 'Let us decide on the date below.']
]

// Yesterday afternoon for the first seventeen, this morning for the rest.
const teamSpaceLeadIn = teamSpaceLines.map(([sender, body], index) => {
  const minutesAgo = index < 17 ? 24 * 60 + 300 - index * 4 : 120 - (index - 17) * 4

  return sender === ME.userId
    ? message(`$launch-context-${index + 1}`, true, body, minutesAgo, { encrypted: false })
    : person(sender, `$launch-context-${index + 1}`, body, minutesAgo, { encrypted: false })
})

const companyAIAnswer = {
  ...person(
    TEAM_COS_USER_ID,
    '$company-ai-answer',
    COMPANY_AI_ANSWER_FIXTURE.text,
    2,
    { encrypted: false, replyTo: '$company-ai-mention' }
  ),
  companyAIAnswer: COMPANY_AI_ANSWER_FIXTURE
} as MatrixMessage

// The owner's 2026-11-03 case: a channel mention the Chief of Staff answers in a standard thread.
// In the channel it is one line under the mention (faces, "1 reply", "Last reply …"), never a row.
const teamSpaceCosRoot = message('$cos-thread-root', true, '@Chief of Staff any project updates this week?', 18, {
  encrypted: false,
  reactions: [{ key: '👀', count: 1, own: false, senders: ['@linh:example.invalid'] }]
})

const teamSpaceCosReplies: MatrixMessage[] = [
  person(TEAM_COS_USER_ID, '$cos-thread-reply', 'No project updates yet. The launch board has no new cards since Monday.', 14, {
    encrypted: false,
    thread: true,
    threadRootId: teamSpaceCosRoot.id,
    replyTo: teamSpaceCosRoot.id
  })
]

const teamSpaceConversation = [
  ...teamSpaceLeadIn,
  teamSpaceOtherRoot,
  PLAYGROUND_TEAM_SPACE_ROOT,
  teamSpaceCosRoot,
  person(ME.userId, '$company-ai-mention', '@Chief of Staff what is included in Release B?', 3, { encrypted: false }),
  companyAIAnswer
]

/** Each room's messages, for the playground's select. */
export const PLAYGROUND_MESSAGES: Record<string, MatrixMessage[]> = {
  '!design:example.invalid': groupConversation,
  '!linh:example.invalid': linhConversation,
  [MOON_APP_ROOM]: moonAppConversation,
  [PLAYGROUND_COMPANY_ROOM_ID]: teamSpaceConversation,
  [TRIP_ROOM]: tripConversation,
  // Team Space's direct messages (`?company=team`).
  ...TEAM_MESSAGES
}

const agents: MatrixAgentView[] = [
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
  },
  {
    principal: 'agent-moon',
    userId: MOON.userId,
    deviceId: MOON.deviceId,
    name: 'Lan',
    isDefault: false,
    ready: true,
    hermes: 'ready',
    readiness: { phase: 'ready', since: NOW },
    atumModel: true
  }
]

const app = (
  slug: string,
  name: string,
  accent: string,
  order: number,
  extra: Partial<AppDescriptor> = {}
): AppDescriptor => ({
  app: slug,
  app_id: `00000000-0000-4000-8000-0000000000${String(order).padStart(2, '0')}`,
  app_version_id: `00000000-0000-4000-9000-0000000000${String(order).padStart(2, '0')}`,
  name: { en: name },
  subtitle: null,
  description: null,
  icon: null,
  accent,
  affiliation: 'first_party',
  verified: true,
  availability: 'available',
  roster_default: order < 2,
  roster_order: order,
  supported_modes: ['direct'],
  matrix_room_context: null,
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' },
  ...extra
})

/** An official chat identity for a fixture app (Andy, Demoza, Orbit). */
const appBot = (handle: keyof typeof APP_CHATS, deviceId: string): NonNullable<AppDescriptor['bot']> => ({
  v: 1,
  user_id: APP_CHATS[handle].user,
  handle,
  display_name: APP_CHATS[handle].name,
  avatar: { url: '', sha256: 'a'.repeat(64) },
  device_generation: 1,
  device: { device_id: deviceId, ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
  state: 'active',
  groups: true,
  consent: 'accepted',
  disclosure_version: 1,
  open_route_id: 'chat',
  open_shared_memory: true,
  purchase_route_id: ''
})

/**
 * Moon's panel ground, the light variant of its web-sidebar art: the same orbit lattice drawn in
 * Moon navy on paper `#F7F6F2`, framed as the sidebar's `fixture-c9885aa56f@example.invalid`, at 0.30,
 * no dark variant, with the ramp the platform derives from that ground (deriveLookGround over the
 * worst pixel `#BCBFCD`). Proposed in moon2-app docs/atum-look-pack (2026-11-07) and not yet
 * published: production still serves the v1.1 navy ground, which the browser proof covers too.
 */
const PLAYGROUND_MOON_PAPER_LATTICE = {
  sha256: '6f2c6c150730f2d87dcf760b29f6ea94dbadf410a9b53987b63207946ccf05d2',
  kind: 'vector' as const,
  width: 1440,
  height: 1000,
  variants: [
    {
      mime: 'image/svg+xml' as const,
      sha256: '6f2c6c150730f2d87dcf760b29f6ea94dbadf410a9b53987b63207946ccf05d2',
      bytes: 53197,
      width: 1440,
      height: 1000,
      use: 'full' as const
    }
  ]
}

function withPlaygroundPanel(pack: LookPackPublished | null): LookPackPublished | undefined {
  if (!pack) {
    return undefined
  }

  return {
    ...pack,
    panel: {
      background: {
        light: {
          tone: 'light',
          base: '#F7F6F2',
          layers: [{ asset: PLAYGROUND_MOON_PAPER_LATTICE, fit: 'cover', tile_px: null, position: 'center', opacity: 0.3 }]
        },
        dark: null
      },
      derived: {
        light: {
          worst: '#BCBFCD',
          ink: '#151515FF',
          ink_soft: '#151515BF',
          ink_muted: '#151515B3',
          ink_faint: '#15151599',
          line: '#1515158C',
          scrim: '#F7F6F2'
        }
      }
    }
  }
}

/** A few catalog apps, so Discover, the roster's apps and the new-tab page have content. */
const apps: AppDescriptor[] = [
  app('moon', 'Moon', '#D8612F', 5, {
    // Moon's published look pack, so its chat shows an app look (Atum Kit, FlowAppLook).
    look: withPlaygroundPanel(decodeLookPack(moonLookFixture)),
    subtitle: { en: 'Astrology readings', vi: 'Luận giải chiêm tinh' },
    description: { en: 'A calm, private space for astrology readings.', vi: 'Không gian riêng tư cho luận giải chiêm tinh.' },
    affiliation: 'first_party',
    verification: 'official',
    roster_default: true,
    has_history: true,
    link: { mode: 'external_account', state: 'linked' },
    bot: {
      v: 1,
      user_id: MOON_APP_USER,
      handle: 'moon',
      display_name: 'Moon',
      avatar: { url: '', sha256: 'a'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'MOONAPP', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: true,
      consent: 'accepted',
      disclosure_version: MOON_APP_ONBOARDING_DISCLOSURE_VERSION,
      open_route_id: 'chat',
      open_shared_memory: true,
      purchase_route_id: 'top-up'
    }
  }),
  // River can start a group (connected); Ledger could, once connected.
  app('river', 'River', '#2c8078', 0, {
    matrix_room_context: 'addressed_only',
    link: { mode: 'external_account', state: 'linked' }
  }),
  app('ledger', 'Ledger', '#b4690e', 1, { matrix_room_context: 'addressed_only' }),
  app('atlas', 'Atlas', '#3a62c9', 2),
  app('fern', 'Fern', '#4f8a3a', 3),
  app('quill', 'Quill', '#8a4fb4', 4),
  app('andy', 'Andy', '#3D4A5C', 6, {
    look: PLAYGROUND_ANDY_LOOK,
    subtitle: { en: 'Your personal organiser', vi: 'Trợ lý sắp xếp công việc' },
    verification: 'verified',
    affiliation: 'partner',
    link: { mode: 'external_account', state: 'linked' },
    bot: appBot('andy', 'ANDYAPP')
  }),
  app('demoza', 'Demoza', '#A4553F', 7, {
    look: PLAYGROUND_Demoza_LOOK,
    subtitle: { en: 'Skincare routines', vi: 'Chăm sóc da' },
    verification: 'verified',
    affiliation: 'partner',
    link: { mode: 'external_account', state: 'never_linked' },
    bot: appBot('demoza', 'DemozaAPP')
  }),
  // Declares no icon, accent, subtitle or look: the default Kit panel.
  app('orbit', 'Orbit', '', 8, {
    accent: null,
    affiliation: null,
    verified: false,
    link: { mode: 'external_account', state: 'linked' },
    bot: appBot('orbit', 'ORBITAPP')
  })
]

const ready: MatrixSnapshot = {
  state: 'ready',
  identity: ME,
  assistant: ATUM,
  rooms,
  roomId: ASSISTANT_ROOM,
  messages: conversation,
  canSend: true,
  error: null,
  domainEnabled: true,
  hermes: 'ready',
  readiness: { phase: 'ready', since: NOW },
  assistantPath: 'local',
  atumModel: true,
  agents,
  // A current host always publishes its roster read; without it the launch screen waits on it forever.
  agentRoster: { state: 'ready', since: NOW },
  agentCreation: true,
  apps: { state: 'ready', apps, connections: {} },
  appShortcuts: { [apps[0].app_id]: { visibility: 'shown', status: 'ready' } },
  security: { recovery: 'idle' }
}

const MOON_ROOM = '!moon:example.invalid'
const HANDOFF_TURN = '00000000-0000-4000-8000-1a4c4216bb66'

/** Lan on a Mac that holds a guest copy: its earlier answer from the Mac mini, and a new
 * question handed to it (agent home device). */
const moonConversation: MatrixMessage[] = [
  message('$m1', true, 'Can you pull the latest numbers from the research folder?', 9),
  message(
    '$m2',
    false,
    'The October folder has three new reports. Revenue is up 12% month on month; the churn note is in **retention.md**.',
    8,
    { sender: MOON.userId, replyTo: '$m1', resultFor: '$m1' }
  ),
  message('$m3', true, 'Draft a short summary for the team, please.', 1, { turn: HANDOFF_TURN })
]

function moonHandoff(quiet: boolean): MatrixSnapshot {
  return {
    ...ready,
    assistant: MOON,
    roomId: MOON_ROOM,
    messages: moonConversation,
    localTurns: [
      {
        turnId: HANDOFF_TURN,
        roomId: MOON_ROOM,
        text: 'Draft a short summary for the team, please.',
        createdAt: NOW - 60_000,
        state: 'handed_off',
        synced: { question: true, answer: false },
        ...(quiet ? { notice: 'home_quiet' as const } : {})
      }
    ]
  }
}

/** The launch steps in order, with how long each takes in the playground. */
export const LAUNCH_STEPS: { step: MatrixReadinessStep; ms: number }[] = [
  { step: 'signed_in', ms: 450 },
  { step: 'assistant', ms: 800 },
  { step: 'hermes', ms: 2600 },
  { step: 'ai', ms: 700 },
  { step: 'authority', ms: 450 }
]

/** The default agent's row follows the window's readiness, as main publishes it. */
function withReadiness(
  readiness: NonNullable<MatrixSnapshot['readiness']>,
  extra: Partial<MatrixSnapshot> = {}
): MatrixSnapshot {
  return {
    ...ready,
    messages: [],
    readiness,
    agents: agents.map(agent => (agent.isDefault ? { ...agent, readiness } : agent)),
    ...extra
  }
}

export function launchSnapshot(step: MatrixReadinessStep, since: number): MatrixSnapshot {
  return withReadiness({ phase: 'starting', step, since })
}

/** An assistant's private history, as the roster lists it. */
function history(
  id: string,
  agent: { principal: string; userId: string; name: string },
  minutesAgo: number,
  extra: Partial<MatrixRoom> = {}
): MatrixRoom {
  return {
    id,
    name: agent.name,
    membership: 'join',
    encrypted: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: agent.principal,
    createdAt: NOW - (minutesAgo + 30) * 60_000,
    lastActiveAt: NOW - minutesAgo * 60_000,
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: agent.userId, membership: 'join' }
    ],
    ...extra
  }
}

const ROSTER_ATUM = { principal: 'agent-atum', userId: ATUM.userId, name: 'Atum' }
const ROSTER_MOON = { principal: 'agent-moon', userId: MOON.userId, name: 'Lan' }
const ROSTER_ALFRED = { principal: 'agent-alfred', userId: '@alfred_bot:example.invalid', name: 'Alfred' }
const ROSTER_ANALYST = { principal: 'agent-analyst', userId: '@analyst_bot:example.invalid', name: 'Analyst' }
const ROSTER_COUNCIL = { principal: 'agent-council', userId: '@council_bot:example.invalid', name: 'Council' }
const ROSTER_THERAPIST = { principal: 'agent-therapist', userId: '@therapist_bot:example.invalid', name: 'Therapist' }

const rosterAgent = (agent: typeof ROSTER_ALFRED, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  ...agent,
  isDefault: false,
  ready: true,
  hermes: 'ready',
  readiness: { phase: 'ready', since: NOW },
  atumModel: true,
  ...extra
})

const personRoom = (id: string, name: string, minutesAgo: number, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  lastActiveAt: NOW - minutesAgo * 60_000,
  participants: [
    { userId: ME.userId, membership: 'join' },
    { userId: `@${id.slice(1).split(':')[0]}:atum.chat`, membership: 'join' }
  ],
  ...extra
})

const groupRoom = (id: string, name: string, minutesAgo: number, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: true,
  canInvite: true,
  lastActiveAt: NOW - minutesAgo * 60_000,
  participants: [
    { userId: ME.userId, membership: 'join' },
    { userId: '@lan:example.invalid', membership: 'join' },
    { userId: '@quan:example.invalid', membership: 'join' }
  ],
  ...extra
})

/** Several assistants (Atum with eight histories, one on screen and one unread; Lan with a
 * fresh chat; Alfred with one; Analyst with none; Council getting ready), people and groups
 * with every kind of unread: a count, a mention, a mark, a muted chat's quiet activity. */
function rosterSnapshot(): MatrixSnapshot {
  const atumRooms = [
    history(ASSISTANT_ROOM, ROSTER_ATUM, 2, {
      firstLine: 'Can you plan a three-day trip to Đà Lạt for two, mid-October?…',
      preview: said(true, 'Yes, guesthouses please. Under 1.2 million a night.', 2)
    }),
    history('!atum-landlord:example.invalid', ROSTER_ATUM, 190, {
      firstLine: 'Draft a reply to the landlord about the deposit',
      unreadNotifications: 1,
      unread: true,
      preview: said(false, 'Here’s a short, friendly reply you can send today.', 190, { sender: 'Atum' })
    }),
    history('!atum-cook:example.invalid', ROSTER_ATUM, 1500, {
      firstLine: 'What should I cook this week?',
      preview: said(false, 'Monday: lemongrass chicken. Tuesday: tofu with tomato. Wednesday: fish soup.', 1500, {
        sender: 'Atum'
      })
    }),
    history('!atum-lease:example.invalid', ROSTER_ATUM, 2900, {
      firstLine: 'Summarize this lease for me',
      preview: said(true, 'lease-agreement.pdf', 2900, { kind: 'file' })
    }),
    history('!atum-mom:example.invalid', ROSTER_ATUM, 5800, {
      firstLine: 'Help me write a birthday message for Mom',
      preview: said(false, 'Happy birthday, Mom! Thank you for every early morning…', 5800, { sender: 'Atum' })
    }),
    history('!atum-reminder:example.invalid', ROSTER_ATUM, 8700, {
      preview: said(false, 'Done: your reminder is set for 8am every weekday.', 8700, { sender: 'Atum' })
    }),
    history('!atum-interest:example.invalid', ROSTER_ATUM, 13000, {
      firstLine: 'Explain compound interest simply',
      preview: said(false, 'Imagine your money earns money, and then that money earns money too.', 13000, {
        sender: 'Atum'
      })
    }),
    history('!atum-taxes:example.invalid', ROSTER_ATUM, 17300, {
      title: 'Taxes 2026',
      preview: said(true, 'Thanks, that’s everything I needed.', 17300)
    })
  ]

  const rooms: MatrixRoom[] = [
    ...atumRooms,
    history('!moon:example.invalid', ROSTER_MOON, 5, {
      firstLine: 'Can you pull the latest numbers from the research folder?',
      unreadNotifications: 3,
      unread: true,
      preview: said(false, 'The October folder has three new reports. Revenue is up 12% month on month.', 5, {
        sender: 'Lan'
      })
    }),
    // A chat nobody has written in yet: "New chat", never a date.
    history('!moon-new:example.invalid', ROSTER_MOON, 1),
    history('!alfred:example.invalid', ROSTER_ALFRED, 40, {
      firstLine: 'Book a table for Saturday',
      unreadNotifications: 4,
      unread: true,
      preview: said(false, 'I found three places with a window table at 7pm.', 40, { sender: 'Alfred' })
    }),
    history('!council-a:example.invalid', ROSTER_COUNCIL, 300, { firstLine: 'Weigh the two job offers' }),
    history('!council-b:example.invalid', ROSTER_COUNCIL, 4000, { firstLine: 'Should we move in spring?' }),
    history('!therapist:example.invalid', ROSTER_THERAPIST, 2200, {
      firstLine: 'I’ve been sleeping badly',
      preview: said(false, 'That sounds tiring. What does a usual evening look like?', 2200, { sender: 'Therapist' })
    }),
    personRoom('!linh:example.invalid', 'Linh', 15, {
      unreadNotifications: 2,
      unread: true,
      preview: said(false, 'Perfect. Can you book a table for four?', 15, { sender: 'Linh' })
    }),
    groupRoom('!design:example.invalid', 'Design team', 25, {
      // A mention: the strong badge, with the whole count.
      unreadNotifications: 3,
      highlights: 1,
      unread: true,
      preview: said(false, '@Minh can you check the dessert prices before Friday?', 25, { sender: 'Lan' })
    }),
    groupRoom('!family:example.invalid', 'Gia đình', 70, {
      muted: true,
      unread: true,
      preview: { own: false, sender: 'Bảo', kind: 'image', at: NOW - 70 * 60_000 }
    }),
    personRoom('!hoa:example.invalid', 'Hoa', 3 * 1440, {
      markedUnread: true,
      preview: said(false, 'See you Sunday!', 3 * 1440, { sender: 'Hoa' })
    }),
    personRoom('!quan:example.invalid', 'Quân', 26 * 60, {
      preview: said(true, 'I’ll send the draft tomorrow morning.', 26 * 60)
    }),
    personRoom('!ngoc:example.invalid', 'Ngọc', 5 * 1440, {
      preview: { own: false, sender: 'Ngọc', kind: 'deleted', at: NOW - 5 * 1440 * 60_000 }
    }),
    groupRoom('!trip:example.invalid', 'Đà Lạt trip', 6 * 1440, {
      preview: { own: true, kind: 'image', at: NOW - 6 * 1440 * 60_000 }
    }),
    {
      id: '!book-club:example.invalid',
      name: 'Book club',
      membership: 'invite',
      encrypted: true,
      lastActiveAt: NOW - 7 * 1440 * 60_000
    }
  ]

  return {
    ...ready,
    rooms,
    roomId: ASSISTANT_ROOM,
    messages: conversation,
    agents: [
      agents[0]!,
      agents[1]!,
      rosterAgent(ROSTER_ALFRED),
      // Each avatar dot: listening (live), still starting (a hollow ring), and out of protons
      // (quiet: the one shared action is in the indicator); the rest are ready (live).
      rosterAgent(ROSTER_ANALYST, {
        listening: {
          state: 'listening',
          mode: 'continuous',
          roomId: ASSISTANT_ROOM,
          expiresAt: NOW + 3_600_000,
          queued: 0
        }
      }),
      rosterAgent(ROSTER_COUNCIL, { readiness: { phase: 'starting', step: 'hermes', since: NOW } }),
      rosterAgent(ROSTER_THERAPIST, {
        readiness: { phase: 'degraded', step: 'ai', code: 'out_of_protons', since: NOW }
      })
    ]
  }
}

/** A brand-new account (golden path): no chats yet, the assistant's first message waiting,
 * the welcome gift, and the recovery key kept quietly on this Mac. */
export function firstRunSnapshot(
  readiness: NonNullable<MatrixSnapshot['readiness']>,
  room?: MatrixRoom
): MatrixSnapshot {
  return {
    ...withReadiness(readiness),
    rooms: room ? [room] : [],
    roomId: room?.id ?? null,
    agents: agents.filter(agent => agent.isDefault).map(agent => ({ ...agent, readiness })),
    ownProfile: { userId: ME.userId, displayName: 'Minh', avatarMxc: null },
    firstRunMarker: 'unseen',
    firstRunWelcome: 'open',
    firstRun: 'offer',
    firstRunOpen: true,
    petScope: 'playground',
    starterMarker: 'unseen',
    starter: { kind: 'standard', amount: 50_000_000_000 },
    security: { recovery: 'ready', storage: 'present', kept: true, custody: 'device' }
  }
}

/** The assistant's first chat, as the window creates it once the assistant is ready. */
export const FIRST_RUN_ROOM: MatrixRoom = {
  id: '!first:example.invalid',
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: 'agent-atum',
  createdAt: NOW,
  lastActiveAt: NOW,
  participants: [
    { userId: ME.userId, membership: 'join' },
    { userId: ATUM.userId, membership: 'join' }
  ]
}

/** What the person's Allow posts, and the assistant's review (sample words, never real files). */
export function firstRunReview(locale: string | undefined): { consent: string; answer: string } {
  return locale === 'vi'
    ? {
        consent: 'Được, bạn xem Desktop, Documents và Downloads của mình nhé.',
        answer:
          'Mình thấy: bạn đang chuẩn bị ra mắt **ứng dụng Sen** vào tháng 11 (Documents), và vừa xong báo cáo quý 3 với doanh thu tăng 12% (Desktop). Trong Downloads có thực đơn tháng 10 của nhà hàng.\n\nMình đã ghi nhớ vài điều để giúp bạn tốt hơn. Bạn có muốn mình soạn một trang tóm tắt kế hoạch ra mắt Sen để gửi nhóm không?'
      }
    : {
        consent: 'Sure, take a look at my Desktop, Documents and Downloads.',
        answer:
          'Here’s what I see: you’re getting the **Sen app** ready to launch in November (Documents), and you just finished a Q3 report with revenue up 12% (Desktop). Downloads has October’s restaurant menu.\n\nI’ve noted a few things so I can help better. Want me to draft a one-page summary of the Sen launch plan for your team?'
      }
}

/** A fixture app's own chat, the side panel's look-pack proof (Andy, Demoza, Orbit). */
function appChatSnapshot(handle: keyof typeof APP_CHATS): MatrixSnapshot {
  const chat = APP_CHATS[handle]

  const conversation: MatrixMessage[] = [
    message(`${chat.room}-owner`, true, 'What can you help me with?', 6, { encrypted: true }),
    person(chat.user, `${chat.room}-answer`, `Hi Minh! Open the side panel to see everything ${chat.name} can do.`, 5, {
      encrypted: true
    })
  ]

  const appRoom: MatrixRoom = {
    id: chat.room,
    name: chat.name,
    membership: 'join',
    encrypted: true,
    direct: true,
    createdAt: NOW - 3 * 86_400_000,
    lastActiveAt: NOW - 5 * 60_000,
    preview: said(false, conversation.at(-1)!.body, 5, { sender: chat.name }),
    participants: [
      { userId: ME.userId, membership: 'join' },
      { userId: chat.user, membership: 'join' }
    ]
  }

  return {
    ...ready,
    rooms: [appRoom, ...ready.rooms],
    roomId: appRoom.id,
    messages: conversation,
    members: [
      { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
      { userId: chat.user, name: chat.name, membership: 'join', canRemove: false }
    ]
  }
}

/** An app chat across two days with an unread line: the day and unread dividers on its look. */
function appDaysSnapshot(base: MatrixSnapshot): MatrixSnapshot {
  const appUser = base.members!.find(member => member.userId !== ME.userId)!.userId

  const at = (daysAgo: number, hour: number, minute: number) => {
    const date = new Date(NOW)
    date.setDate(date.getDate() - daysAgo)
    date.setHours(hour, minute, 0, 0)

    return date.getTime()
  }

  const line = (id: string, own: boolean, body: string, time: number): MatrixMessage => ({
    ...message(id, own, body, 0, own ? { encrypted: true } : { sender: appUser, encrypted: true }),
    timestamp: time
  })

  return {
    ...base,
    messages: [
      line('$days-app-hi', true, 'Hi', at(1, 22, 57)),
      line('$days-app-hello', false, 'Hello Minh! What would you like to look at today?', at(1, 22, 58)),
      line('$days-app-ask', true, 'How does my week look?', at(0, 9, 10)),
      line('$days-app-read', false, 'A steady week. One thing first:', at(0, 9, 11)),
      line('$days-app-unread', false, 'Finish what is already open before you start anything new.', at(0, 9, 12)),
      line('$days-app-more', false, 'Ask me about any day for more.', at(0, 9, 13))
    ],
    readMarkerEventId: '$days-app-read'
  }
}

export function scenarioSnapshot(scenario: PlaygroundScenario): MatrixSnapshot {
  switch (scenario) {
    case 'first-launch':

    case 'sign-in-launch':

    case 'signed-out':
      return {
        state: 'signed_out',
        identity: null,
        rooms: [],
        roomId: null,
        messages: [],
        error: null,
        domainEnabled: true
      }

    // The sign-in server ended this Mac's session (it refused the grant): the account stays
    // saved, and the compact sign-in says so over the ways in . Signing in again with the same account resumes it.
    case 'session-ended':
      return {
        state: 'signed_out',
        identity: null,
        rooms: [],
        roomId: null,
        messages: [],
        error: 'matrix_session_ended',
        // Production's sign-in server today: Google only.
        signInMethods: { email: 'unavailable' },
        domainEnabled: true
      }

    // An account record this Mac can't read (Keychain refused, a changed signature): no
    // identity to show, and the ways in would be refused while the record exists.
    case 'account-unavailable':
      return {
        state: 'error',
        identity: null,
        rooms: [],
        roomId: null,
        messages: [],
        error: 'matrix_vault_unavailable',
        domainEnabled: true
      }

    // The sign-in server's new chat token can't be saved, even in the room kept for it: the
    // chats wait for disk space and come back by themselves once a save lands.
    case 'chats-disk-full':
      return {
        state: 'error',
        identity: null,
        rooms: [],
        roomId: null,
        messages: [],
        error: 'matrix_disk_full',
        domainEnabled: true
      }

    // The same on the launch, as it happens: the account is open, its chats never were.
    case 'launch-disk-full':
      return withReadiness(
        { phase: 'starting', step: 'signed_in', since: Date.now() },
        { state: 'error', error: 'matrix_disk_full', rooms: [], roomId: null }
      )

    // The person's chat engine did not start (matrix_sdk_start_failed): main keeps the
    // account, so the launch stops with Try again instead of the sign-in screen.
    case 'launch-unreachable':
      return withReadiness(
        { phase: 'starting', step: 'signed_in', since: Date.now() },
        { state: 'error', error: 'matrix_sdk_start_failed', rooms: [], roomId: null }
      )

    case 'launch':

    case 'launch-slow':
      return launchSnapshot('signed_in', Date.now())

    case 'launch-blocked':
      return withReadiness({ phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: Date.now() })

    // The person's own chats cannot load: the one launch that still stops in front.
    case 'launch-chat-down':
      return withReadiness({ phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: Date.now() })

    case 'launch-signed-out':
      return withReadiness({ phase: 'blocked', step: 'signed_in', code: 'signed_out', since: Date.now() })

    case 'launch-runtime':
      return withReadiness({ phase: 'blocked', step: 'hermes', code: 'runtime_invalid', since: Date.now() })

    case 'launch-protons':
      return withReadiness({ phase: 'blocked', step: 'ai', code: 'out_of_protons', since: Date.now() })

    // A second Mac: the account already has a key, so the only step is entering it.
    case 'launch-recovery':
      return {
        ...ready,
        messages: [],
        readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: Date.now() },
        security: { recovery: 'idle', storage: 'present' }
      }

    // A new Mac with no key: it asks the person's other devices (device-approval.ts).
    case 'launch-approval':

    case 'launch-approval-compare':

    case 'launch-approval-mismatch':
      return {
        ...ready,
        messages: [],
        readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: Date.now() },
        security: {
          recovery: 'idle',
          storage: 'present',
          approval: {
            role: 'request',
            state:
              scenario === 'launch-approval'
                ? 'waiting'
                : scenario === 'launch-approval-compare'
                  ? 'compare'
                  : 'mismatch',
            since: Date.now(),
            deviceName: 'Atum · MacBook Pro mẫu',
            ...(scenario === 'launch-approval-compare' ? { numbers: PLAYGROUND_SAS } : {})
          }
        }
      }

    // No recovery key on the account, but an identity Atum must not replace (rare): a first Mac
    // otherwise makes its key quietly (owner-recovery.ts) and never shows this step.
    case 'launch-recovery-first':
      return {
        ...ready,
        messages: [],
        readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: Date.now() },
        security: { recovery: 'idle', storage: 'absent' }
      }

    // The rare sign-in whose Atum account step did not finish in the browser.
    case 'launch-connect':
      return {
        ...ready,
        messages: [],
        readiness: { phase: 'blocked', step: 'assistant', code: 'action_required', since: Date.now() }
      }
    case 'chat-model-picker': {
      const localModel = {
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        capability: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'] as const }
      }

      return {
        ...ready,
        assistantPath: 'server',
        localModel,
        messages: [
          ...ready.messages,
          message('$model-picker-answer', false, 'I found three quiet guesthouses that fit the nightly budget.', 1, {
            replyTo: '$q2',
            resultFor: '$q2'
          })
        ],
        displayPreferences: {
          appearance: { value: 'system', writable: true },
          textSize: { value: 100, writable: true }
        },
        agents: agents.map(agent =>
          agent.isDefault
            ? {
                ...agent,
                answering: 'cloud' as const,
                macRole: 'standby' as const,
                localModel,
                cloudModel: { offered: ['default', 'nhat-thuc'], current: 'default' },
                modelDestinations: {
                  recommended: 'nguyet-thuc' as const,
                  here: 'nguyet-thuc' as const,
                  choices: [
                    {
                      id: 'cloud',
                      kind: 'cloud' as const,
                      current: 'nguyet-thuc' as const,
                      recommended: true,
                      models: ['nguyet-thuc', 'nhat-thuc'] as const,
                      unavailable: []
                    },
                    {
                      id: 'mac:playground',
                      kind: 'mac' as const,
                      deviceName: 'Mac mini',
                      thisMac: true,
                      current: 'nguyet-thuc' as const,
                      recommended: true,
                      models: ['nguyet-thuc', 'nhat-thuc'] as const,
                      unavailable: []
                    },
                    {
                      id: 'mac:playground-away',
                      kind: 'mac' as const,
                      deviceName: 'MacBook Air',
                      thisMac: false,
                      current: 'nhat-thuc' as const,
                      recommended: false,
                      models: ['nguyet-thuc', 'nhat-thuc'] as const,
                      unavailable: []
                    }
                  ]
                }
              }
            : agent
        )
      }
    }

    // Owner 2026-11-11: the chosen ChatGPT model cannot answer (its Mac is offline). The chip
    // carries the danger glyph, the card greys ChatGPT out, and the answer the fallback gave
    // says so in one faint line. Pair with `&subscriptions=relay-offline`.
    case 'chat-plan-unavailable':

    case 'chat-plan-fell-back':

    case 'chat-google-switch': {
      // S2 variants: the plan is carried to the cloud and answers; one turn fell back, or Google
      // data moved the chat to Nguyệt Thực (pair with `&subscriptions=carried`).
      const s2 = scenario !== 'chat-plan-unavailable'

      const planOption = {
        connectionRef: 'chatgpt_plan:gpt-6.1-sol',
        source: 'chatgpt_plan' as const,
        providerLabel: 'ChatGPT',
        model: 'gpt-6.1-sol',
        modelLabel: 'GPT-6.1 Sol',
        effort: 'medium' as const,
        efforts: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[],
        available: s2
      }

      const atumOption = {
        connectionRef: 'atum:cloud',
        source: 'atum' as const,
        providerLabel: 'Atum',
        effort: 'medium' as const,
        efforts: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[],
        available: true
      }

      return {
        ...ready,
        assistantPath: 'server',
        messages:
          scenario === 'chat-google-switch'
            ? [
                ...ready.messages,
                // The host's own body is for older clients; this client draws its own quiet line.
                message('$google-switch', false, 'I’m continuing with Nguyệt Thực for your Google information.', 2, {
                  notice: true,
                  googleSwitch: { servedBy: 'nguyet-thuc' }
                }),
                message('$google-answer', false, 'Your 3pm with Linh moved to Thursday, so the afternoon is free.', 1, {
                  replyTo: '$q2',
                  resultFor: '$q2'
                }),
                // A repeat (a retry, a restart) never shows a second line.
                message('$google-switch-again', false, 'I’m continuing with Nguyệt Thực for your Google information.', 1, {
                  notice: true,
                  googleSwitch: { servedBy: 'nguyet-thuc' }
                })
              ]
            : [
                ...ready.messages,
                message('$plan-fallback-answer', false, 'I found three quiet guesthouses that fit the nightly budget.', 1, {
                  replyTo: '$q2',
                  resultFor: '$q2'
                }),
                message('$plan-fallback-notice', false, '', 1, {
                  notice: true,
                  replyTo: '$plan-fallback-answer',
                  subscriptionFallback: { plan: 'chatgpt', reason: s2 ? 'timeout' : 'offline', servedBy: 'nguyet-thuc' }
                })
              ],
        agents: agents.map(agent =>
          agent.isDefault
            ? {
                ...agent,
                answering: 'cloud' as const,
                macRole: 'standby' as const,
                cloudModel: {
                  offered: ['default', 'nhat-thuc'],
                  current: 'default',
                  subscription: {
                    source: 'chatgpt_plan' as const,
                    model: 'gpt-6.1-sol',
                    effort: 'medium' as const,
                    displayName: 'GPT-6.1 Sol'
                  },
                  subscriptionState: 'connected' as const,
                  ...(s2 ? {} : { relayPresence: 'offline' as const })
                },
                // The cloud home's current model is the chosen ChatGPT one (agent-home/2.5).
                home: {
                  lives: { kind: 'cloud' as const },
                  move: null,
                  targets: [],
                  issue: null,
                  placement: {
                    profile: 'atum.agent-home/2.5' as const,
                    moveAvailable: true,
                    current: 'cloud',
                    reachability: 'reachable' as const,
                    currentModel: planOption,
                    modelStatus: 'applied' as const,
                    destinations: [
                      {
                        id: 'cloud',
                        kind: 'cloud' as const,
                        name: '',
                        thisMac: false,
                        eligibility: 'ready' as const,
                        catalogRevision: 0,
                        models: [
                          { ...atumOption, model: 'nguyet-thuc', modelLabel: 'Nguyệt Thực 1.3' },
                          { ...atumOption, model: 'nhat-thuc', modelLabel: 'Nhật Thực 1.1' },
                          planOption
                        ]
                      }
                    ]
                  }
                }
              }
            : agent
        )
      }
    }

    case 'chat-moon-app': {
      const moonRoom: MatrixRoom = {
        id: MOON_APP_ROOM,
        name: 'Moon',
        membership: 'join',
        encrypted: true,
        direct: true,
        createdAt: NOW - 12 * 86_400_000,
        lastActiveAt: NOW - 12 * 60_000,
        preview: said(false, moonAppConversation.at(-1)!.body, 12, { sender: 'Moon' }),
        participants: [
          { userId: ME.userId, membership: 'join' },
          { userId: MOON_APP_USER, membership: 'join' }
        ]
      }

      return {
        ...ready,
        rooms: [moonRoom, ...ready.rooms],
        roomId: moonRoom.id,
        messages: moonAppConversation,
        members: [
          { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
          { userId: MOON_APP_USER, name: 'Moon', membership: 'join', canRemove: false }
        ]
      }
    }

    case 'chat-andy-app':
      return appChatSnapshot('andy')

    case 'chat-demoza-app':
      return appChatSnapshot('demoza')

    case 'chat-orbit-app':
      return appChatSnapshot('orbit')

    case 'chat-moon-days':
      return appDaysSnapshot(scenarioSnapshot('chat-moon-app'))

    case 'chat-andy-days':
      return appDaysSnapshot(appChatSnapshot('andy'))
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    // another, your assistant and an app in the group, and a 7-minute pause that starts a new run.
    case 'chat-group-runs': {
      const lan = PLAYGROUND_LAN

      return {
        ...ready,
        roomId: '!design:example.invalid',
        messages: [
          person('@linh:example.invalid', '$runs-1', 'Morning! Three things for Friday:', 62),
          person(
            '@linh:example.invalid',
            '$runs-2',
            'The new soups need one more taste test, the dessert list is down to four, and I moved the printed menus to Thursday so we can fix typos after the tasting.',
            61
          ),
          person('@linh:example.invalid', '$runs-3', 'Thoughts?', 60),
          person('@quan:example.invalid', '$runs-4', 'Thursday works.', 58),
          person('@quan:example.invalid', '$runs-5', 'Prices:\n\n```\nmenu-oct.xlsx\n```', 57),
          message('$runs-6', true, 'Looks good to me.', 50, { readBy: ['@linh:example.invalid'] }),
          message('$runs-7', false, 'I added the tasting to the shared calendar: Thursday, 3 pm.', 49),
          person(MOON_APP_USER, '$runs-8', 'Thursday is a good day for shared meals 🌙', 47),
          person(lan, '$runs-9', 'I can bring the printed menus.', 30),
          person(lan, '$runs-10', 'Done ✅\n\n---\n\nNext: the wine list', 22)
        ],
        members: [
          ...PLAYGROUND_MEMBERS['!design:example.invalid'],
          { userId: ATUM.userId, name: 'Atum', membership: 'join', canRemove: true },
          { userId: MOON_APP_USER, name: 'Moon', membership: 'join', canRemove: true }
        ]
      }
    }

    case 'chat-live':
      return {
        ...ready,
        hermes: 'running',
        hermesActivity: {
          roomId: ASSISTANT_ROOM,
          turnId: '00000000-0000-4000-8000-daf874c4b5fa',
          invocationId: 'playground-live',
          state: 'running',
          reasoning: 'Looking for quiet guesthouses near the lake, under 1.2 million a night, in mid-October.',
          tools: [
            {
              name: 'Search web',
              state: 'complete',
              summary: 'Completed',
              detail: 'guesthouse Đà Lạt Tuyền Lâm quiet'
            },
            { name: 'Read web', state: 'running', summary: 'Running', detail: 'booking listings, October prices' }
          ],
          text: 'Three that fit:\n\n1. **Hillside pines homestay**, about 950,000 a night'
        }
      }

    // The first moment of a turn: no thoughts, steps or words yet.
    case 'chat-thinking':
      return {
        ...ready,
        hermes: 'running',
        agents: agents.map(agent => (agent.isDefault ? { ...agent, hermes: 'running' as const } : agent)),
        hermesActivity: {
          roomId: ASSISTANT_ROOM,
          turnId: '00000000-0000-4000-8000-80909f49ab71',
          invocationId: 'playground-thinking',
          state: 'running',
          text: '',
          tools: []
        }
      }

    // The model's thoughts arriving, before any step or word of the answer.
    case 'chat-reasoning':
      return {
        ...ready,
        hermes: 'running',
        agents: agents.map(agent => (agent.isDefault ? { ...agent, hermes: 'running' as const } : agent)),
        hermesActivity: {
          roomId: ASSISTANT_ROOM,
          turnId: '00000000-0000-4000-8000-9ead932fdf2d',
          invocationId: 'playground-reasoning',
          state: 'running',
          reasoning: 'Quiet guesthouses near the lake, under 1.2 million a night. Mid-October is dry season, so',
          text: '',
          tools: []
        }
      }

    // Steps running before the answer, while Lan works in its own chat.
    case 'chat-working':
      return {
        ...ready,
        hermes: 'running',
        agents: agents.map(agent => ({ ...agent, hermes: 'running' as const })),
        agentTurns: [
          {
            roomId: '!moon:example.invalid',
            activity: {
              roomId: '!moon:example.invalid',
              invocationId: 'playground-moon',
              state: 'running',
              text: '',
              tools: [{ name: 'Read file', state: 'running', detail: 'retention.md' }]
            }
          }
        ],
        hermesActivity: {
          roomId: ASSISTANT_ROOM,
          turnId: '00000000-0000-4000-8000-b7cce19738df',
          invocationId: 'playground-working',
          state: 'running',
          reasoning: 'Looking for quiet guesthouses near the lake, under 1.2 million a night, in mid-October.',
          tools: [
            {
              name: 'Search web',
              state: 'complete',
              summary: 'Completed',
              detail: 'guesthouse Đà Lạt Tuyền Lâm quiet'
            },
            { name: 'Read web', state: 'running', summary: 'Running', detail: 'booking listings, October prices' }
          ],
          text: ''
        }
      }

    // Everything an answer can be made of, to look at the markdown surfaces.
    case 'chat-rich':
      return {
        ...ready,
        messages: [
          message('$r1', true, 'Can you compare the three guesthouses and give me a script to track prices?', 6),
          message(
            '$r2',
            false,
            [
              '### Three that fit',
              '',
              '| Stay | Night | Walk to the lake |',
              '| --- | --- | --- |',
              '| Hillside pines | 950,000 | 10 min |',
              '| Tuyền Lâm cabin | 1,150,000 | 2 min |',
              '| Old town loft | 780,000 | 25 min |',
              '',
              '> Prices are for **Oct 17–19**, checked this morning.',
              '',
              'Run this to watch them, with `python3 track.py`:',
              '',
              '```python',
              'import json, urllib.request',
              '',
              'def price(url: str) -> int:',
              '    with urllib.request.urlopen(url) as page:',
              "        return json.load(page)['night']",
              '```',
              '',
              'Booking pages: [Hillside pines](https://example.com/hillside) · [Tuyền Lâm cabin](https://example.com/cabin)'
            ].join('\n'),
            5,
            { replyTo: '$r1' }
          )
        ]
      }

    case 'chat-handoff':
      return moonHandoff(false)

    case 'chat-handoff-quiet':
      return moonHandoff(true)

    case 'chat-pet':
      return { ...ready, petScope: 'playground' }

    // Enough history to scroll under the floating composer, with the companion perched on it.
    case 'chat-long':
      return {
        ...ready,
        petScope: 'playground',
        messages: [3, 2, 1, 0].flatMap(round =>
          conversation.map(item => ({
            ...item,
            id: `${item.id}-${round}`,
            replyTo: item.replyTo ? `${item.replyTo}-${round}` : item.replyTo
          }))
        )
      }

    case 'chat-days': {
      const group = scenarioSnapshot('chat-group')
      const at = (daysAgo: number, hour: number, minute: number) => {
        const date = new Date(NOW)
        date.setDate(date.getDate() - daysAgo)
        date.setHours(hour, minute, 0, 0)

        return date.getTime()
      }
      const person = '@linh:example.invalid'
      const rows: MatrixMessage[] = [
        { ...message('$days-last-year', false, 'The old plan is still here.', 0, { sender: person }), timestamp: at(365, 15, 5) },
        { ...message('$days-three', false, 'Three days ago.', 0, { sender: person }), timestamp: at(3, 9, 20) },
        { ...message('$days-yesterday', true, 'Yesterday evening.', 0), timestamp: at(1, 21, 45) },
        { ...message('$days-midnight-before', false, 'Just before midnight.', 0, { sender: person }), timestamp: at(1, 23, 59) },
        { ...message('$days-midnight-after', false, 'Just after midnight.', 0, { sender: person }), timestamp: at(0, 0, 1) },
        { ...message('$days-edited-person', false, 'The corrected detail.', 0, { sender: person, edited: true, editedAt: at(0, 10, 12) }), timestamp: at(0, 10, 2) },
        { ...message('$days-forwarded', true, 'A useful message from another chat.', 0, { forwarded: true }), timestamp: at(0, 11, 30) },
        { ...message('$days-file', true, 'encrypted-notes.pdf', 0, { attachment: true, attachmentSize: 2048 }), timestamp: at(0, 12, 0) },
        { ...message('$days-agent-edit', false, 'Updated quietly by the assistant.', 0, { edited: true, editedAt: at(0, 12, 20) }), timestamp: at(0, 12, 10) }
      ]

      return {
        ...group,
        messages: rows,
        readMarkerEventId: '$days-midnight-after',
        rooms: group.rooms.map(room => room.id === group.roomId ? { ...room, unread: true, unreadNotifications: 4 } : room)
      }
    }

    case 'empty':
      return {
        ...ready,
        messages: [],
        petScope: 'playground',
        starterMarker: 'unseen',
        starter: { kind: 'founding', amount: 50_000_000_000 }
      }

    // Unread waiting elsewhere: in an older Atum chat, in Lan's chat and from Linh. Opening one
    // clears it a moment later, as the private read receipt and the server's next sync do.
    case 'chat-unread':
      return {
        ...ready,
        rooms: [
          ...rooms.map(room =>
            room.id === '!moon:example.invalid' ? { ...room, unreadNotifications: 3, lastActiveAt: NOW - 300_000 } : room
          ),
          {
            id: '!assistant-budget:example.invalid',
            name: 'Trip budget',
            membership: 'join',
            encrypted: true,
            assistant: true,
            roomType: MATRIX_ASSISTANT_ROOM_TYPE,
            agentPrincipal: 'agent-atum',
            unreadNotifications: 1,
            unread: true,
            lastActiveAt: NOW - 5_400_000,
            preview: said(false, 'Your trip comes to about 4.2 million for two, before flights.', 90, {
              sender: 'Atum'
            }),
            participants: [
              { userId: ME.userId, membership: 'join' },
              { userId: ATUM.userId, membership: 'join' }
            ]
          }
        ]
      }

    case 'chat-group':
      return {
        ...ready,
        roomId: '!design:example.invalid',
        messages: groupConversation,
        members: PLAYGROUND_MEMBERS['!design:example.invalid']
      }
    case 'team-space-private-cos':
      // The company's Chief of Staff, never the person's own assistant: its name, face, box and menu.
      return {
        ...ready,
        agentRoster: { state: 'ready', since: NOW },
        companyWorkspaceEnabled: true,
        rooms: [playgroundPrivateCosRoom(ME.userId, NOW - 3 * 60_000), ...ready.rooms],
        roomId: PLAYGROUND_PRIVATE_COS_ROOM_ID,
        messages: [
          person(TEAM_COS_USER_ID, '$private-cos-greeting',
            'Hi Minh, I’m the Chief of Staff at Atum Studio. Ask me about the board, the channels or anything the team is working on.',
            40, { encrypted: false }),
          message('$private-cos-ask', true, 'What changed on the launch board this week?', 6, { encrypted: false }),
          person(TEAM_COS_USER_ID, '$private-cos-answer',
            'Two cards moved to Done (pricing page, onboarding copy). The press kit is still waiting on design.',
            3, { encrypted: false })
        ],
        members: [
          { userId: ME.userId, name: 'Minh', membership: 'join', canRemove: false },
          { userId: TEAM_COS_USER_ID, name: 'Chief of Staff', membership: 'join', canRemove: false }
        ]
      }
    case 'team-space-threads': {
      const teamSpace: MatrixSnapshot = {
        ...ready,
        agentRoster: { state: 'ready', since: NOW },
        companyWorkspaceEnabled: true,
        companyDriveFilesEnabled: true,
        rooms: [
          {
            id: PLAYGROUND_COMPANY_ROOM_ID,
            name: 'launch',
            membership: 'join',
            encrypted: false,
            roomType: MATRIX_COMPANY_CHANNEL_TYPE,
            companyChannel: { companyId: PLAYGROUND_COMPANY_ID, channelId: PLAYGROUND_COMPANY_CHANNEL_ID },
            canInvite: true,
            unread: true,
            highlights: 1,
            lastActiveAt: NOW - 8 * 60_000,
            participants: [
              { userId: ME.userId, membership: 'join' },
              { userId: '@linh:example.invalid', membership: 'join' },
              { userId: '@quan:example.invalid', membership: 'join' },
              { userId: TEAM_COS_USER_ID, membership: 'join' }
            ]
          },
          ...ready.rooms
        ],
        roomId: PLAYGROUND_COMPANY_ROOM_ID,
        messages: teamSpaceConversation,
        members: PLAYGROUND_MEMBERS[PLAYGROUND_COMPANY_ROOM_ID],
        threads: [
          {
            root: PLAYGROUND_TEAM_SPACE_ROOT,
            replies: teamSpaceReplies,
            participantIds: [PLAYGROUND_TEAM_SPACE_ROOT.sender, ME.userId],
            replyCount: teamSpaceReplies.length,
            lastActivityAt: teamSpaceReplies.at(-1)!.timestamp,
            unread: true,
            highlights: 1,
            followed: true
          },
          {
            root: teamSpaceCosRoot,
            replies: teamSpaceCosReplies,
            participantIds: [ME.userId, TEAM_COS_USER_ID],
            replyCount: teamSpaceCosReplies.length,
            lastActivityAt: teamSpaceCosReplies.at(-1)!.timestamp,
            unread: true,
            highlights: 0,
            followed: true
          },
          {
            root: teamSpaceOtherRoot,
            replies: [],
            participantIds: [teamSpaceOtherRoot.sender],
            replyCount: 1,
            lastActivityAt: teamSpaceOtherRoot.timestamp,
            unread: false,
            highlights: 0,
            followed: false
          }
        ]
      }

      // The company's Threads inbox reads the same SDK projection, keyed by company and room.
      return {
        ...teamSpace,
        companyThreads: (teamSpace.threads ?? []).map(thread => ({
          ...thread,
          companyId: PLAYGROUND_COMPANY_ID,
          roomId: PLAYGROUND_COMPANY_ROOM_ID
        }))
      }
    }

    // Your assistant in a group: listed with the groups, asked by name from "Send to".
    case 'chat-group-assistant':
      return {
        ...ready,
        rooms: [
          {
            id: TRIP_ROOM,
            name: 'Đà Lạt trip',
            membership: 'join',
            encrypted: true,
            canInvite: true,
            lastActiveAt: NOW - 12 * 60_000,
            preview: said(false, 'Day 2 looks perfect 👌', 12, { sender: 'Atum' }),
            participants: [
              { userId: ME.userId, membership: 'join' },
              { userId: ATUM.userId, membership: 'join' }
            ]
          },
          ...ready.rooms
        ],
        roomId: TRIP_ROOM,
        messages: tripConversation,
        members: PLAYGROUND_MEMBERS[TRIP_ROOM]
      }

    case 'chat-people':
      return {
        ...ready,
        roomId: '!linh:example.invalid',
        messages: linhConversation,
        members: PLAYGROUND_MEMBERS['!linh:example.invalid'],
        typing: PLAYGROUND_TYPING['!linh:example.invalid']
      }

    // Desktop chat bubbles round 3: the agent acknowledged in a real bubble, keeps typing,
    // and its one working line sits under the typing bubble (agent-turns/1.4).
    case 'chat-bubbles-working':
      return {
        ...ready,
        hermes: 'running',
        messages: bubblesConversation,
        typing: [ATUM.userId],
        hermesActivity: {
          roomId: ASSISTANT_ROOM,
          turnId: '00000000-0000-4000-8000-3599d8cf08f9',
          invocationId: 'playground-bubbles',
          state: 'running',
          text: '',
          tools: [{ name: 'Search web', state: 'running' }]
        }
      }

    // The answer arrived: the interim remark stays as a real message, the working line is gone.
    case 'chat-bubbles-answered':
      return {
        ...ready,
        messages: [...bubblesConversation, bubblesAnswer]
      }

    // The assistant asks before it runs something, above the box the person is looking at.
    case 'chat-prompt':
      return {
        ...ready,
        hermes: 'running',
        hermesPrompts: {
          roomId: ASSISTANT_ROOM,
          prompts: [
            {
              id: 'prompt-approval',
              kind: 'approval',
              description: 'Book the Hillside pines homestay for Oct 17–19?',
              command: 'booking.confirm --stay "Hillside pines" --nights 2',
              allowOnce: true,
              deadlineAt: Date.now() + 5 * 60_000
            }
          ]
        }
      }

    case 'chat-degraded':
      return { ...ready, readiness: { phase: 'degraded', code: 'ai_unavailable', since: NOW } }

    case 'chat-setup':
      return {
        ...ready,
        assistant: undefined,
        agents: [],
        assistantSetup: 'action_required',
        roomId: '!linh:example.invalid',
        messages: []
      }

    // The chats were open when the disk filled up: they wait, and the band says why.
    case 'chat-disk-full':
      return { ...ready, state: 'error', error: 'matrix_disk_full' }

    case 'chat-unavailable':
      return {
        ...ready,
        agents: agents.map(agent =>
          agent.principal === 'agent-moon'
            ? { ...agent, readiness: { phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: NOW } }
            : agent
        )
      }

    // Moon's device on this Mac lost its keys (its store was lost to a full disk): its executor
    // is replaced here (agent-reenroll.ts), in its own chat and on its roster row.
    case 'chat-reconnecting':

    case 'chat-reconnect':
    case 'chat-withdrawn': {
      const readiness = {
        'chat-reconnecting': {
          phase: 'blocked' as const,
          step: 'assistant' as const,
          code: 'agent_reconnecting',
          since: NOW
        },
        'chat-reconnect': {
          phase: 'blocked' as const,
          step: 'assistant' as const,
          code: 'agent_reconnect_required',
          since: NOW
        },
        'chat-withdrawn': {
          phase: 'blocked' as const,
          step: 'authority' as const,
          code: 'authority_withdrawn',
          since: NOW
        }
      }[scenario]

      return {
        ...ready,
        roomId: MOON_ROOM,
        messages: [],
        agents: agents.map(agent => (agent.principal === 'agent-moon' ? { ...agent, readiness } : agent))
      }
    }

    // This Mac's own device lost its keys: a new sign-in mends it, and the kept key unlocks it.
    case 'chat-device-damaged':
      return withReadiness({ phase: 'blocked', step: 'assistant', code: 'device_replaced', since: NOW })

    // Another of the person's devices asks this one to approve it (device-approval.ts).
    case 'chat-approve-asked':

    case 'chat-approve':

    case 'chat-approve-declined':
      return {
        ...ready,
        security: {
          recovery: 'idle',
          storage: 'present',
          kept: true,
          approval: {
            role: 'approve',
            state: scenario === 'chat-approve' ? 'compare' : scenario === 'chat-approve-asked' ? 'asked' : 'declined',
            since: Date.now(),
            deviceName: 'Atum · Mac mini mẫu',
            ...(scenario === 'chat-approve'
              ? {
                  choices: [[PLAYGROUND_SAS[0], 2011, 3322], PLAYGROUND_SAS, [PLAYGROUND_SAS[0], 7488, 8190]]
                }
              : {})
          }
        }
      }

    // A reply from the phone whose quoted message this Mac couldn't read: held, and the
    // assistant says so once, as a notice (the store speaks it in the playground's language).
    case 'chat-held':
      return {
        ...ready,
        messages: [
          ...conversation,
          message('$p1', true, 'Yes, the second one.', 1, { replyTo: '$a1' }),
          message('$n1', false, matrixActionCopy.en.replyQuoteUnreadable, 1, { replyTo: '$p1', notice: true })
        ]
      }

    case 'roster':
      return rosterSnapshot()

    case 'first-run':
      return firstRunSnapshot({ phase: 'starting', step: 'signed_in', since: Date.now() })

    case 'first-run-chat':
      return firstRunSnapshot({ phase: 'ready', since: NOW }, FIRST_RUN_ROOM)

    case 'first-run-blocked':
      return { ...firstRunSnapshot({ phase: 'ready', since: NOW }, FIRST_RUN_ROOM), firstRun: 'blocked' }

    // The folders are being read and the assistant could use Google the moment it is
    // connected (the protected route served): the first message offers Google too.
    case 'first-run-google':
      return {
        ...firstRunSnapshot({ phase: 'ready', since: NOW }, FIRST_RUN_ROOM),
        googleAssistant: { state: 'connect' }
      }

    case 'first-run-skipped':
      return {
        ...firstRunSnapshot({ phase: 'ready', since: NOW }, FIRST_RUN_ROOM),
        firstRun: undefined,
        firstRunOpen: undefined,
        firstRunMarker: 'answered',
        firstRunWelcome: 'dismissed',
        googleAssistant: { state: 'connect' }
      }

    case 'first-learning':
      return {
        ...firstRunSnapshot({ phase: 'ready', since: NOW }, { ...FIRST_RUN_ROOM, dialogue: 'started' }),
        firstRun: undefined,
        firstRunOpen: undefined,
        firstRunMarker: 'answered',
        firstRunWelcome: 'done',
        firstRunProgress: {
          mail: 'done',
          calendar: 'done',
          files: 'reading',
          messages: 'done',
          browser: 'reading',
          location: 'done',
          team_spaces: 'unavailable'
        },
        googleAssistant: {
          state: 'ready',
          services: { gmail: true, send: true, calendar: true, drive: true }
        },
        messages: [
          message('$progress-1', false, 'Mình đang đọc lịch và những việc sắp tới của bạn…', 2, { interim: true }),
          message('$progress-2', false, 'Mình đã thấy vài dự án bạn đang ưu tiên. Giờ mình đang đọc các tài liệu gần đây…', 1, { interim: true }),
          message('$progress-3', false, 'Mình đang nối những điều này với các cuộc trò chuyện của bạn…', 0, { interim: true })
        ],
        hermes: 'running',
        hermesActivity: {
          roomId: FIRST_RUN_ROOM.id,
          turnId: '00000000-0000-4000-8000-33a7ad2979bb',
          invocationId: 'playground-first-learning',
          state: 'running',
          text: '',
          reasoning: '',
          tools: []
        }
      }

    case 'founder-roster':

    case 'founder-chat':

    case 'founder-profile':

    case 'founder-settings':
      return founderScenarioSnapshot(scenario, ready)

    // Quiet verification (2026-10-05): background work never shows; one indicator when the
    // person must act.
    case 'quiet-launch':
      return quietLaunch(index =>
        index % 2
          ? { phase: 'ready', since: NOW }
          : { phase: 'starting', step: index ? 'assistant' : 'hermes', since: Date.now() }
      )

    case 'quiet-needs-you':
      return quietLaunch(index =>
        index === 1
          ? { phase: 'blocked', step: 'assistant', code: 'agent_reconnect_required', since: NOW }
          : { phase: 'ready', since: NOW }
      )

    case 'quiet-two':
      return {
        ...quietLaunch(() => ({ phase: 'ready', since: NOW })),
        disk: { state: 'low', freeGb: 8.4 },
        security: {
          recovery: 'idle',
          storage: 'present',
          kept: true,
          // Asked a minute ago, while the person was at the new device: it waits in the indicator.
          approval: { role: 'approve', state: 'asked', since: Date.now() - 60_000, deviceName: 'iPhone mẫu' }
        }
      }

    case 'chat':

    default:
      return ready
  }
}

/** Six assistants, each with a chat, Atum's open; `readiness` by roster position. */
function quietLaunch(readiness: (index: number) => NonNullable<MatrixSnapshot['readiness']>): MatrixSnapshot {
  const extra: MatrixAgentView[] = ['Sun', 'Star', 'Comet', 'Tide'].map(name => ({
    principal: `agent-${name.toLowerCase()}`,
    userId: `@${name.toLowerCase()}_bot:atum.chat`,
    deviceId: `${name.toUpperCase()}MINI`,
    name,
    isDefault: false,
    ready: true,
    hermes: 'ready',
    readiness: { phase: 'ready', since: NOW },
    atumModel: true
  }))

  const all = [...agents, ...extra].map((agent, index) => ({ ...agent, readiness: readiness(index) }))

  return {
    ...ready,
    rooms: [
      ...ready.rooms,
      ...extra.map((agent, at) =>
        history(
          `!${agent.principal}:atum.chat`,
          { principal: agent.principal, userId: agent.userId, name: agent.name! },
          20 + at
        )
      )
    ],
    readiness: all[0]!.readiness,
    agents: all
  }
}
