import { createHash } from 'node:crypto'

import type { SharedGroupDevice } from './shared-group-device'
import type { SharedGroupPersonaSnapshot, SharedGroupRunnerOptions } from './shared-group-runner'
import type { RegisteredAssistant } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/iu
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const MAX_SOUL_BYTES = 64 * 1024

export type SharedGroupModelAlias = 'binh-minh' | 'nguyet-thuc' | 'nhat-thuc'

export interface SharedGroupPersonaPreview {
  content: string
  digest: string
  identityId: string
  approvalRevision: number | null
  approved: boolean
  modelAlias: SharedGroupModelAlias
}

export interface SharedGroupControlOptions {
  account: () => { accountId: string; baseUrl: string } | null
  listAssistants: () => Promise<RegisteredAssistant[]>
  profileRequest: (path: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>) => Promise<unknown>
  isLocalProfile: (profile: string) => boolean
  device: Pick<SharedGroupDevice, 'enable' | 'bindAgent' | 'unbindAgent'>
  stopRunner?: () => void
}

interface AccountScope {
  accountId: string
  baseUrl: string
  generation: number
}

interface LocalProfile {
  name: string
  identityId: string
}

interface ResolvedPersona {
  assistantId: string
  profile: LocalProfile
}

interface PersonaSnapshot extends SharedGroupPersonaPreview {
  soulBytes: Buffer
}

function fail(code: string): never {
  throw new Error(`shared_group_control_${code}`)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validProfileName(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_NAME.test(value)
}

function assistantId(value: unknown): string {
  if (!validUuid(value)) {
    fail('invalid_input')
  }

  return value
}

function profileName(value: unknown): string {
  if (!validProfileName(value)) {
    fail('invalid_input')
  }

  return value
}

/**
 * Electron-main-only consent bridge. It resolves the remotely registered
 * assistant back to a local profile identity before touching local SOUL bytes.
 */
export class SharedGroupControl {
  private generation = 0

  constructor(private readonly options: SharedGroupControlOptions) {}

  /**
   * Invalidates in-flight control work when the desktop session is revoked or
   * the process is quitting. Callers must invoke this before replacing account
   * state, including an A → B → A account transition.
   */
  invalidate(): void {
    this.generation += 1
  }

  async preview(input: { assistantId: string; profile: string }): Promise<SharedGroupPersonaPreview> {
    const scope = this.scope()
    const resolved = await this.resolve(input, scope)
    const snapshot = await this.readSnapshot(resolved, scope)

    return this.publicSnapshot(snapshot)
  }

  async approve(input: { assistantId: string; profile: string; expectedDigest: string }): Promise<{ ok: true }> {
    const expectedDigest = input.expectedDigest?.toLowerCase()

    if (!validDigest(expectedDigest)) {
      fail('invalid_input')
    }

    const scope = this.scope()
    const resolved = await this.resolve(input, scope)
    const before = await this.readSnapshot(resolved, scope)

    if (before.digest !== expectedDigest) {
      fail('digest_changed')
    }

    // A retry completes the device connection without inventing a new consent
    // revision for bytes the owner already approved. Revalidate below either way.
    const approvalResponse = before.approved ? before : await this.request(
      `/api/profiles/${encodeURIComponent(resolved.profile.name)}/shared-persona/approve`,
      'POST',
      { expected_digest: expectedDigest },
      scope,
    )

    // POST returns the same snapshot schema as preview. The following GET is
    // deliberate: it is the authoritative state we bind and later hand to the
    // runner, after the mutation has committed.
    if (!record(approvalResponse)) {
      fail('approval_rejected')
    }

    // Re-read the locally authoritative bytes after the approval mutation.
    const snapshot = await this.readSnapshot(resolved, scope)

    if (!snapshot.approved || snapshot.digest !== expectedDigest || snapshot.approvalRevision === null) {
      fail('approval_not_current')
    }

    // Device registration is an explicit-consent consequence, never a preview
    // side effect. A failed remote bind leaves this locally truthful approval.
    await this.enableDevice(scope)
    await this.bindDevice({
      assistantId: resolved.assistantId,
      profileIdentity: snapshot.identityId,
      modelAlias: snapshot.modelAlias,
      personaDigest: snapshot.digest,
      personaRevision: snapshot.approvalRevision,
    }, scope)

    return { ok: true }
  }

  async revoke(input: { assistantId: string; profile: string }): Promise<{ ok: true }> {
    const scope = this.scope()
    const resolved = await this.resolve(input, scope)
    await this.readSnapshot(resolved, scope)

    // Stop local execution before removing the remote binding, then leave the
    // local approval intact if the remote unbind cannot be confirmed.
    try {
      this.options.stopRunner?.()
    } catch {
      fail('runner_stop_failed')
    }

    await this.unbindDevice(resolved.assistantId, scope)

    const revoked = await this.request(
      `/api/profiles/${encodeURIComponent(resolved.profile.name)}/shared-persona/approve`,
      'DELETE',
      undefined,
      scope,
    )

    if (record(revoked)?.ok !== true) {
      fail('revocation_rejected')
    }

    const snapshot = await this.readSnapshot(resolved, scope)

    if (snapshot.approved || snapshot.approvalRevision !== null) {
      fail('revocation_not_current')
    }

    return { ok: true }
  }

  /** Bound directly to SharedGroupRunnerOptions.persona; it accepts no renderer profile. */
  persona: SharedGroupRunnerOptions['persona'] = async (input): Promise<SharedGroupPersonaSnapshot> => {
    if (!validUuid(input.assistantId) || !validUuid(input.profileIdentity) || !validDigest(input.personaDigest) || !validRevision(input.personaRevision)) {
      fail('invalid_runner_input')
    }

    const scope = this.scope()
    const resolved = await this.resolveByIdentity(input.assistantId, input.profileIdentity, scope)
    const snapshot = await this.readSnapshot(resolved, scope)

    if (
      !snapshot.approved ||
      snapshot.identityId !== input.profileIdentity ||
      snapshot.digest !== input.personaDigest.toLowerCase() ||
      snapshot.approvalRevision !== input.personaRevision
    ) {
      fail('approval_not_current')
    }

    return {
      assistantId: resolved.assistantId,
      profileIdentity: snapshot.identityId,
      personaDigest: snapshot.digest,
      personaRevision: snapshot.approvalRevision,
      soulBytes: snapshot.soulBytes,
    }
  }

  private scope(): AccountScope {
    const current = this.options.account()

    if (!current || !validUuid(current.accountId) || typeof current.baseUrl !== 'string' || !current.baseUrl) {
      fail('not_authenticated')
    }

    return { accountId: current.accountId, baseUrl: current.baseUrl, generation: this.generation }
  }

  private assertScope(scope: AccountScope): void {
    const current = this.options.account()

    if (
      !current
      || current.accountId !== scope.accountId
      || current.baseUrl !== scope.baseUrl
      || this.generation !== scope.generation
    ) {
      fail('account_changed')
    }
  }

  private localProfile(name: string): void {
    let isLocal = false

    try {
      isLocal = this.options.isLocalProfile(name)
    } catch {
      fail('profile_not_local')
    }

    if (!isLocal) {
      fail('profile_not_local')
    }
  }

  private async resolve(input: { assistantId: string; profile: string }, scope: AccountScope): Promise<ResolvedPersona> {
    const id = assistantId(input.assistantId)
    const name = profileName(input.profile)
    this.localProfile(name)
    const assistants = await this.options.listAssistants()
    this.assertScope(scope)
    const assistant = assistants.filter(row => row.id === id && row.status === 'active' && validUuid(row.identityId))

    if (assistant.length !== 1 || !assistant[0]?.identityId) {
      fail('assistant_not_owned')
    }

    const profile = await this.profileByName(name, scope)

    if (profile.identityId !== assistant[0].identityId) {
      fail('identity_mismatch')
    }

    return { assistantId: id, profile }
  }

  private async resolveByIdentity(id: string, identityId: string, scope: AccountScope): Promise<ResolvedPersona> {
    const assistants = await this.options.listAssistants()
    this.assertScope(scope)
    const assistant = assistants.filter(row => row.id === id && row.status === 'active' && row.identityId === identityId)

    if (assistant.length !== 1) {
      fail('assistant_not_owned')
    }

    const profiles = await this.profiles(scope)
    const matches = profiles.filter(profile => profile.identityId === identityId)

    if (matches.length !== 1) {
      fail('identity_mismatch')
    }

    this.localProfile(matches[0]!.name)

    return { assistantId: id, profile: matches[0]! }
  }

  private async profileByName(name: string, scope: AccountScope): Promise<LocalProfile> {
    const profiles = await this.profiles(scope)
    const matches = profiles.filter(profile => profile.name === name)

    if (matches.length !== 1) {
      fail('profile_not_found')
    }

    this.localProfile(matches[0]!.name)

    return matches[0]!
  }

  private async profiles(scope: AccountScope): Promise<LocalProfile[]> {
    const response = await this.request('/api/profiles', 'GET', undefined, scope)
    const root = record(response)

    if (!root || !Array.isArray(root.profiles)) {
      fail('profiles_invalid')
    }

    const rows = root.profiles.map(entry => record(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))

    if (rows.length !== root.profiles.length) {
      fail('profiles_invalid')
    }

    const profiles = rows.map(entry => ({ name: entry.name, identityId: entry.identity_id }))

    if (!profiles.every(entry => validProfileName(entry.name) && validUuid(entry.identityId))) {
      fail('profiles_invalid')
    }

    return profiles as LocalProfile[]
  }

  private async readSnapshot(resolved: ResolvedPersona, scope: AccountScope): Promise<PersonaSnapshot> {
    const response = await this.request(
      `/api/profiles/${encodeURIComponent(resolved.profile.name)}/shared-persona`,
      'GET',
      undefined,
      scope,
    )

    const root = record(response)

    if (!root || typeof root.content !== 'string' || !validDigest(root.digest) || !validUuid(root.identity_id) || typeof root.approved !== 'boolean') {
      fail('snapshot_invalid')
    }

    if (root.identity_id !== resolved.profile.identityId) {
      fail('identity_mismatch')
    }

    const soulBytes = Buffer.from(root.content, 'utf8')

    if (soulBytes.byteLength > MAX_SOUL_BYTES || createHash('sha256').update(soulBytes).digest('hex') !== root.digest.toLowerCase()) {
      fail('snapshot_invalid')
    }

    let approvalRevision: number | null = null

    if (root.approved) {
      const approval = record(root.approval)

      if (!approval || approval.digest !== root.digest || !validRevision(approval.revision)) {
        fail('snapshot_invalid')
      }

      approvalRevision = approval.revision
    } else if (root.approval !== null) {
      // A valid approval with a different digest is expected after a SOUL edit:
      // the Python API deliberately retains it as a stale, non-approved record
      // so the revision stays monotonic. It must never be usable by the runner.
      const approval = record(root.approval)

      if (!approval || !validDigest(approval.digest) || !validRevision(approval.revision)) {
        fail('snapshot_invalid')
      }

      approvalRevision = approval.revision
    }

    return {
      content: root.content,
      digest: root.digest.toLowerCase(),
      identityId: root.identity_id,
      approvalRevision,
      approved: root.approved,
      modelAlias: 'binh-minh',
      soulBytes,
    }
  }

  private publicSnapshot(snapshot: PersonaSnapshot): SharedGroupPersonaPreview {
    const { soulBytes: _soulBytes, ...publicSnapshot } = snapshot

    return publicSnapshot
  }

  private async request(path: string, method: 'GET' | 'POST' | 'DELETE', body: Record<string, unknown> | undefined, scope: AccountScope): Promise<unknown> {
    let response: unknown

    try {
      response = await this.options.profileRequest(path, method, body)
    } catch {
      this.assertScope(scope)
      fail('profile_request_failed')
    }

    this.assertScope(scope)

    return response
  }

  private async enableDevice(scope: AccountScope): Promise<void> {
    try {
      await this.options.device.enable()
    } catch {
      this.assertScope(scope)
      fail('device_enable_failed')
    }

    this.assertScope(scope)
  }

  private async bindDevice(input: Parameters<SharedGroupDevice['bindAgent']>[0], scope: AccountScope): Promise<void> {
    try {
      await this.options.device.bindAgent(input)
    } catch {
      this.assertScope(scope)
      fail('device_bind_failed')
    }

    this.assertScope(scope)
  }

  private async unbindDevice(assistant: string, scope: AccountScope): Promise<void> {
    try {
      await this.options.device.unbindAgent(assistant)
    } catch {
      this.assertScope(scope)
      fail('device_unbind_failed')
    }

    this.assertScope(scope)
  }
}
