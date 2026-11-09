/**
 * The closed, owner-authorized assistant-definition contract.  This module is
 * deliberately free of Electron and renderer concerns so both transport sides
 * agree on the exact data that may cross the local materialization boundary.
 */

export const ATUM_AGENT_PORTABILITY_SCHEMA_VERSION = 1 as const

export type AtumPortableReasoningEffort = null | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AtumPortableReasoning {
  enabled: boolean
  effort: AtumPortableReasoningEffort
}

export interface AtumPortableSkillRef {
  name: string
  sha256: string
}

export interface AtumPortableAssistantDefinition {
  schemaVersion: typeof ATUM_AGENT_PORTABILITY_SCHEMA_VERSION
  soul: string
  modelAlias: 'binh-minh' | 'nguyet-thuc' | 'nhat-thuc'
  reasoning: AtumPortableReasoning | null
  skills: AtumPortableSkillRef[]
}

export interface AtumPortableAssistantIdentity {
  identityId: string
  displayName: string
  avatar: string
}

export const ATUM_ASSISTANT_MARK_SHAPES = [
  'circle', 'rounded_square', 'diamond', 'spark', 'clover', 'heart', 'flower',
  'drop', 'pebble', 'triangle', 'pentagon', 'star', 'hexagon'
] as const
export const ATUM_ASSISTANT_MARK_COLORS = [
  'snow', 'earth', 'coral', 'orange', 'amber', 'mint', 'teal', 'blue', 'violet', 'pink', 'stone'
] as const

export interface AtumAssistantMark {
  shape: (typeof ATUM_ASSISTANT_MARK_SHAPES)[number]
  color: (typeof ATUM_ASSISTANT_MARK_COLORS)[number]
}

/** Existing owner registry projection carried beside a private definition. */
export interface AtumPortableAssistantRecord extends AtumPortableAssistantIdentity {
  id: string
  avatarUrl: string | null
  isDefault: boolean
  lifecycleRevision: number
  status: 'active' | 'retired'
  identityRevision: number
  definitionRevision: number
  title?: string
  mark?: AtumAssistantMark
}

export interface AtumAssistantDefinitionSnapshot {
  assistant: AtumPortableAssistantRecord
  definition: AtumPortableAssistantDefinition
  definitionRevision: number
  identityRevision: number
}

export interface AtumAssistantDefinitionWrite {
  expectedDefinitionRevision: number
  expectedIdentityRevision: number
  displayName: string
  avatar: string
  definition: AtumPortableAssistantDefinition
}

type JsonRecord = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[a-f0-9]{64}$/u
const MODEL_ALIASES = new Set(['binh-minh', 'nguyet-thuc', 'nhat-thuc'])

const REASONING_EFFORTS = new Set<AtumPortableReasoningEffort>([
  null,
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

const encoder = new TextEncoder()

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value as JsonRecord
}

function string(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function revision(value: unknown, label: string, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) {
    throw new Error(`invalid_response:${label}`)
  }

  return Number(value)
}

function printable(value: string): boolean {
  return !Array.from(value).some(character => {
    const point = character.codePointAt(0) ?? 0

    return point < 0x20 || point === 0x7f
  })
}

export function parseAtumPortableDefinition(value: unknown, label = 'definition'): AtumPortableAssistantDefinition {
  const input = object(value, label)

  if (input.schema_version !== ATUM_AGENT_PORTABILITY_SCHEMA_VERSION) {
    throw new Error(`invalid_response:${label}.schema_version`)
  }

  const soul = input.soul

  if (typeof soul !== 'string' || encoder.encode(soul).byteLength > 65_536) {
    throw new Error(`invalid_response:${label}.soul`)
  }

  if (!MODEL_ALIASES.has(input.model_alias as string)) {
    throw new Error(`invalid_response:${label}.model_alias`)
  }

  const reasoningRaw = input.reasoning
  let reasoning: AtumPortableReasoning | null = null

  if (reasoningRaw !== null) {
    const row = object(reasoningRaw, `${label}.reasoning`)

    if (typeof row.enabled !== 'boolean' || !REASONING_EFFORTS.has(row.effort as AtumPortableReasoningEffort)
      || (row.enabled ? row.effort === null : row.effort !== null)) {
      throw new Error(`invalid_response:${label}.reasoning`)
    }

    reasoning = { enabled: row.enabled, effort: row.effort as AtumPortableReasoningEffort }
  }

  if (!Array.isArray(input.skills) || input.skills.length > 512) {
    throw new Error(`invalid_response:${label}.skills`)
  }

  const skills = input.skills.map((raw, index) => {
    const skill = object(raw, `${label}.skills[${index}]`)
    const name = string(skill.name, `${label}.skills[${index}].name`, 200)
    const sha256 = string(skill.sha256, `${label}.skills[${index}].sha256`, 64)

    if (name.split('/').some(part => part === '' || part === '.' || part === '..')
      || !printable(name) || name.includes('\\') || !SHA256.test(sha256)) {
      throw new Error(`invalid_response:${label}.skills[${index}]`)
    }

    return { name, sha256 }
  })

  if (new Set(skills.map(skill => skill.name)).size !== skills.length) {
    throw new Error(`invalid_response:${label}.skills`)
  }

  return {
    schemaVersion: 1,
    soul,
    modelAlias: input.model_alias as AtumPortableAssistantDefinition['modelAlias'],
    reasoning,
    skills
  }
}

/** The owner registry projection accepted beside a portable definition. */
export function parseAtumPortableAssistantRecord(
  value: unknown,
  label = 'assistant_definition.assistant',
  allowRetired = false
): AtumPortableAssistantRecord {
  const assistant = object(value, label)
  const id = string(assistant.id, `${label}.id`)
  const identityId = string(assistant.identity_id, `${label}.identity_id`)
  const displayName = string(assistant.display_name, `${label}.display_name`)
  const avatar = typeof assistant.avatar === 'string' ? assistant.avatar : ''

  const avatarUrl =
    assistant.avatar_url === null || assistant.avatar_url === undefined
      ? null
      : string(assistant.avatar_url, `${label}.avatar_url`, 2048)

  const lifecycleRevision = revision(assistant.lifecycle_revision, `${label}.lifecycle_revision`)
  const status = assistant.status === 'active' || assistant.status === 'retired' ? assistant.status : null
  const definitionRevision = revision(assistant.definition_revision, `${label}.definition_revision`, true)
  const identityRevision = revision(assistant.identity_revision, `${label}.identity_revision`)
  const title = assistant.title === null || assistant.title === undefined
    ? undefined
    : string(assistant.title, `${label}.title`, 80)
  const markShape = assistant.mark_shape
  const markColor = assistant.mark_color
  const mark = markShape === undefined && markColor === undefined
    ? undefined
    : typeof markShape === 'string' && typeof markColor === 'string'
      && (ATUM_ASSISTANT_MARK_SHAPES as readonly string[]).includes(markShape)
      && (ATUM_ASSISTANT_MARK_COLORS as readonly string[]).includes(markColor)
      ? { shape: markShape as AtumAssistantMark['shape'], color: markColor as AtumAssistantMark['color'] }
      : null

  if (
    !UUID.test(id) ||
    !UUID.test(identityId) ||
    // Match the canonical PostgreSQL char_length limits, not UTF-16 units.
    Array.from(displayName).length > 40 ||
    !printable(displayName) ||
    !printable(avatar) ||
    Array.from(avatar).length > 16 ||
    (status !== 'active' && !(allowRetired && status === 'retired')) ||
    typeof assistant.is_default !== 'boolean' ||
    (title !== undefined && (!printable(title) || title.trim() !== title)) ||
    mark === null
  ) {
    throw new Error(`invalid_response:${label}`)
  }

  return {
    id,
    identityId,
    displayName,
    avatar,
    avatarUrl,
    isDefault: assistant.is_default,
    lifecycleRevision,
    status,
    identityRevision,
    definitionRevision,
    ...(title === undefined ? {} : { title }),
    ...(mark === undefined ? {} : { mark })
  }
}

export function parseAtumAssistantDefinitionSnapshot(value: unknown): AtumAssistantDefinitionSnapshot {
  const root = object(value, 'assistant_definition')
  const assistant = parseAtumPortableAssistantRecord(root.assistant)
  const definitionRevision = revision(root.definition_revision, 'assistant_definition.definition_revision', true)
  const identityRevision = revision(root.identity_revision, 'assistant_definition.identity_revision')

  if (
    assistant.definitionRevision !== definitionRevision ||
    assistant.identityRevision !== identityRevision
  ) {
    throw new Error('invalid_response:assistant_definition.assistant')
  }

  return {
    assistant,
    definition: parseAtumPortableDefinition(root.definition),
    definitionRevision,
    identityRevision
  }
}

/** Canonical wire shape shared by hosted writes and main-owned tickets. */
export function portableDefinitionWire(definition: AtumPortableAssistantDefinition): Record<string, unknown> {
  return {
    schema_version: definition.schemaVersion,
    soul: definition.soul,
    model_alias: definition.modelAlias,
    reasoning: definition.reasoning,
    skills: definition.skills
  }
}

export function assistantDefinitionWriteWire(input: AtumAssistantDefinitionWrite): Record<string, unknown> {
  const snapshot = parseAtumAssistantDefinitionSnapshot({
    assistant: {
      id: '00000000-0000-4000-8000-000000000000',
      identity_id: '00000000-0000-4000-8000-000000000000',
      display_name: input.displayName,
      avatar: input.avatar,
      avatar_url: null,
      is_default: false,
      lifecycle_revision: 1,
      status: 'active',
      identity_revision: input.expectedIdentityRevision,
      definition_revision: input.expectedDefinitionRevision
    },
    definition: portableDefinitionWire(input.definition),
    definition_revision: input.expectedDefinitionRevision,
    identity_revision: input.expectedIdentityRevision
  })

  return {
    expected_definition_revision: snapshot.definitionRevision,
    expected_identity_revision: snapshot.identityRevision,
    display_name: snapshot.assistant.displayName,
    avatar: snapshot.assistant.avatar,
    definition: portableDefinitionWire(snapshot.definition)
  }
}
