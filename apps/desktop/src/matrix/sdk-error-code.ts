import { ConversationUnavailableError, EarlierConversationError } from '../../shared/agent-conversation'

/** The SDK seam reports only the SDK's declared refusal vocabulary. Raw server or SDK
 * error text remains generic even when it happens to look like an Atum code. */
export const MATRIX_SDK_FAILED = 'matrix_operation_failed'

const CLOSED = new Set([
  'matrix_identity_review_required',
  'matrix_identity_review_invalid',
  'matrix_identity_review_stale',
  'matrix_device_isolation_invalid',
  'matrix_device_isolation_pending',
  'matrix_device_isolation_stale',
  'matrix_device_isolation_unavailable',
  'matrix_agent_device_replaced',
  'matrix_agent_identity_invalid',
  'matrix_agent_identity_stopped',
  'matrix_agent_recovery_conflict',
  'matrix_agent_recovery_incomplete',
  'matrix_agent_recovery_invalid',
  'matrix_app_bot_direct_invalid',
  'matrix_app_bot_dm_encrypted',
  'matrix_app_bot_dm_invalid',
  'matrix_app_bot_message_invalid',
  'matrix_app_bot_mode_required',
  'matrix_app_bot_profile_invalid',
  'matrix_app_bot_recent_invalid',
  'matrix_app_bot_resting',
  'matrix_app_bot_scan_invalid',
  'matrix_app_bot_syncing',
  'matrix_app_id_invalid',
  'matrix_app_shortcut_failed',
  'matrix_app_shortcut_pending',
  'matrix_app_shortcut_readonly',
  'matrix_app_unavailable',
  'matrix_approval_invalid',
  'matrix_bot_device_keys_mismatch',
  'matrix_bot_device_keys_unavailable',
  'matrix_check_in_invalid',
  'matrix_check_in_pending',
  'matrix_check_in_readonly',
  'matrix_check_in_stale',
  'matrix_command_invalid',
  'matrix_company_ai_unavailable',
  'matrix_private_cos_scope_invalid',
  'matrix_private_cos_room_missing',
  'matrix_private_cos_room_type_invalid',
  'matrix_private_cos_identity_unavailable',
  'matrix_private_cos_join_request_failed',
  'matrix_private_cos_join_result_invalid',
  'matrix_company_room_conflict',
  'matrix_company_room_required',
  'matrix_conversation_unavailable',
  'matrix_continuity_unavailable',
  'matrix_device_name_invalid',
  'matrix_device_query_unavailable',
  'matrix_display_preference_invalid',
  'matrix_display_preference_pending',
  'matrix_display_preference_readonly',
  'matrix_display_preference_stale',
  'matrix_display_preference_unavailable',
  'matrix_encrypted_invite_required',
  'matrix_encrypted_room_required',
  'matrix_earlier_conversation',
  'matrix_favourite_unavailable',
  'matrix_file_invalid',
  'matrix_file_unavailable',
  'matrix_fingerprint_mismatch',
  'matrix_first_run_invalid',
  'matrix_first_run_stale',
  'matrix_first_run_unavailable',
  'matrix_founder_recipient_unready',
  'matrix_founder_unready',
  'matrix_google_fence_pending',
  'matrix_google_fence_readonly',
  'matrix_google_fence_stale',
  'matrix_google_fence_unavailable',
  'matrix_group_agents_full',
  'matrix_group_room_required',
  'matrix_ignore_invalid_account_data',
  'matrix_ignore_self',
  'matrix_ignore_unavailable',
  'matrix_invite_denied',
  'matrix_invite_invalid',
  'matrix_invocation_invalid',
  'matrix_invocation_scan_invalid',
  'matrix_invocation_untrusted',
  'matrix_low_priority_unavailable',
  'matrix_membership_required',
  'matrix_message_changed',
  'matrix_model_unavailable',
  'matrix_mute_unavailable',
  'matrix_notes_self_stale',
  'matrix_notes_self_create_unconfirmed',
  'matrix_notes_self_uncertain',
  'matrix_notes_self_quarantined',
  'matrix_notes_self_readonly',
  'matrix_notes_self_offline',
  'matrix_notes_self_company_invalid',
  'matrix_notes_self_unavailable',
  'matrix_official_accounts_invalid',
  'matrix_official_accounts_profile',
  'matrix_offline',
  'matrix_operation_failed',
  'matrix_owner_recovery_invalid',
  'matrix_owner_recovery_stopped',
  'matrix_pet_invalid',
  'matrix_private_assistant_room_required',
  'matrix_profile_name_invalid',
  'matrix_profile_pending',
  'matrix_profile_photo_size',
  'matrix_profile_photo_type',
  'matrix_profile_stale',
  'matrix_profile_target_invalid',
  'matrix_profile_unavailable',
  'matrix_profile_upload_failed',
  'matrix_profile_upload_required',
  'matrix_recovery_deadline',
  'matrix_recovery_exists',
  'matrix_recovery_incomplete',
  'matrix_recovery_key_invalid',
  'matrix_recovery_pending',
  'matrix_recovery_stale',
  'matrix_refresh_unavailable',
  'matrix_remove_denied',
  'matrix_report_target_changed',
  'matrix_report_unavailable',
  'matrix_retired_agent_room_required',
  'matrix_room_missing',
  'matrix_sdk_stopped',
  'matrix_security_stopped',
  'matrix_send_failed',
  'matrix_send_pending',
  'matrix_signed_out',
  'matrix_starter_readonly',
  'matrix_starter_stale',
  'matrix_starter_unavailable',
  'matrix_store_runs_invalid',
  'matrix_store_runs_pending',
  'matrix_store_runs_readonly',
  'matrix_store_runs_stale',
  'matrix_task_files_invalid',
  'matrix_title_unavailable',
  'matrix_unread_unavailable',
  'matrix_unsent_message_changed',
  'matrix_verification_pending',
  'matrix_verification_phase',
  'matrix_verification_self',
  'matrix_verification_stale'
])

// SAS cancellation encodes its closed protocol reason and side in the code.
const CANCELLED =
  /^matrix_agent_verification_cancelled:(?:m\.(?:user|timeout|unknown_transaction|unknown_method|unexpected_message|key_mismatch|user_mismatch|invalid_message|accepted)|unknown):(?:owner|agent|unknown)$/

// Only protocol scalars cross IPC; no response body, URL, cause or server message.
const PRIVATE_COS_JOIN = /^matrix_private_cos_join_request_failed:http=(?:[1-5][0-9]{2}|unknown):errcode=(?:M_FORBIDDEN|M_NOT_FOUND|M_UNKNOWN|M_UNKNOWN_TOKEN|M_MISSING_TOKEN|M_BAD_STATE|M_LIMIT_EXCEEDED|M_RESOURCE_LIMIT_EXCEEDED|M_UNABLE_TO_AUTHORISE_JOIN|M_UNRECOGNIZED|unknown)$/

export function isPrivateCosJoinFailureCode(value: string): boolean {return PRIVATE_COS_JOIN.test(value)}

export function privateCosJoinFailure(error: unknown): Error {
  const value = error as {httpStatus?:unknown;errcode?:unknown}|null

  const status = typeof value?.httpStatus === 'number' && Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : 'unknown'

  const errcode = typeof value?.errcode === 'string' && value.errcode.length < 64 ? value.errcode : 'unknown'
  const candidate = `matrix_private_cos_join_request_failed:http=${status}:errcode=${errcode}`

  return new Error(isPrivateCosJoinFailureCode(candidate) ? candidate :
    `matrix_private_cos_join_request_failed:http=${status}:errcode=unknown`)
}

export function matrixSdkErrorCode(value: unknown): string {
  const text = value instanceof Error ? value.message : value

  return typeof text === 'string' && (CLOSED.has(text) || CANCELLED.test(text) || isPrivateCosJoinFailureCode(text)) ? text : MATRIX_SDK_FAILED
}

export interface EarlierConversationPayload {
  code: 'matrix_earlier_conversation'
  roomId: string
  main?: string
}

const roomId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 255 && /^![A-Za-z0-9_=/+.-]+:[A-Za-z0-9_.:-]+$/.test(value)

/** Closed, identifier-only failure data. Raw text and unknown fields never cross. */
export function matrixSdkErrorPayload(value: unknown): string | EarlierConversationPayload {
  if (
    typeof value === 'object' && value !== null &&
    'code' in value && value.code === 'matrix_earlier_conversation' &&
    'roomId' in value && roomId(value.roomId) &&
    (!('main' in value) || value.main === undefined || roomId(value.main))
  ) {
    return {
      code: 'matrix_earlier_conversation',
      roomId: value.roomId,
      ...('main' in value && value.main !== undefined ? { main: value.main as string } : {})
    }
  }

  return matrixSdkErrorCode(value)
}

/** Rehydrate declared errors after either structured clone or process IPC. */
export function matrixSdkCommandError(value: unknown): Error {
  const payload = matrixSdkErrorPayload(value)

  if (typeof payload !== 'string') {
    return new EarlierConversationError(payload.roomId, payload.main)
  }

  return payload === 'matrix_conversation_unavailable'
    ? new ConversationUnavailableError()
    : new Error(payload)
}
