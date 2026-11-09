import type { GatewayEvent } from '@hermes/shared'

import type { ProductEvent } from '../../shared/atum-observability'

export function reportProductEvent(name: ProductEvent['name'], properties: ProductEvent['properties'] = {}): void {
  window.hermesDesktop?.reporting?.capture({ name, properties })
}

export function reportRendererError(error: unknown): void {
  // No message crosses IPC, including rejection strings and React component props.
  window.hermesDesktop?.reporting?.error({
    operation: 'renderer', kind: error instanceof Error ? error.name : 'Error',
    stack: error instanceof Error ? error.stack?.slice(0, 16_384) : undefined
  })
}

const turns = new Map<string, { key: string; first: boolean; tools: Set<string> }>()

export function observeReportingGatewayEvent(event: GatewayEvent, mode: 'local' | 'remote'): void {
  const bridge = window.hermesDesktop?.reporting

  if (!bridge) {return}
  const payload = (event.payload ?? {}) as Record<string, unknown>

  if (event.type === 'gateway.ready') {
    reportProductEvent('app_ready', { mode, duration_ms: 0 })

    return
  }

  if (!event.session_id) {return}
  const session = `${event.profile ?? 'default'}:${event.session_id}`

  if (event.type === 'message.start' && typeof payload.turn_id === 'string' && payload.turn_id.length <= 512) {
    if (turns.size >= 256) {turns.delete(turns.keys().next().value!)}
    turns.set(session, { key: payload.turn_id, first: false, tools: new Set() })
    bridge.turn({ key: payload.turn_id, phase: 'start' })
    reportProductEvent('feature_used', { feature: 'chat' })
  }

  const turn = turns.get(session)

  if (!turn) {return}

  if (event.type === 'session.info' && payload.running === false) {
    bridge.turn({ key: turn.key, phase: 'lost' })
  }

  if (event.type === 'message.delta' && !turn.first) {
    turn.first = true
    bridge.turn({ key: turn.key, phase: 'first_token' })
  }

  if (event.type === 'tool.complete') {
    const toolKey = payload.tool_id ?? payload.tool_call_id ?? payload.id

    if (typeof toolKey === 'string' && toolKey.length <= 512 && !turn.tools.has(toolKey) && turn.tools.size < 4096) {
      turn.tools.add(toolKey)
      bridge.turn({ key: turn.key, phase: 'tool', toolKey })
    }
  }

  if (event.type === 'message.complete' || event.type === 'error') {
    // Ignore late terminal events belonging to a previous turn on this session.
    if (payload.turn_id !== turn.key && !(event.type === 'error' && payload.turn_id == null)) {return}

    const outcome = event.type === 'error' || payload.status === 'error' ? 'failed'
      : ['interrupted', 'cancelled'].includes(String(payload.status)) ? 'cancelled' : 'completed'

    bridge.turn({ key: turn.key, phase: 'finish', outcome })
    turns.delete(session)
  }
}

export function installReporting(): void {
  window.addEventListener('error', event => reportRendererError(event.error))
  window.addEventListener('unhandledrejection', event => reportRendererError(event.reason))
  let activeDay = ''

  const active = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible') {return}
    const day = new Date().toISOString().slice(0, 10)

    if (day === activeDay) {return}
    activeDay = day
    reportProductEvent('app_active')
  }

  window.addEventListener('pointerdown', active, { passive: true })
  window.addEventListener('keydown', active, { passive: true })
  window.hermesDesktop?.reporting?.onChanged(() => {turns.clear()})
}
