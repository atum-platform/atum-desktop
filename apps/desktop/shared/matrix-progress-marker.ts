/**
 * The `io.atum.progress` marker of `atum.agent-turns/1.3` (spec/agent-turns/v1.3,
 * `progress_marker`). Dependency-free so the publisher, the SDK builder and every renderer
 * read the same shape. Presentation only: it confers no execution authority.
 */
import type { MatrixProgressFrame, MatrixProgressKind, MatrixProgressPhase } from './matrix-progress-kernel'

export const MATRIX_PROGRESS_PROFILE = 'atum.agent-turns/1.3'

export const MATRIX_PROGRESS_KEY = 'io.atum.progress'

export type { MatrixProgressKind, MatrixProgressPhase }

export interface MatrixProgressMarker {
  profile: typeof MATRIX_PROGRESS_PROFILE
  scope: 'owner_private'
  phase: MatrixProgressPhase
  kind: MatrixProgressKind
  revision: number
  device?: string
  heartbeat?: true
  /** Optional host presentation extension. Scheduled turns have no owner source event. */
  trigger?: 'cron'
}

const PHASES: readonly string[] = ['working', 'waiting', 'settled']
const KINDS: readonly string[] = ['interim', 'todo', 'heartbeat', 'device', 'touch_id', 'settled']

/** The marker of a message's content, or nothing when it has none or it is not exactly the
 * contract's shape (unknown keys are dropped, never trusted). Older clients ignore it. */
export function matrixProgressMarker(content: unknown): MatrixProgressMarker | undefined {
  const raw = (content as Record<string, unknown> | null | undefined)?.[MATRIX_PROGRESS_KEY] as
    | Record<string, unknown>
    | null
    | undefined

  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.profile !== MATRIX_PROGRESS_PROFILE ||
    raw.scope !== 'owner_private' ||
    typeof raw.phase !== 'string' ||
    !PHASES.includes(raw.phase) ||
    typeof raw.kind !== 'string' ||
    !KINDS.includes(raw.kind) ||
    !Number.isInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    (raw.revision as number) > 48 ||
    (raw.device !== undefined && (typeof raw.device !== 'string' || !raw.device || [...raw.device].length > 80)) ||
    (raw.heartbeat !== undefined && raw.heartbeat !== true)
  ) {
    return undefined
  }

  return {
    profile: MATRIX_PROGRESS_PROFILE,
    scope: 'owner_private',
    phase: raw.phase as MatrixProgressPhase,
    kind: raw.kind as MatrixProgressKind,
    revision: raw.revision as number,
    ...(raw.device !== undefined ? { device: raw.device as string } : {}),
    ...(raw.heartbeat === true ? { heartbeat: true as const } : {}),
    ...(raw.trigger === 'cron' ? { trigger: 'cron' as const } : {})
  }
}

/** The marker a kernel frame publishes under (the same on the original and on every edit). */
export function matrixProgressMarkerOf(frame: MatrixProgressFrame): MatrixProgressMarker {
  return {
    profile: MATRIX_PROGRESS_PROFILE,
    scope: 'owner_private',
    phase: frame.phase,
    kind: frame.kind,
    revision: frame.revision,
    ...(frame.device ? { device: frame.device } : {}),
    ...(frame.heartbeat ? { heartbeat: true as const } : {})
  }
}
