import { openAccountConnect } from '@/app/connections/store'
import { $workActive, $workBandOpen } from '@/app/work/store'

import type {
  MatrixWorkBridge,
  MatrixWorkPlanConsent,
  MatrixWorkProjection,
  MatrixWorkRect
} from '../../../shared/matrix-work'

/**
 * Self-work slice A (lane DW): the Work page on fixture data.
 *
 * - `?work=ready|starting|unavailable|off|enroll|assistants-off|holding|stale|unreachable|working|protons`
 *   opens the Work page in that state (`enroll` is the D9 text; `working` has agents running).
 * - Slice B (subscriptions): `&connect=offer|connected` opens gate 4a (the first-sign-in step shows for `offer`);
 *   `&plan=off|on` the per-Mac plan switch; `&consent=off|on|on-two-macs` the account's consent; `&sheet` opens the consent sheet;
 *   `&page=chat` leaves the Work page so the app (or Settings, `?view=settings-work`) is what shows.
 * - `&band` opens the assistants band; `&workShot=<url>` paints that image where main would paint the
 *   owner view (the fork's screen), so the page can be judged with something in it.
 */
const STATES: Record<string, Partial<MatrixWorkProjection>> = {
  ready: {},
  starting: { view: 'starting' },
  unavailable: { view: 'unavailable' },
  off: { view: 'off', assistants: 'off' },
  enroll: { assistants: 'needs_grant' },
  'assistants-off': { assistants: 'off' },
  holding: { assistants: 'holding' },
  stale: { assistants: 'stale' },
  unreachable: { assistants: 'unreachable' },
  working: {
    agents: [
      { principal: 'agent-atum', running: 1, stopping: false },
      { principal: 'agent-moon', running: 0, stopping: true }
    ]
  },
  protons: { protons: 'empty' }
}

const READY: MatrixWorkProjection = { view: 'ready', assistants: 'on', agents: [], protons: 'ok' }

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

function paint(rect: MatrixWorkRect | null, shot: string | null) {
  let layer = document.querySelector<HTMLImageElement>('[data-playground-work-view]')

  if (!rect || !shot) {
    layer?.remove()

    return
  }

  if (!layer) {
    layer = document.createElement('img')
    layer.dataset.playgroundWorkView = ''
    layer.alt = ''
    layer.style.cssText = 'position:fixed;z-index:20;object-fit:cover;object-position:left top;border-radius:14px;pointer-events:none'
    layer.src = shot
    document.body.append(layer)
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

  const connect = params.get('connect')
  const plan = params.get('plan')

  let projection: MatrixWorkProjection = {
    ...READY,
    ...STATES[state],
    ...(connect === 'offer' || connect === 'connected' ? { planConnect: connect } : {}),
    ...(plan === 'off' || plan === 'on' ? { plan } : {})
  }

  let consent = consentFixture(params.get('consent'))
  const listeners = new Set<(projection: MatrixWorkProjection | null) => void>()
  const shot = params.get('workShot')
  const sidebarEdge = Number(params.get('workSidebar') ?? 0)

  const emit = (next: Partial<MatrixWorkProjection>) => {
    projection = { ...projection, ...next }
    listeners.forEach(listener => listener(projection))
  }

  $workActive.set(params.get('page') !== 'chat')
  $workBandOpen.set(params.has('band'))

  if (params.has('sheet')) {
    openAccountConnect('codex')
  }

  try {
    // The Connect step appears once; the playground shows it whenever `connect=offer` asks.
    localStorage.removeItem('atum.work.plan-connect.seen.v1')
  } catch {
    // Storage off: the step shows anyway.
  }

  return {
    work: {
      getSurfaceMode: async () => null,
      // `workSidebar=<px>` stands in for the view's thread-list report (its right edge), so the band's
      // bell can be judged against a `workShot`; `runCommand` lets the band show its buttons.
      getSidebar: async () => (sidebarEdge > 0 ? { open: true, edge: sidebarEdge } : null),
      onSidebarChanged: () => () => {},
      runCommand: async () => true,
      setSurfaceMode: async () => {},
      onSurfaceModeChanged: () => () => {},
      read: async () => projection,
      show: async rect => paint(projection.view === 'ready' ? rect : null, shot),
      hide: async () => paint(null, shot),
      retry: async () => emit({ view: 'ready' }),
      allowAssistants: async () => emit({ assistants: 'on' }),
      setAssistants: async on => emit({ assistants: on ? 'on' : 'off' }),
      setPlan: async on => emit({ plan: on ? 'on' : 'off' }),
      setWork: async on => emit({ view: on ? 'ready' : 'off' }),
      reconnectAssistants: async () => emit({ assistants: 'on' }),
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
