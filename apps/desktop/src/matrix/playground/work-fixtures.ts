import { $accountConnectProgress, openAccountConnect } from '@/app/connections/store'
import { $workActive } from '@/app/work/store'

import type { FirstRunLabels } from '../../../shared/first-run-labels'
import type {
  MatrixWorkBridge,
  MatrixWorkPlanConsent,
  MatrixWorkProjection
} from '../../../shared/matrix-work'

const STATES: Record<string, Partial<MatrixWorkProjection>> = {
  ready: {},
  starting: { view: 'starting' },
  unavailable: { view: 'unavailable' },
  off: { view: 'off' },
  protons: { protons: 'empty' }
}

/** The first chat's Connections rows (`?firstRun=one|several|none|free`, `?signing=codex|claude|antigravity`). */
const FIRST_RUN_LABELS: Record<string, FirstRunLabels> = {
  one: { claude: { state: 'ready', label: 'Claude Pro' }, codex: { state: 'signed_out' } },
  several: { claude: { state: 'ready', label: 'Claude Pro' }, codex: { state: 'ready', label: 'ChatGPT Plus' } },
  none: {},
  free: { codex: { state: 'ready', label: 'ChatGPT Free' } },
  connected: { codex: { state: 'ready', label: 'ChatGPT Plus' } }
}

const READY: MatrixWorkProjection = { view: 'ready', protons: 'ok' }

const THIS_MAC = '00000000-0000-4000-8000-0000000c0a01'
const OTHER_MAC = '00000000-0000-4000-8000-0000000c0a02'
/** The playground's assistants (fixtures.ts: Atum is the master, Moon the second). */
export const PLAYGROUND_WORK_AGENTS = ['agent-atum', 'agent-moon'] as const

function consentFixture(mode: string | null): MatrixWorkPlanConsent {
  const macs = [{ id: THIS_MAC, thisMac: true, named: mode === 'on' || mode === 'on-two-macs' }]

  if (mode === 'on-two-macs') {
    macs.push({ id: OTHER_MAC, thisMac: false, named: false })
  }

  return mode === 'on' || mode === 'on-two-macs'
    ? {
        state: 'on',
        agents: [PLAYGROUND_WORK_AGENTS[0]],
        eligible: [...PLAYGROUND_WORK_AGENTS],
        macs,
        alsoWhenScheduled: false,
        grantedAt: Date.UTC(2026, 10, 22, 2, 30)
      }
    : { state: 'off', agents: [], eligible: [...PLAYGROUND_WORK_AGENTS], macs, alsoWhenScheduled: false }
}

export function playgroundWork(params: URLSearchParams): { work?: MatrixWorkBridge } {
  const state = params.get('work')

  if (!state || !(state in STATES)) {
    return {}
  }

  let projection = { ...READY, ...STATES[state] }
  let consent = consentFixture(params.get('consent'))
  const listeners = new Set<(projection: MatrixWorkProjection | null) => void>()
  const sidebarEdge = Number(params.get('workSidebar') ?? 0)
  // `workRightPanel=open|closed` stands in for the view's report that a thread with a panel is open.
  const rightPanelParam = params.get('workRightPanel')
  const rightPanel = rightPanelParam === 'open' || rightPanelParam === 'closed' ? rightPanelParam : undefined

  const emit = (next: Partial<MatrixWorkProjection>) => {
    projection = { ...projection, ...next }
    listeners.forEach(listener => listener(projection))
  }

  $workActive.set(params.get('page') !== 'chat')

  if (params.has('sheet')) {
    openAccountConnect('codex')
  }

  const signing = params.get('signing')

  if (signing === 'codex' || signing === 'claude' || signing === 'antigravity') {
    $accountConnectProgress.set({ plan: signing, phase: 'signing_in' })
  }

  const firstRunLabels = FIRST_RUN_LABELS[params.get('firstRun') ?? ''] ?? FIRST_RUN_LABELS.none!

  return {
    work: {
      // `workMode=work|code` stands in for the view's report that a project is open, so the title bar's
      // Work · Code switch shows.
      getSurfaceMode: async () =>
        params.get('workMode') === 'work' || params.get('workMode') === 'code'
          ? { projectId: 'playground', mode: params.get('workMode') as 'work' | 'code' }
          : null,
      // `workSidebar=<px>` stands in for the view's thread-list report (its right edge), so the band's
      // bell can be judged against a `workShot`; `runCommand` lets the band show its buttons.
      getSidebar: async () => (sidebarEdge > 0 ? { open: true, edge: sidebarEdge, ...(rightPanel ? { rightPanel } : {}) } : null),
      onSidebarChanged: () => () => {},
      runCommand: async () => true,
      setSurfaceMode: async () => {},
      onSurfaceModeChanged: () => () => {},
      read: async () => projection,
      open: async () => {},
      retry: async () => emit({ view: 'ready' }),
      setWork: async on => emit({ view: on ? 'ready' : 'off' }),
      openPlanConnect: async () => emit({ view: 'ready' }),
      readPlanLabels: async () => firstRunLabels,
      readPlanConsent: async () => consent,
      setPlanConsent: async input => {
        consent = {
          ...consent,
          state: 'on',
          agents: [...input.agents],
          macs: consent.macs.map(mac => ({ ...mac, named: input.macs.includes(mac.id) })),
          alsoWhenScheduled: input.alsoWhenScheduled,
          grantedAt: Date.now()
        }

        return consent
      },
      revokePlanConsent: async () => {
        consent = { ...consent, state: 'off', agents: [], macs: consent.macs.map(mac => ({ ...mac, named: false })) }

        return consent
      },
      subscribe: listener => {
        listeners.add(listener)

        return () => void listeners.delete(listener)
      }
    }
  }
}
