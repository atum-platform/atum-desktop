import type { GroupDetail, GroupOperationInput } from '../../shared/atum-group-conversations'

import type { SocialLookupResponse, SocialMutationAction, SocialMutationResponse, SocialSyncResponse } from './social'
import type { PendingMutation } from './types'
import type { DesktopSessionBody, parseConversation, parseMessagePage, parseSendResponse, SyncPage } from './wire'

/** The direct-only provider surface consumed by the S5 sync engine. */
export interface DirectMessagingTransport {
  abortAll(): void
  session(): Promise<DesktopSessionBody>
  conversations(): Promise<{ conversations: DesktopConversation[] }>
  messages(conversationId: string, cursor?: string | null, limit?: number): Promise<DesktopMessagePage>
  send(mutation: PendingMutation): Promise<DesktopSendResponse>
  markRead(conversationId: string, throughMessageId: string, clientOperationId: string): Promise<void>
  sync(cursor: string | null): Promise<SyncPage>
  socialLookup(query: string): Promise<SocialLookupResponse>
  socialMutate(input: {
    accountEpoch: string
    action: SocialMutationAction
    clientOperationId: string
    targetProfileId: string
  }): Promise<SocialMutationResponse>
  socialSync(accountEpoch: string, cursor: string | null, limit?: number): Promise<SocialSyncResponse>
}

type DesktopConversation = ReturnType<typeof parseConversation>
type DesktopMessagePage = ReturnType<typeof parseMessagePage>
type DesktopSendResponse = ReturnType<typeof parseSendResponse>

/**
 * Closed create-direct input. The `never` members make accidental reuse of an
 * app/specialist request object a compile-time error at the S5 boundary.
 */
export interface CreateDirectConversationRequest {
  contactUserId: string
  clientOperationId: string
  specialist?: never
  specialist_scope?: never
}

/** Group capability is composed beside the frozen direct transport. */
export interface GroupMessagingTransport {
  groupDetail(
    conversationId: string,
    cursor?: string | null
  ): Promise<GroupDetail>
  groupOperate(
    input: GroupOperationInput
  ): Promise<{ conversationId: string; replayed: boolean }>
}
