import { z } from 'zod'

import { isWorkLocalPlan, WORK_LOCAL_PLANS, type WorkLocalPlan, type WorkLocalPlanAuthAction, type WorkLocalPlanStates } from '../../../shared/work-local-plans'
import type { WorkIncarnation } from '../sidecar/process'

import { type OwnerFetch, readWorkProviders, workOwnerSocketUrl } from './provider-config'

const nativeStatus = z.object({
  instanceId: z.string(), driver: z.string(), enabled: z.boolean(), installed: z.boolean(),
  auth: z.object({ status: z.string(), type: z.string().optional() }),
  usageLimits: z.object({ windows: z.array(z.object({ id: z.string(), label: z.string() })) }).optional()
})

export function projectLocalPlanStates(providers: unknown): WorkLocalPlanStates {
  const states: WorkLocalPlanStates = {}

  for (const value of Array.isArray(providers) ? providers : []) {
    const parsed = nativeStatus.safeParse(value)

    if (!parsed.success) {continue}

    const { instanceId, driver, enabled, installed, auth, usageLimits } = parsed.data

    if (!isWorkLocalPlan(instanceId) || driver !== WORK_LOCAL_PLANS[instanceId].driver || !enabled) {continue}

    const state = !installed ? 'not_installed' : auth.status === 'authenticated' && auth.type !== 'api_key' ? 'ready' : 'signed_out'
    const allowance = instanceId === 'openrouter-free'
      ? usageLimits?.windows.find(window => window.id === 'openrouter-free-daily')?.label
      : undefined

    states[instanceId] = { state, ...(allowance && /^\d+ free requests left today$/u.test(allowance) ? { allowance } : {}) }
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
  message?: unknown
}

/** Use the Work owner session for both the native sign-in request and its progress stream. */
export async function setupWorkLocalPlan(origin: string, owner: OwnerFetch, plan: WorkLocalPlan, action: WorkLocalPlanAuthAction, signal: AbortSignal) {
  const url = await workOwnerSocketUrl(origin, owner, signal)

  if (!url || signal.aborted) {throw new Error('work_setup_unavailable')}

  return new Promise<string | void>((resolve, reject) => {
    const socket = new WebSocket(url)
    let flowId: string | undefined
    let finished = false

    const methodId = action === 'setup-google' ? 'google' : action === 'setup-github' ? 'github' : undefined
    const send = (id: string, tag: string, method?: string) => socket.send(JSON.stringify({
      _tag: 'Request', id, tag, payload: { instanceId: plan, ...(method ? { methodId: method } : {}) }, headers: []
    }))
    const finish = (ok = false, detail?: unknown) => {
      if (finished) {return}
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.close()
      if (ok) {resolve()}
      else if (typeof detail === 'string' && detail.trim() && detail.length <= 500) {resolve(detail)}
      else {reject(new Error('work_setup_failed'))}
    }
    const abort = () => finish()
    const timer = setTimeout(abort, 310_000)

    signal.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => send('1', action === 'logout' ? 'provider.auth.logout' : 'provider.auth.start', methodId), { once: true })
    socket.addEventListener('message', event => {
      if (finished) {return}
      try {
        const frame = JSON.parse(event.data as string) as AuthFrame

        if (frame._tag === 'Exit' && frame.requestId === '1') {
          const state = frame.exit?.value

          if (frame.exit?._tag !== 'Success' || state?.instanceId !== plan) {return finish()}
          if (action === 'logout') {return finish(true)}
          if (state.phase === 'failed') {return finish(false, state.message)}
          if (!state.flowId) {return finish()}
          flowId = state.flowId
          send('2', 'provider.auth.subscribe')
        } else if (frame._tag === 'Chunk' && frame.requestId === '2') {
          socket.send(JSON.stringify({ _tag: 'Ack', requestId: '2' }))

          for (const state of frame.values ?? []) {
            if (state.instanceId !== plan || state.flowId !== flowId) {continue}
            if (state.phase === 'succeeded') {return finish(true)}
            if (state.phase === 'failed') {return finish(false, state.message)}
            if (state.phase === 'cancelled') {return finish()}
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
