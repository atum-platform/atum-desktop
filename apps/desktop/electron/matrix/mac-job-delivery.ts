import type { HomeLeaseFence } from './agent-home-placement/contract'
import { MATRIX_CRON_STRANDED, type MatrixCronDelivery, type MatrixCronPost } from './cron-delivery'
import type { MacJobsClient } from './mac-jobs'

/** Only the exact home/term that ran an occurrence publishes or settles it: the same fields the platform's
 * `job_occurrence_fence` (0384) checks. A later home, or this Mac under a new epoch or term, gets
 * `MATRIX_CRON_STRANDED`; no current home at all is a retryable refusal. */
export function assertMacJobDeliveryHome(post: MatrixCronPost, current: HomeLeaseFence | null): void {
  if (!current) {throw new Error('mac_job_not_home')}
  const bound = post.occurrence?.home

  if (!bound || bound.homeId !== current.homeId || bound.homeEpoch !== current.homeEpoch ||
      bound.executorTerm !== current.executorTerm || bound.leaseId !== current.leaseId) {
    throw new Error(MATRIX_CRON_STRANDED)
  }
}

/** The managed-job share of a planned move's D1 drain (coordinator decision, 2026-11-01). Admission stops and
 * the running occurrence is cancelled, then THIS home publishes and settles its pending managed deliveries,
 * all bounded by `deadline`. Past it the move proceeds: what is left stays this home's, fenced by the drain
 * acknowledgement and settled `uncertain` by the platform's expiry. Never rejects, so it never ends a move. */
export async function drainMacJobs(input: {
  lifecycle?: { stop(): void; drained(): Promise<void> }
  delivery?: Pick<MatrixCronDelivery, 'resumeManaged'>
  deadline: AbortSignal
  log(line: string): void
}): Promise<void> {
  const { deadline } = input
  input.lifecycle?.stop()

  const overrun = new Promise<void>(resolve => {
    if (deadline.aborted) {resolve()}
    deadline.addEventListener('abort', () => resolve(), { once: true })
  })

  await Promise.race([input.lifecycle?.drained().catch(() => {}), overrun])
  const { left } = input.delivery ? await input.delivery.resumeManaged(deadline) : { left: 0 }

  if (left !== 0) {
    input.log(`[Matrix] managed job deliveries left with the source home: ${left < 0 ? 'unknown' : left}`)
  }
}

/** Retried from the existing outbox with stable business identities. The signed
 * client supplies fresh D1 metadata and current authority on every attempt. */
export async function completeMacJobDelivery(
  client: Pick<MacJobsClient, 'occurrence'>,
  post: MatrixCronPost,
  signal: AbortSignal
) {
  const occurrence = post.occurrence

  if (!occurrence || occurrence.occurrenceId !== post.runId) {throw new Error('matrix_cron_occurrence_mismatch')}
  const common = { executorId: occurrence.executorId, protocol: 3 as const, occurrenceId: occurrence.occurrenceId }

  const completed = await client.occurrence(occurrence.assistantId, {
    ...common, operation: 'complete', outcome: 'answered', usage: { computeSeconds: occurrence.computeSeconds }
  }, signal)

  if ('code' in completed || completed.occurrenceId !== occurrence.occurrenceId ||
      completed.state !== 'completed' || completed.outcome !== 'answered') {
    throw new Error('matrix_cron_settlement_unavailable')
  }

  return { occurrence, common }
}

/** Completion precedes D1 enqueue: its job fence rejects dispatched occurrences.
 * Repeating completion after a lost response returns the stored settlement. */
export async function settleMacJobDelivery(
  client: Pick<MacJobsClient, 'occurrence'>,
  post: MatrixCronPost,
  eventId: string,
  signal: AbortSignal
): Promise<void> {
  const { occurrence, common } = await completeMacJobDelivery(client, post, signal)

  const published = await client.occurrence(occurrence.assistantId, {
    ...common, operation: 'published', publishedEvent: eventId
  }, signal)

  if ('code' in published || published.occurrenceId !== occurrence.occurrenceId || published.publishedEvent !== eventId) {
    throw new Error('matrix_cron_receipt_unavailable')
  }
}
