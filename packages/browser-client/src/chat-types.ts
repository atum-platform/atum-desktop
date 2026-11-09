import type { MatrixMessage, MatrixSnapshot } from '../../../apps/desktop/shared/matrix'

/** Browser-local send correlation; never authority or delivery evidence. */
export interface BrowserChatMessage extends MatrixMessage {
  matrixTransactionId?: string
}

export interface BrowserChatSnapshot extends Omit<MatrixSnapshot, 'messages'> {
  messages: BrowserChatMessage[]
}
