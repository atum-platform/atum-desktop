/**
 * The agent-home model, assembled for the app: everything `main.ts` needs from it, built from a handful of
 * closures over what `main.ts` already has (the owner's S1 requests, this Mac's device key and store, the Hermes
 * runtime, one handle per agent). Nothing here reaches into Electron, so the assembly is tested without it
 * (`app.test.ts`); `main.ts` supplies the closures and calls four things:
 *
 *   `holds(agent)`        added to `isMovingAgent`: the agent stays off while this Mac is not its home
 *   `keepsLease(agent)`   `reconcileLease` leaves the answering lease alone while a drain or checkpoint needs it
 *   `guard(queue, agent)` on an agent host's command queue: a Mac that is not the home publishes nothing
 *   `fence(agent, kind, send)`  the same decision for a send that does not go through that queue (the owner's task files)
 *   `service`             the loop, the views, and the owner's move and cancel
 */
import type { MatrixPublishResultFields } from '../../../shared/matrix'
import type { MatrixModelCatalog, MatrixModelRoute } from '../../../shared/matrix-models'

import { ArchiveCustody } from './archive-custody'
import { type HomeArchiveStore, type HomeSealKeySource, ShellArchiveStore, ShellSealKeySource } from './archive-store'
import { type CadenceOptions, CheckpointCadence } from './cadence'
import { PlacementConnectionAuth } from './connection-auth'
import { AgentHomeConnectionParticipant, type ModelApplyResult, type PrepareResult } from './connection-participant'
import { PlacementConnectionPlatform } from './connection-platform'
import { isUuid } from './contract'
import { AgentHomeController, type ControllerOptions } from './controller'
import { AgentEmissions } from './emissions'
import { type ExecutorKey, MacExecutorAuth } from './executor-auth'
import { AgentHomeHolds } from './holds'
import { type HomeTool, HomeToolError, PythonHomeTool, type PythonRuntime } from './home-tool'
import { AgentHomeJournal, type JournalStore } from './journal'
import { AgentHomeOwnerController } from './owner-controller'
import { ShellHomePlatform } from './platform-client'
import type { PublicationRequest } from './publication'
import { MacPublications, PublicationError, type PublicationStore } from './publication'
import { createHomeRuntimeOps, type MacAgentHandle } from './runtime-adapter'
import type { HomeContext } from './runtime-ops'
import { AgentHomeService, rememberUnsupported } from './service'
import { sweepStagingAtStart } from './staging'
import { type EmissionGuard, fenceEmission, guardAgentPublication, NotTheHomeError } from './standing'

export interface AgentHomeAppDeps {
  /** `account.s1Request`: runs `send` with a live bearer and the S1 resource base URL. */
  request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  /** This Mac's device key while it is enrolled (`MacDeviceIdentity.executorKey`). */
  key(): ExecutorKey | null
  /** The device's encrypted store: the frame counter, and what this Mac remembers about each home. */
  store: JournalStore & { failureCode(): string | null }
  /** The Hermes runtime the portable capture and restore run in; absent until it is installed. */
  runtime(): PythonRuntime | undefined
  /** Replaces the Python tool (tests). */
  tool?: HomeTool
  /** Private folders for staging, the backups of what a restore replaces, and quarantined copies. */
  dirs: HomeContext['dirs']
  /** One agent's runtime on this Mac, or null when it has none. */
  handle(agent: string): MacAgentHandle | null
  /** Create target custody for a cloud-home agent without admitting work. */
  materialize?(agent: string, signal: AbortSignal): Promise<void>
  /**
   * Whether this Mac already holds the agent (an enrollment and a Hermes home): its connection catalog is read from what is
   * there. Defaults to the handle having a home. A Mac creates custody only for an agent it is (about to be) the home of.
   */
  custody?(agent: string): boolean
  /** Existing sanitized provider adapter; no credential material is returned. */
  connections?: {
    catalog(agent: string, signal: AbortSignal): Promise<MatrixModelCatalog>
    apply(agent: string, route: MatrixModelRoute, effort: 'low' | 'medium' | 'high' | 'max', signal: AbortSignal): Promise<ModelApplyResult>
    /**
     * Keeps this Mac's executor for an agent it holds without running answerable (rotated ahead of its expiry, or enrolled again
     * once it lapsed); `force` rotates now. Starts no host, lease, listener or turn. Throws when it could not.
     */
    keepExecutor?(agent: string, signal: AbortSignal, force: boolean): Promise<void>
  }
  /** The agent's encrypted store (where its invocation outcomes live): the event bytes handed to the platform are kept there. */
  publicationStore(agent: string): PublicationStore | null
  /** The agent principals whose placement this Mac should look at. */
  agents(): readonly string[]
  /** Signed in and not closing. */
  ready(): boolean
  /** The signed-in account's identity. */
  scope(): string | null
  /**
   * The owner's platform principal: the `principal` of the platform's own answer about this sign-in. The data key's name is
   * derived from it, so a key the platform names for any other owner is refused. Null when it cannot be read.
   */
  ownerPrincipal(signal: AbortSignal): Promise<string | null>
  /** A view changed: publish the app state again. */
  changed(): void
  log(line: string): void
  now?(): number
  fetch?: typeof fetch
  verifyController?(message: string, value: unknown): boolean
  budgets?: ControllerOptions['budgets']
  /** How a flow waits (tests: a fake clock); the clock's own by default. */
  sleep?: ControllerOptions['sleep']
  /** Test seam: a flow reports each named step after it is journaled (`checkpoint:sealed`...); a test models a crash there. */
  step?(name: string): void
  /** The checkpoint cadence's clocks (tests; the defaults are the owner's: 15 minutes when dirty, 5 idle). */
  cadence?: Partial<Pick<CadenceOptions, 'every' | 'idleAfter' | 'tickMs' | 'minGapMs' | 'retryMs' | 'unsupportedRetryMs'>>
  /** How a result waits for the platform's worker (tests; the defaults are the worker's own minute). */
  publicationTiming?: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; pollMs?: number; waitMs?: number }
}

export interface AgentHomeApp {
  service: AgentHomeService
  holds: AgentHomeHolds
  controller: AgentHomeController
  owner: AgentHomeOwnerController
  participant?: AgentHomeConnectionParticipant
  /** Takes the home's periodic and idle checkpoints (cadence.ts). */
  cadence: CheckpointCadence
  /** The owner just acted on the agent: look at it, its move and its saved model at the next beat instead of when their time comes. */
  kick(agent: string): void
  /** The agent must stay off on this Mac (the placement model's answer for `isMovingAgent`). */
  isHeld(agent: string): boolean
  /** The answering lease is what signs a drain or a checkpoint right now: leave it as it is. */
  keepsLease(agent: string): boolean
  /**
   * The placement model governs this agent (a move was asked for, or has happened): its results reach a room only
   * through the platform's outbox, and its typed questions go through the platform's ledger like a cloud agent's.
   * An agent this Mac has not seen under the model keeps today's path.
   */
  isMigrated(agent: string): boolean
  /** The result of this invocation was handed to the platform's outbox: the ledger records it, so no legacy acknowledgement follows. */
  outboxed(agent: string, invocationId: string): boolean
  /** Managed jobs always use the fenced D1 outbox, including while draining. No rollout direct-send fallback. */
  publishJob(request: PublicationRequest, signal: AbortSignal): Promise<string>
  /**
   * The owner's "Set this Mac up for <agent>": this Mac enrolls for the agent and publishes its connection catalog at once,
   * so the platform lists it as a place the agent can move to (desktop and phone). Admits no turn; moves nothing.
   */
  prepare(agent: string, signal: AbortSignal): Promise<PrepareResult>
  /** Put the stand-down fence on an agent host's command queue. */
  guard<Q extends { command(value: unknown, timeoutMs?: number): Promise<unknown> }>(queue: Q, agent: () => string | undefined): Q
  /**
   * The same fence for something the agent's own queue never sees, run as `send`: the owner's task files go out from the
   * owner's session, but they are addressed to an agent this Mac may have stood down or be draining. Throws when this Mac
   * may not say it; counted as in flight while it runs.
   */
  fence<T>(agent: string, kind: string, send: () => Promise<T>): Promise<T>
  /** Whether `fence` would let this Mac say `kind` for the agent now, asked without saying anything (a status, a dry run). */
  allows(agent: string, kind: string): Promise<boolean>
}

/** A tool that finds the runtime when it is used, so the app can build the model before Hermes is installed. */
function lazyTool(runtime: () => PythonRuntime | undefined): HomeTool {
  const tool = (): HomeTool => {
    const python = runtime()

    if (!python) {
      throw new HomeToolError('runtime_unavailable')
    }

    return new PythonHomeTool(python)
  }

  return {
    capture: async (input, signal) => tool().capture(input, signal),
    snapshot: async (input, signal) => tool().snapshot(input, signal),
    fingerprint: async (input, signal) => tool().fingerprint(input, signal),
    exportAll: async (input, signal) => tool().exportAll(input, signal),
    restore: async (input, signal) => tool().restore(input, signal)
  }
}

export function createAgentHomeApp(deps: AgentHomeAppDeps): AgentHomeApp {
  const now = deps.now ?? Date.now
  const journal = new AgentHomeJournal(deps.store)
  const holds = new AgentHomeHolds(journal)
  // A process that was killed in the middle of a checkpoint or a restore leaves its staging on the disk (a plaintext copy of the
  // portable part, or the sealed archive it was about to upload). Nothing is staging yet, so everything the journal does not name
  // as a live checkpoint's own folder is of no further use; that one may hold the only copy of what was sealed.
  sweepStagingAtStart(deps.dirs.work, agent => journal.read(agent).checkpoint?.checkpointId, deps.log)
  // What each agent is saying directly right now, and whether it has been switched to the platform's outbox only.
  const emissions = new AgentEmissions()
  // The connection participant is built below, from these ops; the gate asks it only when an activation happens.
  let participant: AgentHomeConnectionParticipant | undefined

  const ops = createHomeRuntimeOps({
    handle: deps.handle,
    materialize: deps.materialize,
    holds,
    emissions,
    modelGate: deps.connections ? (agent, signal) => participant?.prepareActivation(agent, signal) ?? Promise.resolve(false) : undefined,
    log: deps.log
  })

  const auth = new MacExecutorAuth({ key: deps.key, store: deps.store, now })
  const platform = rememberUnsupported(new ShellHomePlatform({ request: deps.request, fetch: deps.fetch }), { now })
  const connectionAuth = new PlacementConnectionAuth({ key: deps.key, store: deps.store, now })

  const connectionPlatform = new PlacementConnectionPlatform({
    request: deps.request,
    fetch: deps.fetch,
    verifyController: deps.verifyController
  })

  const owner = new AgentHomeOwnerController({
    platform: connectionPlatform,
    auth: connectionAuth,
    now,
    changed: deps.changed
  })

  // The archive and key routes admit a device, not a lease: this Mac signs for the home it is, or the move it is the target of.
  const custody = new ArchiveCustody({ platform, auth, me: () => auth.deviceServiceId(), leaseFacts: agent => ops.leaseFacts(agent) })
  // The owner's principal does not change for a sign-in: asked once per sign-in, and again for another account.
  let known: { scope: string | null; principal: string } | undefined

  const ownerPrincipal = async (signal: AbortSignal): Promise<string | null> => {
    const scope = deps.scope()

    if (known && known.scope === scope) {
      return known.principal
    }

    try {
      const principal = await deps.ownerPrincipal(signal)

      if (typeof principal === 'string' && isUuid(principal)) {
        known = { scope, principal }

        return principal
      }
    } catch {
      // Not readable now: no key is taken until it is.
    }

    return null
  }

  const shell = { request: deps.request, signer: custody, ownerPrincipal, fetch: deps.fetch, now, sleep: deps.sleep }
  const archives: HomeArchiveStore = new ShellArchiveStore(shell)
  const keys: HomeSealKeySource = new ShellSealKeySource(shell)

  participant = deps.connections
    ? new AgentHomeConnectionParticipant({
        platform: connectionPlatform,
        auth: connectionAuth,
        owner,
        holds,
        store: deps.store,
        scope: deps.scope,
        me: () => connectionAuth.deviceServiceId(),
        catalog: deps.connections.catalog,
        custody: deps.custody ?? (agent => Boolean(deps.handle(agent)?.home())),
        materialize: deps.materialize ?? (async () => undefined),
        keepExecutor: deps.connections.keepExecutor,
        atRest: agent => ops.atRest(agent),
        leaseFacts: agent => ops.leaseFacts(agent),
        apply: deps.connections.apply,
        resume: agent => deps.handle(agent)?.restart(),
        now,
        log: deps.log
      })
    : undefined

  const controller = new AgentHomeController({
    platform,
    auth,
    tool: deps.tool ?? lazyTool(deps.runtime),
    store: archives,
    keys,
    journalStore: deps.store,
    runtime: ops,
    connection: { platform: connectionPlatform, auth: connectionAuth },
    participant,
    me: () => auth.deviceServiceId(),
    dirs: deps.dirs,
    budgets: deps.budgets,
    sleep: deps.sleep,
    now,
    log: deps.log,
    step: deps.step,
    notHome: agent => ops.standDown(agent)
  })

  /**
   * The checkpoint cadence. A Mac checkpoints an agent only when the model governs it, this Mac is its home, nothing is
   * moving it and nothing holds it (a drain, a restore, a stand-down); `service` is read when it is asked, after it exists.
   */
  const cadence = new CheckpointCadence({
    journal,
    now,
    eligible: agent => {
      const entry = journal.read(agent)
      const view = controller.view(agent)

      return (
        entry.managed &&
        !entry.standDown &&
        !service.holds(agent) &&
        view !== null &&
        view.lives.kind === 'mac' &&
        view.lives.thisMac &&
        view.move === null
      )
    },
    busy: agent => deps.handle(agent)?.busy?.() ?? false,
    atRest: agent => ops.atRest(agent),
    fingerprint: async (agent, signal) => {
      const home = ops.home(agent)

      if (!home) {
        return null
      }

      try {
        return (await controller.ctx.tool.fingerprint({ home }, signal)).fingerprintSha256
      } catch {
        // No runtime, or a tool that predates the fingerprint: the quarter hour alone decides.
        return null
      }
    },
    checkpoint: (agent, reason, signal) => controller.checkpoint(agent, signal, reason),
    log: deps.log,
    ...deps.cadence
  })

  const service = new AgentHomeService({
    controller,
    holds,
    agents: deps.agents,
    ready: deps.ready,
    scope: deps.scope,
    now,
    changed: deps.changed,
    cadence,
    forget: agent => {
      participant?.forget(agent)
      owner.forget(agent)
    },
    log: deps.log
  })

  const publications = new MacPublications({
    platform,
    auth,
    standing: controller.standing,
    leaseFacts: agent => ops.leaseFacts(agent),
    store: deps.publicationStore,
    now,
    log: deps.log,
    ...deps.publicationTiming
  })

  /**
   * A migrated agent's `publishResult`: prepared by the SDK as final bytes, signed, and handed to the platform. The one
   * exception is the rollout's: while the platform's worker is switched off (`publication_disabled`) and nothing of the
   * result was ever enqueued, the result is sent the legacy way, through the same fence as any other direct send.
   */
  const outbox: NonNullable<EmissionGuard['outbox']> = async (command, context) => {
    const result = command as unknown as MatrixPublishResultFields

    // Only a result of the platform's ledger can be recorded by the worker; anything else has nowhere to be recorded.
    if (result.ledger !== true || !isUuid(result.invocationId)) {
      throw new PublicationError('matrix_publication_refused', 'not_ledgered')
    }

    try {
      return await throughPlatform(command, context)
    } catch (error) {
      if (error instanceof PublicationError && error.code === 'matrix_publication_disabled') {
        return context.direct(command, context.timeoutMs)
      }

      throw error
    }
  }

  const throughPlatform = (
    command: Record<string, unknown>,
    context: { agent: string; send: (value: unknown, timeoutMs?: number) => Promise<unknown>; timeoutMs?: number }
  ): Promise<unknown> => {
    const result = command as unknown as MatrixPublishResultFields

    return publications.publish(
      {
        agent: context.agent,
        operation: { kind: 'invocation', id: result.invocationId },
        roomId: result.roomId,
        transactionId: result.matrixTransactionId ?? result.transactionId,
        ...(result.part ? { part: result.part } : {}),
        prepare: async () => {
          const prepared = (await context.send({ ...command, kind: 'prepareResult' }, context.timeoutMs)) as {
            eventType?: unknown
            content?: unknown
          } | null

          if (
            !prepared ||
            (prepared.eventType !== 'm.room.message' && prepared.eventType !== 'm.room.encrypted') ||
            !prepared.content ||
            typeof prepared.content !== 'object'
          ) {
            throw new PublicationError('matrix_publication_unavailable', 'prepare_invalid')
          }

          return { eventType: prepared.eventType, content: prepared.content }
        }
      },
      // The platform's worker comes round about once a minute: a call waits for it, and stops when the app does.
      AbortSignal.any([service.signal, AbortSignal.timeout(180_000)])
    )
  }

  /** Whether the model governs the agent: the journal's word, kept a moment so the questions asked all the time stay cheap. */
  const migrated = new Map<string, { at: number; value: boolean }>()
  /** When each never-moved agent was last asked to be looked at because it spoke. */
  const discovered = new Map<string, number>()

  /** The one fence for what an agent says in a room (see `fenceEmission`); the queue's guard and `fence` share it. */
  const emissionGuard: EmissionGuard = {
    standing: controller.standing,
    // The journal's word, read where it is asked: an agent this Mac has not seen under the model never waits for anyone.
    managed: agent => controller.ctx.journal.read(agent).managed,
    // This Mac stood the agent down itself: said no without asking anyone, even with the platform out of reach.
    stoodDown: each => {
      // Seeds the holds from the journal on first sight, so a restart does not forget a stand-down.
      service.holds(each)

      return holds.reasons(each).includes('standDown')
    },
    outboxOnly: each => emissions.outboxOnly(each),
    flights: emissions,
    // Whatever the agent says counts as activity: its idle clock starts again.
    activity: each => cadence.touch(each),
    // An agent that was never moved is looked at in the background while it talks, not before it may: a move asked for
    // from another Mac is then noticed in seconds rather than at the slow loop's next turn. Once per quarter minute.
    discover: each => {
      if (now() - (discovered.get(each) ?? Number.NEGATIVE_INFINITY) >= 15_000) {
        discovered.set(each, now())
        service.kick(each)
      }
    },
    outbox
  }

  return {
    service,
    holds,
    controller,
    owner,
    participant,
    cadence,
    kick: agent => {
      participant?.wake(agent)
      owner.wake(agent)
      service.kick(agent)
    },
    prepare: async (agent, signal) => {
      if (!participant || !deps.ready()) {return { ok: false, reason: 'unavailable' }}

      // What the platform says the placement is right now, not what the last beat saw.
      const placement = await platform.readPlacement(agent, signal)

      if (placement.ok === false) {return { ok: false, reason: 'unavailable' }}

      const result = await participant.prepare(agent, placement.value, signal)

      // The owner's sheet reads the platform's view next: look at the agent, its catalog and its move at once.
      if (result.ok) {
        participant.wake(agent)
        owner.wake(agent)
        service.kick(agent)
      }

      return result
    },
    isHeld: agent => service.holds(agent),
    keepsLease: agent => {
      service.holds(agent)

      return holds.keepsLease(agent)
    },
    isMigrated: agent => {
      const known = migrated.get(agent)

      if (known && now() - known.at < 2_000) {
        return known.value
      }

      const value = controller.ctx.journal.read(agent).managed
      migrated.set(agent, { at: now(), value })

      return value
    },
    publishJob: (request, signal) => {
      if (request.operation.kind !== 'job') {throw new PublicationError('matrix_publication_refused', 'not_job')}

      return publications.publish(request, AbortSignal.any([service.signal, signal]))
    },
    outboxed: (agent, invocationId) => publications.has(agent, { kind: 'invocation', id: invocationId }),
    guard: (queue, agent) => guardAgentPublication(queue, { ...emissionGuard, agent }),
    fence: <T>(agent: string, kind: string, send: () => Promise<T>) =>
      fenceEmission(emissionGuard, agent, kind, { kind }, async () => send()) as Promise<T>,
    allows: async (agent, kind) => {
      try {
        await fenceEmission(emissionGuard, agent, kind, { kind }, async () => true)

        return true
      } catch (error) {
        if (error instanceof NotTheHomeError) {
          return false
        }

        throw error
      }
    }
  }
}
