import {
  FOLLOWUP_SWEEP_BOUNDS,
  type FollowupSweepMode,
  followupSweepPrompt,
  type FollowupSweepPromptEvidence,
  type FollowupSweepPromptSnapshot,
  type WarmupNudgeIndex,
  warmupNudgePrompt
} from './followup-sweep'

export const FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2 = 'atum.followup-sweep-evidence/2' as const

export interface AgentSourceBinding {
  connectionRef: string
  scopeRef: string
  descriptorRevision: number
  authorityRevision: number
}

export type AgentSourceSweepStatus =
  | 'ok' | 'partial' | 'not_configured' | 'not_authorized' | 'unavailable' | 'failed'
  | 'budget_skipped' | 'policy_unsupported'

export interface AgentSourceSweepEvidenceInput {
  sourceId: string
  scope: string
  objectId: string
  anchorId: string
  dueAt: number | null
  observedAt: number
  title?: string
  text: string
  fresh: boolean
  harmBeforeMorning?: boolean
  provenanceTags: string[]
  policyTags: string[]
}

export interface AgentSourceSweepEvidence extends FollowupSweepPromptEvidence {
  profile: typeof FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2
  sourceId: string
  source: string
  scope: string
  objectId: string
  anchorId: string
  provenanceTags: string[]
  policyTags: string[]
}

interface AgentSourceSweepOutcomeCommon {
  sourceId: string
  binding: AgentSourceBinding
  provenanceTags: string[]
  policyTags: string[]
}

export type AgentSourceSweepOutcome =
  | (AgentSourceSweepOutcomeCommon & { status: 'ok' | 'partial'; evidenceIds: string[] })
  | (AgentSourceSweepOutcomeCommon & {
      status: 'not_configured' | 'not_authorized' | 'unavailable' | 'failed' | 'budget_skipped'
      evidenceIds: []
    })
  | (AgentSourceSweepOutcomeCommon & {
      status: 'policy_unsupported'
      evidenceIds: []
      unsupportedPolicyTags: string[]
    })

export interface AgentSourceSweepSnapshot extends FollowupSweepPromptSnapshot {
  profile: typeof FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2
  sourceSnapshotDigest: string
  cursorDeltas: Record<string, string>
  sources: AgentSourceSweepOutcome[]
  entries: AgentSourceSweepEvidence[]
  digest: string
}

const SOURCE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/u
const TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const CURSOR = /^[ -~]{1,2048}$/u
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(',')}]`}

  if (record(value)) {return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`}

  return JSON.stringify(value) ?? 'null'
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64urlHex(value: string): string {
  const bytes = new Uint8Array(value.match(/../gu)!.map(pair => Number.parseInt(pair, 16)))
  let binary = ''

  for (const byte of bytes) {binary += String.fromCharCode(byte)}

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function scalarCharacters(value: string, maximum: number, allowEmpty = false): boolean {
  if (!allowEmpty && value.length === 0) {return false}
  let count = 0

  for (const character of value) {
    const point = character.codePointAt(0)!

    if (point >= 0xd800 && point <= 0xdfff || ++count > maximum) {return false}
  }

  return true
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 &&
    [...value].every(character => {
      const point = character.codePointAt(0)!

      return point > 0x1f && point !== 0x7f
    })
}

function sourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ID.test(value) && !RESERVED.has(value)
}

function sortedTags(values: unknown): values is string[] {
  return Array.isArray(values) && values.length <= 16 && values.every((value, index) =>
    typeof value === 'string' && TAG.test(value) && (index === 0 || values[index - 1]! < value))
}

/** Stable legacy-compatible finding hash plus an open, path-safe evidence ID. */
export async function agentSourceSweepEvidence(input: AgentSourceSweepEvidenceInput): Promise<AgentSourceSweepEvidence> {
  if (!sourceId(input.sourceId) || ![input.scope, input.objectId, input.anchorId].every(identity) ||
      input.dueAt !== null && (!Number.isSafeInteger(input.dueAt) || input.dueAt < 0) ||
      !Number.isSafeInteger(input.observedAt) || input.observedAt < 0 ||
      !scalarCharacters(input.text, FOLLOWUP_SWEEP_BOUNDS.maxEvidenceTextCharacters) ||
      input.title !== undefined && !scalarCharacters(input.title, FOLLOWUP_SWEEP_BOUNDS.maxEvidenceTitleCharacters, true) ||
      typeof input.fresh !== 'boolean' ||
      input.harmBeforeMorning !== undefined && typeof input.harmBeforeMorning !== 'boolean' ||
      !sortedTags(input.provenanceTags) || !sortedTags(input.policyTags)) {
    throw new Error('agent_source_sweep_evidence_invalid')
  }

  // Keep the v2 hash preimage used by the legacy sources so migrated findings retain dedupe.
  const findingHash = await sha256({ v: 2, source: input.sourceId, scope: input.scope,
    objectId: input.objectId, anchorId: input.anchorId, dueAt: input.dueAt })

  const id = `src:${base64urlHex(findingHash)}`

  return Object.freeze({ profile: FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2, ...input,
    source: input.sourceId, id, findingHash })
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Bounded open-source snapshot used by both cloud and later native collectors. */
export async function agentSourceSweepSnapshot(
  input: Omit<AgentSourceSweepSnapshot, 'profile' | 'digest'>
): Promise<AgentSourceSweepSnapshot> {
  const ids = input.sources.map(source => source.sourceId)
  const bySource = new Map(input.sources.map(source => [source.sourceId, source]))

  if (!Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0 ||
      typeof input.ownerTimeZone !== 'string' || input.ownerTimeZone.length < 3 || input.ownerTimeZone.length > 64 ||
      !SHA256.test(input.sourceSnapshotDigest) || input.sources.length > 64 ||
      ids.some((id, index) => !sourceId(id) || index > 0 && ids[index - 1]! >= id) ||
      Object.keys(input.cursorDeltas).length > 64 || Object.entries(input.cursorDeltas)
        .some(([id, cursor]) => !sourceId(id) || !CURSOR.test(cursor)) || jsonBytes(input.cursorDeltas) > 65_536 ||
      input.entries.length > FOLLOWUP_SWEEP_BOUNDS.maxEvidenceEntries ||
      new Set(input.entries.map(entry => entry.id)).size !== input.entries.length) {
    throw new Error('agent_source_sweep_snapshot_invalid')
  }

  for (const source of input.sources) {
    if (!sortedTags(source.provenanceTags) || !sortedTags(source.policyTags) ||
        (source.status === 'ok' || source.status === 'partial'
          ? new Set(source.evidenceIds).size !== source.evidenceIds.length ||
            source.status === 'partial' && source.evidenceIds.length === 0
          : source.evidenceIds.length !== 0) ||
        source.status === 'policy_unsupported' &&
          (!sortedTags(source.unsupportedPolicyTags) || source.unsupportedPolicyTags.length === 0)) {
      throw new Error('agent_source_sweep_snapshot_invalid')
    }
  }

  for (const [id] of Object.entries(input.cursorDeltas)) {
    const source = bySource.get(id)

    if (!source || source.status !== 'ok' && source.status !== 'partial') {
      throw new Error('agent_source_sweep_snapshot_invalid')
    }
  }

  for (const entry of input.entries) {
    const source = bySource.get(entry.sourceId)
    const evidenceIds: readonly string[] = source?.evidenceIds ?? []

    if (!source || entry.source !== entry.sourceId || !evidenceIds.includes(entry.id) ||
        !sameTags(entry.provenanceTags, source.provenanceTags) || !sameTags(entry.policyTags, source.policyTags)) {
      throw new Error('agent_source_sweep_snapshot_invalid')
    }

    const expected = await agentSourceSweepEvidence(entry)

    if (entry.id !== expected.id || entry.findingHash !== expected.findingHash) {
      throw new Error('agent_source_sweep_snapshot_invalid')
    }
  }

  const digest = await sha256({ sourceSnapshotDigest: input.sourceSnapshotDigest,
    cursorDeltas: input.cursorDeltas, sources: input.sources,
    entries: input.entries.map(({ sourceId: id, scope, objectId, anchorId, dueAt, observedAt }) =>
      ({ sourceId: id, scope, objectId, anchorId, dueAt, observedAt })) })

  return Object.freeze({ profile: FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2, ...input,
    sources: input.sources.map(source => Object.freeze({ ...source })),
    entries: input.entries.map(entry => Object.freeze({ ...entry })), digest })
}

/** Prompt fitting never drops retained evidence, so a provider-proven cursor remains sound. */
export async function fitAgentSourceSweepSnapshot(
  snapshot: AgentSourceSweepSnapshot,
  mode: FollowupSweepMode | { warmup: WarmupNudgeIndex } = 'finding',
  options: { previousSuggestion?: string | undefined } = {}
): Promise<AgentSourceSweepSnapshot> {
  const entries = snapshot.entries.map(entry => ({ ...entry }))

  while (true) {
    const candidate = await agentSourceSweepSnapshot({ capturedAt: snapshot.capturedAt,
      ownerTimeZone: snapshot.ownerTimeZone, sourceSnapshotDigest: snapshot.sourceSnapshotDigest,
      cursorDeltas: snapshot.cursorDeltas, sources: snapshot.sources, entries })

    try {
      typeof mode === 'object' ? warmupNudgePrompt(candidate, mode.warmup) : followupSweepPrompt(candidate, mode, options)

      return candidate
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'followup_sweep_prompt_too_large') {throw error}
    }

    const longest = entries.reduce((best, entry, index) =>
      [...entry.text].length > [...entries[best]!.text].length ? index : best, 0)

    const text = [...entries[longest]!.text]

    if (text.length > 1) {
      entries[longest] = { ...entries[longest]!, text: text.slice(0, Math.max(1, Math.floor(text.length / 2))).join('') }

      continue
    }

    const titled = entries.findIndex(entry => entry.title !== undefined)

    if (titled >= 0) {
      const { title: _title, ...entry } = entries[titled]!
      entries[titled] = entry

      continue
    }

    throw new Error('followup_sweep_prompt_too_large')
  }
}

export function agentSourceSnapshotHasTag(snapshot: AgentSourceSweepSnapshot, tag: string): boolean {
  return snapshot.entries.some(entry => entry.provenanceTags.includes(tag) || entry.policyTags.includes(tag))
}
