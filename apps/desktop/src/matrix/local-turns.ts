import type { MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'

export interface MatrixTranscriptEntry {
  message: MatrixMessage
  /** Present for a local turn's question or answer, which renders its state and actions. */
  local?: { view: MatrixLocalTurnView; role: 'question' | 'answer' }
}

/**
 * The transcript: the room timeline with this Mac's local turns merged in (plan
 * 2026-09-26-reliable-local-first-chat §5). A local turn shows at once, before any network
 * activity completes; its room events (question, answer) are hidden while main still
 * lists the turn, so nothing shows twice. Once both events are in the room main drops the
 * turn and the room events show on their own.
 */
export function mergeLocalTurns(
  messages: readonly MatrixMessage[],
  turns: readonly MatrixLocalTurnView[] | undefined,
  people: { human?: string; assistant?: string }
): MatrixTranscriptEntry[] {
  const shown = new Map((turns ?? []).map(turn => [turn.turnId, turn]))

  const entries: MatrixTranscriptEntry[] = messages
    .filter(message => !message.turn || !shown.has(message.turn))
    .map(message => ({ message }))

  for (const view of shown.values()) {
    entries.push({
      message: {
        id: `local-q-${view.turnId}`,
        sender: people.human ?? '',
        body: view.text,
        timestamp: view.createdAt,
        own: true,
        encrypted: true,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false,
        turn: view.turnId
      },
      local: { view, role: 'question' }
    })

    if (view.answer) {
      entries.push({
        message: {
          id: `local-a-${view.turnId}`,
          sender: people.assistant ?? '',
          body: view.answer,
          // Just after its question, whatever the clocks say.
          timestamp: view.createdAt + 1,
          own: false,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false,
          turn: view.turnId
        },
        local: { view, role: 'answer' }
      })
    }
  }

  // Stable: room order is kept, local entries slot in by time.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.message.timestamp - b.entry.message.timestamp || a.index - b.index)
    .map(({ entry }) => entry)
}

/** The copy keys a turn's status reads (`t.matrixShell`). */
export interface MatrixTurnCopy {
  turnNotSent: string
  turnInterrupted: string
  turnHomeQuiet: string
  readinessOffline: string
  readinessAiUnavailable: string
  readinessOutOfProtons: string
}

/**
 * What a local turn says under its question: only a failure the person can act on (not sent,
 * interrupted, out of Protons, or a quiet other Mac to answer for), never progress. While the
 * agent works the chat shows it typing instead (`matrixAgentTyping`), as any messaging app does.
 */
export function matrixTurnStatus(
  view: MatrixLocalTurnView,
  role: 'question' | 'answer',
  copy: MatrixTurnCopy
): { text: string; tone: 'notice'; action?: 'retry' | 'top_up' | 'answer_here' } | null {
  if (role === 'answer') {
    return null
  }

  switch (view.state) {
    case 'not_sent':
      return { text: copy.turnNotSent, tone: 'notice', action: 'retry' }

    case 'interrupted':
      return view.notice === 'offline'
        ? { text: copy.readinessOffline, tone: 'notice', action: 'retry' }
        : view.notice === 'ai_unavailable'
          ? { text: copy.readinessAiUnavailable, tone: 'notice', action: 'retry' }
          : view.notice === 'out_of_protons'
            ? { text: copy.readinessOutOfProtons, tone: 'notice', action: 'top_up' }
            : { text: copy.turnInterrupted, tone: 'notice', action: 'retry' }

    // The other Mac had its bounded time without an answer: offer to answer right away (it runs
    // here under a platform grant, never twice). The cloud, after its longer time, only says
    // there is no reply yet (this Mac never runs it). Where an assistant answers is never named.
    case 'handed_off':
      return view.notice !== 'home_quiet'
        ? null
        : view.route === 'cloud'
          ? { text: copy.turnHomeQuiet, tone: 'notice' }
          : { text: copy.turnHomeQuiet, tone: 'notice', action: 'answer_here' }

    default:
      return null
  }
}

/** A turn the agent is still working on: its question is in, its answer is not. */
const WORKING: ReadonlySet<MatrixLocalTurnView['state']> = new Set(['waiting', 'running', 'handed_off'])

/**
 * Whether the agent of this chat is typing, as the chat shows it: its own standard typing
 * notification (`m.typing`, from whichever device or cloud runs it), or, until that arrives, a
 * turn of this room still being answered (this Mac knows it is working on your message). A turn
 * this Mac can no longer move (the other Mac went quiet) types nothing: its line says so.
 */
export function matrixAgentTyping(input: {
  roomId: string
  agentId?: string
  typing?: readonly string[]
  turns?: readonly MatrixLocalTurnView[]
  running?: boolean
}): boolean {
  return Boolean(
    input.running ||
    (input.agentId && input.typing?.includes(input.agentId)) ||
    input.turns?.some(
      turn => turn.roomId === input.roomId && WORKING.has(turn.state) && !turn.answer && turn.notice !== 'home_quiet'
    )
  )
}
