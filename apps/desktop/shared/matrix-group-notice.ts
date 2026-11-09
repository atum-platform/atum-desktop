/** Main-to-platform free publication authority; never a renderer grant. */
export interface MatrixGroupNoticeBinding {
  executorId: string
  leaseToken: string
  roomId: string
  day: string
}

export interface MatrixGroupNoticeClaim extends MatrixGroupNoticeBinding {
  operation: 'claim'
  dailyTurns: number
}

export interface MatrixGroupNoticeReceipt extends MatrixGroupNoticeBinding {
  operation: 'published'
  publishedEvent: string
}

export type MatrixGroupNoticeRequest = MatrixGroupNoticeClaim | MatrixGroupNoticeReceipt

export interface MatrixGroupNoticePublication {
  version: 1
  state: 'publish'
  owner: string
  roomId: string
  day: string
  cap: number
  executorId: string
  agentPrincipal: string
  agentUserId: string
  deviceId: string
  transactionId: string
}
