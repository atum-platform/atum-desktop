import { openAccountConnect } from '@/app/connections/store'
import { $workActive } from '@/app/work/store'

import type {
  MatrixWorkBridge,
  MatrixWorkPlanConsent,
  MatrixWorkProjection,
  MatrixWorkRect
} from '../../../shared/matrix-work'

const STATES: Record<string, Partial<MatrixWorkProjection>> = {
  ready: {},
  starting: { view: 'starting' },
  unavailable: { view: 'unavailable' },
  off: { view: 'off' },
  protons: { protons: 'empty' }
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

function paint(rect: MatrixWorkRect | null, shot: string | null, live: string | null) {
  let layer = document.querySelector<HTMLElement>('[data-playground-work-view]')

  if (!rect || (!shot && !live)) {
    layer?.remove()

    return
  }

  if (!layer && live) {
    // `workView=<url>`: the real Work web UI where main lays the native view: a transparent page,
    // rounded to the panel radius as electron-view.ts rounds it.
    const frame = document.createElement('iframe')
    frame.dataset.playgroundWorkView = ''
    frame.style.cssText = 'position:fixed;z-index:20;border:0;border-radius:14px;background:transparent;color-scheme:normal'
    frame.setAttribute('allowtransparency', 'true')
    frame.src = live
    document.body.append(frame)
    layer = frame
  } else if (!layer && shot) {
    const image = document.createElement('img')
    image.dataset.playgroundWorkView = ''
    image.alt = ''
    image.style.cssText = 'position:fixed;z-index:20;object-fit:cover;object-position:left top;border-radius:14px;pointer-events:none'
    image.src = shot
    document.body.append(image)
    layer = image
  }

  if (!layer) {
    return
  }

  Object.assign(layer.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  })
}

export function playgroundWork(params: URLSearchParams): { work?: MatrixWorkBridge } {
  const state = params.get('work')

  if (!state || !(state in STATES)) {
    return {}
  }

  let projection = { ...READY, ...STATES[state] }
  let consent = consentFixture(params.get('consent'))
  const listeners = new Set<(projection: MatrixWorkProjection | null) => void>()
  const shot = params.get('workShot')
  const live = params.get('workView')
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
      show: async rect => paint(projection.view === 'ready' ? rect : null, shot, live),
      hide: async () => paint(null, shot, live),
      retry: async () => emit({ view: 'ready' }),
      setWork: async on => emit({ view: on ? 'ready' : 'off' }),
      openPlanConnect: async () => emit({ view: 'ready' }),
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
