/**
 * File chips (agent-turns/1.7, plan "You talk and things happen" §3.2, slice 2): an answer shows
 * only the agent's words, and each file it made is a chip under it whose state changes by itself.
 *
 * Two steps, split where each one's authority lives:
 *  - Projection (SDK host, `matrixFileAnswerProjection`): slice 1's passive reader replays the
 *    answer and its `io.atum.files.update` references from the room (Matrix's own relation
 *    aggregation), original first, updates in revision order. It checks the wire only: schema,
 *    room, the answer's sender for every update, the identity and the answer event.
 *  - Admission (renderer, `matrixAdmittedFiles`): the projection is shown only when the current
 *    platform binding names the sender: an owner agent (platform roster principal + Matrix user)
 *    in that agent's own room, or a company channel's Chief of Staff (authenticated company view
 *    + the channel's immutable create binding). Anything else, a stray or spoofed marker
 *    included, keeps today's message exactly.
 *
 * A chip is a label, never authority: no field opens, previews or locates a file. Open, preview
 * and Finder need the server-side resolver (follow-up), so a chip offers no action yet.
 * A message without a valid 1.7 marker (every answer before this design, and every answer
 * until the publisher sends 1.7) never gets a chip and renders as it always did.
 */
import type { FileChip, FileIdentity } from '../../../packages/device-protocol/agent-files'

import { DESKTOP_LOCALES } from './desktop-locale'
import { type MatrixAgentStatusCode, matrixAgentStatusText } from './matrix-agent-status-copy'
import { type FileReaderEvent, readFileAnswer, reduceFileUpdate } from './matrix-file-reader'

export type { FileChip } from '../../../packages/device-protocol/agent-files'

export const MATRIX_FILES_KEY = 'io.atum.files'
export const MATRIX_FILES_UPDATE_TYPE = 'io.atum.files.update'

/** What the SDK host projects onto an answer: the replayed files, and who asked. */
export interface MatrixFileAnswerProjection {
  identity: FileIdentity
  triggerEventId: string
  /** The trigger's sender as the room knows it; absent when it is not loaded. */
  triggerSender?: string
  files: FileChip[]
}

function relationTarget(content: unknown): string | undefined {
  const relation = (content as { 'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: unknown } } } | null)?.[
    'm.relates_to'
  ]

  const target = relation?.['m.in_reply_to']?.event_id

  return typeof target === 'string' ? target : undefined
}

function updateRevision(event: FileReaderEvent): number {
  const revision = (event.content as { [MATRIX_FILES_KEY]?: { file?: { revision?: unknown } } } | null)?.[
    MATRIX_FILES_KEY
  ]?.file?.revision

  return typeof revision === 'number' ? revision : Number.MAX_SAFE_INTEGER
}

/**
 * The answer's files after every related update, or nothing (not a 1.7 answer, malformed, or
 * invalidated by a redaction). The reader admits against the answer's own identity here; the
 * renderer then checks that identity against the platform binding.
 */
export function matrixFileAnswerProjection(
  answer: FileReaderEvent,
  updates: readonly FileReaderEvent[],
  triggerSender?: string
): MatrixFileAnswerProjection | undefined {
  const marker = (answer.content as Record<string, unknown> | null)?.[MATRIX_FILES_KEY] as
    | { identity?: FileIdentity }
    | undefined

  const triggerEventId = relationTarget(answer.content)

  if (!marker?.identity || !triggerEventId) {
    return undefined
  }

  const authority = { identity: marker.identity, agentUserId: answer.sender, triggerEventId }
  let state = readFileAnswer(answer, authority)

  if (!state) {
    return undefined
  }

  // History replay: in revision order, then any update the SDK still holds as redacted (a
  // redaction fails closed; it never brings an older state back).
  const ordered = [
    ...updates.filter(update => !update.redacted).sort((left, right) => updateRevision(left) - updateRevision(right)),
    ...updates.filter(update => update.redacted)
  ]

  for (const update of ordered) {
    state = reduceFileUpdate(state, update, authority)
  }

  return state.invalidated || !state.files.length
    ? undefined
    : {
        identity: state.identity,
        triggerEventId,
        ...(triggerSender ? { triggerSender } : {}),
        files: state.files
      }
}

/** The current platform binding of the room a message is shown in. */
export interface MatrixFileBinding {
  roomId: string
  ownerUserId?: string
  /** The owner's agents from the owner-scoped platform roster. */
  agents?: readonly { principal: string; userId: string }[]
  /** The agent whose own room with the owner this is (as main named it); absent elsewhere. */
  roomAgentPrincipal?: string
  /** A company channel's immutable create binding. */
  companyChannel?: { companyId: string; channelId: string }
  /** The company's authenticated Chief of Staff view for that channel's company. */
  companyAgent?: { companyId: string; principal: string; userId: string }
}

interface MatrixFileMessage {
  sender: string
  own: boolean
  files?: MatrixFileAnswerProjection
}

/**
 * The chips to show for a message, or nothing (it then renders exactly as before). Every
 * platform-knowable identity field is compared with the binding; the per-turn fields (root,
 * task, invocation) are correlation the reader already holds consistent, and grant nothing.
 * The owner's own principal is implied by the owner-scoped roster: the renderer has no
 * separate platform copy of it.
 */
export function matrixAdmittedFiles(message: MatrixFileMessage, binding: MatrixFileBinding): FileChip[] | undefined {
  const files = message.files

  if (!files || message.own || files.identity.roomId !== binding.roomId) {
    return undefined
  }

  const identity = files.identity

  if (identity.scope === 'owner_private') {
    const agent = binding.agents?.find(each => each.principal === identity.agentPrincipal)

    return agent &&
      agent.userId === message.sender &&
      !binding.companyChannel &&
      binding.roomAgentPrincipal === identity.agentPrincipal &&
      Boolean(binding.ownerUserId) &&
      files.triggerSender === binding.ownerUserId
      ? files.files
      : undefined
  }

  // Company: only a channel audience is admitted here. A private Chief of Staff pair needs its
  // member principal and membership incarnation from the private-CoS binding (follow-up).
  const company = binding.companyAgent

  return identity.audience.kind === 'channel' &&
    binding.companyChannel &&
    company &&
    company.companyId === binding.companyChannel.companyId &&
    identity.companyId === binding.companyChannel.companyId &&
    identity.audience.channelId === binding.companyChannel.channelId &&
    identity.agentPrincipal === company.principal &&
    message.sender === company.userId &&
    Boolean(files.triggerSender) &&
    files.triggerSender !== company.userId
    ? files.files
    : undefined
}

/** The status codes whose sentence used to ride on (or beside) an answer that made files. */
const FILE_ANSWER_CODES = [
  'saved_to_drive',
  'saved_as_copy',
  'save_unconfirmed',
  'memory_not_saved'
] as const satisfies readonly MatrixAgentStatusCode[]

const FILE_ANSWER_SENTENCES = new Set(
  DESKTOP_LOCALES.flatMap(locale => FILE_ANSWER_CODES.map(code => matrixAgentStatusText(code, locale)))
)

/**
 * An admitted answer's body without Atum's own trailing sentences ("Saved to Atum Drive.", the
 * memory note), in any locale. A 1.7 answer never carries them; this keeps a mixed publisher
 * from putting the machine back. Only whole trailing paragraphs that are exactly one of them go.
 */
export function matrixFileAnswerBody(body: string): string {
  const paragraphs = body.split(/\n{2,}/u)
  let kept = paragraphs.length

  while (kept > 1 && FILE_ANSWER_SENTENCES.has(paragraphs[kept - 1]!.trim())) {
    kept--
  }

  return kept === paragraphs.length ? body : paragraphs.slice(0, kept).join('\n\n').trimEnd()
}

interface MatrixFileNoticeCandidate extends MatrixFileMessage {
  id: string
  notice?: boolean
  replyTo?: string
  resultFor?: string
  cloudStatus?: { code: string }
}

/**
 * A separate file-state or memory notice from the same agent about a question whose admitted
 * answer carries chips says nothing the chips don't: it is left out. Everything else stays.
 */
export function matrixHideFileStatusNotices<Message extends MatrixFileNoticeCandidate>(
  messages: readonly Message[],
  binding: MatrixFileBinding
): Message[] {
  const answered = new Set(
    messages.flatMap(message =>
      matrixAdmittedFiles(message, binding) ? [`${message.sender}\n${message.files!.triggerEventId}`] : []
    )
  )

  if (!answered.size) {
    return [...messages]
  }

  return messages.filter(message => {
    const question = message.resultFor ?? message.replyTo
    const code = message.cloudStatus?.code

    return !(
      message.notice &&
      !message.own &&
      question &&
      code &&
      (FILE_ANSWER_CODES as readonly string[]).includes(code) &&
      answered.has(`${message.sender}\n${question}`)
    )
  })
}

/** The kit's Phosphor glyph for a file's shape, by its name's extension. */
const GLYPHS: readonly [RegExp, MatrixFileGlyph][] = [
  [/\.(docx?|odt|rtf|pages)$/iu, 'file-doc'],
  [/\.(xlsx?|ods|numbers)$/iu, 'file-xls'],
  [/\.csv$/iu, 'file-csv'],
  [/\.pdf$/iu, 'file-pdf'],
  [/\.(pptx?|odp|key)$/iu, 'file-ppt'],
  [/\.(zip|rar|7z|tar|gz|tgz)$/iu, 'file-zip'],
  [/\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/iu, 'image'],
  [/\.(mp3|m4a|wav|aac|flac|ogg)$/iu, 'file-audio'],
  [/\.(txt|md|markdown)$/iu, 'file-text'],
  [/\.(json|ya?ml|js|ts|tsx|py|html?|css|sh|sql)$/iu, 'file-code']
]

export type MatrixFileGlyph =
  | 'file'
  | 'file-doc'
  | 'file-xls'
  | 'file-csv'
  | 'file-pdf'
  | 'file-ppt'
  | 'file-zip'
  | 'image'
  | 'file-audio'
  | 'file-text'
  | 'file-code'

export function matrixFileGlyph(name: string): MatrixFileGlyph {
  return GLYPHS.find(([pattern]) => pattern.test(name))?.[1] ?? 'file'
}

/**
 * The binding of a room as the window holds it: an agent's own room with the owner (never a
 * company room, a group or an app's), or a company channel with its company view's agent.
 */
export function matrixFileBindingForRoom(
  room:
    | {
        id: string
        assistant?: boolean
        agentPrincipal?: string
        companyChannel?: { companyId: string; channelId: string }
        companyConversation?: unknown
        companyPrivateCos?: unknown
      }
    | undefined,
  context: {
    ownerUserId?: string
    agents?: readonly { principal: string; userId: string }[]
    companyAgent?: { companyId: string; principal: string; userId: string }
  }
): MatrixFileBinding | undefined {
  if (!room) {
    return undefined
  }

  const agentRoom = Boolean(
    room.assistant && room.agentPrincipal && !room.companyChannel && !room.companyConversation && !room.companyPrivateCos
  )

  return {
    roomId: room.id,
    ...(context.ownerUserId ? { ownerUserId: context.ownerUserId } : {}),
    ...(context.agents ? { agents: context.agents } : {}),
    ...(agentRoom ? { roomAgentPrincipal: room.agentPrincipal } : {}),
    ...(room.companyChannel
      ? {
          companyChannel: { companyId: room.companyChannel.companyId, channelId: room.companyChannel.channelId },
          ...(context.companyAgent ? { companyAgent: context.companyAgent } : {})
        }
      : {})
  }
}
