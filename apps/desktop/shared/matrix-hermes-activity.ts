/**
 * A bounded, presentation-only view of one native-owned Hermes invocation, shown
 * only in the owner's own window (never posted to the room). Like the old app's
 * live turn it carries the growing answer, the model's reasoning text and
 * Hermes's own short context line per tool (plan 2026-09-26-chat-speed-parity).
 * Raw tool inputs/results, prompts, credentials and any other gateway event stay
 * on the native boundary; this is not a gateway event type.
 */
export type MatrixHermesActivityState = 'running' | 'complete' | 'stopped'

export interface MatrixHermesActivityTool {
  name: string
  state: 'running' | 'complete'
  /** Native-authored state label; never tool input, output, or provider text. */
  summary?: 'Running' | 'Completed'
  /** Hermes's own short description of the call (its `context`, e.g. a command or
   * file), bounded; never the raw arguments or result. */
  detail?: string
}

export interface MatrixHermesActivitySnapshot {
  /** Binds this ephemeral display state to exactly one authorized invocation. */
  invocationId: string
  state: MatrixHermesActivityState
  /** Public assistant text only, bounded by the native projection. */
  text: string
  /** The model's reasoning ("thinking") text, bounded; shown locally, never posted. */
  reasoning?: string
  /** Public tool labels only, bounded by the native projection. */
  tools: MatrixHermesActivityTool[]
}

/** A throwing observer is presentation failure only; native execution continues. */
export type MatrixHermesActivityCallback = (snapshot: MatrixHermesActivitySnapshot) => void
