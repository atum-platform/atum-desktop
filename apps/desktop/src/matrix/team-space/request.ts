import type { MatrixCompanyBridge, MatrixCompanyErrorCode } from '../../../shared/matrix-company'
import type {
  MatrixCompanyRefusalReason,
  TeamSpaceAction,
  TeamSpaceRequest,
  TeamSpaceValueMap
} from '../../../shared/matrix-company-team-space'

export type TeamSpaceResult<A extends TeamSpaceAction> =
  | { ok: true; value: TeamSpaceValueMap[A] }
  | { ok: false; error: MatrixCompanyErrorCode; reason?: MatrixCompanyRefusalReason; retryAfterSeconds?: number }

/** The `schemaVersion` each family answers with, through directory-invitation wire 1.10. */
const ANSWER_SCHEMA: Record<TeamSpaceAction, number | readonly number[]> = {
  capabilities: 4,
  // company-invites/1 is its own message, schema 1; an older server ignores the profile and answers the 1.3
  // capabilities (4). Profiles 2 and 3 answer their own schema. Policy 1.2/1.3 keep the administration envelope.
  'invite-readiness': [1, 2, 3, 4],
  administration: 4,
  'administration-policy': 4,
  'role-change': 4,
  'ownership-transfer': 4,
  'policy-update': 4,
  'member-add-readiness': 12,
  'member-add': 12,
  'email-invitation-status': 10,
  'invitation-create': 4,
  'invitation-create-directory': 11,
  'email-invitation-create': 10,
  'invitation-accept': 4,
  'invitation-decline': 4,
  'invitation-cancel': 4,
  'invitation-resend': 4,
  'invite-links': 3,
  'invite-link-create': 3,
  'invite-link-revoke': 3,
  'invite-link-preview': 3,
  'invite-link-redeem': 3,
  'browse-channels': 5,
  'browse-joinable-channels': 7,
  'admitted-channels': 5,
  'read-admitted-channel': 5,
  'channel-members': 5,
  'channel-command': 5,
  conversations: 6,
  'read-conversation': 6,
  'conversation-open': 6,
  'conversation-expand': 6,
  'conversation-hidden': 6,
  'set-avatar': 8
}

/**
 * One typed Team Space request. Main validates every answer against the strict wire schema for
 * the action asked, so the value's type is the action's; this seam also refuses an answer from
 * another wire family (a bridge that answers anything with a 1.1 directory, an older host) rather
 * than let it be read as data.
 */
export async function requestTeamSpace<A extends TeamSpaceAction>(
  bridge: MatrixCompanyBridge,
  request: Extract<TeamSpaceRequest, { action: A }>
): Promise<TeamSpaceResult<A>> {
  try {
    const result = await bridge.request(request)

    if (!result.ok) {
      return result
    }

    const value = result.value as { schemaVersion?: unknown }

    const expected: readonly unknown[] = [ANSWER_SCHEMA[request.action]].flat()

    if (!expected.includes(value.schemaVersion)) {
      return { ok: false, error: 'invalid' }
    }

    return { ok: true, value: result.value as TeamSpaceValueMap[A] }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}
