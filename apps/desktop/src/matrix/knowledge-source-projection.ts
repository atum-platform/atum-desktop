import {
  MATRIX_AGENT_SOURCE_GATES,
  type MatrixAgentSourceGate,
  type MatrixAgentSourcePresentation,
  type MatrixAgentSourceStatus,
  type MatrixAgentSourcesView
} from '../../shared/matrix-agent-sources'

export const MATRIX_KNOWLEDGE_SOURCE_KINDS = [
  'google',
  'folders',
  'messages',
  'browser',
  'location',
  'teamSpaces',
  'unknown'
] as const

export type MatrixKnowledgeSourceKind = (typeof MATRIX_KNOWLEDGE_SOURCE_KINDS)[number]
export interface MatrixKnowledgeSourceRow {
  key: string
  gate: string
  kind: MatrixKnowledgeSourceKind
  kinds: string[]
  presentation?: MatrixAgentSourcePresentation
  sourceCount: number
  /** Where the source works today. Reported beside the switch; never changes it. */
  status: MatrixAgentSourceStatus
  /** The macOS pane that unblocks a `needs_permission` source. */
  permission?: 'fullDisk'
  /** The account's saved choice, exactly. */
  checked: boolean
  /** The source can't work anywhere on this account yet (the first-run ask skips it). */
  disabled: boolean
  switchable: boolean
}

/** Best first: a gate with several sources reports the most useful one. */
const STATUS_ORDER: readonly MatrixAgentSourceStatus[] = [
  'ready',
  'mac_only',
  'needs_permission',
  'not_connected',
  'needs_mac',
  'unavailable'
]

function rank(status: MatrixAgentSourceStatus | undefined): number {
  const index = status ? STATUS_ORDER.indexOf(status) : -1

  return index < 0 ? STATUS_ORDER.length : index
}

const GATES = new Set<string>(MATRIX_AGENT_SOURCE_GATES)
const KIND_ORDER = new Map(MATRIX_KNOWLEDGE_SOURCE_KINDS.map((kind, index) => [kind, index]))

function family(kind: string): MatrixKnowledgeSourceKind {
  if (kind.startsWith('google.')) {
    return 'google'
  }
  if (kind === 'mac.files') {
    return 'folders'
  }
  if (kind === 'mac.message-metadata') {
    return 'messages'
  }
  if (kind === 'mac.browser-history') {
    return 'browser'
  }
  if (kind === 'mac.location') {
    return 'location'
  }
  if (kind.startsWith('matrix.')) {
    return 'teamSpaces'
  }

  return 'unknown'
}

/**
 * One calm row and one switch per gate. The switch is the account's saved choice and never
 * moves because a source is unavailable; status is a separate, quiet fact. Unknown kinds remain
 * visible and generic.
 */
export function projectMatrixKnowledgeSourceRows(view: MatrixAgentSourcesView): MatrixKnowledgeSourceRow[] {
  const groups = new Map<string, MatrixAgentSourcesView['sources']>()

  for (const source of view.sources) {
    if (source.optOutGate === null) {
      continue
    }

    const group = groups.get(source.optOutGate) ?? []
    group.push(source)
    groups.set(source.optOutGate, group)
  }

  return [...groups]
    .map(([gate, sources]) => {
      const families = sources.map(source => family(source.kind))
      const kind = families.reduce<MatrixKnowledgeSourceKind>(
        (current, candidate) =>
          (KIND_ORDER.get(candidate) ?? Number.MAX_SAFE_INTEGER) < (KIND_ORDER.get(current) ?? Number.MAX_SAFE_INTEGER)
            ? candidate
            : current,
        'unknown'
      )
      const switchable = GATES.has(gate)
      const enabled = switchable ? view.gates[gate as MatrixAgentSourceGate] : false
      const grantable = sources.some(source => source.grantable)
      const best = sources.reduce<MatrixAgentSourcesView['sources'][number] | undefined>(
        (current, candidate) => (!current || rank(candidate.status) < rank(current.status) ? candidate : current),
        undefined
      )
      const status = best && rank(best.status) < STATUS_ORDER.length ? best.status : 'unavailable'
      const presentation = [...sources]
        .sort((left, right) => left.kind.localeCompare(right.kind))
        .find(source => source.presentation)?.presentation

      return {
        key: gate,
        gate,
        kind,
        kinds: [...new Set(sources.map(source => source.kind))].sort(),
        ...(presentation ? { presentation } : {}),
        sourceCount: sources.length,
        status,
        ...(status === 'needs_permission' && best?.permission ? { permission: best.permission } : {}),
        checked: enabled,
        disabled: !switchable || !grantable,
        switchable
      }
    })
}
