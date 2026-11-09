import type { MatrixSdkCommand } from '../../shared/matrix'
import { MatrixPresentationSignals, type MatrixPresentationWork } from '../../shared/matrix-presentation-signals'

import type { MatrixHermesAsk } from './hermes-prompts'

export type MatrixAgentSignalCommand = Extract<MatrixSdkCommand, { kind: 'agentSeen' | 'agentTyping' }>

export interface MatrixAgentSignalDeps {
  send(command: MatrixAgentSignalCommand): Promise<unknown>
  owner(): string | undefined
  /** The runtime supplies the real lease; optional only for existing legacy caller tests. */
  leaseHeld?(): boolean
  log?(line: string): void
}

export type MatrixAgentWork = MatrixPresentationWork

/** Native timer/SDK port over the one shared presentation emitter. */
export class MatrixAgentSignals extends MatrixPresentationSignals {
  constructor(deps: MatrixAgentSignalDeps) {
    super({
      ...deps,
      leaseHeld: () => deps.leaseHeld?.() ?? true,
      every: (milliseconds, run) => {
        const timer = setInterval(run, milliseconds)
        timer.unref?.()

        return () => clearInterval(timer)
      }
    })
  }
}

/** Questions to the owner pause typing until the answer arrives. */
export function matrixWorkingAsk(ask: MatrixHermesAsk, work: MatrixAgentWork | undefined): MatrixHermesAsk {
  return work ? (prompt, signal, deadlineAt) => work.waiting(ask(prompt, signal, deadlineAt)) : ask
}
