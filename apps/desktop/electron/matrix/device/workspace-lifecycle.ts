/** Completion is a signed control lifecycle, never a model tool or Receipt data. */
import type { TurnGrant, WorkspaceConfirm, WorkspaceFinalize, WorkspaceResult } from '../../../../../packages/device-protocol'
import { sameWorkspaceBinding, workspaceBinding, workspaceFinalizeRefusal, workspaceResultHash } from '../../../../../packages/device-protocol'

import type { DeviceArtifact, WorkspaceCopies } from './contracts'
import type { DeviceService, DeviceSessionFacts } from './service'
import type { ConflictCopyRelay } from './workspace'

export interface WorkspaceLifecycleDeps {
  service: DeviceService
  copies: WorkspaceCopies
  quiesce(): Promise<void>
  send(type: 'WorkspaceResult' | 'WorkspaceRefused', body: Record<string, unknown>): Promise<boolean>
  sendArtifact(requestId: string, artifact: DeviceArtifact): Promise<boolean>
  /** Sealed confirmation receipt only; this does not immediately remove a copy. */
  saved(copy: string, digest: string, result: WorkspaceResult): Promise<void>
  copyDigest(copy: string): Promise<string | null>
  conflicts?: Pick<ConflictCopyRelay, 'scan' | 'confirm'>
  now?(): number
}
interface Frozen {
  request: WorkspaceFinalize
  result: WorkspaceResult
  artifacts: DeviceArtifact[]
  cwd: string
  generation: number
  digest: string | null
  outputArtifacts: DeviceArtifact[]
  /** The wire name (`output-N`) of each of `outputArtifacts`, same order; their copy path is the artifact's `name`. */
  outputNames: string[]
  /** The last look at the Drive twins (see `WorkspaceCopies.publicationGuard`); null when the copies offer none. */
  guard: ((paths: string[]) => Promise<string[]>) | null
  /** The controller has been sent this result: from then on it is never changed, only repeated. */
  announced: boolean
}
export class DeviceWorkspaceLifecycle {
  private readonly retained = new Map<string, Frozen>()
  private readonly pending = new Map<string, { request: WorkspaceFinalize; done: Promise<void> }>()
  constructor(private readonly deps: WorkspaceLifecycleDeps) {}
  get available(): boolean {
    const copy = this.deps.copies

    return Boolean(copy.changes && copy.manifest && copy.end && copy.release)
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private async send(frozen: Frozen): Promise<void> {
    const held = new Set<string>()

    for (const artifact of frozen.artifacts) {
      // Until the controller has the result, every output's Drive twin is looked at again just
      // before its bytes leave (`changes()` looked once, when the turn was frozen): an owner edit
      // made since is not overwritten. A result the controller already has is only repeated.
      if (!frozen.announced && await this.mustHold(frozen, artifact.name)) {
        held.add(artifact.name)

        continue
      }

      if (!await this.deps.sendArtifact(frozen.request.requestId, artifact)) {return}
    }

    if (held.size) {await this.leaveOut(frozen, held)}
    frozen.announced = await this.deps.send('WorkspaceResult', { ...frozen.result })
  }
  /** Whether the output sent under `name` must be held back: its Drive twin changed under the copy. */
  private async mustHold(frozen: Frozen, name: string): Promise<boolean> {
    const at = frozen.outputNames.indexOf(name)

    if (at < 0 || !frozen.guard) {return false}

    try {
      return (await frozen.guard([frozen.outputArtifacts[at]!.name])).length > 0
    } catch {
      // A look that failed is not a clean one.
      return true
    }
  }
  /**
   * Leave the held-back files out of the result, as if they had never been collected: their artifacts,
   * outputs, the hash over them. The copy is not complete (its work is not all published), so it
   * is never pruneable. Their frozen bytes are released; the agent's version stays in its copy.
   */
  private async leaveOut(frozen: Frozen, names: Set<string>): Promise<void> {
    const body = {
      ...frozen.result,
      artifacts: frozen.result.artifacts.filter(artifact => !names.has(artifact.name)),
      outputs: frozen.result.outputs.filter(output => !names.has(output.artifactName)),
      complete: false,
      resultHash: ''
    }

    body.resultHash = workspaceResultHash(body)
    const gone = frozen.outputArtifacts.filter((_artifact, index) => names.has(frozen.outputNames[index]!))
    frozen.outputArtifacts = frozen.outputArtifacts.filter((_artifact, index) => !names.has(frozen.outputNames[index]!))
    frozen.outputNames = frozen.outputNames.filter(name => !names.has(name))
    frozen.artifacts = frozen.artifacts.filter(artifact => !names.has(artifact.name))
    frozen.result = body
    await this.deps.copies.release?.(gone)
  }
  async finalize(request: WorkspaceFinalize, session: DeviceSessionFacts): Promise<void> {
    for (const [id, old] of this.retained) {
      if (old.request.expiresAt > this.now() && old.generation === this.deps.service.workspaceGeneration()) {continue}
      this.retained.delete(id)
      await this.deps.copies.release?.(old.outputArtifacts)
    }

    const previous = this.retained.get(request.requestId)

    if (previous && sameWorkspaceBinding(request, previous.request) && request.expiresAt === previous.request.expiresAt
      && request.issuedAt === previous.request.issuedAt && request.expiresAt > this.now()
      && this.deps.service.workspaceGeneration() === previous.generation) {
      await this.send(previous)

      return
    }

    const pending = this.pending.get(request.requestId)

    if (pending) {
      if (sameWorkspaceBinding(request, pending.request) && request.issuedAt === pending.request.issuedAt
        && request.expiresAt === pending.request.expiresAt) {await pending.done}

      return
    }

    if (this.pending.size >= 64 || [...this.pending.values()].some(entry => entry.request.grantId === request.grantId)
      || [...this.retained.values()].some(entry => entry.request.grantId === request.grantId)) {
      await this.deps.send('WorkspaceRefused', { ...workspaceBinding(request), reason: 'unavailable' })

      return
    }

    const done = this.freeze(request, session).finally(() => this.pending.delete(request.requestId))
    this.pending.set(request.requestId, { request, done })
    await done
  }
  private async freeze(request: WorkspaceFinalize, session: DeviceSessionFacts): Promise<void> {
    const copies = this.deps.copies
    const grant = this.deps.service.workspaceGrant(request.grantId)
    const refusal = workspaceFinalizeRefusal(request, grant as TurnGrant | null, session, this.now())

    const refuse = async (reason: string) => { await this.deps.send('WorkspaceRefused', { ...workspaceBinding(request), reason }) }

    if (refusal) {await refuse(refusal);

 return}

    if (!this.available) {await refuse('unavailable');

 return}

    let frozen: Frozen | undefined
    let collected: DeviceArtifact[] = []

    try {
      const result = await this.deps.service.collectWorkspace(request.grantId, session, this.deps.quiesce, async () => {
        const cwd = await copies.ownWorkingRoot(request.grantId)
        const manifest = copies.manifest!(request.grantId)

        if (!cwd || !manifest || manifest.taskId !== request.invocationId) {throw Error('workspace_unavailable')}
        const beforeDigest = await this.deps.copyDigest(cwd)
        const changes = await copies.changes!(request.grantId)
        const guard = copies.publicationGuard?.(request.grantId) ?? null
        const artifacts = await copies.collect(changes.changed.map(name => cwd + '/' + name))
        collected = artifacts
        const total = artifacts.reduce((sum, artifact) => sum + artifact.size, 0)

        if (total > 67_108_864) {throw Error('workspace_too_large')}
        const afterDigest = await this.deps.copyDigest(cwd)
        const digest = beforeDigest && beforeDigest === afterDigest ? beforeDigest : null
        const wire = artifacts.map((artifact, index) => ({ ...artifact, name: 'output-' + index }))
        const offered = await this.deps.conflicts?.scan()
        let remaining = 67_108_864 - total

        const conflicts = (offered?.offered ?? []).filter(copy => {
          if (copy.agentPrincipal !== grant!.agentPrincipal || copy.label !== manifest.folder
            || wire.length >= 16 || copy.artifact.size > remaining) {return false}

          remaining -= copy.artifact.size
          wire.push({ ...copy.artifact, name: 'conflict-' + wire.length })

          return true
        })

        const body = { ...workspaceBinding(request), manifest, artifacts: wire.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
          outputs: artifacts.map((artifact, index) => ({ path: artifact.name, artifactName: wire[index]!.name })),
          deleted: changes.deleted,
          // A file kept back (its Drive twin changed under the copy) is work not published: not complete, never pruneable.
          complete: digest !== null && artifacts.length === changes.changed.length && !manifest.truncated && changes.deleted.length === 0
            && !changes.withheld?.length,
          conflicts: conflicts.map((copy, index) => ({ key: copy.key, path: copy.path, label: copy.label,
            artifactName: wire[artifacts.length + index]!.name })), resultHash: '' }

        body.resultHash = workspaceResultHash(body)
        frozen = { request, result: body, artifacts: wire, outputArtifacts: artifacts, outputNames: artifacts.map((_artifact, index) => wire[index]!.name),
          guard, announced: false, cwd, digest, generation: this.deps.service.workspaceGeneration() }

        return frozen
      })

      if (!result || request.expiresAt <= this.now()) {
        if (frozen) {await copies.release!(frozen.outputArtifacts)}
        await refuse('stopped')

        return
      }

      copies.end!(request.grantId)
      this.retained.set(request.requestId, result)

      for (const [id, old] of [...this.retained].slice(0, Math.max(0, this.retained.size - 64))) {
        this.retained.delete(id)
        await copies.release!(old.outputArtifacts)
      }

      await this.send(result)
    } catch {
      await copies.release!(frozen?.outputArtifacts ?? collected)
      await refuse('quiescence_failed')
    }
  }
  async confirm(confirm: WorkspaceConfirm, session: DeviceSessionFacts): Promise<void> {
    const frozen = this.retained.get(confirm.requestId)

    if (!frozen || !sameWorkspaceBinding(confirm, frozen.request) || confirm.resultHash !== frozen.result.resultHash
      || session.connectionId !== frozen.request.connectionId || session.connectionEpoch !== frozen.request.connectionEpoch
      || session.deviceServiceId !== frozen.request.deviceServiceId || session.accountEpoch !== frozen.request.accountEpoch
      || session.enrollmentEpoch !== frozen.request.enrollmentEpoch || frozen.request.expiresAt <= this.now()
      || frozen.generation !== this.deps.service.workspaceGeneration()
      || new Set(confirm.confirmedConflictKeys).size !== confirm.confirmedConflictKeys.length
      || confirm.confirmedConflictKeys.some(key => !frozen.result.conflicts.some(conflict => conflict.key === key))) {return}

    // An unhandled deletion, truncated output or dirty unbound input never becomes pruneable.
    if (confirm.saved && frozen.digest && frozen.result.complete && frozen.result.outputs.length > 0
      && frozen.result.manifest.files.every(file => file.server !== null)) {await this.deps.saved(frozen.cwd, frozen.digest, frozen.result)}

    this.retained.delete(confirm.requestId)
    await this.deps.conflicts?.confirm(confirm.confirmedConflictKeys)
    await this.deps.copies.release!(frozen.outputArtifacts)
  }
  async clear(): Promise<void> {
    const frozen = [...this.retained.values()]
    this.retained.clear()

    for (const entry of frozen) {await this.deps.copies.release?.(entry.outputArtifacts)}
  }
}
