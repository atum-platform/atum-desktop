import type { MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { WorkAgentPlans } from '../../../shared/matrix-work'
import type { WorkRelayMachine } from '../../../shared/matrix-work-relay'

/**
 * `?agentPlace=cloud|mini|laptop|off`: where the open assistant is working, for the place icon beside
 * its name in the window's title bar (owner 2026-11-28). Every assistant is a cloud-only one on the
 * cloud route, as shipped; the plan read answers the place: an Atum model (the cloud), a Claude plan
 * through the Mac mini, a ChatGPT plan through a MacBook Pro, or a plan whose only Mac is off.
 */
export type PlaygroundAgentPlaceMode = 'cloud' | 'mini' | 'laptop' | 'off'

const MODES: readonly PlaygroundAgentPlaceMode[] = ['cloud', 'mini', 'laptop', 'off']

const MINI: WorkRelayMachine = { id: 'svc-mini', name: 'Mac mini', kind: 'mac-mini', online: true }
const PRO: WorkRelayMachine = { id: 'svc-pro', name: 'MacBook Pro', kind: 'laptop', online: true }

const PLANS: Record<PlaygroundAgentPlaceMode, WorkAgentPlans> = {
  cloud: { published: true, plans: {}, selection: null },
  mini: {
    published: true,
    plans: { claude: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'claude', model: 'claude-opus', revision: 1 },
    machines: { claude: [MINI] }
  },
  laptop: {
    published: true,
    plans: { codex: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'codex', model: 'gpt-sol', revision: 1 },
    machines: { codex: [PRO] }
  },
  off: {
    published: true,
    plans: { claude: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'claude', model: 'claude-opus', revision: 1 },
    machines: { claude: [{ ...MINI, online: false }] }
  }
}

export function playgroundAgentPlaceMode(params: URLSearchParams): PlaygroundAgentPlaceMode | null {
  const mode = params.get('agentPlace') as PlaygroundAgentPlaceMode | null

  return mode && MODES.includes(mode) ? mode : null
}

/** Every assistant answers in the cloud, its home the cloud with no move: the shipped cloud-only window. */
export function withPlaygroundAgentPlace(snapshot: MatrixSnapshot, mode: PlaygroundAgentPlaceMode | null): MatrixSnapshot {
  if (!mode) {
    return snapshot
  }

  return {
    ...snapshot,
    assistantPath: 'server',
    agents: snapshot.agents?.map(agent => ({
      ...agent,
      answering: 'cloud' as const,
      macRole: undefined,
      title: agent.title ?? (agent.isDefault ? 'Chief of staff' : undefined),
      home: agent.home
        ? {
            ...agent.home,
            lives: { kind: 'cloud' as const },
            move: null,
            placement: agent.home.placement ? { ...agent.home.placement, current: 'cloud', progress: undefined } : undefined
          }
        : agent.home
    }))
  }
}

/** The plan read the pickers and the place icon share (`work.readAgentPlans`), answered from the mode. */
export function playgroundAgentPlaceWork(
  mode: PlaygroundAgentPlaceMode | null,
  work: MatrixUiBridge['work']
): Pick<MatrixUiBridge, 'work'> {
  if (!mode) {
    return work ? { work } : {}
  }

  return {
    // Without `?work=` the account has no Work page (read: null); only the plan read answers.
    work: {
      ...(work ?? { subscribe: () => () => {}, read: async () => null }),
      readAgentPlans: async () => PLANS[mode]
    } as NonNullable<MatrixUiBridge['work']>
  }
}
