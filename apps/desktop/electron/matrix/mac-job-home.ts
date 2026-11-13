/** Retained legacy Mac-job authority and publication fence until native job cutover.
 * This module has no relocation, archive, restore, checkpoint or model-application runner.
 */
import type { MatrixPublishResultFields } from '../../shared/matrix'

import { AgentEmissions } from './agent-home-placement/emissions'
import { type ExecutorKey, MacExecutorAuth } from './agent-home-placement/executor-auth'
import type { LeaseFacts } from './agent-home-placement/fence'
import { AgentHomeJournal, type JournalStore } from './agent-home-placement/journal'
import { ShellHomePlatform } from './agent-home-placement/platform-client'
import { MacPublications, PublicationError, type PublicationStore } from './agent-home-placement/publication'
import { type EmissionGuard, fenceEmission, guardAgentPublication, HomeStanding, mayAct, NotTheHomeError } from './agent-home-placement/standing'

export interface MacJobHomeDeps {
  request<T>(send: (token: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  key(): ExecutorKey | null
  store: JournalStore & { failureCode(): string | null }
  leaseFacts(agent: string): LeaseFacts | null
  publicationStore(agent: string): PublicationStore | null
  agents(): readonly string[]
  ready(): boolean
  changed(): void
  log(line: string): void
}

export function createMacJobHome(deps: MacJobHomeDeps) {
  const auth = new MacExecutorAuth({ key: deps.key, store: deps.store })
  const platform = new ShellHomePlatform({ request: deps.request })
  const journal = new AgentHomeJournal(deps.store)
  const me = () => auth.deviceServiceId()
  const standing = new HomeStanding({ platform, journal, me, log: deps.log })
  const ctx = { auth, platform, journal, standing, me, runtime: { leaseFacts: deps.leaseFacts } }
  const lifetime = new AbortController()

  const publications = new MacPublications({ platform, auth, standing, leaseFacts: deps.leaseFacts,
    store: deps.publicationStore, log: deps.log })

  const held = (agent: string) => {
    const entry = journal.read(agent)
    const last = standing.last(agent)

    return entry.standDown || (entry.managed && (!last || !mayAct(last)))
  }

  const emissions = new AgentEmissions()

  const guard: EmissionGuard = {
    standing, managed: agent => journal.read(agent).managed,
    stoodDown: held, outboxOnly: () => false, flights: emissions,
    outbox: async (command, context) => {
      const result = command as unknown as MatrixPublishResultFields

      if (result.ledger !== true) { throw new PublicationError('matrix_publication_refused', 'not_ledgered') }

      return publications.publish({ agent: context.agent, operation: { kind: 'invocation', id: result.invocationId },
        roomId: result.roomId, transactionId: result.matrixTransactionId ?? result.transactionId,
        ...(result.part ? { part: result.part } : {}),
        prepare: async () => {
          const prepared = await context.send({ ...command, kind: 'prepareResult' }, context.timeoutMs) as {
            eventType?: unknown; content?: unknown
          } | null

          if (!prepared || (prepared.eventType !== 'm.room.message' && prepared.eventType !== 'm.room.encrypted') ||
            !prepared.content || typeof prepared.content !== 'object') {
            throw new PublicationError('matrix_publication_unavailable', 'prepare_invalid')
          }

          return { eventType: prepared.eventType, content: prepared.content }
        }
      }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(180_000)]))
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = async () => {
    if (!deps.ready() || lifetime.signal.aborted) { return }
    await Promise.all(deps.agents().map(agent => standing.check(agent, lifetime.signal, { fresh: true })))
    deps.changed()
  }

  return {
    controller: { ctx },
    service: {
      start() { timer ??= setInterval(() => void refresh().catch(() => deps.log('[Matrix] Mac-job authority unavailable')), 5_000); timer.unref(); void refresh().catch(() => {}) },
      stop() { lifetime.abort(); clearInterval(timer) },
      view(agent: string) {
        const last = standing.last(agent)

        if (!last || !('placement' in last)) { return null }
        const location = last.placement.location

        return { lives: location.kind === 'cloud' ? { kind: 'cloud' as const }
          : { kind: 'mac' as const, deviceServiceId: location.deviceServiceId, thisMac: location.deviceServiceId === me() } }
      }
    },
    isHeld: held,
    keepsLease: (agent: string) => journal.read(agent).managed && !held(agent),
    isMigrated: (agent: string) => journal.read(agent).managed,
    outboxed: (agent: string, invocationId: string) => publications.has(agent, { kind: 'invocation', id: invocationId }),
    publishJob: (request: Parameters<MacPublications['publish']>[0], signal: AbortSignal) => {
      if (request.operation.kind !== 'job') { throw new PublicationError('matrix_publication_refused', 'not_job') }

      return publications.publish(request, AbortSignal.any([lifetime.signal, signal]))
    },
    guard: <Q extends { command(value: unknown, timeoutMs?: number): Promise<unknown> }>(queue: Q, agent: () => string | undefined) => guardAgentPublication(queue, { ...guard, agent }),
    fence: <T>(agent: string, kind: string, send: () => Promise<T>) => fenceEmission(guard, agent, kind, { kind }, async () => send()) as Promise<T>,
    allows: async (agent: string, kind: string) => {
      try { await fenceEmission(guard, agent, kind, { kind }, async () => true);

 return true }
      catch (error) { if (error instanceof NotTheHomeError) { return false }; throw error }
    }
  }
}

export type MacJobHome = ReturnType<typeof createMacJobHome>
