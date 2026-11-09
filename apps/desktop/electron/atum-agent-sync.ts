import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { type AtumPersonalPet, parsePetInspection } from '../shared/atum-account-pets'
import { type AtumAccountPreferences, type AtumCloudPreferences, type AtumPreferencesStatus, parseAccountPreferences, preferenceFields, preferencesFromFields } from '../shared/atum-account-preferences'
import type { AtumPetBinding } from '../shared/atum-account-preferences'
import {
  type AtumAgentSyncStatus,
  type AtumCloudMemory,
  type AtumMemorySnapshot,
  type AtumSkillBundle,
  parseMemorySnapshot,
  parseSkillBundle
} from '../shared/atum-agent-content'
import {
  type AtumAssistantDefinitionSnapshot,
  type AtumAssistantDefinitionWrite,
  type AtumPortableAssistantDefinition,
  parseAtumPortableDefinition,
  portableDefinitionWire
} from '../shared/atum-agent-portability'

import type { AtumAssistantPortabilityService, AtumSkillHashMismatch } from './atum-agent-portability'
import { accountKeyFor, type AccountRootAuthority } from './atum-messaging/account-roots'
import { MessagingTransportError } from './atum-messaging/transport-error'
import type { RegisteredAssistant } from './atum-messaging/types'
import { type AtumPetLibraryClient, type PetReplicaState, type PetSyncContext, restorePersonalPet, syncPersonalPets } from './atum-pet-sync'

interface AgentState {
  petBase?: AtumPetBinding
  petLibrary?: PetReplicaState
  definition?: AtumPortableAssistantDefinition
  memoryBase?: AtumMemorySnapshot
  uploaded: string[]
  /** Catalog-owned hashes deliberately kept out of the owner-private CAS (plan
   *  decision 6 / review B1). Recorded so the omission is visible, never silent. */
  catalogOwned?: string[]
  /** Entitled catalog skills this device resolved from its own shipped tree,
   *  as Hermes last reported them. Durable, because it is a standing fact about
   *  this computer: without it every later run would re-apply the definition to
   *  rediscover the same drift. See `withReportedHashes`. */
  skillDrift?: AtumSkillHashMismatch[]
  status: AtumAgentSyncStatus
}
interface SyncState {
  version: 1
  agents: Record<string, AgentState>
  preferences?: {
    snapshot: AtumAccountPreferences
    seed?: AtumAccountPreferences
    dirty: string[]
    revision: number
    status: 'pending' | 'synced' | 'error'
  }
}
interface Fence {
  accountId: string
  generation: number
  epoch: number
  path: string
  localContent?: boolean
}
export interface AtumAgentSyncOptions {
  accountRoots: AccountRootAuthority
  session: () => { user: { id: string } } | null
  portability: AtumAssistantPortabilityService
  listAssistants: () => Promise<RegisteredAssistant[]>
  getDefinition: (id: string) => Promise<AtumAssistantDefinitionSnapshot>
  putDefinition: (id: string, input: AtumAssistantDefinitionWrite) => Promise<AtumAssistantDefinitionSnapshot>
  putSkill: (id: string, bundle: AtumSkillBundle) => Promise<void>
  getMemory: (id: string) => Promise<AtumCloudMemory>
  putMemory: (
    id: string,
    input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot }
  ) => Promise<AtumCloudMemory>
  changed: () => void
  /** Account-local latch owned by the utility manager, including after disconnect. */
  workspaceProtected?: () => boolean
  getPreferences?: () => Promise<AtumCloudPreferences>
  pets?: AtumPetLibraryClient
  putPreferences?: (input: { expected_revision: number; snapshot: AtumAccountPreferences }) => Promise<AtumCloudPreferences>
  /** Catalog-owned sha256s from the store's SIGNED envelope (`catalog_owned`),
   * never the listed catalog — delisted and draft items stay paid (review B5).
   * No envelope yet = empty = skip nothing; the platform's 409 `catalog_owned`
   * refusal is the cold-start backstop and is recorded, never a sync error. */
  catalogOwnedHashes?: () => ReadonlySet<string>
  /** Fires once per sync run, after it settles — the store refresh rides this
   * cadence instead of owning a timer (plan decision 8). */
  onTick?: () => void
  now?: () => number
}
const emptyMemory = (): AtumMemorySnapshot => ({ memory: [], user: [] })
const equal = isDeepStrictEqual

function definitionKey(definition: AtumPortableAssistantDefinition) {
  return { ...definition, skills: [...definition.skills].sort((a, b) => a.name.localeCompare(b.name)) }
}

/**
 * Rewrite the hashes Hermes told us it resolved locally back to the ones the
 * cloud recorded.
 *
 * An entitled catalog skill is resolved from this device's own shipped tree —
 * its bytes are never in the account's CAS, because catalog-owned content is
 * refused there by design. So device B's tree hash legitimately differs from
 * device A's, and comparing the two can never converge: the assistant sat in
 * `conflict` on every run, and "Use account copy" threw `cloud_definition_changed`
 * every time (re-review 2026-09-12). Only the exact substitution Hermes
 * reported is accepted — a hash that drifted for any other reason still shows
 * as the divergence it is.
 */
function withReportedHashes(
  definition: AtumPortableAssistantDefinition,
  mismatches: readonly AtumSkillHashMismatch[] | undefined
): AtumPortableAssistantDefinition {
  if (!mismatches?.length) {
    return definition
  }

  const expectedByName = new Map(mismatches.map(entry => [entry.name, entry] as const))

  return {
    ...definition,
    skills: definition.skills.map(skill => {
      const reported = expectedByName.get(skill.name)

      return reported && reported.actualSha256 === skill.sha256
        ? { ...skill, sha256: reported.expectedSha256 }
        : skill
    })
  }
}

function sameDefinition(
  a: AtumPortableAssistantDefinition | undefined,
  b: AtumPortableAssistantDefinition,
  mismatches?: readonly AtumSkillHashMismatch[]
) {
  return !!a && equal(definitionKey(withReportedHashes(a, mismatches)), definitionKey(b))
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('invalid_content_response')}
  const result = value as Record<string, unknown>

  if (result.ok !== true) {throw new Error('content_unavailable')}

  return result
}

/** The platform refuses catalog-owned hashes at the owner-CAS reserve/read with
 * this code (HTTP 409, review B6 — previously a retryable 503, which made this
 * skip unreachable). For the uploader it is an expected skip, never a sync
 * failure. */
function isCatalogOwnedRefusal(error: unknown): boolean {
  return (
    (error instanceof MessagingTransportError && error.code === 'catalog_owned') ||
    (error instanceof Error && error.message === 'catalog_owned')
  )
}

/** Three-way snapshot sync. Ambiguous edits remain visible, never last-write-wins. */
export class AtumAgentSync {
  private timer: ReturnType<typeof setInterval> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private syncPending: Promise<void> | null = null
  private state: SyncState = { version: 1, agents: {} }
  private epoch = 0
  private activePath: string | null = null
  private readonly now: () => number
  constructor(private readonly options: AtumAgentSyncOptions) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => {
      void this.sync().catch(() => undefined)
    }, 60_000)
    this.timer.unref?.()
    void this.sync().catch(() => undefined)
  }
  stop(): void {
    this.epoch += 1

    if (this.timer) {clearInterval(this.timer)}
    this.timer = undefined
    this.activePath = null
    this.state = { version: 1, agents: {} }
    this.options.changed()
  }
  statuses(): AtumAgentSyncStatus[] {
    try {
      if (this.capture().path !== this.activePath) {return []}

      const protectedWorkspace = this.workspaceProtected()

      return Object.values(this.state.agents).map(entry => protectedWorkspace
        ? { ...entry.status, skills: 'local_only', memory: 'local_only', ...(this.options.pets ? { pets: 'local_only' as const } : {}), workspaceProtected: true }
        : { ...entry.status })
    } catch {
      return []
    }
  }
  private workspaceProtected(): boolean {
    // A locked/unreadable credential store cannot authorize content export.
    try { return this.options.workspaceProtected?.() ?? false }
    catch { return true }
  }
  private contentFence(fence: Fence): Fence {
    const content = { ...fence, localContent: true }
    this.assert(content)

    return content
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation)
    this.queue = next

    return next
  }
  private capture(): Fence {
    const accountId = this.options.session()?.user.id
    const committed = this.options.accountRoots.committed()

    if (!accountId || !committed || committed.marker.accountKey !== accountKeyFor(accountId))
      {throw new Error('account_context_changed')}

    return {
      accountId,
      generation: committed.marker.generation,
      epoch: this.epoch,
      path: join(
        this.options.accountRoots.pathsForAccount(accountId).hermesStateRoot,
        '.atum-portability',
        'sync-state.json'
      )
    }
  }
  private assert(fence: Fence): void {
    const current = this.capture()

    if (
      current.accountId !== fence.accountId ||
      current.generation !== fence.generation ||
      current.epoch !== fence.epoch
    )
      {throw new Error('account_context_changed')}

    if (fence.localContent && this.workspaceProtected()) {throw new Error('google_workspace_local_only')}
  }
  private async checked<T>(fence: Fence, promise: Promise<T>): Promise<T> {
    const value = await promise
    this.assert(fence)

    return value
  }
  private load(fence: Fence): void {
    this.assert(fence)

    if (this.activePath === fence.path) {return}

    const saved: unknown = existsSync(fence.path)
      ? JSON.parse(readFileSync(fence.path, 'utf8'))
      : { version: 1, agents: {} }

    if (
      !saved ||
      typeof saved !== 'object' ||
      (saved as SyncState).version !== 1 ||
      !(saved as SyncState).agents ||
      typeof (saved as SyncState).agents !== 'object'
    )
      {throw new Error('invalid_sync_state')}

    this.state = saved as SyncState
    this.activePath = fence.path
  }
  private save(fence: Fence): void {
    this.assert(fence)

    if (this.activePath !== fence.path) {throw new Error('account_context_changed')}
    mkdirSync(dirname(fence.path), { recursive: true, mode: 0o700 })
    const temporary = `${fence.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, fence.path)
    this.options.changed()
  }
  private entry(id: string): AgentState {
    return (this.state.agents[id] ??= {
      uploaded: [],
      status: {
        assistantId: id,
        skills: 'pending',
        memory: 'pending',
        memoryEnabled: true,
        lastSyncedAt: null
      }
    })
  }
  private preferenceState() {
    return (this.state.preferences ??= { snapshot: { schema_version: 1 }, dirty: [], revision: 0, status: 'pending' })
  }
  preferences(): AtumPreferencesStatus {
    const fence = this.capture()
    this.load(fence)
    const state = this.preferenceState()

    return { accountId: fence.accountId, snapshot: structuredClone(state.snapshot), revision: state.revision, status: state.status }
  }
  /** Persist intent before network I/O. Each field is replayed against a fresh CAS revision. */
  patchPreferences(accountId: string, value: AtumAccountPreferences): Promise<void> {
    return this.writePreferences(accountId, value, false)
  }
  seedPreferences(accountId: string, value: AtumAccountPreferences): Promise<void> {
    return this.writePreferences(accountId, value, true)
  }
  private async writePreferences(accountId: string, value: AtumAccountPreferences, seed: boolean): Promise<void> {
    const fence = this.capture()

    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }
    const snapshot = parseAccountPreferences(value)
    await this.serialized(async () => {
      this.load(fence)
      const state = this.preferenceState()

      if (seed) {
        // A legacy seed is used only for an absent cloud record, never as new intent.
        if (state.revision === 0 && !state.seed) { state.seed = snapshot }
      } else {
        const patch = preferenceFields(snapshot)
        state.snapshot = preferencesFromFields({ ...preferenceFields(state.snapshot), ...patch })
        state.dirty = [...new Set([...state.dirty, ...Object.keys(patch)])]
        state.status = 'pending'
      }

      this.save(fence)
    })
    void this.sync().catch(() => undefined)
  }
  private async syncPreferences(fence: Fence): Promise<void> {
    if (!this.options.getPreferences || !this.options.putPreferences) { return }
    const state = this.preferenceState()
    const cloud = await this.checked(fence, this.options.getPreferences())

    if (cloud.accountId !== fence.accountId) { throw new Error('account_context_changed') }
    const fields = preferenceFields(cloud.revision === 0 && state.seed ? state.seed : cloud.snapshot)
    const local = preferenceFields(state.snapshot)

    for (const key of state.dirty) { if (Object.hasOwn(local, key)) { fields[key] = local[key] } }
    const snapshot = preferencesFromFields(fields)
    let accepted = cloud

    if (!equal(snapshot, cloud.snapshot)) {
      accepted = await this.checked(fence, this.options.putPreferences({ expected_revision: cloud.revision, snapshot }))

      if (accepted.accountId !== fence.accountId || !equal(accepted.snapshot, snapshot)) { throw new Error('invalid_account_preferences') }
    }

    state.snapshot = accepted.snapshot
    state.revision = accepted.revision
    state.dirty = []
    delete state.seed
    state.status = 'synced'
  }
  private async syncPets(fence: Fence, assistant: RegisteredAssistant, entry: AgentState, cloud: Map<string, AtumPersonalPet>): Promise<void> {
    if (!this.options.pets) { return }
    fence = this.contentFence(fence)

    const context: PetSyncContext = {
      assistant, cloud, client: this.options.pets,
      state: entry.petLibrary ??= { records: {}, restored: [] },
      checked: operation => this.checked(fence, operation),
      run: (operation, payload) => {
        this.assert(fence)

        return this.checked(fence, this.options.portability.runContent(assistant, operation, payload))
      },
      save: () => this.save(fence),
      assert: () => this.assert(fence)
    }

    const result = await syncPersonalPets(context)
    entry.status.pets = result.partial ? 'unavailable' : 'pending'

    if (result.conflict) { entry.status.pets = 'conflict';

 return }

    if (this.preferenceState().status !== 'synced') { return }
    let local = result.inspection.active
    const saved = this.preferenceState().snapshot.assistants?.[assistant.id]?.pet
    let desired = saved ?? local

    // Explicit local changes are captured against the last converged binding;
    // a fresh factory pet yields to an existing account choice.
    if (entry.petBase ? !equal(local, entry.petBase) : result.inspection.explicit) { desired = local }

    if (desired.ref?.kind === 'personal') {
      const owned = cloud.get(desired.ref.pet_id)

      if (!owned) { entry.status.pets = 'unavailable';

 return }

      if (owned.deleted_at) { desired = { ...desired, ref: null, enabled: false } }
    }

    if (!equal(saved, desired)) {
      const preferences = this.preferenceState()
      preferences.snapshot = preferencesFromFields({ ...preferenceFields(preferences.snapshot), [`assistant.${assistant.id}`]: { pet: desired } })
      preferences.dirty = [...new Set([...preferences.dirty, `assistant.${assistant.id}`])]
      preferences.status = 'pending'
      this.save(fence)
      await this.syncPreferences(fence)
    }

    if (!equal(local, desired)) {
      if (desired.ref?.kind === 'personal' && !result.inspection.pets.some(pet => equal(pet.ref, desired.ref))) {
        const owned = cloud.get(desired.ref.pet_id)

        if (!owned) { throw new Error('pet_record_missing') }
        await restorePersonalPet(context, owned)
        local = parsePetInspection(await context.run('read_pets')).active

        // Downloading bytes must not overwrite a choice made while it ran.
        if (!equal(local, result.inspection.active)) { entry.status.pets = 'conflict';

 return }
      }

      const applied = await context.run('apply_pet_binding', { binding: desired, expected_binding: local }) as { ok?: boolean; status?: string }

      if (applied?.ok !== true) { entry.status.pets = applied?.status === 'conflict' ? 'conflict' : 'unavailable';

 return }

      const observed = parsePetInspection(await context.run('read_pets')).active

      if (!equal(observed, desired)) { entry.status.pets = 'conflict';

 return }
    }

    entry.petBase = desired
    entry.status.pets = result.partial ? 'unavailable' : 'synced'
  }
  private async inspect(fence: Fence, assistant: RegisteredAssistant) {
    const result = row(await this.checked(fence, this.options.portability.runContent(assistant, 'inspect')))

    return parseAtumPortableDefinition(result.definition)
  }
  private async uploadSkills(
    fence: Fence,
    assistant: RegisteredAssistant,
    definition: AtumPortableAssistantDefinition,
    entry: AgentState
  ) {
    const catalogOwned = this.options.catalogOwnedHashes?.() ?? new Set<string>()
    let recorded = false

    for (const skill of definition.skills) {
      if (entry.uploaded.includes(skill.sha256)) {continue}

      // Catalog-owned bytes never enter the owner-private CAS (plan decision 6):
      // a second device re-fetches them through the entitlement-gated catalog.
      if (catalogOwned.has(skill.sha256)) {
        recorded = this.recordCatalogOwned(entry, skill.sha256) || recorded

        continue
      }

      try {
        const exported = row(
          await this.checked(fence, this.options.portability.runContent(assistant, 'export_skill', { skill }))
        )

        const bundle = parseSkillBundle(exported.bundle)

        if (bundle.sha256 !== skill.sha256) {throw new Error('skill_changed_during_sync')}
        await this.checked(fence, this.options.putSkill(assistant.id, bundle))
      } catch (error) {
        // A hash the cold catalog cache did not know: the platform's refusal is
        // expected — record the omission and continue, never a sync error.
        if (!isCatalogOwnedRefusal(error)) {throw error}
        this.assert(fence)
        recorded = this.recordCatalogOwned(entry, skill.sha256) || recorded

        continue
      }

      entry.uploaded.push(skill.sha256)
      this.save(fence)
    }

    if (recorded) {this.save(fence)}
  }
  /** Keep what Hermes reported, and fall back to what it reported last time.
   *  A run that did not materialise learns nothing new about this device's
   *  tree, so forgetting here would put the assistant straight back into
   *  `conflict` on the next tick. */
  private rememberDrift(
    fence: Fence,
    entry: AgentState,
    reported: AtumSkillHashMismatch[] | undefined
  ): readonly AtumSkillHashMismatch[] | undefined {
    if (reported === undefined) {
      return entry.skillDrift
    }

    if (!equal(entry.skillDrift ?? [], reported)) {
      entry.skillDrift = reported.length > 0 ? reported : undefined
      this.save(fence)
    }

    return entry.skillDrift
  }
  private recordCatalogOwned(entry: AgentState, sha256: string): boolean {
    const list = (entry.catalogOwned ??= [])

    if (list.includes(sha256)) {return false}
    list.push(sha256)
    list.sort()

    return true
  }
  private async syncSkills(
    fence: Fence,
    assistant: RegisteredAssistant,
    entry: AgentState,
    resolve?: 'local' | 'cloud'
  ) {
    fence = this.contentFence(fence)
    let cloud: AtumAssistantDefinitionSnapshot | null = null

    if (assistant.definitionRevision > 0) {cloud = await this.checked(fence, this.options.getDefinition(assistant.id))}
    let local: AtumPortableAssistantDefinition
    // Entitled catalog skills Hermes resolved from this device's own tree.
    // Their hashes differ from the cloud's by design; see `withReportedHashes`.
    let mismatches: readonly AtumSkillHashMismatch[] | undefined = entry.skillDrift

    try {
      local = await this.inspect(fence, assistant)
    } catch (error) {
      if (assistant.isDefault) {
        entry.status.skills = 'pending'

        if (!cloud) {return}

        try {
          // The default ticket requires adopted identity; Python only restores
          // an empty managed root and checks that condition under its lock.
          const restored = await this.checked(fence, this.options.portability.materializeAssistant(assistant.id))

          if (!restored.ok || restored.status === 'reused') {return}
          mismatches = this.rememberDrift(fence, entry, restored.skillHashMismatches)
        } catch {
          this.assert(fence)

          return
        }
      } else {
        if (!cloud) {throw error}
        const installed = await this.checked(fence, this.options.portability.materializeAssistant(assistant.id))

        if (!installed.ok || installed.status === 'reused') {throw error}
        mismatches = this.rememberDrift(fence, entry, installed.skillHashMismatches)
      }

      local = await this.inspect(fence, assistant)
    }

    // Hermes now seeds its canonical SOUL.md while the default identity is
    // adopted, so inspect can succeed before this device has ever restored
    // the account definition. Give the native materializer the first-restore
    // decision: it accepts only an otherwise-pristine adopted root and still
    // refuses any user-edited persona, skill, or model assignment.
    if (assistant.isDefault && cloud && !entry.definition) {
      try {
        const restored = await this.checked(fence, this.options.portability.materializeAssistant(assistant.id))

        if (restored.ok && restored.status !== 'reused') {
          mismatches = this.rememberDrift(fence, entry, restored.skillHashMismatches)
          local = await this.inspect(fence, assistant)
        }
      } catch {
        this.assert(fence)
      }
    }

    if (cloud && sameDefinition(local, cloud.definition, mismatches)) {
      // Older clients could publish references without uploading their bytes.
      await this.uploadSkills(fence, assistant, local, entry)
      entry.definition = local
      entry.status.skills = 'synced'

      return
    }

    if (resolve === 'cloud' || (cloud && sameDefinition(entry.definition, local, mismatches))) {
      if (!cloud) {throw new Error('cloud_definition_missing')}
      const result = await this.checked(fence, this.options.portability.applyAssistantDefinition(assistant.id, local))

      if (!result.ok) {throw new Error('missing_skills')}

      const applied = await this.inspect(fence, assistant)

      if (!sameDefinition(applied, cloud.definition, this.rememberDrift(fence, entry, result.skillHashMismatches))) {
        throw new Error('cloud_definition_changed')
      }

      entry.definition = applied
      entry.status.skills = 'synced'

      return
    }

    if (!cloud || resolve === 'local' || sameDefinition(entry.definition, cloud.definition)) {
      await this.uploadSkills(fence, assistant, local, entry)

      const accepted = await this.checked(
        fence,
        this.options.putDefinition(assistant.id, {
          definition: local,
          displayName: cloud?.assistant.displayName ?? assistant.displayName,
          avatar: cloud?.assistant.avatar ?? assistant.avatar,
          expectedDefinitionRevision: cloud?.definitionRevision ?? 0,
          expectedIdentityRevision: cloud?.identityRevision ?? assistant.identityRevision
        })
      )

      entry.definition = accepted.definition
      entry.status.skills = 'synced'

      return
    }

    entry.status.skills = 'conflict'
  }
  private async localMemory(fence: Fence, assistant: RegisteredAssistant) {
    return parseMemorySnapshot(
      row(await this.checked(fence, this.options.portability.runContent(assistant, 'read_memory'))).snapshot
    )
  }
  private async syncMemory(
    fence: Fence,
    assistant: RegisteredAssistant,
    entry: AgentState,
    resolve?: 'local' | 'cloud'
  ) {
    fence = this.contentFence(fence)
    let cloud = await this.checked(fence, this.options.getMemory(assistant.id))

    // A missing row has no saved preference or memory to overwrite. Enable it
    // through the existing CAS writer; positive revisions preserve saved pauses.
    if (cloud.revision === 0) {
      const snapshot = await this.localMemory(fence, assistant)
      cloud = await this.checked(fence, this.options.putMemory(assistant.id, {
        expected_revision: 0, enabled: true, snapshot
      }))
      entry.memoryBase = cloud.snapshot
    }

    entry.status.memoryEnabled = cloud.enabled

    if (!cloud.enabled) {
      entry.status.memory = 'disabled'

      return
    }

    const local = await this.localMemory(fence, assistant)
    const base = entry.memoryBase
    const desired = emptyMemory()
    let conflict = false

    for (const target of ['memory', 'user'] as const) {
      if (equal(local[target], cloud.snapshot[target])) {desired[target] = local[target]}
      else if (resolve === 'local') {desired[target] = local[target]}
      else if (resolve === 'cloud') {desired[target] = cloud.snapshot[target]}
      else if (base && equal(local[target], base[target])) {desired[target] = cloud.snapshot[target]}
      else if (base && equal(cloud.snapshot[target], base[target])) {desired[target] = local[target]}
      else if (!base && local[target].length === 0) {desired[target] = cloud.snapshot[target]}
      else {
        conflict = true
        desired[target] = local[target]
      }
    }

    if (conflict) {
      entry.status.memory = 'conflict'

      return
    }

    if (!equal(cloud.snapshot, desired))
      {cloud = await this.checked(
        fence,
        this.options.putMemory(assistant.id, {
          expected_revision: cloud.revision,
          enabled: true,
          snapshot: desired
        })
      )}

    if (!equal(local, desired)) {
      const response = row(
        await this.checked(
          fence,
          this.options.portability.runContent(assistant, 'apply_memory', {
            expected_snapshot: local,
            snapshot: desired
          })
        )
      )

      const result = response.result as
        | { success?: boolean; targets?: Record<string, { status?: string }>; snapshot?: unknown }
        | undefined

      const observed = result?.snapshot ? parseMemorySnapshot(result.snapshot) : null
      const nextBase = base ? structuredClone(base) : emptyMemory()

      for (const target of ['memory', 'user'] as const) {
        if (observed && equal(observed[target], desired[target])) {nextBase[target] = desired[target]}
      }

      entry.memoryBase = nextBase

      if (result?.success !== true) {
        entry.status.memory = 'conflict'

        return
      }
    }

    entry.memoryBase = desired
    entry.status.memory = 'synced'
  }
  async sync(): Promise<void> {
    if (this.syncPending) { return this.syncPending }
    const requested = this.capture()

    const operation = this.serialized(async () => {
      this.assert(requested)
      this.load(requested)

      try {
        await this.syncPreferences(requested)
      } catch {
        this.assert(requested)
        this.preferenceState().status = 'error'
      }

      this.save(requested)
      const assistants = await this.checked(requested, this.options.listAssistants())

      const active = assistants.filter(a => a.status === 'active' && a.identityId)
      const activeIds = new Set(active.map(a => a.id))
      let pets: Map<string, AtumPersonalPet> | null = null

      if (this.options.pets) {
        try { pets = new Map((await this.checked(requested, this.options.pets.list())).map(pet => [pet.pet_id, pet])) }
        catch { this.assert(requested) }
      }

      for (const id of Object.keys(this.state.agents)) {
        if (!activeIds.has(id)) {delete this.state.agents[id]}
      }

      this.save(requested)

      for (const assistant of active) {
        const entry = this.entry(assistant.id)

        if (this.workspaceProtected()) {
          entry.status.skills = 'local_only'
          entry.status.memory = 'local_only'

          if (this.options.pets) { entry.status.pets = 'local_only' }
          this.save(requested)

          continue
        }

        try {
          await this.syncSkills(requested, assistant, entry)
        } catch {
          this.assert(requested)
          entry.status.skills = this.workspaceProtected() ? 'local_only' : 'error'
        }

        try {
          await this.syncMemory(requested, assistant, entry)
        } catch {
          this.assert(requested)
          entry.status.memory = this.workspaceProtected() ? 'local_only' : 'error'
        }

        if (this.options.pets) {
          try {
            if (!pets) { throw new Error('pet_library_unavailable') }
            await this.syncPets(requested, assistant, entry, pets)
          } catch {
            this.assert(requested)
            entry.status.pets = this.workspaceProtected() ? 'local_only' : 'error'
          }
        }

        if (entry.status.skills === 'synced' && ['synced', 'disabled'].includes(entry.status.memory))
          {entry.status.lastSyncedAt = this.now()}

        this.save(requested)
      }
    })

    this.syncPending = operation

    try { await operation } finally {
      if (this.syncPending === operation) {this.syncPending = null}
      // The store's catalog/envelope refresh rides the sync cadence rather
      // than owning a timer. It fences itself; a tick never fails a sync run.
      this.options.onTick?.()
    }
  }
  async publishDefinition(id: string, input: AtumAssistantDefinitionWrite): Promise<AtumAssistantDefinitionSnapshot> {
    const fence = this.contentFence(this.capture())

    return this.serialized(async () => {
      this.load(fence)

      const assistant = (await this.checked(fence, this.options.listAssistants())).find(
        a => a.id === id && a.status === 'active'
      )

      if (!assistant) {throw new Error('assistant_not_found')}
      const definition = parseAtumPortableDefinition(portableDefinitionWire(input.definition))
      const local = await this.inspect(fence, assistant)

      if (!sameDefinition(local, definition)) {throw new Error('local_definition_changed')}
      const entry = this.entry(id)
      await this.uploadSkills(fence, assistant, definition, entry)
      const accepted = await this.checked(fence, this.options.putDefinition(id, input))
      entry.definition = accepted.definition
      entry.status.skills = 'synced'
      this.save(fence)

      return accepted
    })
  }
  setMemoryEnabled(id: string, enabled: boolean): Promise<void> {
    const fence = this.capture()

    return this.serialized(async () => {
      fence.localContent = true
      this.assert(fence)
      this.load(fence)

      const assistant = (await this.checked(fence, this.options.listAssistants())).find(
        a => a.id === id && a.status === 'active'
      )

      if (!assistant) {throw new Error('assistant_not_found')}
      const cloud = await this.checked(fence, this.options.getMemory(id))
      const entry = this.entry(id)
      // Enabling a never-saved agent seeds this device's curated memory.
      const snapshot = enabled && cloud.revision === 0 ? await this.localMemory(fence, assistant) : cloud.snapshot

      const accepted = await this.checked(
        fence,
        this.options.putMemory(id, { expected_revision: cloud.revision, enabled, snapshot })
      )

      entry.status.memoryEnabled = accepted.enabled
      entry.status.memory = enabled ? 'pending' : 'disabled'

      if (cloud.revision === 0) {entry.memoryBase = snapshot}
      this.save(fence)

      if (enabled) {
        await this.syncMemory(fence, assistant, entry)
        this.save(fence)
      }
    })
  }
  resolve(id: string, kind: 'skills' | 'memory', choice: 'local' | 'cloud'): Promise<void> {
    const fence = this.capture()

    return this.serialized(async () => {
      fence.localContent = true
      this.assert(fence)
      this.load(fence)

      const assistant = (await this.checked(fence, this.options.listAssistants())).find(
        a => a.id === id && a.status === 'active'
      )

      if (!assistant) {throw new Error('assistant_not_found')}
      const entry = this.entry(id)

      if (kind === 'skills') {await this.syncSkills(fence, assistant, entry, choice)}
      else {await this.syncMemory(fence, assistant, entry, choice)}

      this.save(fence)
    })
  }
}
