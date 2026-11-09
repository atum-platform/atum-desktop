import { atom } from 'nanostores'

import type { MatrixMessage } from '../../shared/matrix'

import type { MatrixTranscriptEntry } from './local-turns'

/**
 * Your message, on screen the moment you press Send (the local echo every messaging app
 * draws): a pending bubble in this window until the real one (a local turn or the room's own
 * event) arrives and takes its place. Display only: nothing here is stored or sent.
 */
export interface MatrixOutgoingEcho {
  id: string
  roomId: string
  body: string
  createdAt: number
  failed: boolean
  /** The message this one answers: its quote shows at once, so nothing jumps when the real one lands. */
  replyTo?: string
  mentions?: MatrixMessage['mentions']
  /** Learned once the send returns: the local turn or room event that stands in for it. */
  turnId?: string
  eventId?: string
}

export const $outgoingEchoes = atom<readonly MatrixOutgoingEcho[]>([])

/** An echo whose real message never showed is let go this long after its send returned. */
const SETTLED_ECHO_MS = 15_000
/** Clocks of this window, main and the Matrix window are one clock; this absorbs rounding. */
const ECHO_SKEW_MS = 250

let sequence = 0

export function addOutgoingEcho(
  roomId: string,
  body: string,
  { mentions, replyTo, now = Date.now() }: { mentions?: MatrixMessage['mentions']; replyTo?: string; now?: number } = {}
): string {
  sequence += 1
  const id = `echo-${now.toString(36)}-${sequence}`
  $outgoingEchoes.set([
    ...$outgoingEchoes.get(),
    {
      id,
      roomId,
      body,
      createdAt: now,
      failed: false,
      ...(replyTo ? { replyTo } : {}),
      ...(mentions ? { mentions } : {})
    }
  ])

  return id
}

/** The send returned: remember what stands in for the echo, and let it go if that never shows. */
export function settleOutgoingEcho(id: string, found: { turnId?: string; eventId?: string } = {}) {
  update(id, echo => ({ ...echo, ...found }))
  setTimeout(() => dropOutgoingEchoes([id]), SETTLED_ECHO_MS)
}

/** The send failed and nothing else shows the message: it stays, marked not sent. */
export function failOutgoingEcho(id: string) {
  update(id, echo => ({ ...echo, failed: true }))
}

export function dropOutgoingEchoes(ids: readonly string[]) {
  if (!ids.length) {
    return
  }

  const gone = new Set(ids)
  const current = $outgoingEchoes.get()
  const next = current.filter(echo => !gone.has(echo.id))

  if (next.length !== current.length) {
    $outgoingEchoes.set(next)
  }
}

function update(id: string, change: (echo: MatrixOutgoingEcho) => MatrixOutgoingEcho) {
  $outgoingEchoes.set($outgoingEchoes.get().map(echo => (echo.id === id ? change(echo) : echo)))
}

/**
 * The transcript with this room's echoes: an echo gives way to the first own message that is
 * its send (the same local turn or event once known, else the same words sent no earlier than
 * it), so nothing shows twice. `matched` lists the echoes that gave way, to be dropped.
 */
export function mergeOutgoingEchoes(
  entries: readonly MatrixTranscriptEntry[],
  echoes: readonly MatrixOutgoingEcho[],
  roomId: string,
  sender: string
): { entries: MatrixTranscriptEntry[]; matched: string[] } {
  const claimed = new Set<string>()
  const matched = new Set<string>()
  const shown: MatrixTranscriptEntry[] = []
  const here = echoes.filter(echo => echo.roomId === roomId)

  const claim = (echo: MatrixOutgoingEcho, fits: (message: MatrixMessage) => boolean) => {
    const real = entries.find(({ message }) => message.own && !claimed.has(message.id) && fits(message))

    if (real) {
      claimed.add(real.message.id)
      matched.add(echo.id)
    }
  }

  // Exact matches first (the echo's own local turn or event), so a same-words echo can never
  // take another send's message. Then, for echoes still waiting, the same words sent no earlier
  // than them; a failed echo never matches by words: its send is known not to have gone out, so
  // an identical later send must not take its place (and its Retry).
  for (const echo of here) {
    claim(
      echo,
      message =>
        (echo.turnId !== undefined && message.turn === echo.turnId) ||
        (echo.eventId !== undefined && message.id === echo.eventId)
    )
  }

  for (const echo of here) {
    if (!matched.has(echo.id) && !echo.failed) {
      claim(echo, message => message.body === echo.body && message.timestamp >= echo.createdAt - ECHO_SKEW_MS)
    }
  }

  for (const echo of here) {
    if (matched.has(echo.id)) {
      continue
    }

    const message: MatrixMessage = {
      id: echo.id,
      sender,
      body: echo.body,
      timestamp: echo.createdAt,
      own: true,
      encrypted: true,
      decryptionFailed: false,
      pending: !echo.failed,
      failed: echo.failed,
      attachment: false,
      ...(echo.replyTo ? { replyTo: echo.replyTo } : {}),
      ...(echo.mentions ? { mentions: echo.mentions } : {})
    }

    shown.push({ message })
  }

  return { entries: shown.length ? [...entries, ...shown] : [...entries], matched: [...matched] }
}

export function isOutgoingEcho(messageId: string): boolean {
  return messageId.startsWith('echo-')
}
