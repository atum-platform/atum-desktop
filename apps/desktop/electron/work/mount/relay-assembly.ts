import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  /**
   * Absolute paths a relay session must not read (plan O16): other makers' logins, SSH and cloud credentials, browser
   * profiles, the keychain, Atum's and T3's own stores, sibling assistants. Written into the folder's native settings.
   */
  protectedRoots?: readonly string[]
}

/**
 * The protected data of plan O16 as roots under `home`, for a relay folder's native settings: other makers' logins, SSH and
 * cloud credentials, the keychain, browser stores, Atum's and T3's own stores, and every assistant folder (a session's own
 * folder is allowed back in by `allowRead`).
 */
export function relayProtectedRoots(home: string, assistantsRoot: string): string[] {
  return [
    '.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.kube', '.docker', '.netrc', '.gnupg',
    '.codex', '.gemini', '.claude', '.claude.json', '.t3', '.hermes',
    'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Mail', 'Library/Messages',
    'Library/Application Support/Google', 'Library/Application Support/Chromium',
    'Library/Application Support/Firefox', 'Library/Application Support/Arc',
    'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
    'Library/Application Support/T3 Code', 'Library/Application Support/Atum',
    'Library/Application Support/Claude', 'Library/Application Support/Antigravity',
    'Library/Application Support/Code/User/globalStorage'
  ]
    .map(relative => join(home, relative))
    .concat(resolve(assistantsRoot))
}

/** Instruction files each native harness loads at session start: Codex and Antigravity read AGENTS.md, Claude CLAUDE.md, Antigravity GEMINI.md. */
export const RELAY_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const

/**
 * Claude Code's own project settings for a relay folder, written once with the persona (never rewritten): an enforced
 * deny-read over the protected roots, its native sandbox required, no project MCP servers, and no edits to the persona
 * or these settings. `//` is Claude's absolute-path prefix in permission rules.
 */
export function claudeRelaySettings(input: { folder: string; protectedRoots: readonly string[] }) {
  const absolute = (path: string) => `/${path}`
  const own = (file: string) => absolute(join(input.folder, file))

  return {
    permissions: {
      deny: [
        ...input.protectedRoots.flatMap(root => [`Read(${absolute(root)})`, `Read(${absolute(root)}/**)`]),
        ...[...RELAY_INSTRUCTION_FILES, '.claude/settings.json'].flatMap(file => [`Edit(${own(file)})`, `Write(${own(file)})`])
      ]
    },
    enableAllProjectMcpServers: false,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyRead: [...input.protectedRoots], allowRead: [input.folder] }
    }
  }
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

    const pending = this.pending.get(key)

    if (pending) {
      return pending
    }

    const run = this.create(principal, threadId, key).finally(() => this.pending.delete(key))
    this.pending.set(key, run)

    return run
  }

  private async create(principal: string, threadId: string, key: string) {
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
    const folder = join(root, createHash('sha256').update(JSON.stringify([principal, threadId])).digest('hex'))
    mkdirSync(root, { recursive: true, mode: 0o700 })

    if (lstatSync(root).isSymbolicLink()) {
      throw new Error('relay_folder_invalid')
    }

    // A new native session gets its own project. Keep it beside legacy assistant projects
    // so native instruction discovery cannot inherit their previously shared persona.
    if (!existsSync(folder)) {
      const temporary = mkdtempSync(join(root, '.relay-persona-'))
      const instruction = `<!-- Atum persona revision: ${snapshot.definitionRevision} -->\n${snapshot.definition.soul}\n`

      try {
        for (const file of RELAY_INSTRUCTION_FILES) {
          writeFileSync(join(temporary, file), instruction, { mode: 0o400, flag: 'wx' })
        }

        mkdirSync(join(temporary, '.claude'), { mode: 0o700 })
        writeFileSync(
          join(temporary, '.claude', 'settings.json'),
          JSON.stringify(claudeRelaySettings({ folder, protectedRoots: this.o.protectedRoots ?? [] })),
          { mode: 0o400, flag: 'wx' }
        )

        renameSync(temporary, folder)
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    }

    if (!lstatSync(folder).isDirectory()) {
      throw new Error('relay_folder_invalid')
    }

    // Project creation and ledger persistence can fail independently. Retrying the same
    // launch must reuse the files and their original revision across either failure.
    const instructions = RELAY_INSTRUCTION_FILES.map(file => {
      const location = join(folder, file)

      if (!lstatSync(location).isFile()) {
        throw new Error('relay_folder_invalid')
      }

      return readFileSync(location, 'utf8')
    })
    const revision = /^<!-- Atum persona revision: ([1-9][0-9]*) -->\n/u.exec(instructions[0])
    const personaRevision = Number(revision?.[1])

    if (!Number.isSafeInteger(personaRevision) || instructions.some(text => text !== instructions[0])) {
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

    const pinned = { projectId, personaRevision }
    this.o.ledger.setMeta(key, JSON.stringify(pinned))

    return pinned
  }
}
