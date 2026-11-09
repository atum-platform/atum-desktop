import type { DesktopLocale } from '../../../shared/desktop-locale'
import type { MatrixCommand, MatrixMessage, MatrixSnapshot } from '../../../shared/matrix'
import {
  applyMatrixCheckInChange,
  applyMatrixCheckInFeedback,
  defaultMatrixCheckInSettings,
  emptyMatrixCheckInLedger,
  type MatrixCheckInNudge,
  type MatrixCheckInsState
} from '../../../shared/matrix-check-ins'

/**
 * Check-ins in the playground (dev only), switched on from the URL so the plain scenarios
 * stay as they are:
 *
 * - `?checkins=cards` — this morning's brief and a nudge from Atum in its chat;
 * - `?checkins=intro` — the one-line first mention, with the cost;
 * - `?checkins=ask` — "Keep these coming?" after five unanswered nudges;
 * - `?checkins=off` — just turned off by "stop checking in".
 *
 * Every signed-in scenario has the records, so the main assistant's card always shows the row,
 * and its controls work here.
 */
export type PlaygroundCheckInsMode = 'cards' | 'intro' | 'ask' | 'off'

export function playgroundCheckInsMode(params: URLSearchParams): PlaygroundCheckInsMode | undefined {
  const mode = params.get('checkins')

  return mode === 'cards' || mode === 'intro' || mode === 'ask' || mode === 'off' ? mode : undefined
}

const ATUM = '@atum_bot:example.invalid'
const ASSISTANT_ROOM = '!assistant:example.invalid'
const PREFIX = '$checkin-'

const nudges: Record<'en' | 'vi', { brief: MatrixCheckInNudge; nudge: MatrixCheckInNudge }> = {
  en: {
    brief: {
      kind: 'brief',
      key: 'brief-2026-10-05',
      text: "This morning: Lan's quote is due at 5 pm · the Q4 plan changed last night.",
      source: 'files',
      action: 'review'
    },
    nudge: {
      kind: 'deadline',
      key: 'quote-lan',
      text: "Lan's quote is due at 5 pm today. Want me to draft the email to her?",
      source: 'files',
      ref: 'quote-lan.md',
      action: 'draft'
    }
  },
  vi: {
    brief: {
      kind: 'brief',
      key: 'brief-2026-10-05',
      text: 'Sáng nay: báo giá cho chị Lan hết hạn lúc 17:00 · kế hoạch Q4 vừa sửa tối qua.',
      source: 'files',
      action: 'review'
    },
    nudge: {
      kind: 'deadline',
      key: 'quote-lan',
      text: 'Báo giá cho chị Lan hết hạn chiều nay lúc 17:00. Mình soạn email gửi chị nhé?',
      source: 'files',
      ref: 'bao-gia-lan.md',
      action: 'draft'
    }
  }
}

function initial(mode: PlaygroundCheckInsMode | undefined, now: number): MatrixCheckInsState {
  const settings = defaultMatrixCheckInSettings()
  const ledger = emptyMatrixCheckInLedger()

  if (mode === 'intro') {
    return { settings, feedback: { muted: [], snoozed: [], ackAt: 0 }, ledger }
  }

  if (mode === 'ask') {
    return {
      settings: { ...settings, introducedAt: now - 7 * 86_400_000 },
      feedback: { muted: [], snoozed: [], ackAt: now - 6 * 86_400_000 },
      ledger: { ...ledger, ignored: 5, lastNudgeAt: now - 3_600_000, nudges: 1 }
    }
  }

  if (mode === 'off') {
    return {
      settings: { ...settings, enabled: false, offAt: now - 60_000, offBy: 'asked', introducedAt: now - 86_400_000 },
      feedback: { muted: [], snoozed: [], ackAt: now - 60_000 },
      ledger
    }
  }

  return { settings: { ...settings, introducedAt: now - 86_400_000 }, feedback: { muted: [], snoozed: [], ackAt: 0 }, ledger }
}

export class PlaygroundCheckIns {
  private state: MatrixCheckInsState
  private listeners = new Set<() => void>()

  constructor(
    private readonly mode: PlaygroundCheckInsMode | undefined,
    private readonly locale: () => DesktopLocale | undefined
  ) {
    this.state = initial(mode, Date.now())
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  private messages(): MatrixMessage[] {
    const words = nudges[this.locale() === 'vi' ? 'vi' : 'en']
    const now = Date.now()

    const post = (id: string, nudge: MatrixCheckInNudge, minutesAgo: number): MatrixMessage => ({
      id: `${PREFIX}${id}`,
      sender: ATUM,
      body: nudge.text,
      timestamp: now - minutesAgo * 60_000,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      checkIn: nudge
    })

    return [post('brief', words.brief, 1), post('nudge', words.nudge, 0)]
  }

  /** The records on every signed-in snapshot; the posts in Atum's chat for `cards`. */
  decorate(snapshot: MatrixSnapshot): MatrixSnapshot {
    if (!snapshot.identity || snapshot.state !== 'ready') {
      return snapshot
    }

    const own = snapshot.messages.filter(message => !message.id.startsWith(PREFIX))

    return {
      ...snapshot,
      checkIns: { ...this.state, writable: true },
      messages: this.mode === 'cards' && snapshot.roomId === ASSISTANT_ROOM ? [...own, ...this.messages()] : own
    }
  }

  /** The window's check-in commands, answered here; everything else goes on. */
  wrap(command: (value: MatrixCommand) => Promise<unknown>) {
    return async (value: MatrixCommand) => {
      if (value.kind === 'checkInsChange') {
        this.state = { ...this.state, settings: applyMatrixCheckInChange(this.state.settings, value.change, Date.now()) }
      } else if (value.kind === 'checkInsFeedback') {
        this.state = { ...this.state, feedback: applyMatrixCheckInFeedback(this.state.feedback, value.feedback, Date.now()) }
      } else {
        return command(value)
      }

      this.listeners.forEach(listener => listener())

      return null
    }
  }
}
