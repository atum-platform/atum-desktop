import type { MatrixMessage, MatrixSnapshot } from '../../../shared/matrix'
import type { WorkRelayTurnChrome } from '../../../shared/matrix-work-relay'

/**
 * Relay R1 (lane U1) in the open chat, one state at a time (`?relay=<state>`): a short exchange whose messages carry the line the
 * relay view-model gives them (`MatrixMessage.relayTurn`). Synthetic words, as on a phone screenshot. Dev only.
 */
export const PLAYGROUND_RELAY_STATES = [
  'plan',
  'fallback-mac',
  'fallback-consent',
  'fallback-switch',
  'fallback-limit',
  'waiting',
  'needs-ok',
  'limit',
  'stopping',
  'stopped',
  'queued',
  'late',
  'empty',
  'failed'
] as const
export type PlaygroundRelayState = (typeof PLAYGROUND_RELAY_STATES)[number]

export function playgroundRelayMode(params: URLSearchParams): PlaygroundRelayState | null {
  const value = params.get('relay')

  return (PLAYGROUND_RELAY_STATES as readonly string[]).includes(value ?? '') ? (value as PlaygroundRelayState) : null
}

const ASK = 'What’s in my Assistants folder?'
const ANSWER = 'Three folders: Notes, Drafts and Invoices. Drafts has the reply to Linh from yesterday.'

interface Line {
  own: boolean
  body: string
  turn?: WorkRelayTurnChrome
}

function exchange(state: PlaygroundRelayState, now: number): Line[] {
  const fallback = (reason: 'mac_off' | 'consent_off' | 'switch_off' | 'limit'): Line[] => [
    { own: true, body: ASK },
    { own: false, body: ANSWER, turn: { kind: 'fallback', at: 'reply', reason } }
  ]

  switch (state) {
    case 'plan':
      return [
        { own: true, body: ASK },
        { own: false, body: ANSWER }
      ]

    case 'fallback-mac':
      return fallback('mac_off')

    case 'fallback-consent':
      return fallback('consent_off')

    case 'fallback-switch':
      return fallback('switch_off')

    case 'fallback-limit':
      return fallback('limit')

    case 'waiting':
      return [{ own: true, body: 'Tidy the Drafts folder and tell me what you moved.', turn: { kind: 'waiting', at: 'message', action: 'stop' } }]

    case 'needs-ok':
      return [{ own: true, body: 'Rename the invoices by month.', turn: { kind: 'needs_ok', at: 'message', action: 'stop' } }]

    case 'limit':
      return [
        {
          own: true,
          body: 'Go through last week’s notes and pull out the to-dos.',
          turn: { kind: 'limit', at: 'message', action: 'stop', resetsAt: now + 95 * 60_000 }
        }
      ]

    case 'stopping':
      return [{ own: true, body: 'Rename the invoices by month.', turn: { kind: 'stopping', at: 'message' } }]

    case 'stopped':
      return [{ own: true, body: 'Rename the invoices by month.', turn: { kind: 'stopped', at: 'message' } }]

    case 'queued':
      return [
        { own: true, body: 'Rename the invoices by month.', turn: { kind: 'needs_ok', at: 'message', action: 'stop' } },
        { own: true, body: 'And then send me the list.', turn: { kind: 'queued', at: 'message' } }
      ]

    case 'late':
      return [
        { own: true, body: 'Tidy the Drafts folder and tell me what you moved.' },
        {
          own: false,
          body: 'Done. I moved four old drafts into Drafts/Archive and kept the reply to Linh where it was.',
          turn: { kind: 'late', at: 'reply', finishedAt: now - 2 * 60_000 }
        }
      ]

    case 'empty':
      return [{ own: true, body: 'Check the Notes folder for anything due today.', turn: { kind: 'empty', at: 'message' } }]

    case 'failed':
      return [{ own: true, body: 'Check the Notes folder for anything due today.', turn: { kind: 'failed', at: 'message' } }]
  }
}

export function withPlaygroundRelay(snapshot: MatrixSnapshot, state: PlaygroundRelayState | null): MatrixSnapshot {
  const me = snapshot.identity?.userId

  if (!state || !snapshot.roomId || !me || snapshot.messages.some(message => message.id.startsWith('$relay-'))) {
    return snapshot
  }

  const other = snapshot.messages.find(message => !message.own && !message.notice)?.sender ?? '@atum:example.invalid'
  const now = Date.now()
  const lines = exchange(state, now)

  const added = lines.map(
    (line, index): MatrixMessage => ({
      id: `$relay-${index}`,
      sender: line.own ? me : other,
      body: line.body,
      timestamp: now - (lines.length - index) * 60_000,
      own: line.own,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      ...(line.own ? {} : { replyTo: '$relay-0', resultFor: '$relay-0' }),
      ...(line.turn ? { relayTurn: line.turn } : {})
    })
  )

  return { ...snapshot, messages: [...snapshot.messages, ...added] }
}
