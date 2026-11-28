import { ATUM_WORK_MODEL, ATUM_WORK_PROVIDER } from '../sidecar/process'

import { pickWorkSubscription } from './plan-capabilities'
import { type OwnerFetch, workOwnerSocketUrl } from './provider-config'

const atum = { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL }
type Selection = typeof atum

function sameModel(value: unknown, expected: Selection): boolean {
  return !!value && typeof value === 'object' && 'instanceId' in value && 'model' in value &&
    value.instanceId === expected.instanceId && value.model === expected.model &&
    (!('options' in value) || (Array.isArray(value.options) && value.options.length === 0))
}

interface Config {
  providers?: unknown
  settings?: { defaultModelSelection?: unknown }
}

interface ConfigEvent {
  type: string
  config?: Config
  payload?: Config
}

interface RpcFrame {
  _tag: string
  requestId?: string
  values?: ConfigEvent[]
  exit?: { _tag: string; value?: Config['settings'] }
}

/** Follow the paired owner's native provider catalog. Write only the environment default through T3's settings RPC. */
export async function watchWorkModelDefault(origin: string, owner: OwnerFetch, signal: AbortSignal, current: () => boolean): Promise<void> {
  try {
    const url = await workOwnerSocketUrl(origin, owner, signal)

    if (!url || signal.aborted || !current()) {return}

    await new Promise<void>(resolve => {
      const socket = new WebSocket(url)
      // Slow provider probes continue in the background once the owner view is ready.
      const timer = setTimeout(resolve, 2_000)
      let automatic: Selection = atum
      let saved: unknown
      let providers: unknown
      let requestId = 1
      let writing: { id: string; selection: Selection } | undefined

      const ready = () => {
        clearTimeout(timer)
        resolve()
      }

      const close = () => {
        signal.removeEventListener('abort', close)
        ready()
        socket.close()
      }

      const request = (id: string, tag: string, payload: object) => {
        socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }))
      }

      const reconcile = () => {
        if (writing || !Array.isArray(providers)) {return}
        const next = pickWorkSubscription(providers) ?? atum

        if (!sameModel(saved, automatic) || sameModel(saved, next)) {
          ready()

          return
        }

        writing = { id: String(++requestId), selection: next }
        request(writing.id, 'server.updateSettings', { patch: { defaultModelSelection: next } })
      }

      signal.addEventListener('abort', close, { once: true })
      socket.addEventListener('open', () => {
        request('1', 'subscribeServerConfig', { workspaceSnapshotsOnDemand: true, providerCatalogsOnDemand: true })
      }, { once: true })
      socket.addEventListener('message', event => {
        if (!current() || typeof event.data !== 'string' || event.data.length > 4_000_000) {return close()}

        try {
          const frame = JSON.parse(event.data) as RpcFrame

          if (frame._tag === 'Chunk' && frame.requestId === '1') {
            for (const update of frame.values ?? []) {
              if (update.type === 'snapshot') {
                saved = update.config?.settings?.defaultModelSelection
                providers = update.config?.providers
              } else if (update.type === 'providerStatuses') {
                providers = update.payload?.providers
              } else if (update.type === 'settingsUpdated') {
                saved = update.payload?.settings?.defaultModelSelection
              }
            }

            socket.send(JSON.stringify({ _tag: 'Ack', requestId: '1' }))
            reconcile()
          } else if (frame._tag === 'Exit' && writing && frame.requestId === writing.id) {
            if (frame.exit?._tag !== 'Success' || !sameModel(frame.exit.value?.defaultModelSelection, writing.selection)) {return close()}

            // Keep a concurrent user's selection if the stream already delivered it.
            if (sameModel(saved, automatic)) {saved = writing.selection}
            automatic = writing.selection
            writing = undefined
            reconcile()
          } else if (frame._tag === 'Exit' && frame.requestId === '1') {
            close()
          }
        } catch {
          close()
        }
      })
      socket.addEventListener('error', close, { once: true })
      socket.addEventListener('close', () => {
        signal.removeEventListener('abort', close)
        ready()
      }, { once: true })
    })
  } catch {
    // The bootstrapped Atum default remains available if the local RPC is unavailable.
  }
}
