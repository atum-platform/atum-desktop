/** Same native domain admission as host Stop/Desk; 401 asks s1Request to refresh once. */
export async function requestNativeT3(
  token: string, base: string, signal: AbortSignal, request: typeof fetch,
  agent: string, path: string, method: string, body?: unknown
): Promise<unknown> {
  const response = await request(new URL('/api/host/native-t3', base).href, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0' },
    body: JSON.stringify({ agent, path, method, body })
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 ? 'matrix_s1_authentication' : 'native_profile_unavailable')
  }

  return response.json()
}
