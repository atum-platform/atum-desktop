import { atom } from 'nanostores'

import { translateNow } from '@/i18n/runtime'

import { $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import type { ComposerAttachment } from './composer'
import { notifyError } from './notifications'
import { captureIntentForScope, freezeSurfaceCapture, type FrozenSurfaceCapture, type SurfaceCaptureIntent } from './surface-capture'
import { ownsActionPanel } from './windows'
import { $workbenchScope, assistantChatWorkbenchScopeKey, resolveCaptureScope } from './workbench-tabs'

export interface QueuedPromptEntry {
  id: string
  text: string
  attachments: ComposerAttachment[]
  queuedAt: number
  submissionId?: string
  frozenContext?: FrozenSurfaceCapture | null
  /** Persisted descriptor only; never a native handle or captured body. */
  captureIntent?: SurfaceCaptureIntent
  /** Distinguishes Send without document from ordinary automatic omission. */
  explicitNoContext?: boolean
  contextUnavailable?: boolean
  uncertain?: boolean
}

type QueueState = Record<string, QueuedPromptEntry[]>

function persistedIntent(value: unknown): SurfaceCaptureIntent | undefined {
  const intent = value as Partial<SurfaceCaptureIntent> | undefined

  if (!intent || !['automatic', 'linked', 'removed'].includes(intent.mode ?? '') || typeof intent.revision !== 'string' || intent.revision.length > 128) {return undefined}
  const target = intent.target

  if (target && (typeof target !== 'object' || typeof (target as { path?: unknown }).path !== 'string' || (target as { path: string }).path.length > 4096)) {return undefined}

  return { mode: intent.mode!, revision: intent.revision, ...(target ? { target } : {}) }
}

const STORAGE_KEY = 'hermes.desktop.composerQueue.v2'
const LEGACY_STORAGE_KEY = 'hermes.desktop.composerQueue.v1'
export const QUEUE_RECOVERY_KEY = 'hermes.desktop.composerQueue.recovery.v1'

function loadOwnerQueues(): Record<string, QueueState> {
  if (typeof window === 'undefined' || !ownsActionPanel()) {return {}}

  try {
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) || '{}')
    const pending = Object.values(legacy).flat().filter((value): value is QueuedPromptEntry => Boolean(value && typeof value === 'object' && typeof (value as QueuedPromptEntry).text === 'string')).map(({ id, text }) => ({ id, text }))

    if (pending.length) {
      const recovery = JSON.parse(window.localStorage.getItem(QUEUE_RECOVERY_KEY) || '[]')
      window.localStorage.setItem(QUEUE_RECOVERY_KEY, JSON.stringify([...recovery, ...pending]))
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    }

    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {return {}}
    const restored: Record<string, QueueState> = {}

    for (const [owner, sessions] of Object.entries(parsed)) {
      if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {continue}
      const state: QueueState = {}

      for (const [sid, entries] of Object.entries(sessions)) {
        if (!Array.isArray(entries)) {continue}

        const safe = entries.filter((entry): entry is QueuedPromptEntry => Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string' && Number.isFinite(entry.queuedAt) && Array.isArray(entry.attachments)))
          .map(entry => ({ id: entry.id, text: entry.text, queuedAt: entry.queuedAt, attachments: entry.attachments,
            submissionId: typeof entry.submissionId === 'string' ? entry.submissionId : undefined,
            captureIntent: persistedIntent(entry.captureIntent),
            explicitNoContext: Boolean(entry.explicitNoContext),
            contextUnavailable: Boolean(entry.contextUnavailable || entry.frozenContext), uncertain: Boolean(entry.uncertain) }))

        if (safe.length) {Object.defineProperty(state, sid, { value: safe, enumerable: true, writable: true, configurable: true })}
      }

      Object.defineProperty(restored, owner, { value: state, enumerable: true, writable: true, configurable: true })
    }

    return restored
  } catch {return {}}
}

const ownerQueues = loadOwnerQueues()
let activeOwner = panelOwnerKey()
export const $queuedPromptsBySession = atom<QueueState>({})
interface QueueRecoveryDraft { id: string; text: string; accountId?: string; ownerKey?: string }
export const $queueRecovery = atom<QueueRecoveryDraft[]>((() => {
  if (typeof window === 'undefined' || !ownsActionPanel()) {return []}

  try {return JSON.parse(window.localStorage.getItem(QUEUE_RECOVERY_KEY) || '[]')} catch {return []}
})())

/** Retain rejected text under its original account, even after the UI switches. */
export function retainQueueRecoveryText(text: string, accountId: string | undefined, ownerKey: string): void {
  const next = [...$queueRecovery.get(), { id: crypto.randomUUID(), text, accountId, ownerKey }]
  $queueRecovery.set(next)

  try {window.localStorage.setItem(QUEUE_RECOVERY_KEY, JSON.stringify(next))} catch { /* remains recoverable in memory */ }
}

export function dismissQueueRecovery(id: string): void {
  const next = $queueRecovery.get().filter(item => item.id !== id)
  window.localStorage.setItem(QUEUE_RECOVERY_KEY, JSON.stringify(next))
  $queueRecovery.set(next)
}

const save = (state: QueueState) => {
  if (typeof window === 'undefined' || !ownsActionPanel() || !$actionPanelOwner.get()) {return}
  ownerQueues[activeOwner] = state

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ownerQueues, (key, value) => {
      if (key === 'frozenContext') {return undefined}

      if (key === 'captureIntent') {return persistedIntent(value)}

      if (value && typeof value === 'object' && 'queuedAt' in value) {
        return { ...value, frozenContext: undefined, contextUnavailable: Boolean(value.frozenContext) || value.contextUnavailable }
      }

      return value
    }))
  } catch { /* in-memory queue remains available */ }
}

$actionPanelOwner.listen(owner => {
  ownerQueues[activeOwner] = $queuedPromptsBySession.get()
  activeOwner = panelOwnerKey(owner)
  $queuedPromptsBySession.set(owner ? (ownerQueues[activeOwner] ?? {}) : {})
})

/**
 * Sessions whose queue the user explicitly halted (Stop button / Esc). A parked
 * queue is skipped by both auto-drain paths until the user acts on it again —
 * resume, send-now, a manual drain, queueing a fresh prompt, or emptying the
 * queue all unpark. Deliberately in-memory only: a fresh app process starts
 * unparked, so restored-entry semantics stay a separate concern.
 */
export const $parkedQueueSessions = atom<Record<string, true>>({})

const setParked = (sid: string, parked: boolean) => {
  const current = $parkedQueueSessions.get()

  if (Boolean(current[sid]) === parked) {
    return
  }

  const next = { ...current }

  if (parked) {
    next[sid] = true
  } else {
    delete next[sid]
  }

  $parkedQueueSessions.set(next)
}

const writeSession = (sid: string, queue: QueuedPromptEntry[]) => {
  const current = $queuedPromptsBySession.get()
  const next = { ...current }

  if (queue.length === 0) {
    delete next[sid]
    // An empty queue has nothing to hold back — drop the park so it can't
    // linger as stale state and silently gate entries queued much later.
    setParked(sid, false)
  } else {
    next[sid] = queue
  }

  $queuedPromptsBySession.set(next)
  save(next)
}

const sidOf = (key: string | null | undefined): null | string => {
  if (!ownsActionPanel()) {return null}
  const trimmed = key?.trim()

  return trimmed ? trimmed : null
}

const queueFor = (sid: string) => $queuedPromptsBySession.get()[sid] ?? []

const nextId = () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const cloneAttachments = (attachments: ComposerAttachment[]) => attachments.map(a => ({ ...a }))

export const getQueuedPrompts = (key: string | null | undefined): QueuedPromptEntry[] => {
  const sid = sidOf(key)

  return sid ? queueFor(sid) : []
}

export const enqueueQueuedPrompt = async (
  key: string | null | undefined,
  payload: { text: string; attachments: ComposerAttachment[]; frozenContext?: FrozenSurfaceCapture | null; captureIntent?: SurfaceCaptureIntent; explicitNoContext?: boolean }
): Promise<null | QueuedPromptEntry> => {
  const sid = sidOf(key)

  if (!sid) {return null}

  if (!$actionPanelOwner.get()) {notifyError(null, translateNow('composer.contextQueueUnavailable'));

 return null}

  const enqueueOwner = panelOwnerKey()
  const pinnedAttachments = cloneAttachments(payload.attachments)
  let frozenContext: FrozenSurfaceCapture | null

  const explicitNoContext = Boolean(payload.explicitNoContext)

  const captureIntent = explicitNoContext ? { mode: 'removed' as const, revision: 'explicit-no-context' }
    : payload.captureIntent ?? captureIntentForScope(assistantChatWorkbenchScopeKey(sid))

  try {frozenContext = explicitNoContext ? null : 'frozenContext' in payload ? payload.frozenContext ?? null : await freezeSurfaceCapture(assistantChatWorkbenchScopeKey(sid), captureIntent)} catch (error) {notifyError(error, translateNow('composer.contextUnavailable'));

 return null}

  if (enqueueOwner !== panelOwnerKey() || (frozenContext && frozenContext.ownerKey !== enqueueOwner)) {return null}
  const used = Object.values(ownerQueues).flatMap(state => Object.values(state).flat()).reduce((sum, item) => sum + JSON.stringify(item.frozenContext ?? null).length * 2, 0)

  if (used + JSON.stringify(frozenContext).length * 2 > 100 * 1024 * 1024) {
    notifyError(null, translateNow('composer.contextCapacity'))

    return null
  }

  const entry: QueuedPromptEntry = {
    id: nextId(),
    submissionId: crypto.randomUUID(),
    frozenContext,
    captureIntent,
    explicitNoContext,
    text: payload.text,
    attachments: pinnedAttachments,
    queuedAt: Date.now()
  }

  writeSession(sid, [...queueFor(sid), entry])
  // Queueing a new prompt is fresh intent to keep the conversation moving —
  // a park from an earlier Stop must not hold this (or the entries ahead of
  // it) back.
  setParked(sid, false)

  return entry
}

export const dequeueQueuedPrompt = (key: string | null | undefined): null | QueuedPromptEntry => {
  const sid = sidOf(key)

  if (!sid) {
    return null
  }

  const [head, ...rest] = queueFor(sid)

  if (!head) {
    return null
  }

  writeSession(sid, rest)

  return head
}

export const removeQueuedPrompt = (key: string | null | undefined, id: string): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  const next = queue.filter(e => e.id !== id)

  if (next.length === queue.length) {
    return false
  }

  writeSession(sid, next)

  return true
}

export const promoteQueuedPrompt = (key: string | null | undefined, id: string): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  const index = queue.findIndex(e => e.id === id)

  if (index <= 0) {
    return false
  }

  const entry = queue[index]!
  writeSession(sid, [entry, ...queue.slice(0, index), ...queue.slice(index + 1)])

  return true
}

export const updateQueuedPrompt = (
  key: string | null | undefined,
  id: string,
  update: { text: string; attachments?: ComposerAttachment[] }
): boolean => {
  const sid = sidOf(key)

  if (!sid) {
    return false
  }

  const queue = queueFor(sid)
  let changed = false

  const next = queue.map(entry => {
    if (entry.id !== id) {
      return entry
    }

    const attachments = update.attachments ? cloneAttachments(update.attachments) : entry.attachments

    if (entry.text === update.text && !update.attachments) {
      return entry
    }

    changed = true

    return { ...entry, text: update.text, attachments }
  })

  if (!changed) {
    return false
  }

  writeSession(sid, next)

  return true
}

export const updateQueuedPromptText = (key: string | null | undefined, id: string, text: string): boolean =>
  updateQueuedPrompt(key, id, { text })

export const clearQueuedPrompts = (key: string | null | undefined) => {
  const sid = sidOf(key)

  if (!sid || !(sid in $queuedPromptsBySession.get())) {
    return
  }

  writeSession(sid, [])
}

/**
 * Move pending entries from a dead session key onto a live one, preserving FIFO
 * (existing target entries first, migrated entries appended). A backend bounce /
 * resume can mint a fresh runtime session id for the *same* conversation; the
 * entries enqueued under the old id would otherwise be stranded under a key
 * nothing reads anymore. No-op unless both keys resolve and differ.
 */
export const migrateQueuedPrompts = (fromKey: string | null | undefined, toKey: string | null | undefined): boolean => {
  const from = sidOf(fromKey)
  const to = sidOf(toKey)

  if (!from || !to || from === to) {
    return false
  }

  const pending = queueFor(from)

  if (pending.length === 0) {
    return false
  }

  const next = { ...$queuedPromptsBySession.get() }
  delete next[from]
  next[to] = [...queueFor(to), ...pending]

  $queuedPromptsBySession.set(next)
  save(next)

  // The park is a property of the entries the user halted — it re-homes with
  // them. Without this, a backend bounce right after Stop would shed the park
  // and auto-send the exact prompts the user just held back.
  if ($parkedQueueSessions.get()[from]) {
    setParked(from, false)
    setParked(to, true)
  }

  return true
}

/**
 * Park a session's queue after an explicit user halt (Stop / Esc): entries stay
 * visible in the panel but neither auto-drain path sends them. No-op for a
 * session with nothing queued — parking exists to hold back queued turns, and
 * a park with no queue would only linger as a stale gate.
 */
export const parkQueuedPrompts = (key: string | null | undefined): boolean => {
  const sid = sidOf(key)

  if (!sid || queueFor(sid).length === 0) {
    return false
  }

  setParked(sid, true)

  return true
}

/** Lift a park (user resumed the queue). Safe to call for any session. */
export const unparkQueuedPrompts = (key: string | null | undefined): void => {
  const sid = sidOf(key)

  if (sid) {
    setParked(sid, false)
  }
}

export const isQueueParked = (key: string | null | undefined): boolean => {
  const sid = sidOf(key)

  return sid ? Boolean($parkedQueueSessions.get()[sid]) : false
}

/** Inputs to {@link shouldAutoDrain}. */
export interface AutoDrainInput {
  isBusy: boolean
  /** The user explicitly halted this session's queue (Stop / Esc). */
  parked?: boolean
  queueLength: number
}

/**
 * Decide whether the composer should auto-drain the next queued prompt.
 *
 * Edge-independent on purpose: the queue must advance whenever the session is
 * idle and has pending entries, NOT only on an observed busy true → false edge.
 * A backend bounce / websocket reconnect remounts the composer and resets the
 * busy ref to the current value, swallowing the settle edge — an edge-gated
 * drain would then strand the entry forever. The caller's drain lock
 * (`drainingQueueRef`) serializes sends so being edge-free can't double-submit.
 *
 * `parked` is the one deliberate exception: an explicit Stop/Esc is the user
 * saying HALT, and immediately firing the next queued prompt contradicts the
 * instruction they just gave. Parked entries stay in the panel until the user
 * resumes, sends, edits, or deletes them. Interrupts that exist to reach the
 * queue faster (send-now-while-busy) never park, so they keep draining through
 * this same gate.
 */
export const shouldAutoDrain = ({ isBusy, parked, queueLength }: AutoDrainInput): boolean =>
  ownsActionPanel() && !isBusy && !parked && queueLength > 0

/** Detach unscoped legacy queues before a backend changes. Persist only pending
 * text in recovery: stale paths/attachment grants cannot cross the boundary.
 * A failed recovery write aborts the switch rather than losing user text. */
export function quarantineQueuedPrompts(): void {
  if (!ownsActionPanel()) {return}
  const pending = Object.values($queuedPromptsBySession.get()).flat().map(entry => ({ id: entry.id, text: entry.text, accountId: $actionPanelOwner.get()?.accountId }))

  if (pending.length && typeof window !== 'undefined') {
    const raw = window.localStorage.getItem(QUEUE_RECOVERY_KEY)
    const existing: unknown = raw ? JSON.parse(raw) : []

    if (!Array.isArray(existing)) {throw new Error('queue_recovery_invalid')}
    window.localStorage.setItem(QUEUE_RECOVERY_KEY, JSON.stringify([...existing, ...pending]))
    $queueRecovery.set([...existing, ...pending] as Array<{ id: string; text: string; accountId?: string }>)
  }

  delete ownerQueues[activeOwner]
  $queuedPromptsBySession.set({})
  $parkedQueueSessions.set({})
  save({})
}

/** Auto-drain attempts for one entry before we stop retrying and toast. The
 * entry stays queued for a manual send; a remount/reconnect resets the count. */
export const MAX_AUTO_DRAIN_ATTEMPTS = 4

/** Recovery always requires a deliberate choice; never recapture during drain. */
export async function recoverQueuedContext(id: string, withoutContext: boolean): Promise<void> {
  for (const [sid, entries] of Object.entries($queuedPromptsBySession.get())) {
    const entry = entries.find(item => item.id === id)

    if (!entry) {continue}
    const recoveryOwner = panelOwnerKey()
    let frozenContext: FrozenSurfaceCapture | null = null

    try {if (!withoutContext) {
      const expectedScope = assistantChatWorkbenchScopeKey(sid)

      if (!entry.captureIntent?.target) {throw new Error(translateNow('composer.contextUnavailable'))}

      if (resolveCaptureScope($workbenchScope.get()) !== expectedScope) {throw new Error(translateNow('composer.contextOwnerChanged'))}
      frozenContext = await freezeSurfaceCapture(expectedScope, entry.captureIntent)

      if (!frozenContext) {throw new Error(translateNow('composer.contextUnavailable'))}
    }} catch (error) {notifyError(error, translateNow('composer.contextUnavailable'));

 return}

    if (recoveryOwner !== panelOwnerKey()) {return}
    writeSession(sid, queueFor(sid).map(item => item.id === id ? { ...item, submissionId: crypto.randomUUID(), frozenContext,
      explicitNoContext: withoutContext, contextUnavailable: false, uncertain: false } : item))
    setParked(sid, true)
  }
}

export function markQueuedSubmissionUncertain(submissionId: string): void {
  for (const [sid, entries] of Object.entries($queuedPromptsBySession.get())) {
    if (entries.some(entry => entry.submissionId === submissionId)) {
      writeSession(sid, entries.map(entry => entry.submissionId === submissionId ? { ...entry, uncertain: true } : entry))
      setParked(sid, true)
    }
  }
}
