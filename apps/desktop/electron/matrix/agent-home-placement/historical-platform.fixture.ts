/** Test-only historic transitions used to prove stale Mac-job authority is refused. */
import {
  type HomeReadinessReport, parseCheckpointCommitResult, parseCheckpointReserveResult, parseDrainAckResult,
  parseMoveAbortResult, parseMoveCommitResult, parseMoveRequestResult,
  parseReadinessObservation
} from './contract'
import {
  type CheckpointCommitBody, type CheckpointReserveBody, type DrainAckBody, type MoveAbortInput,
  type MoveCasInput, type MoveRequestInput, ShellHomePlatform
} from './platform-client'

export class HistoricalFixturePlatform extends ShellHomePlatform {
  requestMove(agent: string, input: MoveRequestInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'request', intent: 'manual', ...input }, signal, value =>
      parseMoveRequestResult(value, agent)
    )
  }

  commitMove(agent: string, input: MoveCasInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'commit', ...input }, signal, value => parseMoveCommitResult(value, agent))
  }

  abortMove(agent: string, input: MoveAbortInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'abort', ...input }, signal, parseMoveAbortResult)
  }

  ackDrain(agent: string, body: DrainAckBody, signal: AbortSignal) {
    return this.call(agent, '/drain', body, signal, parseDrainAckResult)
  }

  reserveCheckpoint(agent: string, body: CheckpointReserveBody, signal: AbortSignal) {
    return this.call(agent, '/checkpoints', body, signal, parseCheckpointReserveResult)
  }

  commitCheckpoint(agent: string, body: CheckpointCommitBody, signal: AbortSignal) {
    return this.call(agent, '/checkpoints', body, signal, parseCheckpointCommitResult)
  }

  reportReadiness(agent: string, body: HomeReadinessReport, signal: AbortSignal) {
    return this.call(agent, '/readiness', body, signal, parseReadinessObservation)
  }

}
