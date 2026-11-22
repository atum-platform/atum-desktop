import { useEffect, useState } from 'react'

import type { WorkConsentAgent } from '@/app/work/plan-consent'
import type { WorkRelayPickerView } from '@/app/work/relay-view'
import { $work, $workPlanConsent } from '@/app/work/store'
import { WorkScreen } from '@/app/work/work-screen'
import { MatrixWorkSettings } from '@/app/work/work-settings'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixWorkBridge, MatrixWorkPlanConsent } from '../../../shared/matrix-work'
import { MatrixModelPicker, type MatrixModelPickerRelay } from '../model-picker'

/**
 * Relay R1 (lane U1) outside the chat, on fixture data (dev only): `?view=relay&relay=<state>`. The picker's plan rows and chip,
 * the Work page's shared-context line, the plan's usage in Settings and the consent sheet when the plan answers chats.
 */
export const PLAYGROUND_RELAY_GALLERY = [
  'picker-selectable',
  'picker-connect',
  'picker-allow',
  'picker-google',
  'chip-limit',
  'chip-fallback',
  'work-disclosure',
  'settings-usage',
  'consent-chats'
] as const
type GalleryState = (typeof PLAYGROUND_RELAY_GALLERY)[number]

const AGENT = '00000000-0000-4000-8000-00000000c0de'
const MAC = '00000000-0000-4000-8000-0000000000a1'
const AGENTS: WorkConsentAgent[] = [{ principal: AGENT, name: 'Rin' }]

const ROOM: MatrixRoom = { id: '!rin:atum.invalid', name: 'Rin', membership: 'join', encrypted: false, assistant: true }

const PICKER_VIEWS: Record<Extract<GalleryState, `picker-${string}` | `chip-${string}`>, WorkRelayPickerView> = {
  'picker-selectable': { plan: 'codex', rows: 'selectable' },
  'picker-connect': { plan: 'codex', rows: 'greyed', greyed: 'connect', fix: 'connect' },
  'picker-allow': { plan: 'codex', rows: 'greyed', greyed: 'allow', fix: 'allow' },
  'picker-google': { plan: 'codex', rows: 'greyed', greyed: 'google' },
  'chip-limit': { plan: 'codex', rows: 'selectable', currentModel: 'gpt-6.1-sol', chip: { kind: 'limit', resetsAt: Date.now() + 95 * 60_000 } },
  'chip-fallback': { plan: 'codex', rows: 'selectable', currentModel: 'gpt-6.1-sol', chip: { kind: 'fallback', reason: 'mac_off' } }
}

const CONSENT_OFF: MatrixWorkPlanConsent = {
  state: 'off',
  agents: [],
  eligible: [AGENT],
  macs: [{ id: MAC, thisMac: true, named: false }],
  alsoWhenScheduled: false
}

const workBridge = {
  read: async () => null,
  place: async () => {},
  hide: async () => {},
  retry: async () => {},
  setWork: async () => {},
  setAssistants: async () => {},
  setPlan: async () => {},
  openPlanConnect: async () => {},
  readPlanConsent: async () => CONSENT_OFF,
  setPlanConsent: async () => CONSENT_OFF,
  revokePlanConsent: async () => CONSENT_OFF
} as unknown as MatrixWorkBridge

function stubPickerBridge() {
  const matrix = window.atumMatrix as unknown as Record<string, unknown>

  Object.assign(matrix, {
    subscriptions: {
      ...(matrix.subscriptions as object | undefined),
      status: async () => ({
        scope: 'account' as const,
        providers: [
          { id: 'openai-codex' as const, connected: true, localConnected: false, models: ['gpt-6.1-sol', 'gpt-6-luna'] },
          { id: 'opencode-go' as const, connected: false }
        ]
      })
    },
    modelDestinations: {
      ...(matrix.modelDestinations as object | undefined),
      read: async () => undefined,
      write: async () => ({ status: 'saved' as const }),
      writeSubscription: async () => ({ status: 'saved' as const }),
      cap: async () => ({ status: 'saved' as const })
    }
  })
}

function RelayPicker({ state }: { state: keyof typeof PICKER_VIEWS }) {
  const [ready] = useState(() => {
    stubPickerBridge()

    return true
  })

  const chip = state.startsWith('chip-')

  const relay: MatrixModelPickerRelay = {
    view: PICKER_VIEWS[state],
    select: async () => ({ status: 'saved' }),
    fix: () => {},
    models: [
      { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
      { id: 'gpt-6-luna', displayName: 'GPT-6 Luna' }
    ]
  }

  return ready ? (
    <div className="flex flex-1 items-end justify-end p-8">
      <MatrixModelPicker
        agentPrincipal={AGENT}
        cloud
        cloudChoice={{ offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' }}
        disabled={false}
        fail={() => {}}
        local
        managed
        open={chip ? undefined : true}
        room={ROOM}
        side="top"
        workRelay={relay}
      />
    </div>
  ) : null
}

export function PlaygroundRelay() {
  const value = new URLSearchParams(location.search).get('relay') ?? ''
  const state: GalleryState = (PLAYGROUND_RELAY_GALLERY as readonly string[]).includes(value) ? (value as GalleryState) : 'picker-selectable'

  useEffect(() => {
    $work.set({
      view: 'ready',
      assistants: 'on',
      agents: [],
      protons: 'ok',
      planConnect: 'connected',
      plan: 'off'
    })
    $workPlanConsent.set(state === 'consent-chats' ? {} : null)
  }, [state])

  if (state in PICKER_VIEWS) {
    return <RelayPicker state={state as keyof typeof PICKER_VIEWS} />
  }

  if (state === 'work-disclosure') {
    return (
      <WorkScreen
        agentName={principal => (principal === AGENT ? 'Rin' : undefined)}
        bridge={workBridge}
        obstructed={false}
        onAddProtons={() => {}}
        projection={{ view: 'ready', assistants: 'on', agents: [{ principal: AGENT, running: 1, stopping: false }], protons: 'ok' }}
        relayChats={[AGENT]}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[36rem] overflow-y-auto px-6 py-10">
      <MatrixWorkSettings
        agents={AGENTS}
        bridge={workBridge}
        planLimit={{ plan: 'codex', state: 'available', observedAt: Date.now(), usedPercent: 42, resetsAt: Date.now() + 3 * 3_600_000 }}
        relayChats={state === 'consent-chats'}
      />
    </div>
  )
}
