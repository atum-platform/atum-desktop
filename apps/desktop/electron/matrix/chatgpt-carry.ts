import { readFileSync } from 'node:fs'
import path from 'node:path'

interface Scope { accountKey: string; generation: number }
interface Tokens { access_token: string; refresh_token: string }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Main-process only. Called after the server confirms this account still needs migration. */
export function readCarryTokens(home: string): Tokens | undefined {
  try {
    const store: unknown = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))
    if (!record(store)) return
    const pool = record(store.credential_pool) ? store.credential_pool['openai-codex'] : undefined
    const rows = Array.isArray(pool) ? pool.filter(record) : []
    const providers = record(store.providers) ? store.providers : {}
    const provider = providers['openai-codex']
    const singleton = record(provider) && record(provider.tokens) ? provider.tokens : undefined
    const pair = [...rows.filter(row => row.last_status !== 'dead'), singleton].find(row => row &&
      typeof row.access_token === 'string' && row.access_token && typeof row.refresh_token === 'string' && row.refresh_token)
    if (pair) return { access_token: String(pair.access_token), refresh_token: String(pair.refresh_token) }
  } catch { /* Missing or locked account store retries on a later ready publication. */ }
}

/** One account-scoped flight. Server migration marker survives app reinstall and lost responses. */
export class ChatGptCarry {
  private running = false
  private completed = new Set<string>()
  private retryAt = 0
  constructor(private readonly options: {
    scope(): Scope | null
    home(): string | undefined
    call(body: Record<string, string>, signal: AbortSignal): Promise<string>
    read?: typeof readCarryTokens
    now?: () => number
  }) {}

  async sync(): Promise<void> {
    const scope = this.options.scope()
    const home = this.options.home()
    const now = (this.options.now ?? Date.now)()
    if (!scope || !home || this.running || this.completed.has(scope.accountKey) || now < this.retryAt) return
    const current = () => scope.accountKey === this.options.scope()?.accountKey &&
      scope.generation === this.options.scope()?.generation
    this.running = true
    this.retryAt = now + 60_000
    try {
      let state = await this.options.call({}, AbortSignal.timeout(25_000))
      if (!current()) return
      if (state === 'pending') {
        const tokens = (this.options.read ?? readCarryTokens)(home)
        if (!tokens || !current()) return
        state = await this.options.call({ ...tokens }, AbortSignal.timeout(25_000))
      }
      if (current() && ['migrated', 'cloud_connection_exists'].includes(state)) this.completed.add(scope.accountKey)
    } catch { /* Fixed status only. No provider exception or credential is logged. */ }
    finally { this.running = false }
  }
}

export async function requestChatGptCarry(resource: string, accessToken: string,
  body: Record<string, string>, signal: AbortSignal): Promise<string> {
  const url = new URL('/api/connections/openai-codex/carry', resource)
  if (url.protocol !== 'https:') throw new Error('carry_unavailable')
  const response = await fetch(url, { method: 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0' }, body: JSON.stringify(body) })
  if (response.status === 401) { await response.body?.cancel(); throw new Error('matrix_s1_authentication') }
  if (!response.ok) { await response.body?.cancel(); throw new Error('carry_unavailable') }
  const value: unknown = await response.json()
  return record(value) && typeof value.state === 'string' ? value.state : 'unavailable'
}
