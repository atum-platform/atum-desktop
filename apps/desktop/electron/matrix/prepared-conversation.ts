/**
 * A conversation made ready before its turn is dispatched (MatrixHermesExecutor.prepare): the
 * vault link checked and, where the room is read, its history witnessed or a new session's seed
 * taken. Opaque; the executor that made it runs it once, for this conversation only.
 *
 * Kept import-free, apart from hermes-executor.ts, so invocation.ts and local-turn.ts can name it
 * without loading the desktop's Hermes runtime into the cloud controller's stricter typecheck.
 */
export interface MatrixPreparedConversation {
  readonly conversationKey: string
}
