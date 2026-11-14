import type { MatrixMessage, MatrixSnapshot } from '../../../shared/matrix'
import type {
  MatrixAgentDeskBridge,
  MatrixHostAgentControl,
  MatrixHostDeskFiles,
  MatrixHostDeskRead,
  MatrixHostDeskSchedule
} from '../../../shared/matrix-agent-desk'

/**
 * The agent's desk (the side panel's agent tab, plan r2) on fixture data: `?desk=free|working|
 * waiting|ok|routine|device` dresses the open assistant chat in that moment of Now. The assistant
 * is native Hermes in the cloud (`runtime: 'hermes'`), and every line is what its Matrix
 * presentation plugin sends: a native todo list, "Waiting for your OK…", a cron turn. Stop
 * answers from the fixture; nothing reaches a network. Pair with `?macs=three` for Your devices.
 */
export const PLAYGROUND_DESK_MODES = ['free', 'working', 'waiting', 'ok', 'routine', 'device'] as const
export type PlaygroundDeskMode = (typeof PLAYGROUND_DESK_MODES)[number]

export function playgroundDeskMode(params: URLSearchParams): PlaygroundDeskMode | undefined {
  const value = params.get('desk')

  return (PLAYGROUND_DESK_MODES as readonly string[]).includes(value ?? '') ? (value as PlaygroundDeskMode) : undefined
}

const WORDS = {
  en: {
    ask: 'Order 40 boxes from the usual supplier on Shopee.',
    steps: ['Opened Shopee, already signed in', 'Found your usual supplier', 'Filling the order form'],
    bank: 'Get last month’s invoice from my bank. It only works on my Mac.',
    macDoing: 'Getting October’s invoice from your bank',
    macSteps: ['Opened your bank in Safari', 'Found October’s statement', 'Downloading the invoice'],
    quote: 'Make the quote for Minh Long and send it.',
    question: 'Send the quote to Minh Long?',
    choices: ['Send', 'Not now'],
    plan: 'Is the Q4 plan done?',
    done: 'Done, split by month. I also moved the launch dates to December.',
    files: ['Q4 plan.docx', 'Quote Q4.xlsx'],
    clean: 'Clear out my Downloads folder on the Mac.',
    okLine: 'Waiting for your OK…',
    routineLine: 'Looking it up on the web…',
  },
  vi: {
    ask: 'Đặt 40 thùng carton ở nhà cung cấp quen trên Shopee nhé.',
    steps: ['Mở Shopee, đã đăng nhập sẵn', 'Tìm thấy nhà cung cấp quen', 'Điền đơn đặt hàng'],
    bank: 'Lấy hoá đơn tháng trước từ ngân hàng giúp mình. Chỉ vào được trên máy Mac.',
    macDoing: 'Lấy hoá đơn tháng 10 từ ngân hàng',
    macSteps: ['Mở ngân hàng trong Safari', 'Tìm thấy sao kê tháng 10', 'Đang tải hoá đơn'],
    quote: 'Làm báo giá cho Minh Long rồi gửi luôn.',
    question: 'Gửi báo giá cho Minh Long?',
    choices: ['Gửi', 'Để sau'],
    plan: 'Kế hoạch Q4 xong chưa?',
    done: 'Xong rồi, chia theo từng tháng. Mình dời ngày ra mắt sang tháng 12 luôn.',
    files: ['Kế hoạch Q4.docx', 'Báo giá Q4.xlsx'],
    clean: 'Dọn thư mục Downloads trên máy Mac giúp mình.',
    okLine: 'Đang chờ bạn đồng ý…',
    routineLine: 'Đang tra cứu trên web…',
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

function progress(
  sender: string,
  body: string,
  kind: 'todo' | 'device',
  extra: { device?: string; phase?: 'working' | 'waiting'; trigger?: 'cron'; minutes?: number } = {}
): MatrixMessage {
  return line('$desk-line', sender, body, Date.now() - (extra.minutes ?? 0.5) * 60_000, {
    notice: true,
    progress: {
      profile: 'atum.agent-turns/1.3',
      scope: 'owner_private',
      phase: extra.phase ?? 'working',
      kind,
      revision: 2,
      ...(extra.device ? { device: extra.device } : {}),
      ...(extra.trigger ? { trigger: extra.trigger } : {})
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

  // The native presentation plugin's todo list: every line marked, ✓ done and • still to do.
  const todo = (list: readonly string[]) =>
    list.map((step, index) => (index === list.length - 1 ? `• ${step}` : `✓ ${step}`)).join('\n')

  const base: MatrixSnapshot = {
    ...snapshot,
    agents: snapshot.agents?.map(each =>
      each.principal === agent.principal
        ? {
            ...each,
            answering: 'cloud' as const,
            runtime: 'hermes' as const,
            modelDestinations: each.modelDestinations ?? {
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
                }
              ]
            }
          }
        : each
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
          line('$desk-plan-answer', agent.userId, words.done, now - 28 * 60_000, { replyTo: ask.id }),
          ...words.files.map((name, index) =>
            line(`$desk-file-${index}`, agent.userId, name, now - (27 - index) * 60_000, {
              attachment: true,
              attachmentSize: [48_200, 21_700][index]
            })
          )
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
          progress(agent.userId, todo(words.steps), 'todo')
        ]
      }

    case 'ok':
      return {
        ...base,
        typing: [agent.userId],
        messages: [
          ...earlier,
          own('$desk-clean', words.clean, 3),
          progress(agent.userId, words.okLine, 'device', { phase: 'waiting' })
        ]
      }

    case 'routine':
      return {
        ...base,
        messages: [...earlier, progress(agent.userId, words.routineLine, 'todo', { trigger: 'cron', minutes: 2 })]
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
          progress(agent.userId, `${words.macDoing}\n${todo(words.macSteps)}`, 'device', { device: 'MacBook Air' })
        ]
      }
  }
}

/** The host desk route on fixture data: its own files (home, one folder) and its routines. */
export function playgroundAgentDesk(locale: string): MatrixAgentDeskBridge {
  const vi = locale === 'vi'
  const day = 86_400_000
  const now = Date.now()

  const files: Record<string, MatrixHostDeskFiles> = {
    home: {
      read: 'files',
      root: 'home',
      path: '',
      rows: [
        { name: vi ? 'Báo cáo' : 'Reports', kind: 'folder', size: 0, modifiedAt: now - day },
        { name: vi ? 'ghi-chu-nha-cung-cap.md' : 'supplier-notes.md', kind: 'file', size: 3_400, modifiedAt: now - 2 * day },
        { name: 'shopee-orders.csv', kind: 'file', size: 12_800, modifiedAt: now - 3 * day }
      ],
      truncated: false
    }
  }

  const schedule: MatrixHostDeskSchedule = {
    read: 'schedule',
    observedAt: now,
    jobs: [
      {
        id: 'brief', name: vi ? 'Bản tin buổi sáng' : 'Morning brief', kind: 'cron', display: 'Every day at 08:00',
        timezone: 'Asia/Ho_Chi_Minh', state: 'scheduled', nextRunAt: new Date(now + day / 2).toISOString(),
        lastRunAt: null, lastStatus: null, expr: '0 8 * * *', minutes: null, runAt: null, pausedReason: null
      },
      {
        id: 'sweep', name: vi ? 'Kiểm tra việc còn dở' : 'Follow-up sweep', kind: 'cron', display: 'every 2h',
        timezone: 'Asia/Ho_Chi_Minh', state: 'paused', nextRunAt: null, lastRunAt: null, lastStatus: null,
        expr: '0 */2 * * *', minutes: null, runAt: null, pausedReason: 'owner_pause'
      }
    ],
    truncated: false
  }

  return {
    // Every control is accepted, as the host would with a running agent.
    control: async (_principal: string, request: MatrixHostAgentControl) => ({ action: request.action, changed: 1 }),
    read: (async (_principal: string, request: MatrixHostDeskRead) => {
      if (request.read === 'schedule') {
        return schedule
      }

      if (request.read === 'files') {
        return request.path ? { ...files.home!, path: request.path.split('/').slice(1).join('/'), rows: [] } : files.home
      }

      throw new Error('playground_desk_unavailable')
    }) as MatrixAgentDeskBridge['read']
  }
}
