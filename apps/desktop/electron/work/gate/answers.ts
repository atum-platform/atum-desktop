import {
  WORK_REFUSAL_REASONS,
  WORK_REJECTION_REASONS,
  type WorkGateId,
  type WorkRefusalReason,
  type WorkRejectionReason,
  type WorkRequestAnswer,
  workResultIsError
} from './contract'
import type { ReceiptRow } from './ledger'

const REFUSALS = new Set<string>(WORK_REFUSAL_REASONS)
const REJECTIONS = new Set<string>(WORK_REJECTION_REASONS)

/**
 * What the Mac's row says about a request, for every state that needs no read of T3. A revocation always wins:
 * after a cutoff the caller never gets the thread, whatever the row holds (plan §6.4 step 2).
 */
export function answerForRow(gateId: WorkGateId, row: ReceiptRow): WorkRequestAnswer {
  const head = { gateId, requestId: row.requestId }

  if (row.stopScope) {
    return { ...head, class: 'revoked', receipt: 'revoked', scope: row.stopScope }
  }

  switch (row.state) {
    case 'launched':
      return {
        ...head,
        class: 'accepted',
        receipt: 'launched',
        threadId: row.threadId as string,
        ...(row.runId ? { runId: row.runId } : {})
      }

    case 'rejected':
      return { ...head, class: 'refused', receipt: 'rejected', reason: (REJECTIONS.has(row.reason ?? '') ? row.reason : 't3_invalid_request') as WorkRejectionReason }

    case 'refused':
      return { ...head, class: 'refused', receipt: 'refused', reason: (REFUSALS.has(row.reason ?? '') ? row.reason : 'invalid_field') as WorkRefusalReason }

    case 'void':
      return { ...head, class: 'refused', receipt: 'void', reason: 'void_by_agent' }

    default:
      return { ...head, class: 'pending', receipt: 'admitted', forwarded: row.forwarded }
  }
}

const TEXT: Record<string, string> = {
  none: 'No such request.',
  pending: 'The Mac has the request.',
  accepted: 'Started on the Mac.',
  refused: 'It did not start.',
  ambiguous: 'Could not confirm whether it ran.',
  // The cutoff answer is immediate; whether the work was stopped is confirmed later by the Mac's cleanup and report.
  revoked: 'Access to this Mac was revoked.',
  unavailable: 'The Mac is not ready yet; nothing was started.',
  revocation_pending: 'A stop is still in progress on the Mac; nothing was started.',
  ok: 'Done.',
  t3_error: 'The Mac could not do that.'
}

/** One short, plain block of text. Consumers read `structuredContent` only. */
export function envelope(answer: { class?: string }): {
  content: [{ type: 'text'; text: string }]
  structuredContent: unknown
  isError: boolean
} {
  return {
    content: [{ type: 'text', text: TEXT[answer.class] ?? 'Done.' }],
    structuredContent: answer,
    isError: workResultIsError(answer.class ?? 'ok')
  }
}

/** The six tools with their input schemas, for `tools/list`. */
export const TOOL_DESCRIPTIONS = {
  reset: 'Stop and confirm open work, then advance the conversation history boundary.',
  question: 'Read a pending user question on an admitted owner run or answer it using a verified Matrix reply.',
  close: 'Acknowledge reconciled publication and release the operation.',
  send: 'Relay one verified owner DM event on the selected plan. IDs only.',
  status: 'Read or reconcile the request-scoped relay operation; close after publication.',
  launch: 'Start one task on the owner\'s Mac. Needs the owner\'s own Matrix message as `ownerEvent`; one message starts one task.',
  interrupt: 'Stop a thread this assistant started on the Mac.',
  read: 'Read a Work thread on the Mac.',
  wait: 'Wait up to 50 seconds for a thread\'s run to end. Call again to keep waiting.',
  list: 'List Work threads on the Mac.',
  request: 'The status of a launch request, or void an id that never reached the Mac.'
} as const
