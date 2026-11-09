import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import type { SurfaceCaptureIntent } from './surface-capture'

interface PendingTurn {
  intent?: SurfaceCaptureIntent
  profile: string
  sessionId: string
  submissionId: string
  ownerKey: string
  epoch: number
}

interface AuthorizedTurn {
  bindingId?: string
  mode?: SurfaceCaptureIntent['mode']
  profile: string
  sessionId: string
  ownerKey: string
  epoch: number
}

const pending = new Map<string, PendingTurn[]>()
const turns = new Map<string, AuthorizedTurn>()
const keyFor = (profile: string, sessionId: string, turnId: string) => `${profile}\0${sessionId}\0${turnId}`
const settled = new Set<string>()

/** Records submit-time authority until the gateway gives that submission a turn id. */
export function recordPendingWordTurn(profile: string, sessionId: string, submissionId: string, intent?: SurfaceCaptureIntent): void {
  if (!profile || !sessionId || !submissionId) {return}
  const queue = pending.get(sessionId) ?? []

  const next = [...queue.filter(item => item.submissionId !== submissionId), { profile, sessionId, submissionId, intent,
    ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get() }]

  pending.set(sessionId, next.slice(-8))
}

/** message.start is the only authority that turns a submitted intent into a live turn. */
export function startWordTurn(profile: string, sessionId: string, turnId: string, submissionId?: string): void {
  if (!profile || !sessionId || !turnId) {return}

  const key = keyFor(profile, sessionId, turnId)

  if (turns.has(key) || settled.has(key)) {return}
  const queue = pending.get(sessionId) ?? []
  const index = queue.findIndex(item => item.profile === profile && item.submissionId === submissionId)
  const pendingTurn = index < 0 ? undefined : queue[index]

  if (index >= 0) {
    queue.splice(index, 1)

    if (queue.length) {pending.set(sessionId, queue)} else {pending.delete(sessionId)}
  }

  // Match the exact server-acknowledged submission, never FIFO: autonomous or
  // replayed message.start events must not consume another pending send.
  // Explicit Send without document (or Removed) has no binding, and an
  // unknown gateway turn must fail closed instead of borrowing current UI state.
  turns.set(key, {
    profile,
    sessionId,
    ownerKey: pendingTurn?.ownerKey ?? '',
    epoch: pendingTurn?.epoch ?? -1,
    ...(pendingTurn?.intent ? { mode: pendingTurn.intent.mode } : {}),
    ...(pendingTurn?.intent?.wordBindingId ? { bindingId: pendingTurn.intent.wordBindingId } : {})
  })

  // Missing settle events must not retain authority forever. Eviction only
  // revokes access; it can never grant an old turn the current document.
  if (turns.size > 128) {turns.delete(turns.keys().next().value!)}
}

export function discardPendingWordTurn(sessionId: string, submissionId: string): void {
  const queue = pending.get(sessionId)

  if (!queue) {return}
  const next = queue.filter(item => item.submissionId !== submissionId)

  if (next.length) {pending.set(sessionId, next)} else {pending.delete(sessionId)}
}

/** The authenticated open_preview flow may establish an Automatic turn's first pair. */
export function authorizeAutomaticWordBinding(profile: string, sessionId: string, turnId: string, bindingId: string): boolean {
  const key = keyFor(profile, sessionId, turnId)
  const turn = turns.get(key)

  if (!bindingId || turn?.profile !== profile || turn.mode !== 'automatic' || turn.bindingId) {return false}
  turns.set(key, { ...turn, bindingId })

  return true
}

export function wordBindingForTurn(profile: string, sessionId: string, turnId: string): string | null {
  const turn = turns.get(keyFor(profile, sessionId, turnId))

  return turn?.profile === profile && turn.ownerKey === panelOwnerKey() && turn.epoch === $actionPanelEpoch.get() && turn.bindingId ? turn.bindingId : null
}

export function settleWordTurn(sessionId: string, turnId: string, profile?: string): void {
  if (!profile) {return}
  const key = keyFor(profile, sessionId, turnId)
  turns.delete(key)
  settled.add(key)

  if (settled.size > 128) {settled.delete(settled.values().next().value!)}
}

export function resetWordTurnLedgerForTests(): void {
  pending.clear()
  turns.clear()
  settled.clear()
}

$actionPanelOwner.listen(() => {pending.clear(); turns.clear(); settled.clear()})
