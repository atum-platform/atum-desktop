import { $workActive, $workBandOpen } from '@/app/work/store'

import type { MatrixWorkBridge, MatrixWorkProjection, MatrixWorkRect } from '../../../shared/matrix-work'

/**
 * Self-work slice A (lane DW): the Work page on fixture data.
 *
 * - `?work=ready|starting|unavailable|off|enroll|assistants-off|holding|stale|unreachable|working|protons`
 *   opens the Work page in that state (`enroll` is the D9 text; `working` has agents running).
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

  let projection: MatrixWorkProjection = { ...READY, ...STATES[state] }
  const listeners = new Set<(projection: MatrixWorkProjection | null) => void>()
  const shot = params.get('workShot')

  const emit = (next: Partial<MatrixWorkProjection>) => {
    projection = { ...projection, ...next }
    listeners.forEach(listener => listener(projection))
  }

  $workActive.set(true)
  $workBandOpen.set(params.has('band'))

  return {
    work: {
      read: async () => projection,
      show: async rect => paint(projection.view === 'ready' ? rect : null, shot),
      hide: async () => paint(null, shot),
      retry: async () => emit({ view: 'ready' }),
      allowAssistants: async () => emit({ assistants: 'on' }),
      setAssistants: async on => emit({ assistants: on ? 'on' : 'off' }),
      setWork: async on => emit({ view: on ? 'ready' : 'off' }),
      reconnectAssistants: async () => emit({ assistants: 'on' }),
      subscribe: listener => {
        listeners.add(listener)

        return () => void listeners.delete(listener)
      }
    }
  }
}
