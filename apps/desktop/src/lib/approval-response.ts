import type { HermesGateway } from '@/hermes'
import type { ApprovalRequest } from '@/store/prompts'

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

type ApprovalChoiceInput = Pick<ApprovalRequest, 'allowPermanent' | 'choices' | 'smartDenied'>

const DEFAULT_CHOICES: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny']

/**
 * The choices the backend will honor for this request. The gateway's explicit
 * `choices` list is authoritative; a Smart DENY owner override is once/deny;
 * `allow_permanent: false` (a Tirith warning) removes "always" even when the
 * list would otherwise include it.
 */
export function approvalChoicesFor(request: ApprovalChoiceInput): readonly ApprovalChoice[] {
  let choices = (request.choices ?? DEFAULT_CHOICES).filter((choice): choice is ApprovalChoice =>
    (DEFAULT_CHOICES as readonly string[]).includes(choice)
  )

  // A Smart DENY owner override is an independent restriction: whatever the
  // event declared, the user may only run this once or deny it.
  if (request.smartDenied) {
    choices = choices.filter(choice => choice === 'once' || choice === 'deny')
  }

  if (request.allowPermanent === false) {
    choices = choices.filter(choice => choice !== 'always')
  }

  return choices
}

const PRIMARY_PREFERENCE: readonly Extract<ApprovalChoice, 'always' | 'once' | 'session'>[] = ['always', 'once', 'session']

/**
 * The primary action (main button, ⌘/Ctrl+Enter, and the OS notification's
 * Approve): "Always allow" whenever the backend permits a durable allow, so
 * permission is asked once and remembered; otherwise the widest approval the
 * backend declared ("Allow once", then "Allow this session"). `null` when the
 * backend declared no affirmative choice at all — the card then offers only
 * Deny rather than synthesizing an action the gate would reject.
 */
export function primaryApprovalChoice(
  request: ApprovalChoiceInput
): Extract<ApprovalChoice, 'always' | 'once' | 'session'> | null {
  const choices = approvalChoicesFor(request)

  return PRIMARY_PREFERENCE.find(choice => choices.includes(choice)) ?? null
}

/**
 * Resolve one Hermes approval by its exact pattern key. Hermes owns consent:
 * a durable answer lands in its `command_allowlist`, and Atum's native
 * authority binds the approved operation to the account on the backend side,
 * so the renderer has nothing to mint before it answers.
 */
export async function respondToApprovalRequest(
  gateway: HermesGateway,
  request: ApprovalRequest,
  choice: ApprovalChoice
): Promise<void> {
  const result = await gateway.request<{ resolved?: boolean | number }>('approval.respond', {
    choice,
    ...(request.patternKey ? { pattern_key: request.patternKey } : {}),
    session_id: request.sessionId ?? undefined
  })

  if (!result.resolved) {
    throw new Error('The approval request is no longer pending')
  }
}
