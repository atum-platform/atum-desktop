import { randomBytes } from 'node:crypto'

import type { MacJobOccurrenceResponse } from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/mac-jobs'
import type { UpstreamRequest } from '../../../../packages/model-client/src/gateway-upstream'
import { ModelBroker } from '../../../../packages/model-client/src/model-broker'
import { ModelGrantRegistry } from '../../../../packages/model-client/src/model-grants'

import { macJobModelUpstream } from './mac-job-model'
import { MacJobsClient, type MacJobsOptions } from './mac-jobs'

/** A private child gets only a loopback key. MAS, D1 and the platform grant stay
 * in main. The shared broker owns body/alias/output/stream limits and cancellation.
 * Signed transport uses the finalized N7a4 Mac gateway form.
 */
export async function openMacJobBroker(options: MacJobsOptions & {
  assistantId: string
  baseUrl: string
  occurrence: Exclude<MacJobOccurrenceResponse, { code: string }>
  signal: AbortSignal
}): Promise<{ baseUrl: string; key: string; stop(): Promise<void> }> {
  const occurrence = options.occurrence
  const model = occurrence.grants?.model
  const budget = occurrence.budget

  if (occurrence.state !== 'dispatched' || !model || !budget || model.funding === 'subscription') {
    throw new Error('mac_job_model_grant_unavailable')
  }

  options.signal.throwIfAborted()
  const grants = new ModelGrantRegistry()
  const key = randomBytes(32).toString('base64url')
  grants.admit(key, {
    taskId: occurrence.occurrenceId, aliases: model.aliases, expiresAt: model.expiresAt,
    maxOutputTokens: model.outputBudget, contextLength: model.contextBudget,
    ...('effort' in model && ['low', 'medium', 'high'].includes(model.effort)
      ? { effort: model.effort as 'low' | 'medium' | 'high' } : {}),
    ...('googlePolicy' in model ? { protection: { googlePolicy: model.googlePolicy, latchState: model.latchState } } : {})
  })
  grants.bindSource(occurrence.occurrenceId, '127.0.0.1')
  const client = new MacJobsClient(options)
  const upstream = macJobModelUpstream(options)

  const admit = async (request: UpstreamRequest): Promise<UpstreamRequest> => {
    const signal = AbortSignal.any([request.signal, options.signal])
    signal.throwIfAborted()
    const checked = await client.grant(options.assistantId, { token: model.token }, signal)

    if ('code' in checked || checked.state !== 'active' ||
        checked.agentPrincipal !== occurrence.agentPrincipal || checked.reservationId !== budget.reservationId ||
        checked.expiresAt <= Date.now() || checked.alias !== model.alias || checked.model !== model.model ||
        checked.outputBudget !== model.outputBudget || checked.contextBudget !== model.contextBudget) {
      throw new Error('mac_job_model_grant_unavailable')
    }

    signal.throwIfAborted()

    return { ...request, signal, token: model.token }
  }

  const broker = new ModelBroker({ host: '127.0.0.1', port: 0, grants, upstream: {
    complete: async request => upstream.complete(await admit(request)),
    stream: async request => upstream.stream(await admit(request))
  } })

  let stopping: Promise<void> | undefined

  const stop = () => {
    grants.revokeTask(occurrence.occurrenceId, 'occurrence_stopped')

    return stopping ??= broker.stop()
  }

  const abort = () => { void stop() }
  options.signal.addEventListener('abort', abort, { once: true })

  try {
    const address = await broker.start()
    options.signal.throwIfAborted()

    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, key,
      stop: async () => { options.signal.removeEventListener('abort', abort); await stop() } }
  } catch (error) {
    options.signal.removeEventListener('abort', abort)
    // start may have raced abort before the server existed.
    await broker.stop()
    throw error
  }
}
