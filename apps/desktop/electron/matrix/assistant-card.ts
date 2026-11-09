import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  ATUM_AGENT_PORTABILITY_SCHEMA_VERSION,
  type AtumAssistantDefinitionWrite
} from '../../shared/atum-agent-portability'
import {
  matrixAssistantAvatarChange,
  type MatrixAssistantCard,
  matrixAssistantCardChange,
  type MatrixAssistantCardError,
  matrixAssistantCardPrincipal,
  type MatrixAssistantCardResult
} from '../../shared/matrix-assistant-card'
import { checkAssistantName, isAssistantNameLocked } from '../../shared/matrix-assistant-name'
import { renameSoulHeading } from '../../shared/matrix-assistant-persona'
import { MATRIX_DEFAULT_MODEL } from '../../shared/matrix-models'

import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from './agent-definition'
import { matrixPrimarySoul, renamePrimarySoul } from './atum-soul'

/** What main knows about one of the owner's assistants on the current roster. */
export interface MatrixAssistantCardAgent {
  principal: string
  assistantId: string
  isDefault: boolean
  name?: string
}

export interface MatrixAssistantCardsOptions {
  /** The owner's current assistants (the authoritative roster this Mac holds). */
  agents(): readonly MatrixAssistantCardAgent[]
  /** The names the apps in the current catalog go by (`appCatalogNames`): not an assistant's to take. */
  appNames?(): readonly string[]
  read(assistantId: string, signal: AbortSignal): Promise<MatrixAgentDefinitionSnapshot>
  write(
    assistantId: string,
    input: AtumAssistantDefinitionWrite,
    signal: AbortSignal
  ): Promise<MatrixAgentDefinitionSnapshot>
  avatar(
    agent: MatrixAssistantCardAgent,
    avatar: { type: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array } | null,
    signal: AbortSignal
  ): Promise<MatrixAgentDefinitionSnapshot>
  /** A write landed: main updates the roster's name, this Mac's copy and what others see. */
  saved?(
    agent: MatrixAssistantCardAgent,
    snapshot: MatrixAgentDefinitionSnapshot,
    previous: MatrixAgentDefinitionSnapshot
  ): void
  timeoutMs?: number
}

/** The persona a primary assistant without one answers with, as the card shows it: the
 * built-in one, under the name the primary goes by (owner decision D1: it is renameable). */
export function matrixPrimaryCardSoul(name: string): string {
  const shown = name.trim() || 'Atum'

  return `# ${shown}\n\n${matrixPrimarySoul(shown)}`
}

/** The card's persona for a primary still called Atum. */
export const MATRIX_PRIMARY_CARD_SOUL = matrixPrimaryCardSoul('Atum')

/** The card's native side: one owner-scoped read and one fenced write per change. */
export class MatrixAssistantCards {
  constructor(private readonly options: MatrixAssistantCardsOptions) {}

  private agent(principal: string): MatrixAssistantCardAgent | undefined {
    const matches = this.options.agents().filter(agent => agent.principal === principal)

    return matches.length === 1 ? matches[0] : undefined
  }

  private signal(parent?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000)

    return parent ? AbortSignal.any([parent, timeout]) : timeout
  }

  private card(agent: MatrixAssistantCardAgent, snapshot: MatrixAgentDefinitionSnapshot): MatrixAssistantCard {
    const stored = snapshot.definition?.soul ?? ''
    const inherited = agent.isDefault && !stored.trim()

    return {
      principal: agent.principal,
      displayName: snapshot.assistant.displayName,
      isDefault: agent.isDefault,
      soul: inherited ? matrixPrimaryCardSoul(snapshot.assistant.displayName) : stored,
      inherited,
      skills: (snapshot.definition?.skills ?? []).map(skill => skill.name),
      definitionRevision: snapshot.definitionRevision,
      identityRevision: snapshot.identityRevision
    }
  }

  async read(value: unknown, signal?: AbortSignal): Promise<MatrixAssistantCardResult> {
    const principal = matrixAssistantCardPrincipal(value)
    const agent = principal ? this.agent(principal) : undefined

    if (!agent) {
      return { ok: false, error: 'missing' }
    }

    try {
      return { ok: true, card: this.card(agent, await this.options.read(agent.assistantId, this.signal(signal))) }
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
  }

  async save(value: unknown, signal?: AbortSignal): Promise<MatrixAssistantCardResult> {
    const change = matrixAssistantCardChange(value)
    const agent = change ? this.agent(change.principal) : undefined

    if (!change || !agent) {
      return { ok: false, error: change ? 'missing' : 'invalid' }
    }

    let name: string | undefined

    if (change.displayName !== undefined) {
      // Owner decision D1 (PRIMARY_ASSISTANT_KEEPS_NAME): the primary may be always Atum.
      if (isAssistantNameLocked(agent)) {
        return { ok: false, error: 'locked' }
      }

      const checked = checkAssistantName(change.displayName, {
        primary: agent.isDefault,
        principal: agent.principal,
        others: this.options.agents().map(each => ({ principal: each.principal, name: each.name })),
        apps: this.options.appNames?.()
      })

      if (checked.ok === false) {
        return {
          ok: false,
          error: checked.problem === 'reserved' ? 'reserved' : checked.problem === 'duplicate' ? 'duplicate' : 'invalid'
        }
      }

      name = checked.name
    }

    let current: MatrixAgentDefinitionSnapshot

    try {
      current = await this.options.read(agent.assistantId, this.signal(signal))
    } catch (error) {
      return { ok: false, error: failure(error) }
    }

    if (
      current.definitionRevision !== change.expectedDefinitionRevision ||
      current.identityRevision !== change.expectedIdentityRevision
    ) {
      return { ok: false, error: 'conflict', card: this.card(agent, current) }
    }

    const storedSoul = current.definition?.soul ?? ''
    const displayName = name ?? current.assistant.displayName

    // A persona is written only when one is given, or when a rename moves its heading. Its
    // "# Name" heading always follows the stored name: a persona built by the window before a
    // rename landed (a queued save, an Undo of an older edit) never brings the old name back.
    // The primary's also keeps Atum's built-in first line ("You are Name, …") on its name.
    const rehead = agent.isDefault ? renamePrimarySoul : renameSoulHeading

    const soul =
      change.soul !== undefined ? rehead(change.soul, displayName) : name ? rehead(storedSoul, name) : storedSoul

    if (displayName === current.assistant.displayName && soul === storedSoul) {
      return { ok: true, card: this.card(agent, current) }
    }

    try {
      const written = await this.options.write(
        agent.assistantId,
        {
          expectedDefinitionRevision: current.definitionRevision,
          expectedIdentityRevision: current.identityRevision,
          displayName,
          avatar: current.assistant.avatar,
          definition: {
            schemaVersion: ATUM_AGENT_PORTABILITY_SCHEMA_VERSION,
            soul,
            modelAlias: current.definition?.modelAlias ?? MATRIX_DEFAULT_MODEL,
            reasoning: current.definition?.reasoning ?? null,
            skills: current.definition?.skills ?? []
          }
        },
        this.signal(signal)
      )

      this.options.saved?.(agent, written, current)

      return { ok: true, card: this.card(agent, written) }
    } catch (error) {
      const code = failure(error)

      if (code === 'conflict') {
        try {
          return {
            ok: false,
            error: code,
            card: this.card(agent, await this.options.read(agent.assistantId, this.signal(signal)))
          }
        } catch {
          return { ok: false, error: code }
        }
      }

      // The platform refused the request itself: with a new name, the name (its own list).
      return { ok: false, error: code === 'invalid' && name ? 'reserved' : code }
    }
  }

  async avatar(value: unknown, signal?: AbortSignal) {
    const change = matrixAssistantAvatarChange(value)
    const agent = change ? this.agent(change.principal) : undefined

    if (!change || !agent) {
      return { ok: false as const, error: change ? 'missing' as const : 'invalid' as const }
    }

    try {
      const snapshot = await this.options.avatar(agent, change.avatar, this.signal(signal))

      if (snapshot.assistant.principal !== agent.principal) {
        return { ok: false as const, error: 'unavailable' as const }
      }

      return { ok: true as const, avatarUrl: snapshot.assistant.avatarUrl }
    } catch (error) {
      return { ok: false as const, error: failure(error) }
    }
  }
}

function failure(error: unknown): MatrixAssistantCardError {
  if (!(error instanceof MatrixAgentDefinitionError)) {
    return 'unavailable'
  }

  return (
    { denied: 'denied', conflict: 'conflict', missing: 'missing', unavailable: 'offline', invalid: 'invalid' } as const
  )[error.code]
}

/** Fixed trusted UI operations: a principal in, a card out. */
export function registerMatrixAssistantCardsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  cards: MatrixAssistantCards,
  requireCaller: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle('matrix:assistants:read', (event, principal: unknown) => {
    requireCaller(event)

    return cards.read(principal)
  })
  ipc.handle('matrix:assistants:save', (event, change: unknown) => {
    requireCaller(event)

    return cards.save(change)
  })
  ipc.handle('matrix:assistants:avatar', (event, change: unknown) => {
    requireCaller(event)

    return cards.avatar(change)
  })
}
