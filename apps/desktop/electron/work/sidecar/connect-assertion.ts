export async function fetchConnectAssertion(
  token: string,
  base: string,
  signal: AbortSignal,
  request: typeof fetch
): Promise<string> {
  const response = await request(new URL('/api/work/connect/assertion', base).href, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}` }
  })

  if (response.status === 401) {throw new Error('matrix_s1_authentication')}

  if (!response.ok) {throw new Error('work_connect_assertion_unavailable')}
  const body: unknown = await response.json()

  if (!body || typeof body !== 'object' || !('assertion' in body) || typeof body.assertion !== 'string' || !body.assertion) {
    throw new Error('work_connect_assertion_invalid')
  }

  return body.assertion
}
