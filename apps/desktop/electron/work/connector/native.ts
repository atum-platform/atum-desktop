import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type NativePath = '/tools' | '/native-register' | '/native-consent' | '/native-consent?phase=prepare' | '/native-consent?phase=callback'
export interface NativeGrant {
  clientId: string
  binding: { owner: string; agent: string; generation: string; mac: string; consent_revision: number }
  enabled: boolean
  expiresAt: number
  sessionExpiresAt?: number
  [key: string]: unknown
}
export interface NativeConnectorPorts {
  current(): boolean
  enabled?(): boolean
  agents(): Promise<string[]>
  /** Main's authenticated account transport resolves the agent's private S2 profile. */
  request(agent: string, path: NativePath, method: 'GET' | 'POST', body?: unknown): Promise<unknown>
}

/** One account and one Mac. No caller-supplied URL or cloud credential reaches the provider. */
export class NativeConnector {
  private grants = new Map<string, NativeGrant>()
  readonly forwardFile: string
  readonly bindingsFile: string
  constructor(private readonly root: string, readonly mac: string, private readonly ports: NativeConnectorPorts) {
    this.forwardFile = join(root, 'native-forward.json')
    this.bindingsFile = join(root, 'native-bindings.json')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    try {
      const rows = JSON.parse(readFileSync(this.forwardFile, 'utf8')) as NativeGrant[]
      this.grants = new Map(rows.filter(row => row.binding?.mac === mac).map(row => [row.clientId, { ...row, enabled: false }]))
    } catch { /* A first account start has no snapshot. */ }
    this.save(this.forwardFile, [...this.grants.values()])
    this.save(this.bindingsFile, [])
  }
  private save(file: string, rows: unknown): void {
    const bytes = JSON.stringify(rows)
    try { if (readFileSync(file, 'utf8') === bytes) {return} } catch { /* First write. */ }
    writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  private live(): void {
    if (!this.ports.current()) {throw new Error('native_account_changed')}
  }
  async consent(): Promise<{ grants: NativeGrant[] }> {
    this.live()
    const agents = await this.ports.agents()
    // Preserve disabled membership so a revoked Atum client can never become an ordinary client.
    const next = new Map([...this.grants].map(([id, grant]) => [id, { ...grant, enabled: false }]))
    await Promise.all(agents.map(async agent => {
      try {
        const value = await this.ports.request(agent, '/native-consent', 'GET') as { grants: NativeGrant[] }
        if (!Array.isArray(value.grants)) {throw new Error('native_invalid_grants')}
        for (const grant of value.grants) {
          if (grant.binding?.agent === agent && grant.binding.mac === this.mac && typeof grant.clientId === 'string') {
            next.set(grant.clientId, { ...grant, enabled: grant.enabled && (this.ports.enabled?.() ?? true) })
          }
        }
      } catch { /* This profile is unavailable; other agents retain their own route. */ }
    }))
    this.live()
    this.grants = next
    const grants = [...next.values()]
    this.save(this.forwardFile, grants)
    return { grants }
  }
  async handle(path: NativePath, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    this.live()
    if (path === '/native-consent' && method === 'GET') {return this.consent()}
    if (path !== '/native-consent' && !path.startsWith('/native-consent?') && this.ports.enabled?.() === false) {
      throw new Error('native_mac_disabled')
    }
    if (method !== 'POST' || !body || typeof body !== 'object') {throw new Error('native_invalid_request')}
    const input = body as { binding?: { agent?: string; mac?: string }; agent?: string }
    const agent = input.binding?.agent ?? input.agent
    const agents = await this.ports.agents()
    if (!agent || !agents.includes(agent) || (input.binding && input.binding.mac !== this.mac)) {
      throw new Error('native_foreign_binding')
    }
    const result = await this.ports.request(agent, path, method, body)
    this.live()
    return result
  }
  environment(endpoint: string): Record<string, string> {
    return { ATUM_WORK_MAC_ID: this.mac, ATUM_WORK_FORWARD_GRANTS_FILE: this.forwardFile,
      ATUM_WORK_BINDINGS_FILE: this.bindingsFile, ATUM_WORK_TOOLS_CONNECTOR_URL: endpoint }
  }
  revoke(): void {
    this.grants = new Map([...this.grants].map(([id, row]) => [id, { ...row, enabled: false }]))
    this.save(this.forwardFile, [...this.grants.values()])
    this.save(this.bindingsFile, [])
  }
  renewal(now = Date.now()): 'needed' | 'soon' | 'current' {
    if (this.ports.enabled?.() === false) {return 'current'}
    const rows = [...this.grants.values()].filter(row => row.enabled)
    if (!rows.length || rows.some(row => (row.sessionExpiresAt ?? row.expiresAt) <= now)) {return 'needed'}
    return rows.some(row => (row.sessionExpiresAt ?? row.expiresAt) - now <= 3 * 86400_000) ? 'soon' : 'current'
  }
}
