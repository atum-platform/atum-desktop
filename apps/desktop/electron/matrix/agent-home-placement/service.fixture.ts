/**
 * Test support only: a Mac wired the way the app wires it — `AgentHomeService` over `createHomeRuntimeOps` over a
 * `MacAgentHandle` — around the same simulated platform, clock and tool the controller tests use.
 *
 * `FakeHandle` keeps the promises `MacAgentHandle` documents: a drain stops admission and waits for the turn in
 * flight without ever ending it, stopping the writers gives up the lease, a restart competes for it again, and
 * `beginHere` counts the fresh sessions a conversation would be rebuilt with.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { HomeArchiveStore, HomeSealKeySource } from './archive-store'
import { AgentHomeController } from './controller'
import { AgentHomeHolds } from './holds'
import { AgentHomeJournal } from './journal'
import type { TestMac } from './mac.fixture'
import { FakeHomeTool, shellArchive } from './node.fixture'
import { createHomeRuntimeOps, type MacAgentHandle } from './runtime-adapter'
import { AgentHomeService, rememberUnsupported } from './service'
import { guardAgentPublication } from './standing'
import { scratchDirectory, type World } from './world.fixture'

/** The SDK window as the agent's host queue reaches it: it records every command and prepares a result as plain bytes. */
class FakeQueue {
  readonly sent: Array<{ kind: string; body?: string; [key: string]: unknown }> = []
  /** A command is on its way to the room until this resolves (a slow send): a test holds a notice here. */
  pause: ((command: { kind: string; [key: string]: unknown }) => Promise<void> | undefined) | null = null

  command = async (value: unknown): Promise<unknown> => {
    const command = value as { kind: string; body?: string }
    this.sent.push(command)
    await this.pause?.(command)

    // A result prepared, not sent: the final bytes of a room without encryption.
    if (command.kind === 'prepareResult') {
      return { eventType: 'm.room.message', content: { msgtype: 'm.text', body: command.body } }
    }

    return { ok: true }
  }
}

export class FakeHandle implements MacAgentHandle {
  readonly calls: string[] = []
  readonly queue = new FakeQueue()
  admitting = true
  up = true
  wantsLease = false
  freshSessions = 0
  intake = true
  /** The agent is in the middle of something (a turn, a task): the cadence waits for it. */
  working = false
  /** Hermes's review of the last answer is still writing the home (its `bg-review` thread): the agent is not at rest. */
  reviewing = false
  /** How many times the agent's process was started again after being stopped (a cold start); a checkpoint beside it makes none. */
  coldStarts = 0
  /** How many times the agent's writers were stopped (its process killed). */
  stops = 0
  /** How many times the cadence asked whether the agent is at rest (a query: it disturbs nothing). */
  restAsked = 0
  /** The next turn finds a cold agent: its process was stopped and started again since the last one. */
  private cold = false
  turn: { finish(): void; done: Promise<void> } | null = null
  private guarded: FakeQueue | undefined

  constructor(
    private readonly world: World,
    private readonly mac: TestMac,
    readonly homeDir: string
  ) {}

  guard(standing: AgentHomeController['standing']): void {
    this.guarded = guardAgentPublication(this.queue, { agent: () => this.world.agent, standing }) as FakeQueue
  }

  /** The agent host's queue as the app wraps it (`AgentHomeApp.guard`). */
  guardWith(wrap: (queue: FakeQueue, agent: () => string) => FakeQueue): void {
    this.guarded = wrap(this.queue, () => this.world.agent)
  }

  startTurn(): void {
    let finish!: () => void

    const done = new Promise<void>(resolve => {
      finish = resolve
    })

    this.turn = { finish, done }
  }

  /**
   * What the agent says in a room, through the host queue's guard: a result of the platform's ledger by default (the
   * only kind a migrated agent can publish), or one without (`ledger: false`). Resolves with how it went.
   */
  async say(body: string, options: { ledger?: boolean; invocationId?: string } = {}): Promise<'sent' | 'refused'> {
    const invocationId = options.invocationId ?? randomUUID()
    const ledgered = options.ledger !== false

    if (ledgered) {
      this.world.stub.registerOperation(this.world.agent, { kind: 'invocation', id: invocationId })
    }

    try {
      await (this.guarded ?? this.queue).command({
        kind: 'publishResult',
        body,
        roomId: '!room:atum.example',
        eventId: '$question:atum.example',
        invocationId,
        transactionId: `atum-${invocationId.slice(0, 8)}`,
        ...(ledgered ? { ledger: true as const } : {})
      })

      return 'sent'
    } catch {
      return 'refused'
    }
  }

  /** Any other command the agent's host sends (a routine's result, a notice, a task event): through the guard, how it went. */
  async emit(command: { kind: string; [key: string]: unknown }): Promise<'sent' | 'refused'> {
    try {
      await (this.guarded ?? this.queue).command(command)

      return 'sent'
    } catch {
      return 'refused'
    }
  }

  private tryAcquire(): void {
    const lease = this.world.stub.lease(this.world.agent)

    if (this.wantsLease && (!lease || lease.expiresAt <= this.world.clock.now())) {
      this.world.stub.grantLease(this.world.agent, this.mac.deviceServiceId)
    }
  }

  home(): string {
    return this.homeDir
  }

  leaseFacts() {
    this.tryAcquire()
    const lease = this.world.stub.lease(this.world.agent)

    return lease && lease.executorDevice === this.mac.deviceServiceId && lease.expiresAt > this.world.clock.now()
      ? { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term }
      : null
  }

  async drain(): Promise<void> {
    this.calls.push('drain')
    this.admitting = false

    if (this.turn) {
      await this.turn.done
      this.turn = null
    }
  }

  async stopWriters(options: { keepLease: boolean }): Promise<void> {
    this.calls.push(options.keepLease ? 'stopWriters(keepLease)' : 'stopWriters')
    this.admitting = false
    this.up = false
    this.stops += 1
    this.cold = true

    if (options.keepLease) {
      return
    }

    this.wantsLease = false
    const lease = this.world.stub.lease(this.world.agent)

    if (lease?.executorDevice === this.mac.deviceServiceId) {
      this.world.stub.releaseLease(this.world.agent)
    }
  }

  restart(): void {
    this.calls.push('restart')

    if (!this.up) {
      this.coldStarts += 1
    }

    this.up = true
    this.admitting = true
    this.wantsLease = true
    this.tryAcquire()
  }

  /**
   * The owner's next message. A warm agent answers at once; one whose process was stopped and started again since the
   * last turn pays the cold start (and has lost what lived only in that process) before it can.
   */
  ask(): 'warm' | 'cold' {
    const answer = this.cold || !this.up ? 'cold' : 'warm'
    this.cold = false

    return answer
  }

  beginHere(): void {
    this.calls.push('beginHere')
    this.freshSessions += 1
  }

  async running(): Promise<boolean> {
    return this.up
  }

  busy(): boolean {
    return this.working
  }

  async atRest(): Promise<boolean> {
    this.restAsked += 1

    return !this.working && !this.reviewing
  }

  /** How many times the writers were held still for a snapshot (admission only: nothing was stopped, nothing restarted). */
  writeHolds = 0
  /** The writers are held right now. */
  held = false

  async holdWrites(): Promise<(() => void) | null> {
    if (this.held || this.working || this.reviewing || this.turn) {
      return null
    }

    this.held = true
    this.writeHolds += 1
    let released = false

    return () => {
      if (!released) {
        released = true
        this.held = false
      }
    }
  }

  readiness() {
    return { homeAccessible: existsSync(this.homeDir), runtimeUsable: this.up, matrixIntakeWorking: this.intake }
  }
}

export interface ServiceNode {
  mac: TestMac
  root: string
  home: string
  handle: FakeHandle
  holds: AgentHomeHolds
  journal: AgentHomeJournal
  controller: AgentHomeController
  service: AgentHomeService
  tool: FakeHomeTool
  logs: string[]
  changes: number
  /** The app was quit and opened again: new holds, controller and service over the same journal and folders. */
  restart(): void
}

export function createServiceNode(
  world: World,
  mac: TestMac,
  options: { files?: Record<string, string>; ready?: () => boolean } = {}
): ServiceNode {
  const root = scratchDirectory(`atum-home-svc-${mac.name.replace(/\W+/gu, '-')}-`)
  const home = path.join(root, 'hermes-home')
  mkdirSync(home, { recursive: true })

  for (const [relative, content] of Object.entries(options.files ?? {})) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
    writeFileSync(path.join(home, relative), content)
  }

  const handle = new FakeHandle(world, mac, home)
  const tool = new FakeHomeTool()
  const logs: string[] = []

  const shell = shellArchive(world, mac, { leaseFacts: () => handle.leaseFacts() })
  const store: HomeArchiveStore = shell.store
  const keys: HomeSealKeySource = shell.keys

  const node = {
    mac,
    root,
    home,
    handle,
    tool,
    logs,
    changes: 0,
    restart: () => build()
  } as ServiceNode

  const build = () => {
    const journal = new AgentHomeJournal(mac.store)
    const holds = new AgentHomeHolds(journal)
    const ops = createHomeRuntimeOps({ handle: () => handle, holds, log: line => logs.push(line) })

    const controller = new AgentHomeController({
      platform: rememberUnsupported(mac.platform, { now: world.clock.now }),
      auth: mac.auth,
      tool,
      store,
      keys,
      journalStore: mac.store,
      runtime: ops,
      me: () => mac.deviceServiceId,
      dirs: { work: path.join(root, 'work'), backups: path.join(root, 'backups'), quarantine: path.join(root, 'quarantine') },
      budgets: { drainMs: 1_000, targetWaitMs: 15 * 60_000, attempts: 3 },
      now: world.clock.now,
      log: line => logs.push(line),
      notHome: agent => ops.standDown(agent)
    })

    handle.guard(controller.standing)

    const service = new AgentHomeService({
      controller,
      holds,
      agents: () => [world.agent],
      ready: options.ready ?? (() => true),
      scope: () => '@owner:atum.example',
      now: world.clock.now,
      changed: () => {
        node.changes += 1
      },
      log: line => logs.push(line)
    })

    Object.assign(node, { journal, holds, controller, service })
  }

  build()

  return node
}

/** Beats until nothing is left to do: the clock moves a second on, every Mac in turn, as the app's loop would. */
export async function settleServices(world: World, nodes: ServiceNode[], rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const node of nodes) {
      if (world.stub.lease(world.agent)) {
        world.stub.renewLease(world.agent)
      }

      node.service.kick()
      await node.service.tick()
    }

    world.clock.advance(1_000)
  }
}
