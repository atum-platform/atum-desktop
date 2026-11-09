import type {
  AtumMessagingClient,
  AtumMessagingConversation,
  AtumMessagingMessage,
  AtumMessagingSyncStatus,
  AtumMessagingTransportStatus
} from './atum-messaging-client'

/** Renderer-facing S5 surface. App chat and artifact resolution stay outside it. */
export type AtumDirectMessagingClient = Pick<
  AtumMessagingClient,
  | 'status'
  | 'roster'
  | 'messages'
  | 'loadOlderMessages'
  | 'transportStatus'
  | 'mentionTargets'
  | 'ensureContactConversation'
  | 'handleAvailability'
  | 'renameHandle'
  | 'updateProfile'
  | 'createAvatarUpload'
  | 'completeAvatarUpload'
  | 'clearAvatar'
  | 'socialLookup'
  | 'socialMutate'
  | 'socialRelationships'
  | 'socialSync'
  | 'draft'
  | 'saveDraft'
  | 'send'
  | 'retry'
  | 'markRead'
  | 'toggleReaction'
  | 'editMessage'
  | 'recallMessage'
  | 'searchMessages'
  | 'createMediaUpload'
  | 'completeMediaUpload'
  | 'downloadMedia'
  | 'sendTyping'
  | 'drainMentionJobs'
  | 'sync'
>

export type {
  AtumMessagingConversation as AtumDirectConversation,
  AtumMessagingMessage as AtumDirectMessage,
  AtumMessagingSyncStatus as AtumDirectSyncStatus,
  AtumMessagingTransportStatus as AtumDirectTransportStatus
}

export function atumDirectMessagingClient(): AtumDirectMessagingClient {
  if (!window.hermesDesktop?.messaging) {
    throw new Error('Atum direct messaging is unavailable in this desktop runtime')
  }

  return window.hermesDesktop.messaging
}
