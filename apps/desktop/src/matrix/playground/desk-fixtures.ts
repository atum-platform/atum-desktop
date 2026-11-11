import type { MatrixMessage, MatrixSnapshot } from '../../../shared/matrix'

/**
 * The agent's desk (the side panel's agent tab, plan P1) on fixture data: `?desk=free|working|
 * waiting|device` dresses the open assistant chat in that moment of Now. The assistant answers in
 * the cloud, so Stop names its question; nothing reaches a network. Pair with `?macs=three` for
 * Your devices.
 */
export const PLAYGROUND_DESK_MODES = ['free', 'working', 'waiting', 'device'] as const
export type PlaygroundDeskMode = (typeof PLAYGROUND_DESK_MODES)[number]

export function playgroundDeskMode(params: URLSearchParams): PlaygroundDeskMode | undefined {
  const value = params.get('desk')

  return (PLAYGROUND_DESK_MODES as readonly string[]).includes(value ?? '') ? (value as PlaygroundDeskMode) : undefined
}

const WORDS = {
  en: {
    ask: 'Order 40 boxes from the usual supplier on Shopee.',
    doing: 'Ordering 40 boxes on Shopee',
    steps: ['Opened Shopee, already signed in', 'Found your usual supplier', 'Filling the order form'],
    bank: 'Get last month’s invoice from my bank. It only works on my Mac.',
    macDoing: 'Getting October’s invoice from your bank',
    macSteps: ['Opened your bank in Safari', 'Found October’s statement', 'Downloading the invoice'],
    quote: 'Make the quote for Minh Long and send it.',
    question: 'Send the quote to Minh Long?',
    choices: ['Send', 'Not now'],
    plan: 'Is the Q4 plan done?',
    done: 'Done, split by month. I also moved the launch dates to December.',
  },
  vi: {
    ask: 'Đặt 40 thùng carton ở nhà cung cấp quen trên Shopee nhé.',
    doing: 'Đặt 40 thùng carton trên Shopee',
    steps: ['Mở Shopee, đã đăng nhập sẵn', 'Tìm thấy nhà cung cấp quen', 'Điền đơn đặt hàng'],
    bank: 'Lấy hoá đơn tháng trước từ ngân hàng giúp mình. Chỉ vào được trên máy Mac.',
    macDoing: 'Lấy hoá đơn tháng 10 từ ngân hàng',
    macSteps: ['Mở ngân hàng trong Safari', 'Tìm thấy sao kê tháng 10', 'Đang tải hoá đơn'],
    quote: 'Làm báo giá cho Minh Long rồi gửi luôn.',
    question: 'Gửi báo giá cho Minh Long?',
    choices: ['Gửi', 'Để sau'],
    plan: 'Kế hoạch Q4 xong chưa?',
    done: 'Xong rồi, chia theo từng tháng. Mình dời ngày ra mắt sang tháng 12 luôn.',
  }
} as const

function line(
  id: string,
  sender: string,
  body: string,
  timestamp: number,
  extra: Partial<MatrixMessage> = {}
): MatrixMessage {
  return {
    id,
    sender,
    body,
    timestamp,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...extra
  }
}

function progress(sender: string, body: string, kind: 'todo' | 'device', device?: string): MatrixMessage {
  return line('$desk-line', sender, body, Date.now() - 30_000, {
    notice: true,
    progress: {
      profile: 'atum.agent-turns/1.3',
      scope: 'owner_private',
      phase: 'working',
      kind,
      revision: 2,
      ...(device ? { device } : {})
    }
  })
}

/** The open assistant chat in that moment, with its agent answering in the cloud. */
export function withPlaygroundDesk(
  snapshot: MatrixSnapshot,
  mode: PlaygroundDeskMode | undefined,
  locale: string
): MatrixSnapshot {
  const room = snapshot.rooms.find(each => each.id === snapshot.roomId)
  const agent = snapshot.agents?.find(each => each.principal === room?.agentPrincipal)
  const owner = snapshot.identity?.userId

  if (!mode || !room?.assistant || !agent || !owner) {
    return snapshot
  }

  const words = WORDS[locale === 'vi' ? 'vi' : 'en']
  // The store decorates its own output again on every emit: replace this fixture's lines, never add twice.
  const earlier = snapshot.messages.filter(message => !message.id.startsWith('$desk-'))
  const now = Date.now()
  const own = (id: string, body: string, minutes: number) =>
    line(id, owner, body, now - minutes * 60_000, { own: true })

  const steps = (current: string, list: readonly string[]) =>
    [current, ...list.map((step, index) => (index === list.length - 1 ? `• ${step}` : `✓ ${step}`))].join('\n')

  const base: MatrixSnapshot = {
    ...snapshot,
    agents: snapshot.agents?.map(each =>
      each.principal === agent.principal ? { ...each, answering: 'cloud' as const } : each
    )
  }

  switch (mode) {
    case 'free': {
      const ask = own('$desk-plan', words.plan, 30)

      return {
        ...base,
        messages: [
          ...earlier,
          ask,
          line('$desk-plan-answer', agent.userId, words.done, now - 28 * 60_000, { replyTo: ask.id })
        ]
      }
    }

    case 'working':
      return {
        ...base,
        typing: [agent.userId],
        messages: [
          ...earlier,
          own('$desk-ask', words.ask, 4),
          progress(agent.userId, steps(words.doing, words.steps), 'todo')
        ]
      }

    case 'waiting':
      return {
        ...base,
        typing: [agent.userId],
        messages: [...earlier, own('$desk-quote', words.quote, 12)],
        agentTurns: [
          {
            roomId: room.id,
            prompts: [
              {
                id: 'desk-prompt',
                kind: 'clarify',
                question: words.question,
                choices: [...words.choices],
                deadlineAt: now + 30 * 60_000
              }
            ]
          }
        ]
      }

    case 'device':
      return {
        ...base,
        typing: [agent.userId],
        messages: [
          ...earlier,
          own('$desk-bank', words.bank, 2),
          progress(agent.userId, steps(words.macDoing, words.macSteps), 'device', 'MacBook Air')
        ]
      }
  }
}
