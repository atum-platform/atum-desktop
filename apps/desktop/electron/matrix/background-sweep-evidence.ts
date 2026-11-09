import { createHash } from 'node:crypto'

import type { FollowupSweepEvidenceInput } from '../../../shared/src/followup-sweep'

const DAY_MS = 24 * 60 * 60_000

/**
 * The cloud controller's source frontier: capture moment, one identity digest, and the
 * opaque overflow carry. Both homes read and write this exact form, so a source advanced
 * by the cloud is still understood here and vice versa.
 */
export function sweepHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sweepCarryKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

export function sweepWatermark(at: number, identities: string[], carry: string[] = []): string {
  return `${at}.${sweepHash([...identities].sort())}${carry.length ? `.${[...new Set(carry)].sort().join(',')}` : ''}`
}

/** The capture moment, accepting the legacy plain-timestamp frontier older Mac builds wrote. */
export function sweepWatermarkAt(value: string | null, fallback: number): number {
  const parsed = value && /^(\d{1,16})(?:[.]|$)/u.exec(value)

  return parsed && Number.isSafeInteger(Number(parsed[1])) ? Number(parsed[1]) : fallback
}

export function sweepWatermarkDigest(value: string | null): string | null {
  const parsed = value && /^\d{1,16}[.]([a-f0-9]{64})(?:[.][a-f0-9,]+)?$/u.exec(value)

  return parsed?.[1] ?? null
}

export function sweepWatermarkCarry(value: string | null): Set<string> {
  const parsed = value && /^\d{1,16}[.][a-f0-9]{64}(?:[.]([a-f0-9,]+))?$/u.exec(value)

  return new Set(parsed?.[1]?.split(',').filter(Boolean) ?? [])
}

/** The cloud's bounded text: code points, never a split surrogate pair. */
export function sweepBounded(value: unknown, maximum: number): string {
  return typeof value === 'string' ? [...value].slice(0, maximum).join('') : ''
}

export interface MacSweepMailMessage {
  messageId: string
  threadId?: string
  sourceId?: string
  date?: string
  subject?: string
  from?: string
  snippet?: string
}

/** Mail evidence exactly as the cloud builds it: one thread, anchored at its latest message. */
export function backgroundSweepMailEvidence(
  message: MacSweepMailMessage,
  observedAt: number
): FollowupSweepEvidenceInput {
  return {
    source: 'google_mail',
    scope: message.sourceId ?? 'google:gmail',
    objectId: message.threadId ?? message.messageId,
    anchorId: message.messageId,
    dueAt: null,
    observedAt,
    title: sweepBounded(message.subject, 240),
    text: sweepBounded(message.snippet, 400),
    fresh: true
  }
}

export interface BackgroundSweepMailSelection {
  entries: Array<{ message: MacSweepMailMessage; observedAt: number }>
  watermark: string
}

function mailMessage(value: unknown): MacSweepMailMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  if (typeof row.messageId !== 'string' || !row.messageId) {
    return null
  }

  return {
    messageId: row.messageId,
    ...(typeof row.threadId === 'string' && row.threadId ? { threadId: row.threadId } : {}),
    ...(typeof row.sourceId === 'string' && row.sourceId ? { sourceId: row.sourceId } : {}),
    ...(typeof row.date === 'string' ? { date: row.date } : {}),
    ...(typeof row.subject === 'string' ? { subject: row.subject } : {}),
    ...(typeof row.from === 'string' ? { from: row.from } : {}),
    ...(typeof row.snippet === 'string' ? { snippet: row.snippet } : {})
  }
}

/** Group the search result by thread, keeping the thread's latest message as the anchor. */
function latestMailByThread(
  messages: readonly MacSweepMailMessage[],
  now: number
): Array<{ message: MacSweepMailMessage; observedAt: number }> {
  const threads = new Map<string, { message: MacSweepMailMessage; observedAt: number }>()

  for (const message of messages) {
    const threadId = message.threadId ?? message.messageId
    const observedAt = Date.parse(String(message.date ?? '')) || now
    const latest = threads.get(threadId)

    if (!latest || observedAt > latest.observedAt) {
      threads.set(threadId, { message, observedAt })
    }
  }

  return [...threads.values()]
}

/**
 * One entry per thread per run, anchored at that thread's latest message, carrying every
 * thread not yet included. The carry rides the watermark, so three threads sharing one
 * timestamp still surface as two and then the third instead of the strict timestamp filter
 * losing the last one.
 */
export function selectBackgroundSweepMail(
  messages: readonly unknown[],
  prior: string | null,
  now: number
): BackgroundSweepMailSelection {
  const rows = messages.map(mailMessage).filter((message): message is MacSweepMailMessage => message !== null)
  const threads = latestMailByThread(rows, now)
  const revisions = threads.map(thread => thread.message.messageId)
  const priorCarry = sweepWatermarkCarry(prior)
  const changed = prior === null || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const candidates = threads
    .map(thread => ({ ...thread, key: sweepCarryKey(thread.message.messageId) }))
    .filter(candidate => changed || priorCarry.has(candidate.key))
    .sort((left, right) => Number(priorCarry.has(right.key)) - Number(priorCarry.has(left.key)))
  const included = new Set<string>()
  const entries: BackgroundSweepMailSelection['entries'] = []

  for (const candidate of candidates.slice(0, 2)) {
    included.add(candidate.key)
    entries.push({ message: candidate.message, observedAt: candidate.observedAt })
  }

  const carry = [...new Set([...priorCarry, ...candidates.map(candidate => candidate.key)])]
    .filter(key => !included.has(key))
    .slice(0, 20)

  return { entries, watermark: sweepWatermark(now, revisions, carry) }
}

export interface MacSweepChatMessage {
  eventId: string
  at: number
  text: string
}

/** Chat evidence with the cloud adapter's exact scope/object/anchor identity. */
export function backgroundSweepChatEvidence(
  roomId: string,
  message: MacSweepChatMessage,
  label?: string
): FollowupSweepEvidenceInput {
  return {
    source: 'atum_chats',
    scope: roomId,
    objectId: roomId,
    anchorId: message.eventId,
    dueAt: null,
    observedAt: message.at,
    ...(label !== undefined ? { title: sweepBounded(label, 120) } : {}),
    text: sweepBounded(message.text, 250),
    fresh: true
  }
}

export interface BackgroundSweepChatCandidate {
  room: Record<string, unknown>
  id: string
  anchorId: string
  key: string
}

export interface BackgroundSweepChatSelection {
  candidates: BackgroundSweepChatCandidate[]
  watermark(included: ReadonlySet<string>): string
}

/** Rooms with an owner-facing last message, oldest carry first, bounded like the cloud. */
export function selectBackgroundSweepChats(
  rooms: readonly unknown[],
  prior: string | null,
  now: number,
  recent = false
): BackgroundSweepChatSelection {
  const priorCarry = sweepWatermarkCarry(prior)
  const candidates = rooms
    .filter((room): room is Record<string, unknown> => Boolean(room) && typeof room === 'object' && !Array.isArray(room))
    .filter(room => Boolean(room.last) && typeof room.last === 'object' &&
      !Array.isArray(room.last) && (room.last as Record<string, unknown>).mine === false &&
      typeof room.id === 'string' && typeof (room.last as Record<string, unknown>).eventId === 'string' &&
      (recent
        ? typeof room.lastAt === 'number' && room.lastAt >= now - 7 * DAY_MS
        : Number(room.notifications ?? 0) > 0))
    .map(room => {
      const anchorId = String((room.last as Record<string, unknown>).eventId)

      return { room, id: String(room.id), anchorId, key: sweepCarryKey(anchorId) }
    })
  const revisions = candidates.map(candidate => candidate.anchorId)
  const changed = prior === null || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const pending = candidates
    .filter(candidate => changed || priorCarry.has(candidate.key))
    .sort((left, right) => Number(priorCarry.has(right.key)) - Number(priorCarry.has(left.key)))
    .slice(0, 3)

  return {
    candidates: pending,
    watermark: included => {
      const carry = [...new Set([...priorCarry, ...pending.map(candidate => candidate.key)])]
        .filter(key => !included.has(key))
        .slice(0, 20)

      return sweepWatermark(now, revisions, carry)
    }
  }
}

export interface MacSweepCalendarEvent {
  eventId: string
  sourceId?: string
  start: number
  startText?: string
  title?: string
  location?: string
  notes?: string
}

/** Calendar evidence: raw provider identity, the event's start as its due moment. */
export function backgroundSweepCalendarEvidence(
  event: MacSweepCalendarEvent,
  capturedAt: number,
  insideNormalWindow: boolean
): FollowupSweepEvidenceInput {
  return {
    source: 'google_calendar',
    scope: event.sourceId ?? 'google:calendar',
    objectId: event.eventId,
    anchorId: event.eventId,
    dueAt: event.start,
    observedAt: event.start,
    title: sweepBounded(event.title, 240),
    text: sweepBounded([event.title, event.startText ?? new Date(event.start).toISOString(), event.location, event.notes]
      .filter(Boolean).join('\n'), 200),
    fresh: true,
    ...(!insideNormalWindow && event.start <= capturedAt + 60 * 60_000 ? { harmBeforeMorning: true } : {})
  }
}

export interface BackgroundSweepDriveFile {
  fileId: string
  sourceId?: string
  name?: string
  modifiedAt?: string
  viewedAt?: string
}

/** Drive evidence is metadata only: a name and provider-supplied viewed/modified times. */
export function backgroundSweepDriveEvidence(
  file: BackgroundSweepDriveFile,
  fresh: boolean
): FollowupSweepEvidenceInput | null {
  const modifiedAt = Date.parse(String(file.modifiedAt ?? ''))
  const viewedAt = Date.parse(String(file.viewedAt ?? ''))
  const observedAt = Math.max(Number.isFinite(modifiedAt) ? modifiedAt : 0, Number.isFinite(viewedAt) ? viewedAt : 0)

  if (!file.fileId || observedAt <= 0) {
    return null
  }

  const revision = `${file.fileId}:${Number.isFinite(modifiedAt) ? modifiedAt : ''}:${Number.isFinite(viewedAt) ? viewedAt : ''}`
  const times = [
    Number.isFinite(modifiedAt) ? `Modified ${new Date(modifiedAt).toISOString()}` : '',
    Number.isFinite(viewedAt) ? `Viewed ${new Date(viewedAt).toISOString()}` : ''
  ].filter(Boolean).join('; ')

  return {
    source: 'google_drive',
    scope: file.sourceId ?? 'google:drive',
    objectId: file.fileId,
    anchorId: revision,
    dueAt: null,
    observedAt,
    title: sweepBounded(file.name, 240),
    text: sweepBounded(times, 240),
    fresh
  }
}

export interface BackgroundSweepMacFile {
  /** A host-generated opaque identity; a path is never model-facing. */
  identity: string
  name: string
  modifiedAt: number
}

/** Mac file evidence deliberately exposes only the base name and modification time. */
export function backgroundSweepMacFileEvidence(
  file: BackgroundSweepMacFile,
  fresh: boolean
): FollowupSweepEvidenceInput {
  return {
    source: 'mac_files',
    scope: 'mac',
    objectId: file.identity,
    anchorId: `${file.identity}:${file.modifiedAt}`,
    dueAt: null,
    observedAt: file.modifiedAt,
    title: sweepBounded(file.name, 240),
    text: `Modified ${new Date(file.modifiedAt).toISOString()}`,
    fresh
  }
}

/** Memory is context for the classifier, never evidence that a source changed. */
export function backgroundSweepMemoryEvidence(
  agentPrincipal: string,
  text: string,
  observedAt: number
): FollowupSweepEvidenceInput {
  return {
    source: 'memory',
    scope: agentPrincipal,
    objectId: 'agent-memory',
    anchorId: 'agent-memory',
    dueAt: null,
    observedAt,
    text: sweepBounded(text, 400),
    fresh: false
  }
}

/** Conversation is context too: the owner's latest event anchors it, but it never counts as fresh. */
export function backgroundSweepConversationEvidence(
  roomId: string,
  ownerEvent: { eventId: string; at: number },
  sourceIntervalMs: number,
  text: string
): FollowupSweepEvidenceInput {
  return {
    source: 'conversation',
    scope: roomId,
    objectId: ownerEvent.eventId,
    anchorId: ownerEvent.eventId,
    dueAt: ownerEvent.at + sourceIntervalMs,
    observedAt: ownerEvent.at,
    text: sweepBounded(text, 600),
    fresh: false
  }
}
