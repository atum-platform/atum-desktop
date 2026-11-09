import type {
  ExecutionDestinationId,
  ExecutionDestinationStatus,
  ExecutionDeviceName,
  ExecutionPolicySnapshot,
  ExecutionPolicyUpdate,
  ExecutionStatusSnapshot,
  MatrixExecutionPolicyBridge,
  MatrixExecutionPolicyView
} from '../../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../../shared/execution-policy'
import type { MatrixSnapshot } from '../../../shared/matrix'

/** Local/cloud placement follows the saved execution policy and current lease. */
export type PlaygroundPolicyMode =
  | 'answering'
  | 'elsewhere'
  | 'elsewhere-error'
  | 'loading'
  | 'long-name'
  | 'paused'
  | 'saving-failed'
  | 'single-mac'

const MODES: readonly PlaygroundPolicyMode[] = [
  'answering',
  'elsewhere',
  'elsewhere-error',
  'loading',
  'long-name',
  'paused',
  'saving-failed',
  'single-mac'
]

export function playgroundPolicyMode(params: URLSearchParams): PlaygroundPolicyMode | undefined {
  const mode = params.get('policy')

  return MODES.find(each => each === mode)
}

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const AIR = '00000000-0000-4000-8000-b454f82c5857'
const MINI = '00000000-0000-4000-8000-f6222a1106ee'

const AIR_DESTINATION = `mac:${AIR}` as ExecutionDestinationId
const MINI_DESTINATION = `mac:${MINI}` as ExecutionDestinationId
const ORDER: ExecutionDestinationId[] = ['cloud', AIR_DESTINATION, MINI_DESTINATION]

const NAMES: Record<string, ExecutionDeviceName> = {
  [AIR]: { displayName: "Example's MacBook Air", model: 'MacBook Air', thisMac: true },
  [MINI]: { displayName: "Owner's Mac mini", thisMac: false }
}

function policy(disabled: ExecutionDestinationId[]): ExecutionPolicySnapshot {
  return parseExecutionPolicySnapshot({
    profile: 'atum.execution-policy/1',
    agentPrincipal: AGENT,
    revision: 2,
    source: 'saved',
    order: ORDER,
    disabled
  })!
}

function status(
  state: ExecutionStatusSnapshot['state'],
  current: ExecutionDestinationId | null,
  desired: ExecutionDestinationId | null,
  destinations: Record<ExecutionDestinationId, ExecutionDestinationStatus>
): ExecutionStatusSnapshot {
  return parseExecutionStatusSnapshot({
    profile: 'atum.execution-status/1',
    agentPrincipal: AGENT,
    policyRevision: 2,
    asOf: Date.now(),
    state,
    current,
    desired,
    order: ORDER,
    disabled: ORDER.filter(id => destinations[id].state === 'disabled'),
    destinations
  })!
}

const ready = (observedAt: number): ExecutionDestinationStatus => ({ state: 'ready', observedAt })
const working = (observedAt: number): ExecutionDestinationStatus => ({ state: 'working', observedAt })

const off = (observedAt: number): ExecutionDestinationStatus => ({
  state: 'disabled',
  reason: 'owner_disabled',
  observedAt
})

/** Local/cloud placement follows the saved execution policy and current lease. */
const raymond: MatrixExecutionPolicyView = {
  policy: policy([]),
  status: status('working', MINI_DESTINATION, MINI_DESTINATION, {
    cloud: ready(1_791_876_998_000),
    [AIR_DESTINATION]: ready(1_791_876_999_000),
    [MINI_DESTINATION]: working(1_791_876_999_500)
  }),
  stale: false,
  deviceNames: NAMES
}

/** This Mac answers, so the "(máy này)" mark has to be visible in the tooltip and its row. */
const answering: MatrixExecutionPolicyView = {
  policy: policy([]),
  status: status('working', AIR_DESTINATION, AIR_DESTINATION, {
    cloud: ready(1_791_876_998_000),
    [AIR_DESTINATION]: working(1_791_876_999_500),
    [MINI_DESTINATION]: ready(1_791_876_999_000)
  }),
  stale: false,
  deviceNames: NAMES
}

const paused: MatrixExecutionPolicyView = {
  policy: policy([...ORDER]),
  status: status('paused', null, null, {
    cloud: off(1_791_876_998_000),
    [AIR_DESTINATION]: off(1_791_876_999_000),
    [MINI_DESTINATION]: off(1_791_876_999_500)
  }),
  stale: false,
  deviceNames: NAMES
}

const loading: MatrixExecutionPolicyView = { ...raymond, stale: true }

/** A Mac name nothing can strip (no possessive), long enough to overflow every row it appears in. */
export const LONG_MAC_NAME = 'MacBook Pro 16 inch ở phòng làm việc tầng hai, dùng để thiết kế đồ họa'

const longName: MatrixExecutionPolicyView = {
  ...raymond,
  deviceNames: { ...NAMES, [MINI]: { displayName: LONG_MAC_NAME, thisMac: false } }
}

export function playgroundPolicyView(mode: PlaygroundPolicyMode | undefined): MatrixExecutionPolicyView {
  if (mode === 'paused') {
    return paused
  }

  if (mode === 'loading') {
    return loading
  }

  if (mode === 'answering') {
    return answering
  }

  if (mode === 'long-name') {
    return longName
  }

  if (mode === 'single-mac') {
    return singleMac
  }

  return raymond
}

/** A new account's first Mac: the cloud answers and this Mac stands by. One Mac is no choice. */
const ORDER_SINGLE: ExecutionDestinationId[] = ['cloud', AIR_DESTINATION]

const singleMac: MatrixExecutionPolicyView = {
  policy: parseExecutionPolicySnapshot({
    profile: 'atum.execution-policy/1',
    agentPrincipal: AGENT,
    revision: 0,
    source: 'default',
    order: ORDER_SINGLE,
    disabled: []
  })!,
  status: parseExecutionStatusSnapshot({
    profile: 'atum.execution-status/1',
    agentPrincipal: AGENT,
    policyRevision: 0,
    asOf: Date.now(),
    state: 'working',
    current: 'cloud',
    desired: 'cloud',
    order: ORDER_SINGLE,
    disabled: [],
    destinations: { cloud: working(1_791_876_999_500), [AIR_DESTINATION]: ready(1_791_876_999_000) }
  })!,
  stale: false,
  deviceNames: { [AIR]: NAMES[AIR]! }
}

/** The owner's names reach the default assistant the title bar follows; other agents stay plain. */
export function withPlaygroundPolicy(
  snapshot: MatrixSnapshot,
  view: MatrixExecutionPolicyView,
  mode?: PlaygroundPolicyMode
): MatrixSnapshot {
  return snapshot.agents
    ? {
        ...snapshot,
        agents: snapshot.agents.map(agent =>
          agent.isDefault
            ? {
                ...agent,
                executionPolicy: view,
                // "Not ready yet" is only honest when no destination answers (§9.6).
                ...(mode === 'elsewhere' || mode === 'elsewhere-error' || mode === 'long-name'
                  ? {
                      ready: false,
                      readiness: {
                        phase: 'blocked' as const,
                        step: 'ai' as const,
                        // Offline offers Try again (and so owns the roster line); a runtime download does not.
                        code: mode === 'elsewhere-error' ? ('offline' as const) : ('runtime_unavailable' as const),
                        since: Date.now()
                      }
                    }
                  : {})
              }
            : agent
        )
      }
    : snapshot
}

export function playgroundPolicyBridge(mode: PlaygroundPolicyMode | undefined): MatrixExecutionPolicyBridge {
  const view = playgroundPolicyView(mode)

  return {
    read: async () => view,
    save: async (_agentPrincipal: string, update: ExecutionPolicyUpdate) =>
      mode === 'saving-failed'
        ? { ok: false as const, error: { error: 'matrix_503' as const, details: { reason: 'unavailable' as const } } }
        : {
            ok: true as const,
            value: {
              ...view.policy,
              revision: update.expectedRevision + 1,
              order: [...update.order],
              disabled: [...update.disabled]
            }
          }
  }
}
