import { z } from 'zod'

import { isWorkLocalPlan, WORK_LOCAL_PLANS, type WorkLocalPlan, type WorkLocalPlanStates } from '../../../shared/work-local-plans'
import type { WorkIncarnation } from '../sidecar/process'

import { readWorkProviders, workOwnerSocketUrl, type OwnerFetch } from './provider-config'

const nativeStatus = z.object({
  instanceId: z.string(), driver: z.string(), enabled: z.boolean(), installed: z.boolean(),
  auth: z.object({ status: z.string() })
})

export function projectLocalPlanStates(providers: unknown): WorkLocalPlanStates {
  const states: WorkLocalPlanStates = {}

  for (const value of Array.isArray(providers) ? providers : []) {
    const parsed = nativeStatus.safeParse(value)

    if (!parsed.success) {continue}

    const { instanceId, driver, enabled, installed, auth } = parsed.data

    if (!isWorkLocalPlan(instanceId) || driver !== WORK_LOCAL_PLANS[instanceId].driver || !enabled) {continue}

    states[instanceId] = !installed ? 'not_installed' : auth.status === 'authenticated' ? 'ready' : 'signed_out'
  }

  return states
}

export async function readLocalPlanStates(
  running: WorkIncarnation | null | undefined,
  account: { key: string; generation: number },
  owner: OwnerFetch,
  current: () => WorkIncarnation | null | undefined
) {
  if (!running || running.accountKey !== account.key || running.generation !== account.generation) {return {}}

  const providers = await readWorkProviders(running.origin, owner)

  return current() === running ? projectLocalPlanStates(providers) : {}
}

interface AuthFrame {
  _tag: string
  requestId: string
  exit?: { _tag: string; value?: AuthState }
  values?: AuthState[]
}

interface AuthState {
  instanceId: string
  phase: string
  flowId?: string
}

/** Use the Work owner session for both the native sign-in request and its progress stream. */
export async function setupWorkLocalPlan(origin: string, owner: OwnerFetch, plan: WorkLocalPlan, signal: AbortSignal) {
  const url = await workOwnerSocketUrl(origin, owner, signal)

  if (!url || signal.aborted) {throw new Error('work_setup_unavailable')}

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url)
    let flowId: string | undefined
    let finished = false

    const send = (id: string, tag: string) => socket.send(JSON.stringify({
      _tag: 'Request', id, tag, payload: { instanceId: plan }, headers: []
    }))
    const finish = (ok = false) => {
      if (finished) {return}
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.close()
      if (ok) {resolve()} else {reject(new Error('work_setup_failed'))}
    }
    const abort = () => finish()
    const timer = setTimeout(abort, 310_000)

    signal.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => send('1', 'provider.auth.start'), { once: true })
    socket.addEventListener('message', event => {
      if (finished) {return}
      try {
        const frame = JSON.parse(event.data as string) as AuthFrame

        if (frame._tag === 'Exit' && frame.requestId === '1') {
          const state = frame.exit?.value

          if (frame.exit?._tag !== 'Success' || state?.instanceId !== plan || !state.flowId) {return finish()}
          flowId = state.flowId
          send('2', 'provider.auth.subscribe')
        } else if (frame._tag === 'Chunk' && frame.requestId === '2') {
          socket.send(JSON.stringify({ _tag: 'Ack', requestId: '2' }))

          for (const state of frame.values ?? []) {
            if (state.instanceId !== plan || state.flowId !== flowId) {continue}
            if (state.phase === 'succeeded') {return finish(true)}
            if (state.phase === 'cancelled' || state.phase === 'failed') {return finish()}
          }
        } else if (frame._tag === 'Exit' && frame.requestId === '2') {
          finish()
        }
      } catch {
        finish()
      }
    })
    socket.addEventListener('error', abort, { once: true })
    socket.addEventListener('close', abort, { once: true })
  })
}
