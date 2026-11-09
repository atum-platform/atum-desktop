/** One bounded, display-only entry in Team Space's account-local Activity inbox. */
export interface MatrixCompanyActivityItem {
  companyId: string
  roomId: string
  eventId: string
  kind: 'mention' | 'thread_reply'
  body: string
  senderId: string
  senderName?: string
  sentAt: number
  unread: boolean
  threadRootId?: string
  /** The message carries a Chief of Staff answer projection: an answer, never a status-only line. */
  companyAIAnswer?: true
}
