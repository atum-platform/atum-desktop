import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { MatrixAgentDefinitionSnapshot } from '../../matrix/agent-definition'
import { WORK_PROVISIONAL, WorkRelaySelectionSchema } from '../gate/contract'
import type { GateLedger } from '../gate/ledger'
import type { T3Port, T3Reply } from '../gate/ports'
import type { RelaySelection } from '../gate/relay'

/** Main supplies the same account-fenced definition reader used by agent record sync. No credentials or memory are copied. */
export interface RelayAssemblyOptions {
  ledger: GateLedger
  assistantsRoot: string
  definition(principal: string): Promise<MatrixAgentDefinitionSnapshot>
  t3: T3Port
  ownerToken(): Promise<string>
  fresh(): boolean
  now?(): number
}

function result(reply: T3Reply): Record<string, unknown> {
  if (reply.transport !== 'ok' || reply.status !== 200 || reply.isError || reply.code || !reply.data) {
    throw new Error('relay_project_unavailable')
  }

  return reply.data
}

/** Thin composition over the gate ledger, synced definition and native T3 projects. */
export class RelayAssembly {
  private pending = new Map<string, Promise<{ projectId: string; personaRevision: number }>>()
  constructor(private readonly o: RelayAssemblyOptions) {}

  selection = (principal: string): RelaySelection | undefined => {
    const issued = Number(this.o.ledger.meta('relay_selection_issued_at') ?? 0)
    const age = (this.o.now ?? Date.now)() - issued

    if (!issued || !this.o.fresh() || age < -60_000 || age > WORK_PROVISIONAL.entitlementFreshnessBoundSeconds * 1000) {
      return undefined
    }

    try {
      const rows = JSON.parse(this.o.ledger.meta('relay_selections') ?? '[]') as {
        agentPrincipal: string
        selection: unknown
      }[]

      const parsed = WorkRelaySelectionSchema.safeParse(rows.find(row => row.agentPrincipal === principal)?.selection)

      if (!parsed.success || parsed.data.plan !== 'codex') {
        return undefined
      }

      // The target/persona are provisioned by main only for a new native thread, after owner-event/history verification.
      return {
        revision: parsed.data.revision,
        instanceId: 'codex',
        model: parsed.data.model,
        projectId: '',
        personaRevision: 1
      }
    } catch {
      return undefined
    }
  }

  provision = (principal: string, threadId: string): Promise<{ projectId: string; personaRevision: number }> => {
    const key = `relay_persona:${principal}:${threadId}`
    const pinned = this.o.ledger.meta(key)

    if (pinned) {
      return Promise.resolve(JSON.parse(pinned))
    }

    const pending = this.pending.get(principal)

    if (pending) {
      return pending.then(() => this.provision(principal, threadId))
    }

    const run = this.create(principal, key).finally(() => this.pending.delete(principal))
    this.pending.set(principal, run)

    return run
  }

  private async create(principal: string, key: string) {
    const snapshot = await this.o.definition(principal)

    if (
      snapshot.assistant.principal !== principal ||
      !snapshot.definition ||
      snapshot.assistant.status !== 'active' ||
      !Number.isSafeInteger(snapshot.definitionRevision) ||
      snapshot.definitionRevision < 1
    ) {
      throw new Error('relay_definition_unavailable')
    }

    const root = resolve(this.o.assistantsRoot)
    const folder = join(root, createHash('sha256').update(principal).digest('hex'))
    mkdirSync(root, { recursive: true, mode: 0o700 })

    if (lstatSync(root).isSymbolicLink()) {
      throw new Error('relay_folder_invalid')
    }

    mkdirSync(folder, { recursive: true, mode: 0o700 })

    if (lstatSync(folder).isSymbolicLink()) {
      throw new Error('relay_folder_invalid')
    }

    const token = await this.o.ownerToken()

    if (!this.o.t3.projects || !this.o.t3.createProject) {
      throw new Error('relay_project_unavailable')
    }

    let projectId: string | undefined
    let cursor: number | undefined

    for (let page = 0; page < 100; page++) {
      const data = result(await this.o.t3.projects(token, cursor))
      const projects = data.projects as { id: string; workspaceRoot: string; deletedAt: string | null }[]

      if (!Array.isArray(projects)) {
        throw new Error('relay_project_unavailable')
      }

      projectId = projects.find(project => resolve(project.workspaceRoot) === folder && !project.deletedAt)?.id

      if (projectId || data.nextCursor === null) {
        break
      }

      if (!Number.isSafeInteger(data.nextCursor) || (data.nextCursor as number) <= (cursor ?? -1)) {
        throw new Error('relay_project_unavailable')
      }

      cursor = data.nextCursor as number

      if (page === 99) {
        throw new Error('relay_project_unavailable')
      }
    }

    if (!projectId) {
      const data = result(
        await this.o.t3.createProject(token, { title: snapshot.assistant.displayName, workspaceRoot: folder })
      )

      if (data.workspaceRoot !== folder || typeof data.id !== 'string' || !data.id) {
        throw new Error('relay_project_unavailable')
      }

      projectId = data.id
    }

    // Codex reads AGENTS.md at native session start. Never rewrite it on resume/send or record sync.
    const temporary = join(folder, `.persona-${randomUUID()}`)
    writeFileSync(
      temporary,
      `<!-- Atum persona revision: ${snapshot.definitionRevision} -->\n${snapshot.definition.soul}\n`,
      { mode: 0o600, flag: 'wx' }
    )
    renameSync(temporary, join(folder, 'AGENTS.md'))
    const pinned = { projectId, personaRevision: snapshot.definitionRevision }
    this.o.ledger.setMeta(key, JSON.stringify(pinned))

    return pinned
  }
}
