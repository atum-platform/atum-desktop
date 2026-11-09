import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixSnapshot
} from '../../../shared/matrix'

const ATUM_MODEL: MatrixAgentHomeModelOption = {
  connectionRef: 'conn_atummanaged000001',
  source: 'atum',
  providerLabel: 'Atum',
  model: 'nguyet-thuc',
  modelLabel: 'Nguyệt Thực 1.3',
  effort: 'medium',
  efforts: ['low', 'medium', 'high'],
  available: true
}

const MINI_MODEL: MatrixAgentHomeModelOption = {
  connectionRef: 'conn_codexplan00000001',
  source: 'chatgpt_plan',
  providerLabel: 'ChatGPT',
  model: 'gpt-5.6-luna',
  modelLabel: 'GPT-5.6 Luna',
  effort: 'medium',
  efforts: ['low', 'medium', 'high', 'max'],
  available: true
}

const MINI = '00000000-0000-4000-8000-b454f82c5857'
const AIR = '00000000-0000-4000-8000-f6222a1106ee'

/** The design playground's completion of a home (atum.agent-home/2.5), so the card's place row
 * and its popover can be seen without a platform. The primary sits in the cloud (a cloud sign-up)
 * and the other assistant on this Mac, each with the other places (and a second Mac, MacBook Air M2) as moves. */
function home(lives: 'cloud' | 'mac'): MatrixAgentHomeView {
  const here = lives === 'mac'

  return {
    lives: here ? { kind: 'mac', name: 'Mac mini', thisMac: true } : { kind: 'cloud' },
    move: null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: here ? MINI : 'cloud',
      reachability: 'reachable',
      currentModel: here ? MINI_MODEL : ATUM_MODEL,
      modelStatus: 'applied',
      destinations: [
        { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [ATUM_MODEL] },
        { id: MINI, kind: 'mac', name: 'Mac mini', thisMac: true, eligibility: 'ready', catalogRevision: 4, models: [MINI_MODEL] },
        { id: AIR, kind: 'mac', name: 'MacBook Air M2', thisMac: false, eligibility: 'ready', catalogRevision: 2, models: [MINI_MODEL] }
      ]
    }
  }
}

/** The playground snapshot with a place for the primary (cloud) and the other assistant (this Mac). */
export function withPlaygroundHome(snapshot: MatrixSnapshot): MatrixSnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents?.map(each => ({
      ...each,
      home: each.home ?? home(each.isDefault ? 'cloud' : 'mac')
    }))
  }
}

/**
 * The playground's where-it-lives bridge: reads the home the decorated snapshot carries and
 * answers moves/preflights with synthetic success. Nothing leaves the window; the card's popover
 * is the real component, driven by the same fixtures the tests use.
 */
export function playgroundAgentHome(snapshot: () => MatrixSnapshot): MatrixAgentHomeBridge {
  return {
    read: async principal => snapshot().agents?.find(each => each.principal === principal)?.home,
    preflight: async (_principal, target) => ({
      ok: true,
      preflightId: '00000000-0000-4000-8000-f2da1f9533d4',
      target,
      featureLosses: [],
      lastCheckpointAtPlatform: Date.now() - 600_000,
      checkpointLossRequired: false
    }),
    move: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    model: async () => ({ status: 'saved' }),
    prepare: async () => ({ ok: true })
  }
}
