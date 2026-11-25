import type { WorkRelayFallbackReason, WorkRelayPlan } from '../../../shared/matrix-work-relay'

import type { WorkRelayChip, WorkRelayFix, WorkRelayGreyed, WorkRelayTurnChrome, WorkRelayUsage } from './relay-view'

/**
 * The relay's words (relay slice R1, lane U1). One line, plain words, never a cost, a balance, a relay or a token. English and
 * Vietnamese, as Work's own copy; other languages read English until they are written. `plan` is the plan's product name
 * ("ChatGPT"), `model` the Atum model that answered instead ("Nguyệt Thực").
 */
export interface WorkRelayWords {
  /** The picker note under a plan's greyed rows, and its one action. */
  greyed: Record<WorkRelayGreyed, (plan: string) => string>
  fix: Record<WorkRelayFix, string>
  /** Under a reply the Atum model gave instead (O4): who answered, then why, in a few words. */
  fallback(model: string, why: string): string
  fallbackWhy: Record<WorkRelayFallbackReason, (plan: string) => string>
  waiting: string
  needsOk: string
  limitHeld(plan: string, at?: string): string
  stopping: string
  stopped: string
  queued: string
  late(at: string): string
  empty: string
  failed: string
  stop: string
  openWork: string
  /** The composer chip's warning (red glyph + this tooltip) while the selected plan cannot answer. */
  chipLimit(plan: string, at?: string): string
  chipGreyed: Record<WorkRelayGreyed, (plan: string) => string>
  /** The plan's usage line in Settings. Never blocking, never a cost. */
  usageUsed(percent: number, at?: string): string
  usageLimit(at?: string): string
  usageScheduled(runs: number): string
  usageUnknown: string
  /** O14: one line in Work for the assistants whose chat runs in a thread there. */
  sharedContext(names: readonly string[]): string
  /** The consent sheet when the plan also answers the assistants' chats (§6). */
  consentChatsLine: string
  consentScheduled: string
}

const en: WorkRelayWords = {
  greyed: {
    unavailable: () => 'Plan unavailable. Connect this Mac to Atum Work.',
    connect: () => 'Not connected on any of your Macs',
    allow: () => 'Not allowed for this assistant yet',
    google: () => 'Not yet for assistants that use Google',
    encrypted: () => 'Not for encrypted chats'
  },
  fix: { connect: 'Connect', allow: 'Allow' },
  fallback: (model, why) => `${model} answered · ${why}`,
  fallbackWhy: {
    mac_off: () => 'your Mac was off',
    consent_off: plan => `${plan} wasn’t allowed`,
    switch_off: plan => `${plan} is off on your Mac`,
    limit: plan => `${plan} limit reached`,
    other: plan => `${plan} couldn’t answer`
  },
  waiting: 'Waiting for your Mac',
  needsOk: 'Needs your OK on your Mac',
  limitHeld: (plan, at) => (at ? `${plan} limit reached · continues at ${at}` : `${plan} limit reached · continues when it resets`),
  stopping: 'Stopping…',
  stopped: 'Stopped',
  queued: 'Waiting for the reply above',
  late: at => `Finished on your Mac at ${at}`,
  empty: 'Finished on your Mac · no answer',
  failed: 'Didn’t finish on your Mac',
  stop: 'Stop',
  openWork: 'Open Work',
  chipLimit: (plan, at) => (at ? `${plan} limit reached · back at ${at}` : `${plan} limit reached`),
  chipGreyed: {
    unavailable: plan => `${plan} unavailable`,
    connect: plan => `${plan} isn’t connected on any of your Macs`,
    allow: plan => `${plan} isn’t allowed for this assistant`,
    google: plan => `${plan} isn’t available yet for assistants that use Google`,
    encrypted: plan => `${plan} isn’t available in encrypted chats`
  },
  usageUsed: (percent, at) => (at ? `${percent}% used · resets ${at}` : `${percent}% used`),
  usageLimit: at => (at ? `Limit reached · resets ${at}` : 'Limit reached'),
  usageScheduled: runs => `${runs} scheduled runs`,
  usageUnknown: 'Usage not reported',
  sharedContext: names =>
    names.length === 1
      ? `What you type in ${names[0]}’s chat here can show up in its replies.`
      : 'What you type in your assistants’ chats here can show up in their replies.',
  consentChatsLine: 'Your chats with them run on your Mac with this plan. Stop it anytime.',
  consentScheduled: 'Also for scheduled work'
}

const vi: WorkRelayWords = {
  greyed: {
    unavailable: () => 'Gói chưa khả dụng. Hãy kết nối máy Mac này với Atum Work.',
    connect: () => 'Chưa kết nối trên máy Mac nào',
    allow: () => 'Chưa cho phép trợ lý này',
    google: () => 'Chưa dùng được cho trợ lý có Google',
    encrypted: () => 'Không dùng cho cuộc trò chuyện mã hoá'
  },
  fix: { connect: 'Kết nối', allow: 'Cho phép' },
  fallback: (model, why) => `${model} trả lời · ${why}`,
  fallbackWhy: {
    mac_off: () => 'máy Mac của bạn đang tắt',
    consent_off: plan => `${plan} chưa được cho phép`,
    switch_off: plan => `${plan} đang tắt trên máy Mac`,
    limit: plan => `${plan} hết lượt dùng`,
    other: plan => `${plan} chưa trả lời được`
  },
  waiting: 'Đang chờ máy Mac của bạn',
  needsOk: 'Cần bạn đồng ý trên máy Mac',
  limitHeld: (plan, at) => (at ? `${plan} hết lượt · tiếp tục lúc ${at}` : `${plan} hết lượt · tiếp tục khi có lượt lại`),
  stopping: 'Đang dừng…',
  stopped: 'Đã dừng',
  queued: 'Chờ câu trả lời phía trên',
  late: at => `Xong trên máy Mac lúc ${at}`,
  empty: 'Đã xong trên máy Mac · không có câu trả lời',
  failed: 'Chưa xong trên máy Mac',
  stop: 'Dừng',
  openWork: 'Mở Work',
  chipLimit: (plan, at) => (at ? `${plan} hết lượt · có lại lúc ${at}` : `${plan} hết lượt`),
  chipGreyed: {
    unavailable: plan => `${plan} chưa khả dụng`,
    connect: plan => `${plan} chưa kết nối trên máy Mac nào`,
    allow: plan => `${plan} chưa được cho phép với trợ lý này`,
    google: plan => `${plan} chưa dùng được cho trợ lý có Google`,
    encrypted: plan => `${plan} không dùng trong cuộc trò chuyện mã hoá`
  },
  usageUsed: (percent, at) => (at ? `Đã dùng ${percent}% · làm mới ${at}` : `Đã dùng ${percent}%`),
  usageLimit: at => (at ? `Hết lượt · làm mới ${at}` : 'Hết lượt'),
  usageScheduled: runs => `${runs} lượt chạy theo lịch`,
  usageUnknown: 'Chưa có số liệu sử dụng',
  sharedContext: names =>
    names.length === 1
      ? `Những gì bạn nhập vào cuộc trò chuyện của ${names[0]} ở đây có thể xuất hiện trong câu trả lời của trợ lý.`
      : 'Những gì bạn nhập vào cuộc trò chuyện của các trợ lý ở đây có thể xuất hiện trong câu trả lời của họ.',
  consentChatsLine: 'Cuộc trò chuyện của bạn với họ chạy trên máy Mac bằng gói này. Dừng bất cứ lúc nào.',
  consentScheduled: 'Cả việc theo lịch'
}

export function workRelayCopy(locale: string): WorkRelayWords {
  return locale === 'vi' ? vi : en
}

/** The plan's product name. Never translated. */
export const WORK_RELAY_PLAN_NAMES: Record<WorkRelayPlan, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  antigravity: 'Antigravity'
}

/** A time the owner reads: the clock today, the weekday and clock within a week, else the date. */
export function workRelayTime(at: number, now: number, locale: string): string {
  const tag = locale === 'vi' ? 'vi-VN' : 'en'
  const day = 86_400_000
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()

  if (sameDay) {
    return new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' }).format(at)
  }

  if (Math.abs(at - now) < 6 * day) {
    return new Intl.DateTimeFormat(tag, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at)
  }

  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' }).format(at)
}

export interface WorkRelayLineText {
  text: string
  action?: { kind: 'stop' | 'open_work'; label: string }
}

/** The words of one turn's chrome, or null for `none`. */
export function workRelayTurnText(
  chrome: WorkRelayTurnChrome,
  context: { words: WorkRelayWords; plan: string; model: string; now: number; locale: string }
): WorkRelayLineText | null {
  const { words, plan, model, now, locale } = context
  const at = (time: number) => workRelayTime(time, now, locale)
  const action = (kind: 'stop' | 'open_work') => ({ kind, label: kind === 'stop' ? words.stop : words.openWork })

  switch (chrome.kind) {
    case 'none':
      return null

    case 'fallback':
      return { text: words.fallback(model, words.fallbackWhy[chrome.reason](plan)) }

    case 'waiting':
      return { text: words.waiting, action: action(chrome.action) }

    case 'needs_ok':
      return { text: words.needsOk, action: action(chrome.action) }

    case 'limit':
      return {
        text: words.limitHeld(plan, chrome.resetsAt !== undefined ? at(chrome.resetsAt) : undefined),
        action: action(chrome.action)
      }

    case 'stopping':
      return { text: words.stopping }

    case 'stopped':
      return { text: words.stopped }

    case 'queued':
      return { text: words.queued }

    case 'late':
      return { text: words.late(at(chrome.finishedAt)) }

    case 'empty':
      return { text: words.empty }

    case 'failed':
      return { text: words.failed }
  }
}

/** The composer chip's warning, or undefined while the plan can answer. */
export function workRelayChipText(
  chip: WorkRelayChip | undefined,
  context: { words: WorkRelayWords; plan: string; model: string; now: number; locale: string }
): string | undefined {
  const { words, plan, model, now, locale } = context

  if (!chip) {
    return undefined
  }

  switch (chip.kind) {
    case 'greyed':
      return words.chipGreyed[chip.greyed](plan)

    case 'limit':
      return words.chipLimit(plan, chip.resetsAt !== undefined ? workRelayTime(chip.resetsAt, now, locale) : undefined)

    case 'fallback':
      return words.fallback(model, words.fallbackWhy[chip.reason](plan))
  }
}

export function workRelayUsageText(usage: WorkRelayUsage, context: { words: WorkRelayWords; now: number; locale: string }): string {
  const { words, now, locale } = context

  const at = (time: number | undefined) => {
    if (time === undefined) {return undefined}

    if (Math.abs(time - now) < 6 * 86_400_000) {return workRelayTime(time, now, locale)}

    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time)
  }

  switch (usage.kind) {
    case 'used':
      return words.usageUsed(usage.percent, at(usage.resetsAt))

    case 'limit':
      return words.usageLimit(at(usage.resetsAt))

    case 'unknown':
      return words.usageUnknown
  }
}
