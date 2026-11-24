/** The environment endpoint, read through the already-paired owner's native Connect state. */
export async function readConnectMcpUrl(origin: string, owner: { fetch(input: string, init: RequestInit): Promise<Response> }): Promise<string> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)) {throw new Error('native_connect_unavailable')}
  const response = await owner.fetch(`${origin}/api/connect/link-state`, {
    credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000)
  })
  if (!response.ok) {throw new Error('native_connect_unavailable')}
  const state = await response.json() as { linked?: boolean; linkRevoked?: boolean; tunnelHostname?: string }
  if (!state.linked || state.linkRevoked || !state.tunnelHostname || !/^[a-z0-9.-]+$/iu.test(state.tunnelHostname)) {
    throw new Error('native_connect_unavailable')
  }
  // T3 Connect's managedEnvironmentMcpUrl seam: environment origin, never relay API origin.
  return new URL('/mcp', `https://${state.tunnelHostname}`).href
}
