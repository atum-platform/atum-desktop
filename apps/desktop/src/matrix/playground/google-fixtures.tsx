import { useState } from 'react'

import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionSource,
  MatrixGoogleConnectionStatus
} from '../../../shared/matrix-google-connections'
import type { MatrixGoogleAssistantAccess } from '../../../shared/matrix-google-tools'
import { type MatrixSettingsPane, MatrixSettingsSheet } from '../settings-sheet'

import { scenarioSnapshot } from './fixtures'

/** `?google=` picks what Settings › Account › Google shows (dev only). */
export const PLAYGROUND_GOOGLE_STATES = ['connect', 'ready', 'partial', 'route', 'paused', 'own-model'] as const
type PlaygroundGoogleState = (typeof PLAYGROUND_GOOGLE_STATES)[number]

const source = (row: Partial<MatrixGoogleConnectionSource> & Pick<MatrixGoogleConnectionSource, 'id' | 'groupId' | 'kind' | 'label'>): MatrixGoogleConnectionSource => ({
  provider: 'google',
  state: 'connected',
  enabled: true,
  ...row
})

const TWO_ACCOUNTS: MatrixGoogleConnectionSource[] = [
  source({ id: 's:mail', groupId: 'g:personal', kind: 'email', label: 'person@example.com', writable: true }),
  source({ id: 's:cal-1', groupId: 'g:personal', kind: 'calendar', label: 'person@example.com', primary: true, writable: true }),
  source({ id: 's:cal-2', groupId: 'g:personal', kind: 'calendar', label: 'Gia đình', enabled: false }),
  source({ id: 's:drive', groupId: 'g:personal', kind: 'drive', label: 'person@example.com' }),
  source({ id: 's:work-drive', groupId: 'g:work', kind: 'drive', label: 'fixture-cd84bdc64c@example.invalid' })
]

const CALENDAR_ONLY: MatrixGoogleConnectionSource[] = [
  source({ id: 's:cal', groupId: 'g:personal', kind: 'calendar', label: 'person@example.com', primary: true, writable: true })
]

const STATES: Record<PlaygroundGoogleState, { sources: MatrixGoogleConnectionSource[]; assistant: MatrixGoogleAssistantAccess }> = {
  connect: { sources: [], assistant: { state: 'connect' } },
  ready: { sources: TWO_ACCOUNTS, assistant: { state: 'ready', services: { gmail: true, send: true, calendar: true, drive: true } } },
  partial: { sources: CALENDAR_ONLY, assistant: { state: 'ready', services: { gmail: false, send: false, calendar: true, drive: false } } },
  route: { sources: TWO_ACCOUNTS, assistant: { state: 'unavailable', reason: 'route' } },
  paused: { sources: TWO_ACCOUNTS, assistant: { state: 'paused', reason: 'route' } },
  'own-model': { sources: TWO_ACCOUNTS, assistant: { state: 'unavailable', reason: 'own_model' } }
}

/** The connection bridge on fixture data: connecting grants everything after a short wait. */
function playgroundGoogleBridge(initial: MatrixGoogleConnectionSource[]): MatrixGoogleConnectionBridge {
  let sources = initial
  const status = (): { status: MatrixGoogleConnectionStatus } => ({ status: { available: true, sources } })

  return {
    status: async () => status(),
    connect: async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
      sources = sources.length ? sources : TWO_ACCOUNTS

      return status()
    },
    disconnect: async groupId => {
      sources = sources.filter(item => item.groupId !== groupId)

      return status()
    },
    setSourcePreferences: async preferences => {
      sources = sources.map(item => ({ ...item, enabled: preferences.find(change => change.id === item.id)?.enabled ?? item.enabled }))

      return status()
    }
  }
}

/** Settings › Account with the Google section in the state `?google=` names. */
export function PlaygroundGoogleSettings() {
  const requested = new URLSearchParams(location.search).get('google')
  const state: PlaygroundGoogleState = (PLAYGROUND_GOOGLE_STATES as readonly string[]).includes(requested ?? '') ? (requested as PlaygroundGoogleState) : 'ready'
  const [pane, setPane] = useState<MatrixSettingsPane>('account')

  useState(() => {
    window.atumMatrix = { ...window.atumMatrix, googleConnections: playgroundGoogleBridge(STATES[state].sources) } as typeof window.atumMatrix
  })

  return (
    <MatrixSettingsSheet
      fail={() => {}}
      onClose={() => {}}
      onPaneChange={setPane}
      open
      pane={pane}
      snapshot={{ ...scenarioSnapshot('chat'), googleAssistant: STATES[state].assistant }}
    />
  )
}
