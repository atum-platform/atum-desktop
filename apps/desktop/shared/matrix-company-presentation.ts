/**
 * The company scope of `atum.agent-turns/1.6`: a company agent's one working line
 * (`io.atum.progress`, scope `company`) and its interim remarks (`io.atum.interim` + `io.atum.company`)
 * in a company channel thread or a private Chief of Staff room. Dependency-free so the SDK projection
 * and every renderer read the same shape. Presentation only: it confers no execution authority.
 *
 * The personal 1.3/1.4 markers (`matrix-progress-marker.ts`, `matrix-interim-marker.ts`) are unchanged
 * and are never widened to company authority: a content is read by exact profile and scope.
 *
 * Two checks, both required, and they mirror the personal path (the projection parses, the renderer
 * names the agent):
 * 1. `matrixCompanyPresentationContent` reads one content strictly (unknown keys refuse, as the
 *    frozen pack's leak fixtures require) and its exact thread relation;
 * 2. `matrixAdmitCompanyPresentation` keeps it only when the room's bound company agent sent it and the
 *    marker names that agent, that company, that audience and that room. Anything else falls back to
 *    the standard Matrix message.
 */
import type { MatrixProgressKind, MatrixProgressPhase } from './matrix-progress-kernel'

export const MATRIX_COMPANY_PRESENTATION_PROFILE = 'atum.agent-turns/1.6'

export const MATRIX_COMPANY_MARKER_KEY = 'io.atum.company'

export type MatrixCompanyAudience =
  { kind: 'channel'; channelId: string } | { kind: 'private'; memberPrincipal: string; membershipIncarnation: string }

/** The admitted public identity of one company turn (the pack's `company_identity`). */
export interface MatrixCompanyTurnIdentity {
  companyId: string
  agentPrincipal: string
  audience: MatrixCompanyAudience
  roomId: string
  threadRootEventId: string
  taskId: string
  invocationId: string
}

/** What a projected message keeps of it: the identity, its revision and the thread reply it answers. */
export interface MatrixCompanyPresentation extends MatrixCompanyTurnIdentity {
  revision: number
  /** The admitted trigger the event rich-replies to inside the thread (the root itself is allowed). */
  triggerEventId: string
}

/** The company progress marker, as the transcript reads it (phase/kind/device; never tool details). */
export interface MatrixCompanyProgressMarker {
  profile: typeof MATRIX_COMPANY_PRESENTATION_PROFILE
  scope: 'company'
  phase: MatrixProgressPhase
  kind: Exclude<MatrixProgressKind, 'interim'>
  revision: number
  device?: string
  heartbeat?: boolean
}

export type MatrixCompanyPresentationContent =
  | { stream: 'progress'; identity: MatrixCompanyPresentation; progress: MatrixCompanyProgressMarker }
  | { stream: 'interim'; identity: MatrixCompanyPresentation }

/** The room's bound company agent, as the platform states it. Display only. */
export interface MatrixCompanyPresentationBinding {
  companyId: string
  agentPrincipal: string
  agentUserId: string
  roomId: string
  audience: MatrixCompanyAudience
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const EVENT_ID = /^[$][!-~]+$/u
const ROOM_ID = /^![!-~]+$/u
const PHASES: readonly string[] = ['working', 'waiting', 'settled']
const KINDS: readonly string[] = ['todo', 'heartbeat', 'device', 'touch_id', 'settled']
const BODY_MAX = 1_000
const REVISION_MAX = 48

const IDENTITY_KEYS = [
  'companyId',
  'agentPrincipal',
  'audience',
  'roomId',
  'threadRootEventId',
  'taskId',
  'invocationId'
]

const MESSAGE_MARKER_KEYS = ['profile', 'scope', ...IDENTITY_KEYS, 'revision']
const PROGRESS_REQUIRED = [...MESSAGE_MARKER_KEYS, 'phase', 'kind']
const PROGRESS_OPTIONAL = ['device', 'heartbeat']

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Exactly `required` plus any of `optional`: an unknown key refuses (a leaked field is never shown). */
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value)

  return (
    required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key))
  )
}

const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

const eventId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 2 && value.length <= 1024 && EVENT_ID.test(value)

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function audienceOf(value: unknown): MatrixCompanyAudience | undefined {
  const raw = record(value)

  if (raw?.kind === 'channel' && exactKeys(raw, ['kind', 'channelId']) && uuid(raw.channelId)) {
    return { kind: 'channel', channelId: raw.channelId }
  }

  if (
    raw?.kind === 'private' &&
    exactKeys(raw, ['kind', 'memberPrincipal', 'membershipIncarnation']) &&
    uuid(raw.memberPrincipal) &&
    uuid(raw.membershipIncarnation)
  ) {
    return { kind: 'private', memberPrincipal: raw.memberPrincipal, membershipIncarnation: raw.membershipIncarnation }
  }

  return undefined
}

function identityOf(raw: Record<string, unknown>): (MatrixCompanyTurnIdentity & { revision: number }) | undefined {
  const audience = audienceOf(raw.audience)

  if (
    raw.profile !== MATRIX_COMPANY_PRESENTATION_PROFILE ||
    raw.scope !== 'company' ||
    !audience ||
    !uuid(raw.companyId) ||
    !uuid(raw.agentPrincipal) ||
    !uuid(raw.taskId) ||
    !uuid(raw.invocationId) ||
    typeof raw.roomId !== 'string' ||
    raw.roomId.length < 2 ||
    raw.roomId.length > 1024 ||
    !ROOM_ID.test(raw.roomId) ||
    !eventId(raw.threadRootEventId) ||
    !Number.isInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    (raw.revision as number) > REVISION_MAX
  ) {
    return undefined
  }

  return {
    companyId: raw.companyId,
    agentPrincipal: raw.agentPrincipal,
    audience,
    roomId: raw.roomId,
    threadRootEventId: raw.threadRootEventId,
    taskId: raw.taskId,
    invocationId: raw.invocationId,
    revision: raw.revision as number
  }
}

/** The exact company thread relation: `m.thread` to the root, never a timeline fallback, replying to the trigger. */
function threadOf(value: unknown): { root: string; trigger: string } | undefined {
  const relation = record(value)
  const reply = record(relation?.['m.in_reply_to'])

  if (
    !relation ||
    !reply ||
    !exactKeys(relation, ['rel_type', 'event_id', 'is_falling_back', 'm.in_reply_to']) ||
    relation.rel_type !== 'm.thread' ||
    relation.is_falling_back !== false ||
    !eventId(relation.event_id) ||
    !exactKeys(reply, ['event_id']) ||
    !eventId(reply.event_id)
  ) {
    return undefined
  }

  return { root: relation.event_id, trigger: reply.event_id }
}

/**
 * One company presentation content (an original, or the `m.new_content` of an edit), strictly: its
 * marker, its body and its thread relation, whose root must be the marker's. Nothing else, or nothing.
 */
export function matrixCompanyPresentationContent(content: unknown): MatrixCompanyPresentationContent | undefined {
  const body = record(content)

  if (!body) {
    return undefined
  }

  const thread = threadOf(body['m.relates_to'])

  if (body.msgtype === 'm.notice') {
    const raw = record(body['io.atum.progress'])
    const identity = raw && exactKeys(raw, PROGRESS_REQUIRED, PROGRESS_OPTIONAL) ? identityOf(raw) : undefined
    const presentation = record(body['io.atum.presentation'])

    if (
      !raw ||
      !identity ||
      !thread ||
      thread.root !== identity.threadRootEventId ||
      !exactKeys(body, ['msgtype', 'body', 'io.atum.progress', 'm.relates_to'], ['io.atum.presentation']) ||
      (Object.hasOwn(body, 'io.atum.presentation') && !presentation) ||
      !text(body.body, BODY_MAX) ||
      typeof raw.phase !== 'string' ||
      !PHASES.includes(raw.phase) ||
      typeof raw.kind !== 'string' ||
      !KINDS.includes(raw.kind) ||
      (raw.device !== undefined && !text(raw.device, 80)) ||
      (raw.heartbeat !== undefined && typeof raw.heartbeat !== 'boolean')
    ) {
      return undefined
    }

    return {
      stream: 'progress',
      identity: { ...identity, triggerEventId: thread.trigger },
      progress: {
        profile: MATRIX_COMPANY_PRESENTATION_PROFILE,
        scope: 'company',
        phase: raw.phase as MatrixProgressPhase,
        kind: raw.kind as MatrixCompanyProgressMarker['kind'],
        revision: identity.revision,
        ...(raw.device !== undefined ? { device: raw.device as string } : {}),
        ...(raw.heartbeat !== undefined ? { heartbeat: raw.heartbeat as boolean } : {})
      }
    }
  }

  if (body.msgtype === 'm.text') {
    const raw = record(body[MATRIX_COMPANY_MARKER_KEY])
    const identity = raw && exactKeys(raw, MESSAGE_MARKER_KEYS) ? identityOf(raw) : undefined

    if (
      !identity ||
      !thread ||
      thread.root !== identity.threadRootEventId ||
      body['io.atum.interim'] !== true ||
      !exactKeys(body, ['msgtype', 'body', 'io.atum.interim', MATRIX_COMPANY_MARKER_KEY, 'm.relates_to']) ||
      !text(body.body, BODY_MAX)
    ) {
      return undefined
    }

    return { stream: 'interim', identity: { ...identity, triggerEventId: thread.trigger } }
  }

  return undefined
}

/** True when a content claims the company profile at all (it is then never read as personal). */
export function matrixCompanyPresentationClaimed(content: unknown): boolean {
  const body = record(content)

  return Boolean(
    body &&
    (Object.hasOwn(body, MATRIX_COMPANY_MARKER_KEY) ||
      record(body['io.atum.progress'])?.profile === MATRIX_COMPANY_PRESENTATION_PROFILE)
  )
}

export function sameMatrixCompanyAudience(left: MatrixCompanyAudience, right: MatrixCompanyAudience): boolean {
  return left.kind === 'channel'
    ? right.kind === 'channel' && left.channelId === right.channelId
    : right.kind === 'private' &&
        left.memberPrincipal === right.memberPrincipal &&
        left.membershipIncarnation === right.membershipIncarnation
}

/** Identity never changes across revisions (company, agent, audience, room, root, task, invocation, trigger). */
export function sameMatrixCompanyTurn(left: MatrixCompanyPresentation, right: MatrixCompanyPresentation): boolean {
  return (
    left.companyId === right.companyId &&
    left.agentPrincipal === right.agentPrincipal &&
    sameMatrixCompanyAudience(left.audience, right.audience) &&
    left.roomId === right.roomId &&
    left.threadRootEventId === right.threadRootEventId &&
    left.taskId === right.taskId &&
    left.invocationId === right.invocationId &&
    left.triggerEventId === right.triggerEventId
  )
}

interface Presented {
  company?: MatrixCompanyPresentation
  progress?: { scope: string }
  interim?: true
  own: boolean
  sender: string
}

/**
 * The renderer's half: a company line or remark stays only when the room's bound agent sent it and it
 * names that agent, company, audience and room (and, in a thread view, that thread). Otherwise its
 * company meaning is dropped and the standard Matrix message remains. Other messages pass as they are,
 * except that a company view never reads a personal progress marker as a working line.
 */
export function matrixAdmitCompanyPresentation<T extends Presented>(
  messages: readonly T[],
  binding: MatrixCompanyPresentationBinding | undefined,
  threadRootId?: string
): T[] {
  return messages.map(message => {
    const company = message.company

    if (!company) {
      // A company view reads company scope only: a personal 1.3 marker is never relabeled as company
      // progress (its message stays an ordinary notice). Without a binding nothing changes.
      if (binding && message.progress && message.progress.scope !== 'company') {
        const plain = { ...message }

        delete plain.progress

        return plain
      }

      return message
    }

    const admitted =
      binding !== undefined &&
      !message.own &&
      message.sender === binding.agentUserId &&
      company.agentPrincipal === binding.agentPrincipal &&
      company.companyId === binding.companyId &&
      company.roomId === binding.roomId &&
      sameMatrixCompanyAudience(company.audience, binding.audience) &&
      (threadRootId === undefined || company.threadRootEventId === threadRootId)

    if (admitted) {
      return message
    }

    // A company-claimed content never carries a personal marker (the projection reads it as company
    // only), so its progress line and interim flag are company meaning: both go with it.
    const plain = { ...message }

    delete plain.company
    delete plain.interim
    delete plain.progress

    return plain
  })
}
