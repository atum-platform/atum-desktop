import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type WorkConsentSnapshot, workExpectedThreadId, type WorkLaunchArguments, type WorkT3LaunchCall } from './contract'
import { type CallContext, type GateEvent, type GateOptions, WorkGate } from './gate'
import { GateLedger } from './ledger'
import type { GateSession, GateSessions, ModelAccess, OwnerEventOutcome, OwnerEventVerifier, T3Port, T3Reply, ThreadRead } from './ports'

// Stand-ins for the gate's tests. The fake T3 is faithful to what S0-1 and S0-4 measured: a launch derives its
// thread id from the session and the request id, so a resend under the same session is the same thread; a typed
// refusal creates nothing; a stop holds a queued run; a lost reply still leaves the thread in T3.

export const ACCOUNT = '67000000-0000-4000-8000-0000000000a1'
export const DEVICE = '67000000-0000-4000-8000-0000000000d1'
export const LUNA = '67000000-0000-4000-8000-00000000000a'
export const NOVA = '67000000-0000-4000-8000-00000000000b'
export const EVENT_A = '$eventAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const EVENT_B = '$eventBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export const EVENT_C = '$eventCcccccccccccccccccccccccccccccccccccccc'
export const REQ_1 = 'AAAAAAAAAAAAAAAAAAAAA1'
export const REQ_2 = 'AAAAAAAAAAAAAAAAAAAAA2'
export const REQ_3 = 'AAAAAAAAAAAAAAAAAAAAA3'

// Every tool name T3 v0.1.11 advertises to a connected client (recorded from the pinned server's `tools/list`). None of them is a gate tool, and the
// gate serves only its own six: a granted credential cannot reach any of them through the hostname, plan-provider paths included.
export const PINNED_T3_TOOLS = [
  'orchestrator_capabilities', 't3_workflow_stop', 'schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task', 't3_thread_list',
  't3_thread_read', 't3_thread_update', 't3_thread_send', 't3_thread_wait', 't3_thread_interrupt', 't3_environment_links', 't3_environment_link',
  't3_environment_unlink', 'run_scheduled_task_now', 't3_thread_search', 't3_thread_configure', 't3_thread_transfer', 't3_thread_organize',
  't3_pending_request', 't3_queue', 't3_attachment_prepare_upload', 't3_attachment_discard', 't3_thread_send_attachments', 't3_thread_launch',
  't3_project_list', 't3_project_read', 't3_project_create', 't3_project_update', 't3_project_delete', 't3_project_clone', 't3_environment_read',
  't3_environment_preferences_update', 't3_theme_read', 't3_theme_set', 't3_worktree_list', 'link_pull_request', 'link_pull_requests',
  'unlink_pull_request', 'unlink_pull_requests', 'list_thread_pull_requests', 'watch_pull_request', 'unwatch_pull_request',
  'write_pull_request_guides', 'read_pull_request_guide', 'pull_request_read', 'pull_request_list', 'pull_request_create', 'pull_request_update',
  'pull_request_respond', 'pull_request_review', 'pull_request_merge', 'ci_logs', 'ci_rerun', 'list_issues', 'read_issue', 'create_issue',
  'comment_on_issue', 'set_issue_state', 'link_issue', 'unlink_issue', 'list_thread_issues'
]

export class Clock {
  t = 1_795_000_000_000
  mono = 0
  now = () => this.t
  monotonic = () => this.mono

  advance(ms: number): void {
    this.t += ms
    this.mono += ms
  }
}

interface FakeRun {
  runId: string
  ordinal: number
  status: string
}

interface FakeThread {
  id: string
  sessionId: string
  runs: FakeRun[]
  message: string
  /** The provider instance the launch named: what T3 would report as `thread.providerInstanceId`. */
  provider: string
}

export class FakeT3 implements T3Port {
  threads = new Map<string, FakeThread>()
  calls: { tool: string; token: string; args?: unknown }[] = []
  alive = true
  incarnationId = 'inc-1'
  fingerprint = 'fp-1'
  providerOk = true
  /** T3 receives the launch but the reply is lost. */
  dropNextReply = false
  /** The launch bytes never reach T3 (and no reply comes). */
  loseNextBytes = false
  rejectWith: { code?: string; status?: number } | undefined
  /** Hold a launch reply until released: the pause between "T3 has it" and "the gate knows". */
  holdReply: Promise<void> | undefined
  /** A run that stays running until `finish` is called. */
  autoRunning = true
  restartResult: 'restarted' | 'declined' = 'declined'
  readFails = false
  /** What T3 says about the plan (Codex) on this Mac, and the model it lists first. */
  planStatus: 'connected' | 'disconnected' | 'unknown' = 'connected'
  planCalls = 0
  /** Hold a `wait` until released: a call in flight while a revocation lands. */
  holdWait: Promise<void> | undefined

  constructor(readonly sessionOf: (token: string) => string | undefined) {}

  count(tool: string): number {
    return this.calls.filter(call => call.tool === tool).length
  }

  get prompts(): number {
    return this.threads.size
  }

  incarnation = () => (this.alive ? this.incarnationId : undefined)
  settingsFingerprint = () => this.fingerprint
  providerReady = async () => this.providerOk
  planProvider = async (): Promise<{ status: 'connected' | 'disconnected' | 'unknown'; selection?: { instanceId: string; model: string } }> => {
    this.planCalls++

    return this.planStatus === 'connected' ? { status: 'connected', selection: { instanceId: 'codex', model: 'codex-model-1' } } : { status: this.planStatus }
  }
  prepare = async () => true

  restart(): void {
    this.incarnationId = `inc-${Number(this.incarnationId.slice(4)) + 1}`
  }

  restartWhenIdle = async () => {
    if (this.restartResult === 'restarted') {
      this.restart()
    }

    return this.restartResult
  }

  launch(token: string, call: WorkT3LaunchCall, limit: string): Promise<T3Reply> {
    this.calls.push({ tool: 'launch', token, args: { call, limit } })

    if (this.loseNextBytes) {
      this.loseNextBytes = false

      return Promise.resolve({ transport: 'failed', error: 'ECONNRESET' })
    }

    if (this.rejectWith) {
      const { code, status } = this.rejectWith

      return Promise.resolve({ transport: 'ok', status: status ?? 200, isError: true, data: { code }, code: code ?? null })
    }

    const sessionId = this.sessionOf(token) as string
    const id = workExpectedThreadId(sessionId, call.clientRequestId)

    if (!this.threads.has(id)) {
      this.threads.set(id, {
        id,
        sessionId,
        message: call.message,
        provider: call.modelSelection.instanceId,
        runs: [{ runId: `run:thread:${id}:ordinal:1`, ordinal: 1, status: this.autoRunning ? 'running' : 'completed' }]
      })
    }

    if (this.dropNextReply) {
      this.dropNextReply = false

      return Promise.resolve({ transport: 'failed', error: 'ECONNRESET' })
    }

    const reply: T3Reply = { transport: 'ok', status: 200, isError: false, data: { threadId: id } }

    return this.holdReply ? this.holdReply.then(() => reply) : Promise.resolve(reply)
  }

  finish(threadId: string, status = 'completed'): void {
    const thread = this.threads.get(threadId)

    for (const run of thread?.runs ?? []) {
      if (['running', 'queued'].includes(run.status)) {
        run.status = status
      }
    }
  }

  queue(threadId: string): void {
    const thread = this.threads.get(threadId) as FakeThread

    thread.runs.push({ runId: `run:thread:${threadId}:ordinal:${thread.runs.length + 1}`, ordinal: thread.runs.length + 1, status: 'queued' })
  }

  async read(token: string, threadId: string): Promise<ThreadRead> {
    this.calls.push({ tool: 'read', token, args: threadId })

    if (this.readFails) {
      return { kind: 'transport' }
    }

    const thread = this.threads.get(threadId)

    if (!thread) {
      return { kind: 'absent' }
    }

    const active = thread.runs.find(run => run.status === 'running')

    return {
      kind: 'found',
      status: active ? 'running' : (thread.runs.at(-1)?.status ?? 'idle'),
      activeRunId: active?.runId,
      provider: thread.provider,
      runs: thread.runs.map(run => ({ ...run })),
      raw: { thread: { status: active ? 'running' : 'idle' }, recentRuns: thread.runs }
    }
  }

  async interrupt(token: string, threadId: string, options?: { stop?: boolean }): Promise<T3Reply> {
    this.calls.push({ tool: 'interrupt', token, args: { threadId, ...options } })
    const thread = this.threads.get(threadId)

    if (!thread) {
      return { transport: 'ok', status: 200, isError: true, data: { code: 'thread_not_found' }, code: 'thread_not_found' }
    }

    // a stop interrupts the active run and holds the queued one: it stays `queued` and is never started
    for (const run of thread.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted'
      }
    }

    return { transport: 'ok', status: 200, isError: false, data: {} }
  }

  async wait(token: string, threadId: string): Promise<T3Reply> {
    this.calls.push({ tool: 'wait', token, args: threadId })
    await this.holdWait

    return { transport: 'ok', status: 200, isError: false, data: {} }
  }

  async list(token: string): Promise<T3Reply> {
    this.calls.push({ tool: 'list', token })

    return {
      transport: 'ok',
      status: 200,
      isError: false,
      data: { threads: [...this.threads.values()].map(thread => ({ threadId: thread.id, status: 'running', title: 'x' })) }
    }
  }
}

export class FakeSessions implements GateSessions {
  private readonly ids = new Map<string, number>()
  revoked: string[] = []
  all = 0

  sessionIdOf = (token: string): string | undefined => {
    if (token === 'owner-token') {
      return 'sess-owner'
    }

    const principal = token.replace('tok-', '').replace(/-\d+$/u, '')

    return `sess-${principal}-${this.ids.get(principal) ?? 1}`
  }

  private token(principal: string): string {
    return `tok-${principal}-${this.ids.get(principal) ?? 1}`
  }

  agentSessionId(principal: string): string | undefined {
    return `sess-${principal}-${this.ids.get(principal) ?? 1}`
  }

  async agent(principal: string): Promise<GateSession> {
    return { token: this.token(principal), sessionId: `sess-${principal}-${this.ids.get(principal) ?? 1}` }
  }

  async owner(): Promise<GateSession> {
    return { token: 'owner-token', sessionId: 'sess-owner' }
  }

  /** The agent's session was replaced (an auth reset, an expiry). */
  replace(principal: string): void {
    this.ids.set(principal, (this.ids.get(principal) ?? 1) + 1)
  }

  async revokeAgent(principal: string): Promise<void> {
    this.revoked.push(principal)
  }

  async revokeAll(principals: string[]): Promise<void> {
    this.all++
    this.revoked.push(...principals)
  }

  forgetAll(): void {
    // the fake's sessions are numbered; a reset moves every number
    for (const principal of [LUNA, NOVA]) {
      this.replace(principal)
    }
  }
}

export class FakeOwner implements OwnerEventVerifier {
  events = new Map<string, OwnerEventOutcome>()
  fetched: string[] = []
  unreachable = false
  clock: Clock | undefined

  put(eventId: string, outcome?: OwnerEventOutcome): void {
    this.events.set(eventId, outcome ?? { kind: 'ok', body: 'list the PDFs in Reports and write their names to index.txt', originServerTs: this.clock?.now() ?? Date.now() })
  }

  async fetch(input: { eventId: string }): Promise<OwnerEventOutcome> {
    this.fetched.push(input.eventId)

    if (this.unreachable) {
      return { kind: 'unreachable' }
    }

    return this.events.get(input.eventId) ?? { kind: 'invalid', reason: 'owner_event_not_found' }
  }
}

export interface Harness {
  dir: string
  clock: Clock
  t3: FakeT3
  sessions: FakeSessions
  owner: FakeOwner
  ledger: GateLedger
  gate: WorkGate
  held: { value: boolean }
  access: { value: ModelAccess }
  events: GateEvent[]
  pauses: Map<string, { reached: Promise<void>; release(): void }>
  /** Park the next time the gate reaches the named point; `reached` resolves when it is there. */
  pause(name: string): { reached: Promise<void>; release(): void }
  ctx(principal: string): CallContext
  args(requestId: string, ownerEvent: string, extra?: Partial<WorkLaunchArguments>): WorkLaunchArguments
  /** Apply a consent snapshot the way a pulled page does: durably, with the cutoffs, then its age starts. */
  consent(snapshot: Partial<WorkConsentSnapshot> & { agents?: string[] }): WorkConsentSnapshot
  /** A new gate over the same ledger file and the same T3: the app was killed and restarted. */
  reopen(): Harness
  cleanup(): Promise<void>
}

export function makeHarness(previous?: Harness, extra: Partial<GateOptions> = {}): Harness {
  const dir = previous?.dir ?? mkdtempSync(join(tmpdir(), 'wg-'))
  const clock = previous?.clock ?? new Clock()
  const sessions = previous?.sessions ?? new FakeSessions()
  const t3 = previous?.t3 ?? new FakeT3(sessions.sessionIdOf)
  const owner = previous?.owner ?? new FakeOwner()
  const held = previous?.held ?? { value: false }
  const access = previous?.access ?? { value: 'allowed' as ModelAccess }

  owner.clock = clock

  previous?.gate.stop()
  previous?.ledger.close()

  const ledger = new GateLedger(join(dir, 'ledger.sqlite'), ACCOUNT, clock.now)
  const pauses = new Map<string, { reached: Promise<void>; release(): void }>()
  const armed = new Map<string, { signal(): void; wait: Promise<void> }>()
  const events: GateEvent[] = []

  const gate = new WorkGate({
    ...extra,
    accountId: ACCOUNT,
    deviceServiceId: DEVICE,
    ledger,
    t3,
    sessions,
    owner,
    modelAccess: async () => access.value,
    delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:binh-minh' },
    held: () => held.value,
    now: clock.now,
    monotonic: clock.monotonic,
    sleep: async () => undefined,
    stopPollMs: 0,
    stopPolls: 3,
    hooks: async (point, key) => {
      const entry = armed.get(point)

      if (entry) {
        armed.delete(point)
        entry.signal()
        void key
        await entry.wait
      }
    }
  })

  gate.on(event => events.push(event))

  if (!previous) {
    owner.put(EVENT_A)
    owner.put(EVENT_B)
    owner.put(EVENT_C)
    ledger.setMeta('work_grant_accepted_at', clock.now())
    ledger.setMeta('route_open', '1')
    ledger.setEntitled(LUNA, true)
    ledger.setEntitled(NOVA, true)
  }

  gate.noteGoodSync()

  const harness: Harness = {
    dir,
    clock,
    t3,
    sessions,
    owner,
    ledger,
    gate,
    held,
    access,
    events,
    pauses,
    pause(name) {
      let release!: () => void
      let signal!: () => void

      const reached = new Promise<void>(resolve => {
        signal = resolve
      })

      const wait = new Promise<void>(resolve => {
        release = resolve
      })

      armed.set(name, { signal, wait })

      return { reached, release }
    },
    ctx(principal) {
      const agent = ledger.agent(principal)

      return { principal, routeEpoch: ledger.routeEpoch(), generation: agent?.generation ?? 1 }
    },
    args(requestId, ownerEvent, extra = {}) {
      return {
        requestId,
        projectId: 'project-reports',
        task: 'List the PDFs in the Reports folder and write their names to index.txt.',
        ownerEvent,
        notAfter: clock.now() + 90_000,
        ...extra
      }
    },
    consent(partial) {
      const snapshot: WorkConsentSnapshot = {
        provider: 'codex',
        state: 'on',
        revision: 1,
        agents: [LUNA],
        alsoWhenScheduled: false,
        ...partial
      }

      const results = ledger.tx(() => gate.beginConsent(snapshot))

      gate.finishConsent(snapshot, results)

      return snapshot
    },
    reopen: () => makeHarness(harness),
    async cleanup() {
      await gate.scheduleSettle().catch(() => undefined)

      try {
        ledger.close()
      } catch {
        // already closed by a reopen
      }

      rmSync(dir, { recursive: true, force: true })
    }
  }

  return harness
}
