/**
 * The `io.atum.progress` marker of `atum.agent-turns/1.3` (spec/agent-turns/v1.3,
 * `progress_marker`). Dependency-free so the publisher, the SDK builder and every renderer
 * read the same shape. Presentation only: it confers no execution authority.
 */
import type { MatrixProgressFrame, MatrixProgressKind, MatrixProgressPhase } from './matrix-progress-kernel'
import type { MatrixToolActivityKind } from './matrix-status-line-copy'
import { MATRIX_PRESENTATION_KEY } from './matrix-subscription-fallback'

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

/**
 * What the working line says, as a code a viewer words in its own language (agent-turns/1.5 A12,
 * A13), the same shape as the descriptor of `feat/localized-agent-status`. Never a tool name,
 * argument or result, and never text the agent or a person wrote: the todo item text stays in
 * `body`. `approval_wait` is the cloud agent's wait on the owner's approval card (additive).
 * `video_consent_required` says the agent's video step needs the owner's one-time consent: the
 * conversation shows the consent card (video-consent-ask.ts); additive, no arguments.
 */
export type MatrixProgressPresentation =
  | { version: 1; code: 'tool_activity'; args: { activity: MatrixToolActivityKind } }
  | { version: 1; code: 'heartbeat'; args: { elapsed_minutes: number } }
  | { version: 1; code: 'approval_wait'; args: Record<string, never> }
  | { version: 1; code: 'video_consent_required'; args: Record<string, never> }

const TOOL_ACTIVITIES: readonly MatrixToolActivityKind[] = ['web', 'read', 'write', 'run', 'delegate', 'look', 'draw']

const count = (min: number, max: number) => (value: unknown) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max

/** Each code: the marker kind and phase it pairs with, and its exact arguments (no other key). */
const PRESENTATION: Record<
  MatrixProgressPresentation['code'],
  { kind: MatrixProgressKind; phase: MatrixProgressPhase; args: Record<string, (value: unknown) => boolean> }
> = {
  tool_activity: {
    kind: 'todo',
    phase: 'working',
    args: { activity: value => TOOL_ACTIVITIES.includes(value as MatrixToolActivityKind) }
  },
  heartbeat: { kind: 'heartbeat', phase: 'working', args: { elapsed_minutes: count(1, 1440) } },
  approval_wait: { kind: 'device', phase: 'waiting', args: {} },
  video_consent_required: { kind: 'device', phase: 'waiting', args: {} }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The descriptor of a working line's content (`io.atum.presentation`), checked against the line's
 * own marker, or nothing: an absent one, a version or code this build does not know, any argument
 * missing, extra or out of range, or a code on a line of another kind or phase. Nothing is never an
 * error; the viewer shows `body` (empty when the publisher had nothing of the agent's to say).
 */
export function matrixProgressPresentation(
  content: unknown,
  marker: { kind: string; phase: string }
): MatrixProgressPresentation | undefined {
  const raw = plainObject(plainObject(content)?.[MATRIX_PRESENTATION_KEY])
  const args = plainObject(raw?.args)

  if (!raw || !args || raw.version !== 1 || typeof raw.code !== 'string' || !Object.hasOwn(PRESENTATION, raw.code)) {
    return undefined
  }

  const rule = PRESENTATION[raw.code as MatrixProgressPresentation['code']]
  const names = Object.keys(rule.args)

  if (
    Object.keys(raw).some(key => !['version', 'code', 'args'].includes(key)) ||
    rule.kind !== marker.kind ||
    rule.phase !== marker.phase ||
    Object.keys(args).length !== names.length ||
    !names.every(name => Object.hasOwn(args, name) && rule.args[name]!(args[name]))
  ) {
    return undefined
  }

  return { version: 1, code: raw.code, args: { ...args } } as MatrixProgressPresentation
}
