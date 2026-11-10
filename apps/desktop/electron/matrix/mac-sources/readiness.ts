import type { MacSourceState, MacSourceStatus } from '../../../../../packages/device-protocol/messages'

import type { MacSourceConsentSnapshot } from './contract'

/** Native Settings facts are truthful even while remote reads/advertising are disabled. */
export function nativeMacSourceStatus(consent: MacSourceConsentSnapshot, fullDisk: string, location = 'unknown'): MacSourceStatus {
  const disk = fullDisk === 'granted' ? 'ready' : 'needs_permission'
  return { messages: consent.messages ? disk : 'off', browser: consent.browser ? disk : 'off',
    folders: consent.folders ? 'ready' : 'off', location: !consent.location ? 'off' : location === 'granted' ? 'ready' : 'needs_permission' }
}

/** Downgrades from ready immediately; unstable recovery cannot repeatedly redial Hello. */
export class MacSourceReadiness {
  private states = new Map<keyof MacSourceStatus, { published: MacSourceState; candidate: MacSourceState; since: number }>()
  snapshot(consent: MacSourceConsentSnapshot, fullDisk: string, enabled: boolean, now = Date.now(), location = 'unknown'): MacSourceStatus {
    const result: MacSourceStatus = { messages: 'off', browser: 'off', location: 'off', folders: 'off' }

    for (const source of ['messages', 'browser', 'location', 'folders'] as const) {
      const candidate = !enabled || !consent[source] ? 'off' :
        ((source === 'messages' || source === 'browser') && fullDisk !== 'granted') ||
          (source === 'location' && location !== 'granted') ? 'needs_permission' : 'ready'

      let state = this.states.get(source)

      if (!state) {
        state = { published: candidate === 'ready' ? 'off' : candidate, candidate, since: now }
        this.states.set(source, state)
      }

      if (candidate !== state.candidate) { state.candidate = candidate; state.since = now }

      if (candidate === 'off' && (!enabled || !consent[source])) {state.published = 'off'}
      else if (state.published === 'ready' && candidate !== 'ready') {state.published = candidate}
      else if (now - state.since >= 30_000) {state.published = candidate}

      result[source] = state.published
    }

    return result
  }
}
