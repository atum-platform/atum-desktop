import { setTimeout as delay } from 'node:timers/promises'
import type { Session } from 'electron'
import type { NativeConnector } from './native'

/** Finish the owner's tap using T3's own browser-session CSRF approval, never a provider credential. */
export async function approveNativeAgent(input: {
  connector: NativeConnector
  owner: Pick<Session, 'fetch' | 'cookies'>
  origin: string
  agent: string
  request: { mac: string; plan: string; alsoWhenScheduled: boolean; connectUrl: string }
  current(): boolean
}): Promise<void> {
  const live = () => { if (!input.current()) {throw new Error('native_account_changed')} }
  const body = { agent: input.agent, ...input.request }
  let flow = await input.connector.handle('/native-consent', 'POST', body) as Record<string, unknown>
  live()
  await input.connector.consent()
  if (typeof flow.threadId === 'string') {return}
  if (!flow.auth_url || typeof flow.session_id !== 'string') {throw new Error('native_invalid_flow')}
  const sessionId = flow.session_id
  const auth = new URL(String(flow.auth_url))
  const connect = new URL(input.request.connectUrl)
  if (auth.origin !== connect.origin || auth.pathname !== '/oauth/mcp/authorize') {throw new Error('native_invalid_authorization')}
  const authorization = Object.fromEntries(auth.searchParams)
  // The owner cookie belongs to THIS Work incarnation. Its only destination is
  // this same environment through its authenticated Connect endpoint.
  const cookies = await input.owner.cookies.get({ url: input.origin })
  live()
  const headers = { 'content-type': 'application/json', cookie: cookies.map(row => `${row.name}=${row.value}`).join('; ') }
  const post = async (path: string, payload: unknown) => {
    live()
    const response = await input.owner.fetch(new URL(path, connect).href, {
      method: 'POST', redirect: 'error', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
    })
    live()
    if (!response.ok) {throw new Error('native_oauth_refused')}
    return response.json() as Promise<Record<string, unknown>>
  }
  const approval = await post('/oauth/mcp/approval', authorization)
  if (typeof approval.csrfToken !== 'string' || !Array.isArray(approval.oneClickAccess) || !approval.oneClickAccess.includes('full-access')) {
    throw new Error('native_owner_session_unavailable')
  }
  const decision = await post('/oauth/mcp/decision', { authorization,
    decision: { _tag: 'browser-session', access: 'full-access', csrfToken: approval.csrfToken } })
  const callback = new URL(String(decision.redirectTo))
  if (callback.origin + callback.pathname !== new URL(authorization.redirect_uri!).origin + new URL(authorization.redirect_uri!).pathname) {
    throw new Error('native_invalid_callback')
  }
  live()
  await input.connector.handle('/native-consent?phase=callback', 'POST', {
    agent: input.agent, mac: input.request.mac, session_id: sessionId,
    code: callback.searchParams.get('code'), state: callback.searchParams.get('state'), iss: callback.searchParams.get('iss')
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    live()
    flow = await input.connector.handle('/native-consent', 'POST', { ...body, oauthSessionId: sessionId }) as Record<string, unknown>
    if (flow.threadId) {await input.connector.consent(); return}
    if (flow.status !== 'pending') {throw new Error('native_bootstrap_failed')}
    await delay(250)
  }
  throw new Error('native_bootstrap_timed_out')
}
