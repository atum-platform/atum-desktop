import { spawn } from 'node:child_process'

interface Scope { accountKey: string; generation: number }
interface CustodyResult { state: string; access_token?: string; refresh_token?: string }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Native lock + atomic auth writer; private pipe output is never logged. */
export function carryCustody(python: string, source: string, home: string,
  action: 'begin' | 'commit' | 'rollback'): Promise<CustodyResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-s', '-P', '-B', '-m', 'hermes_cli.chatgpt_carry'], {
      cwd: source, env: { ...process.env, HERMES_HOME: home, ATUM_ACCOUNT_AUTH_HOME: home, PYTHONPATH: source }, stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []; let size = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('carry_unavailable')) }, 30_000)
    child.stderr.resume()
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 32_768) { child.kill(); reject(new Error('carry_unavailable')) }
      else {chunks.push(Buffer.from(chunk))}
    })
    child.once('error', () => { clearTimeout(timer); reject(new Error('carry_unavailable')) })
    child.once('close', code => {
      clearTimeout(timer)
      try {
        if (code !== 0) {throw new Error()}
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CustodyResult)
      } catch { reject(new Error('carry_unavailable')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ home, action }))
  })
}

export class CarryRejected extends Error {}

/** One account-scoped flight. Server migration marker survives app reinstall and lost responses. */
export class ChatGptCarry {
  private running = false
  private completed = new Set<string>()
  private retryAt = 0
  constructor(private readonly options: {
    scope(): Scope | null
    home(): string | undefined
    call(body: Record<string, string>, signal: AbortSignal): Promise<string>
    custody(home: string, action: 'begin' | 'commit' | 'rollback'): Promise<CustodyResult>
    drain(): Promise<void>
    carried(): void
    restored(): void
    now?: () => number
  }) {}

  async sync(): Promise<void> {
    const scope = this.options.scope()
    const home = this.options.home()
    const now = (this.options.now ?? Date.now)()
    if (!scope || !home || this.running || this.completed.has(scope.accountKey) || now < this.retryAt) {return}
    const current = () => scope.accountKey === this.options.scope()?.accountKey &&
      scope.generation === this.options.scope()?.generation
    const restore = async () => {
      await this.options.custody(home, 'rollback')
      if (current()) {this.options.restored()}
    }
    this.running = true
    this.retryAt = now + 60_000
    try {
      let state = await this.options.call({}, AbortSignal.timeout(25_000))
      if (!current()) {return}
      if (state === 'pending') {
        const grant = await this.options.custody(home, 'begin')
        if (grant.state !== 'paused' || !grant.access_token || !grant.refresh_token) {return}
        // Retire every cached local consumer before the cloud can own the grant.
        try { await this.options.drain() }
        catch { await restore(); return }
        if (!current()) {return} // Paused, recoverable on this account's next activation.
        try {
          state = await this.options.call({ access_token: grant.access_token, refresh_token: grant.refresh_token }, AbortSignal.timeout(25_000))
          if (['busy', 'no_relay', 'not_imported'].includes(state)) {await restore()}
        } catch (error) {
          if (error instanceof CarryRejected) {await restore()}
          throw error // Lost response stays paused; never race a possibly committed import.
        }
      }
      if (['migrated', 'cloud_connection_exists'].includes(state)) {
        await this.options.custody(home, 'commit')
        await this.options.drain()
        if (current()) { this.options.carried(); this.completed.add(scope.accountKey) }
      }
    } catch { /* Fixed status only. No provider exception or credential is logged. */ }
    finally { this.running = false }
  }
}

export async function requestChatGptCarry(resource: string, accessToken: string,
  body: Record<string, string>, signal: AbortSignal): Promise<string> {
  const url = new URL('/api/connections/openai-codex/carry', resource)
  if (url.protocol !== 'https:') {throw new Error('carry_unavailable')}
  const response = await fetch(url, { method: 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0' }, body: JSON.stringify(body) })
  if (response.status === 401) { await response.body?.cancel(); throw new Error('matrix_s1_authentication') }
  if (!response.ok) {
    await response.body?.cancel()
    if ([400, 403, 413, 415].includes(response.status)) {throw new CarryRejected('carry_rejected')}
    throw new Error('carry_unavailable')
  }
  const value: unknown = await response.json()
  return record(value) && typeof value.state === 'string' ? value.state : 'unavailable'
}
