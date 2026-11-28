import { useEffect, useState } from 'react'

import { openAccountConnect } from '@/app/connections/store'
import type { WorkRelayPickerView } from '@/app/work/relay-view'
import { $work } from '@/app/work/store'
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
  'picker-macs',
  'chip-limit',
  'chip-fallback',
  'settings-usage',
  'consent-chats'
] as const
type GalleryState = (typeof PLAYGROUND_RELAY_GALLERY)[number]

const AGENT = '00000000-0000-4000-8000-00000000c0de'
const MAC = '00000000-0000-4000-8000-0000000000a1'
const MINI = '00000000-0000-4000-8000-0000000000a2'

const ROOM: MatrixRoom = { id: '!rin:atum.invalid', name: 'Rin', membership: 'join', encrypted: false, assistant: true }

const PICKER_VIEWS: Record<Extract<GalleryState, `picker-${string}` | `chip-${string}`>, WorkRelayPickerView> = {
  'picker-selectable': { plan: 'codex', rows: 'selectable' },
  'picker-connect': { plan: 'codex', rows: 'greyed', greyed: 'connect', fix: 'connect' },
  'picker-allow': { plan: 'codex', rows: 'greyed', greyed: 'allow', fix: 'allow' },
  'picker-google': { plan: 'codex', rows: 'greyed', greyed: 'google' },
  // Two of the owner's Macs serve the plan, one of them off; the plan keeps a thinking level.
  'picker-macs': { plan: 'codex', rows: 'selectable', currentModel: 'gpt-6.1-sol' },
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
    ],
    ...(state === 'picker-macs'
      ? {
          machines: [
            { id: MAC, name: 'MacBook Air', kind: 'laptop' as const, online: true },
            { id: MINI, name: 'Mac mini', kind: 'mac-mini' as const, online: false }
          ],
          efforts: ['low', 'medium', 'high'] as const,
          effort: 'high' as const
        }
      : {})
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
        workRelay={[relay]}
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
      protons: 'ok'
    })

    if (state === 'consent-chats') {
      openAccountConnect('codex', 'allow')
    }
  }, [state])

  if (state in PICKER_VIEWS) {
    return <RelayPicker state={state as keyof typeof PICKER_VIEWS} />
  }

  return (
    <div className="mx-auto w-full max-w-[36rem] overflow-y-auto px-6 py-10">
      <MatrixWorkSettings bridge={workBridge} />
    </div>
  )
}
