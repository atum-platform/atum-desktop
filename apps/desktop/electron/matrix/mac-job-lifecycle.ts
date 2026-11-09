import type { HomeLeaseFence } from './agent-home-placement/contract'
import { fenceFromLease } from './agent-home-placement/fence'
import type { HomeContext } from './agent-home-placement/runtime-ops'
import { mayAct, mayPublish } from './agent-home-placement/standing'
import type { MatrixCronHolds } from './cron-hold'
import { MacJobsClient, type MacJobsOptions } from './mac-jobs'

export type MacJobHomeContext = Pick<HomeContext, 'standing' | 'platform' | 'auth' | 'me'> & {
  runtime: Pick<HomeContext['runtime'], 'leaseFacts'>
}

/** Fresh D1 authority for every signed attempt, including bearer refresh. */
export async function macJobAuthority(ctx: MacJobHomeContext, principal: string, signal: AbortSignal, delivery = false): Promise<HomeLeaseFence | null> {
  const standing = await ctx.standing.check(principal, signal, { fresh: true })

  if (!(delivery ? mayPublish(standing) : mayAct(standing))) {return null}

  // Legacy standing has no placement payload. The initial Mac home must also
  // prove its location before the platform scheduler may act.
  const read = standing.state === 'home' || standing.state === 'draining'
    ? { ok: true as const, value: standing.placement }
    : await ctx.platform.readPlacement(principal, signal)

  signal.throwIfAborted()

  if (!read.ok || read.value.location.kind !== 'mac' || read.value.location.deviceServiceId !== ctx.me() || (!delivery && read.value.activeMove)) {
    return null
  }

  return fenceFromLease(read.value, ctx.runtime.leaseFacts(principal))
}

export interface MacJobSelection {
  generation: string
  managedJobIds: readonly string[]
}

/** Snapshot/cancellation composition, separate from occurrence recovery.
 * Startup, home changes and reconnect call refresh. The caller supplies the arm
 * scheduler, not a second clock or recurrence calculator.
 */
export class MacJobLifecycle {
  private prepared = false

  /** Only a validated selection and durable inventory permit the legacy ticker. */
  get tickerPrepared(): boolean { return this.prepared }

  private revision = 0
  private active?: AbortController
  private tail: Promise<void> = Promise.resolve()
  private running: Promise<void> = Promise.resolve()
  readonly client: MacJobsClient

  constructor(private readonly options: {
    context: MacJobHomeContext
    assistantId: string
    principal: string
    agentKey: string
    request: MacJobsOptions['request']
    fetch?: typeof fetch
    holds: Pick<MatrixCronHolds, 'managed' | 'clearManaged'>
    run(selection: MacJobSelection, client: MacJobsClient, signal: AbortSignal): Promise<void>
  }) {
    this.client = new MacJobsClient({
      auth: options.context.auth,
      request: options.request,
      fetch: options.fetch,
      authority: (_assistant, signal) => macJobAuthority(options.context, options.principal, signal)
    })
  }

  /** Invalidate synchronously before any async replacement work. */
  stop(): void {
    this.prepared = false
    this.revision++
    this.active?.abort()
    this.active = undefined
    // Keep the inventory on authority loss/restart. Platform unavailability must
    // never release managed IDs into the autonomous ticker.
  }

  async drained(): Promise<void> {
    await this.tail.catch(() => {})
    await this.running
  }

  refresh(): Promise<void> {
    this.stop()
    const revision = this.revision
    const next = this.tail.catch(() => {}).then(() => this.replace(revision))
    this.tail = next

    return next
  }

  private async replace(revision: number): Promise<void> {
    await this.running

    if (revision !== this.revision) {return}
    const active = new AbortController()
    this.active = active
    let launched = false

    try {
      const result = await this.client.snapshot(this.options.assistantId, active.signal)

      if (revision !== this.revision || active.signal.aborted) {return}

      if ('code' in result) {return}

      if (!result.selected) {
        this.options.holds.clearManaged(this.options.agentKey)
        this.prepared = true

        return
      }

      this.options.holds.managed(this.options.agentKey, result.managedJobIds)
      this.prepared = true

      if (result.generation === null) {return}
      launched = true
      this.running = this.options.run({ generation: result.generation, managedJobIds: result.managedJobIds }, this.client, active.signal)
        .catch(() => { /* Fail closed until the next authority refresh. */ })
        .finally(() => { active.abort();

 if (this.active === active) {this.active = undefined} })

      return
    } catch (error) {
      // A superseded snapshot cannot prepare or fail its replacement.
      if (revision === this.revision && !active.signal.aborted) {throw error}
    } finally {
      if (this.active === active && !launched) {
        active.abort()
        this.active = undefined
      }
    }
  }
}
