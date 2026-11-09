import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { nativeJobProjection } from '../../../../packages/device-protocol/native-job-projection'
import { nativeScheduleForFire } from '../../../../packages/device-protocol/native-schedule'
import type { MacJobFireResponse, MacJobOccurrenceResponse } from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/mac-jobs'

import type { HomeLeaseFence } from './agent-home-placement/contract'
import type { MatrixCronDelivery } from './cron-delivery'
import { matrixHermesOccurrenceHome, type MatrixHermesRuntimeConfig, openMatrixHermes } from './hermes-runtime'
import { openMacJobBroker } from './mac-job-broker'
import type { MacJobsClient, MacJobsOptions } from './mac-jobs'

type Fire = NonNullable<Extract<MacJobFireResponse, { operation: 'claimed' }>['fire']>
type Occurrence = Exclude<MacJobOccurrenceResponse, { code: string }>

export interface MacJobRunnerOptions {
  runtime: MatrixHermesRuntimeConfig
  owner: string
  executorId: string
  assistantId: string
  principal: string
  home: string
  room(): string | undefined
  baseUrl: string
  transport: MacJobsOptions
  client: MacJobsClient
  delivery: MatrixCronDelivery
  signal: AbortSignal
}

/** One private native child; no interactive credentials or autonomous ticker. */
export async function executeMacJob(options: MacJobRunnerOptions, fire: Fire, occurrence: Occurrence, authority: HomeLeaseFence): Promise<void> {
  const model = occurrence.grants?.model

  if (!model) {throw Error('mac_job_model_grant_unavailable')}
  const started = Date.now()
  const deadline = Math.min(model.expiresAt, started + (occurrence.budget?.computeSeconds ?? 0) * 1000)
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - started))])

  const broker = await openMacJobBroker({ ...options.transport, assistantId: options.assistantId,
    baseUrl: options.baseUrl, occurrence, signal })

  const input = { owner: options.owner, executorId: options.executorId, home: options.home, signal,
    occurrence: { executionId: occurrence.occurrenceId, modelBaseUrl: broker.baseUrl, modelKey: broker.key } }

  let connection: Awaited<ReturnType<typeof openMatrixHermes>> | undefined
  let unlisten: (() => void) | undefined

  try {
    const home = matrixHermesOccurrenceHome(options.runtime, input)
    await mkdir(path.join(home, 'cron'), { recursive: true, mode: 0o700 })
    // Explicit definition pins must not escape the occurrence's private grant.
    const job = { ...fire.nativeDefinition, model: model.alias, provider: 'custom:mac-job', base_url: broker.baseUrl }
    await writeFile(path.join(home, 'cron/jobs.json'), JSON.stringify(nativeJobProjection(job, fire.arm.occurrenceAt)), { mode: 0o600 })
    await writeFile(path.join(home, 'config.yaml'), JSON.stringify({
      model: { default: model.alias, provider: 'custom:mac-job', base_url: broker.baseUrl },
      custom_providers: [{ name: 'mac-job', base_url: broker.baseUrl, key_env: 'ATUM_MODEL_KEY' }],
      plugins: { enabled: [] }, agent: { max_turns: 20 },
      auxiliary: { title: { enabled: false } }
    }), { mode: 0o600 })
    signal.throwIfAborted()
    connection = await openMatrixHermes(options.runtime, input)
    unlisten = options.delivery.listen(connection.gateway, { assistantId: options.assistantId,
      executorId: options.executorId, occurrenceId: occurrence.occurrenceId,
      // The output belongs to the home/term that ran it: only it may publish or settle it.
      home: { homeId: authority.homeId, homeEpoch: authority.homeEpoch, executorTerm: authority.executorTerm, leaseId: authority.leaseId },
      get computeSeconds() { return Math.min(86400, Math.ceil((Date.now() - started) / 1000)) } })

    const result = await connection.gateway.request<{ processed: boolean; status: string; reason?: string }>('cron.run_claimed_desktop', {
      job_id: fire.jobId, execution_id: occurrence.occurrenceId, room_id: occurrence.roomId
    }, Math.max(1, (occurrence.expiresAt ?? model.expiresAt) - Date.now()))

    if (result.reason === 'durable_delivery_unavailable') {
      const failed = await options.client.occurrence(options.assistantId, {
        operation: 'complete', protocol: 3, executorId: options.executorId,
        occurrenceId: occurrence.occurrenceId, outcome: 'failed',
        usage: { computeSeconds: Math.min(86400, Math.ceil((Date.now() - started) / 1000)) }
      }, options.signal)

      if ('code' in failed || failed.state !== 'completed' || failed.outcome !== 'failed') {
        throw Error('mac_job_failure_settlement_unavailable')
      }

      throw Error('mac_job_durable_delivery_unavailable')
    }

    if (!result.processed || result.status !== 'ok') {throw Error(result.reason === 'managed_delivery_pending'
      ? 'mac_job_delivery_pending' : 'mac_job_native_failed')}
  } finally {
    unlisten?.()
    await connection?.close()
    await broker.stop()
  }
}

/** Recover delivery before claiming. A dispatch conflict/lost reply NEVER reruns a model. */
export async function tickMacJobs(options: MacJobRunnerOptions): Promise<void> {
  const { signal, client, assistantId, executorId } = options
  await options.delivery.resume()
  signal.throwIfAborted()
  const home = await options.transport.authority(assistantId, signal)

  if (!home) {throw Error('mac_job_not_home')}
  const claimed = await client.fire(assistantId, { profile: 'atum.controller-job-fire/1', operation: 'claim', leaseToken: home.leaseId }, signal)

  if ('code' in claimed) {throw Error(`mac_job_${claimed.code}`)}

  if (claimed.operation !== 'claimed' || !claimed.fire) {return}
  const fire = claimed.fire

  if (!fire.atumExtension) {throw Error('mac_job_definition_invalid')}
  const schedule = nativeScheduleForFire(options.principal, { ...fire, atumExtension: fire.atumExtension })
  const roomId = options.room()

  if (!roomId) {throw Error('mac_job_room_unavailable')}

  const occurrence = await client.occurrence(assistantId, { operation: 'claim', protocol: 3, executorId,
    leaseToken: home.leaseId, scheduleId: schedule.scheduleId, occurrenceAt: schedule.nextOccurrenceAt,
    definitionDigest: schedule.definitionDigest, catchupWindowMs: schedule.catchupWindowMs, roomId }, signal)

  if ('code' in occurrence) {throw Error(`mac_job_${occurrence.code}`)}

  if (occurrence.state === 'claimed') {
    const dispatched = await client.occurrence(assistantId, { operation: 'dispatch', protocol: 3, executorId,
      leaseToken: home.leaseId, occurrenceId: occurrence.occurrenceId }, signal)

    if ('code' in dispatched) {throw Error(`mac_job_${dispatched.code}`)}

    if (dispatched.state !== 'dispatched') {throw Error('mac_job_dispatch_invalid')}
    await executeMacJob(options, fire, dispatched, home)
  }

  // A previously dispatched occurrence can only recover through the durable outbox.
  await client.fire(assistantId, { profile: 'atum.controller-job-fire/1', operation: 'complete', leaseToken: home.leaseId,
    armId: fire.arm.armId, occurrenceId: occurrence.occurrenceId,
    outcome: occurrence.state === 'skipped' ? (occurrence.skipReason === 'missed' ? 'missed' : 'terminal') : 'queued' }, signal)
}

/** The scheduler's lifetime: one failed tick (an outage, `busy`, a lost reply, a delivery still pending) never
 * ends it. Each tick re-reads authority and the platform's own arm/occurrence state, so a retry repeats nothing
 * that already happened; only the lifecycle's abort stops the loop. */
export async function runMacJobs(options: MacJobRunnerOptions & {
  log?(line: string): void
  /** Injectable pause between ticks (tests); production uses an abortable timer. */
  pause?(ms: number, signal: AbortSignal): Promise<void>
}): Promise<void> {
  const pause = options.pause ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }))
  let failures = 0

  while (!options.signal.aborted) {
    try {
      await tickMacJobs(options)
      failures = 0
    } catch (error) {
      if (options.signal.aborted) {break}
      failures++
      options.log?.(`[Matrix] managed job tick deferred: ${error instanceof Error ? error.message : 'failed'}`)
    }

    await pause(failures ? Math.min(60_000, 1000 * 2 ** failures) : 1000, options.signal).catch(() => {})
  }
}
