import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type { AtumSkillBundle } from '../shared/atum-agent-content'
import {
  type AtumAssistantDefinitionSnapshot,
  type AtumAssistantDefinitionWrite,
  type AtumPortableAssistantDefinition,
  type AtumPortableAssistantIdentity,
  parseAtumPortableDefinition,
  portableDefinitionWire
} from '../shared/atum-agent-portability'

import { accountKeyFor, type AccountRootAuthority } from './atum-messaging/account-roots'
import type { RegisteredAssistant } from './atum-messaging/types'

const TICKET_TTL_SECONDS = 90
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[a-f0-9]{64}$/u

export interface AtumPortabilitySession {
  user: { id: string }
}

export interface AtumPortableProfile {
  name: string
  identityId: string
  displayName: string
  avatar: string
  managedBy: 'atum'
  definitionRevision?: number
  identityRevision?: number
}

/**
 * A skill Hermes resolved from this device's own shipped tree instead of the
 * account's bytes: an entitled catalog skill whose local build differs from
 * the one recorded in the cloud. The hash difference is a device fact, not a
 * divergence — the account never holds catalog-owned bytes to reconcile it
 * against, so a sync that treats it as one can never converge (re-review
 * 2026-09-12).
 */
export interface AtumSkillHashMismatch {
  name: string
  expectedSha256: string
  actualSha256: string
}

export type AtumMaterializeResult =
  | {
      ok: true
      status: 'materialized' | 'reused' | 'applied'
      profile: AtumPortableProfile
      skillHashMismatches?: AtumSkillHashMismatch[]
    }
  | { ok: false; status: 'missing_skills'; missingSkills: Array<{ name: string; sha256: string }> }

export type AtumLegacyImportResult =
  | { ok: true; status: 'imported'; profile: AtumPortableProfile }
  | { ok: false; status: 'legacy_source_absent' | 'definition_exists' }
  | { ok: false; status: 'missing_skills'; missingSkills: Array<{ name: string; sha256: string }> }

export interface AtumAssistantPortabilityServiceOptions {
  accountRoots: AccountRootAuthority
  /** Main-only account custody. This is never a renderer supplied identity. */
  session: () => AtumPortabilitySession | null
  listAssistants: () => Promise<RegisteredAssistant[]>
  getAssistantDefinition: (assistantId: string) => Promise<AtumAssistantDefinitionSnapshot>
  putAssistantDefinition: (
    assistantId: string,
    input: AtumAssistantDefinitionWrite
  ) => Promise<AtumAssistantDefinitionSnapshot>
  /** Main's authenticated loopback request seam. The only request body is ticket_id. */
  materialize: (body: { ticket_id: string }) => Promise<unknown>
  /** Main's authenticated loopback export endpoint. It receives only ticket_id. */
  exportLegacy: (body: { ticket_id: string }) => Promise<unknown>
  content?: (body: { ticket_id: string }) => Promise<unknown>
  getSkill?: (assistantId: string, sha256: string) => Promise<AtumSkillBundle>
  /** The original immutable machine home, supplied only by Electron main. */
  legacyHome: string
  /** A fixed main-owned marker path that the local backend consults per request. */
  ticketRootMarkerPath: string
  now?: () => number
}

interface AccountFence {
  accountId: string
  accountKey: string
  generation: number
  ticketRoot: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function profile(value: unknown, identity: AtumPortableAssistantIdentity): AtumPortableProfile {
  const source = record(value, 'materialize.profile')
  const name = text(source.name, 'materialize.profile.name', 256)
  const identityId = text(source.identity_id, 'materialize.profile.identity_id', 64)
  const displayName = text(source.display_name, 'materialize.profile.display_name', 40)
  const avatar = typeof source.avatar === 'string' && source.avatar.length <= 16 ? source.avatar : ''

  if (
    !UUID.test(identityId) ||
    identityId !== identity.identityId ||
    displayName !== identity.displayName ||
    avatar !== identity.avatar ||
    source.managed_by !== 'atum'
  ) {
    throw new Error('invalid_response:materialize.profile')
  }

  return { name, identityId, displayName, avatar, managedBy: 'atum' }
}

/** `skill_hash_mismatches` from `hermes_cli/atum_portability.py`, or none. */
function skillHashMismatches(value: unknown): AtumSkillHashMismatch[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry, index) => {
    const mismatch = record(entry, `materialize.skill_hash_mismatches[${index}]`)
    const name = text(mismatch.name, `materialize.skill_hash_mismatches[${index}].name`, 200)
    const expectedSha256 = text(mismatch.expected_sha256, `materialize.skill_hash_mismatches[${index}].expected_sha256`, 64)
    const actualSha256 = text(mismatch.actual_sha256, `materialize.skill_hash_mismatches[${index}].actual_sha256`, 64)

    if (!SHA256.test(expectedSha256) || !SHA256.test(actualSha256)) {
      throw new Error('invalid_response:materialize.skill_hash_mismatches')
    }

    return { name, expectedSha256, actualSha256 }
  })
}

function parseMaterializeResult(value: unknown, identity: AtumPortableAssistantIdentity): AtumMaterializeResult {
  const source = record(value, 'materialize')

  if (
    source.ok === true &&
    (source.status === 'materialized' || source.status === 'reused' || source.status === 'applied')
  ) {
    const mismatches = skillHashMismatches(source.skill_hash_mismatches)

    return {
      ok: true,
      status: source.status,
      profile: profile(source.profile, identity),
      ...(mismatches.length > 0 ? { skillHashMismatches: mismatches } : {})
    }
  }

  if (source.ok === false && source.status === 'missing_skills' && Array.isArray(source.missing_skills)) {
    const missingSkills = source.missing_skills.map((value, index) => {
      const skill = record(value, `materialize.missing_skills[${index}]`)
      const name = text(skill.name, `materialize.missing_skills[${index}].name`, 200)
      const sha256 = text(skill.sha256, `materialize.missing_skills[${index}].sha256`, 64)

      if (!SHA256.test(sha256)) {
        throw new Error('invalid_response:materialize.missing_skills')
      }

      return { name, sha256 }
    })

    return { ok: false, status: 'missing_skills', missingSkills }
  }

  throw new Error('invalid_response:materialize')
}

function parseLegacyExportResult(
  value: unknown,
  expectedIdentityId: string
): { assistant: AtumPortableAssistantIdentity; definition: AtumPortableAssistantDefinition } | null {
  const source = record(value, 'legacy_export')

  if (source.ok === false && source.status === 'legacy_source_absent') {
    return null
  }

  if (source.ok !== true || source.status !== 'exported') {
    throw new Error('invalid_response:legacy_export')
  }

  const assistant = record(source.assistant, 'legacy_export.assistant')
  const identityId = text(assistant.identity_id, 'legacy_export.assistant.identity_id', 64)
  const displayName = text(assistant.display_name, 'legacy_export.assistant.display_name', 40)
  const avatar = typeof assistant.avatar === 'string' && assistant.avatar.length <= 16 ? assistant.avatar : ''

  if (
    !UUID.test(identityId) ||
    identityId !== expectedIdentityId ||
    Array.from(displayName).some(character => {
      const code = character.codePointAt(0) ?? 0

      return code < 0x20 || code === 0x7f
    }) ||
    Array.from(avatar).some(character => {
      const code = character.codePointAt(0) ?? 0

      return code < 0x20 || code === 0x7f
    })
  ) {
    throw new Error('invalid_response:legacy_export.assistant')
  }

  return {
    assistant: { identityId, displayName, avatar },
    definition: parseAtumPortableDefinition(source.definition, 'legacy_export.definition')
  }
}

/**
 * Main-process custody for the one-use local materialization ticket. The cloud
 * bearer remains in the existing HTTP client; neither it, the ticket id, nor
 * the fetched snapshot crosses preload.
 */
export class AtumAssistantPortabilityService {
  private readonly now: () => number

  constructor(private readonly options: AtumAssistantPortabilityServiceOptions) {
    this.now = options.now ?? (() => Date.now())

    if (!isAbsolute(options.ticketRootMarkerPath)) {
      throw new Error('invalid_ticket_root_marker')
    }

    if (!isAbsolute(options.legacyHome)) {
      throw new Error('invalid_legacy_home')
    }
  }

  /** Called by account activation only after account-root authority commits. */
  activateAccount(accountId: string): void {
    const fence = this.captureFence()

    if (fence.accountId !== accountId) {
      throw new Error('account_context_mismatch')
    }

    this.writeMarker(fence.ticketRoot)
  }

  /** Called before outgoing account authority is released. */
  revokeAccount(accountId: string, generation: number): void {
    const committed = this.options.accountRoots.committed()

    if (committed?.marker.accountKey === accountKeyFor(accountId) && committed.marker.generation === generation) {
      rmSync(this.options.ticketRootMarkerPath, { force: true })
    }
  }

  async materializeAssistant(assistantId: string): Promise<AtumMaterializeResult> {
    if (!UUID.test(assistantId)) {
      throw new Error('assistant_id_invalid')
    }

    const fence = this.captureFence()
    const snapshot = await this.options.getAssistantDefinition(assistantId)
    this.assertFence(fence)

    return this.materializeSnapshot(fence, snapshot)
  }

  /**
   * Explicitly apply the current cloud definition to its existing local
   * managed profile. Main obtains the snapshot; renderer supplies only its id.
   */
  async applyAssistantDefinition(
    assistantId: string,
    expectedLocalDefinition?: AtumPortableAssistantDefinition
  ): Promise<AtumMaterializeResult> {
    if (!UUID.test(assistantId)) {
      throw new Error('assistant_id_invalid')
    }

    const fence = this.captureFence()
    const snapshot = await this.options.getAssistantDefinition(assistantId)
    this.assertFence(fence)

    return this.materializeSnapshot(fence, snapshot, true, expectedLocalDefinition)
  }

  /** Main-only content operations: callers supply a record from the owner roster. */
  async runContent(
    assistant: Pick<RegisteredAssistant, 'identityId'> & Partial<Pick<RegisteredAssistant, 'isDefault'>>,
    operation: string,
    payload: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.options.content || !assistant.identityId || !UUID.test(assistant.identityId))
      {throw new Error('content_sync_unavailable')}

    const fence = this.captureFence()
    const ticketId = randomUUID()
    const ticketPath = join(fence.ticketRoot, `${ticketId}.json`)
    this.writeTicket(ticketPath, ticketId, {
      ...payload,
      operation,
      account_id: fence.accountId,
      expires_at: Math.floor(this.now() / 1_000) + TICKET_TTL_SECONDS,
      identity_id: assistant.identityId,
      is_default: assistant.isDefault === true
    })

    try {
      this.assertFence(fence)
      this.writeMarker(fence.ticketRoot)
      const result = await this.options.content({ ticket_id: ticketId })
      this.assertFence(fence)

      return result
    } finally {
      rmSync(ticketPath, { force: true })
    }
  }

  /**
   * Deliberate upgrade bridge for pre-portability profiles in the original
   * machine home. The renderer supplies a hosted row id only; main obtains the
   * owner-scoped identity and the backend finds a matching managed profile by
   * that exact identity. No name, profile key, or path crosses IPC.
   */
  async importLegacyAssistant(assistantId: string): Promise<AtumLegacyImportResult> {
    if (!UUID.test(assistantId)) {
      throw new Error('assistant_id_invalid')
    }

    const fence = this.captureFence()
    const assistant = (await this.options.listAssistants()).find(row => row.id === assistantId)
    this.assertFence(fence)

    if (!assistant || assistant.status !== 'active' || !assistant.identityId) {
      throw new Error('assistant_not_found')
    }

    if (assistant.definitionRevision > 0) {
      return { ok: false, status: 'definition_exists' }
    }

    const ticketId = randomUUID()
    const ticketPath = join(fence.ticketRoot, `${ticketId}.json`)
    this.writeLegacyExportTicket(ticketPath, ticketId, fence.accountId, assistant)

    let exported: { assistant: AtumPortableAssistantIdentity; definition: AtumPortableAssistantDefinition } | null

    try {
      this.assertFence(fence)
      this.writeMarker(fence.ticketRoot)
      exported = parseLegacyExportResult(await this.options.exportLegacy({ ticket_id: ticketId }), assistant.identityId)
      this.assertFence(fence)
    } finally {
      rmSync(ticketPath, { force: true })
    }

    if (!exported) {
      return { ok: false, status: 'legacy_source_absent' }
    }

    const snapshot = await this.options.putAssistantDefinition(assistantId, {
      expectedDefinitionRevision: assistant.definitionRevision,
      expectedIdentityRevision: assistant.identityRevision,
      displayName: exported.assistant.displayName,
      avatar: exported.assistant.avatar,
      definition: exported.definition
    })

    this.assertFence(fence)
    const materialized = await this.materializeSnapshot(fence, snapshot)

    if (materialized.ok === false && materialized.status === 'missing_skills') {
      return { ok: false, status: 'missing_skills', missingSkills: materialized.missingSkills }
    }

    if (materialized.ok === true) {
      return { ok: true, status: 'imported', profile: materialized.profile }
    }

    throw new Error('invalid_response:materialize')
  }

  private async materializeSnapshot(
    fence: AccountFence,
    snapshot: AtumAssistantDefinitionSnapshot,
    applyExisting = false,
    expectedLocalDefinition?: AtumPortableAssistantDefinition,
    fetchMissing = true
  ): Promise<AtumMaterializeResult> {
    const ticketId = randomUUID()
    const ticketPath = join(fence.ticketRoot, `${ticketId}.json`)
    this.writeMaterializationTicket(
      ticketPath,
      ticketId,
      fence.accountId,
      snapshot,
      applyExisting,
      expectedLocalDefinition
    )

    try {
      this.assertFence(fence)
      // The Python endpoint reads this path only from the main-owned marker.
      // Refresh it immediately before the local request in case a backend was
      // restarted after account activation.
      this.writeMarker(fence.ticketRoot)
      const result = await this.options.materialize({ ticket_id: ticketId })
      this.assertFence(fence)

      const parsed = parseMaterializeResult(result, snapshot.assistant)

      if (parsed.ok === false && fetchMissing && this.options.getSkill && this.options.content) {
        for (const skill of parsed.missingSkills) {
          const bundle = await this.options.getSkill(snapshot.assistant.id, skill.sha256)
          this.assertFence(fence)
          await this.runContent(snapshot.assistant, 'install_skill', { bundle })
          this.assertFence(fence)
        }

        return this.materializeSnapshot(fence, snapshot, applyExisting, expectedLocalDefinition, false)
      }

      // A reused local profile may still contain an older definition. Only a
      // real install/apply proves which cloud version is on this computer.
      if (parsed.ok && parsed.status !== 'reused') {
        parsed.profile.definitionRevision = snapshot.definitionRevision
        parsed.profile.identityRevision = snapshot.identityRevision
      }

      return parsed
    } finally {
      // Successful backends consume it themselves; failures and stale account
      // transitions must never leave a usable ticket behind.
      rmSync(ticketPath, { force: true })
    }
  }

  private captureFence(): AccountFence {
    const session = this.options.session()

    if (!session?.user.id) {
      throw new Error('auth_unavailable')
    }

    const committed = this.options.accountRoots.committed()
    const accountKey = accountKeyFor(session.user.id)

    if (!committed || committed.marker.accountKey !== accountKey) {
      throw new Error('account_context_mismatch')
    }

    const paths = this.options.accountRoots.pathsForAccount(session.user.id)

    return {
      accountId: session.user.id,
      accountKey,
      generation: committed.marker.generation,
      ticketRoot: join(paths.hermesStateRoot, '.atum-portability', 'tickets')
    }
  }

  private assertFence(expected: AccountFence): void {
    const current = this.options.session()
    const committed = this.options.accountRoots.committed()

    if (
      current?.user.id !== expected.accountId ||
      !committed ||
      committed.marker.accountKey !== expected.accountKey ||
      committed.marker.generation !== expected.generation
    ) {
      throw new Error('account_context_changed')
    }
  }

  private writeMaterializationTicket(
    path: string,
    ticketId: string,
    accountId: string,
    snapshot: AtumAssistantDefinitionSnapshot,
    applyExisting = false,
    expectedLocalDefinition?: AtumPortableAssistantDefinition
  ): void {
    this.writeTicket(path, ticketId, {
      account_id: accountId,
      expires_at: Math.floor(this.now() / 1_000) + TICKET_TTL_SECONDS,
      assistant: {
        identity_id: snapshot.assistant.identityId,
        is_default: snapshot.assistant.isDefault === true,
        display_name: snapshot.assistant.displayName,
        avatar: snapshot.assistant.avatar
      },
      definition: portableDefinitionWire(snapshot.definition),
      definition_revision: snapshot.definitionRevision,
      identity_revision: snapshot.identityRevision,
      // Only the identity-matched legacy profile may supply exact skill
      // hashes missing from this account root. This path never comes from IPC.
      legacy_home: this.options.legacyHome,
      ...(expectedLocalDefinition
        ? { expected_local_definition: portableDefinitionWire(expectedLocalDefinition) }
        : {}),
      ...(applyExisting ? { apply_existing: true } : {})
    })
  }

  private writeLegacyExportTicket(
    path: string,
    ticketId: string,
    accountId: string,
    assistant: RegisteredAssistant
  ): void {
    this.writeTicket(path, ticketId, {
      operation: 'export_legacy',
      account_id: accountId,
      expires_at: Math.floor(this.now() / 1_000) + TICKET_TTL_SECONDS,
      assistant: {
        identity_id: assistant.identityId!,
        display_name: assistant.displayName,
        avatar: assistant.avatar
      },
      legacy_home: this.options.legacyHome
    })
  }

  private writeTicket(path: string, ticketId: string, body: Record<string, unknown>): void {
    if (!UUID.test(ticketId)) {
      throw new Error('ticket_id_invalid')
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    const temporary = `${path}.${randomUUID()}.tmp`

    writeFileSync(temporary, JSON.stringify(body), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  }

  private writeMarker(ticketRoot: string): void {
    mkdirSync(dirname(this.options.ticketRootMarkerPath), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.options.ticketRootMarkerPath), 0o700)
    const temporary = `${this.options.ticketRootMarkerPath}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${ticketRoot}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.options.ticketRootMarkerPath)
    chmodSync(this.options.ticketRootMarkerPath, 0o600)
  }
}
