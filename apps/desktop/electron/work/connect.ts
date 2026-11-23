export interface AtumConnectConfig {
  enabled?: boolean
  relayUrl?: string
  platformUrl?: string
}

/** Supplies the assertion as native ManagedRelay method inputs named clerkToken; never a relay bearer cache. */
export function atumConnectAdapter(config: AtumConnectConfig, deps: {
  owner(): string | undefined
  bearer(): Promise<string>
  fetch: typeof fetch
}) {
  if (config.enabled !== true) return undefined
  const relay = new URL(config.relayUrl ?? '')
  const platform = new URL(config.platformUrl ?? '')
  for (const url of [relay, platform]) {
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('work_connect_config_invalid')
  }
  return {
    relayUrl: relay.origin,
    requireNewDeviceApproval: true,
    async getAssertion(): Promise<string> {
      const owner = deps.owner()
      if (!owner) throw Error('work_connect_signed_out')
      const bearer = await deps.bearer()
      if (deps.owner() !== owner) throw Error('work_connect_account_changed')
      const response = await deps.fetch(`${platform.origin}/api/work/connect/assertion`, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${bearer}` },
      })
      if (!response.ok) throw Error('work_connect_assertion_unavailable')
      const value: unknown = await response.json()
      if (deps.owner() !== owner) throw Error('work_connect_account_changed')
      if (!value || typeof value !== 'object' || !('assertion' in value) || typeof value.assertion !== 'string'
        || value.assertion.length > 16384 || value.assertion.split('.').length !== 3
        || !('expires_in' in value) || value.expires_in !== 60) throw Error('work_connect_assertion_invalid')
      return value.assertion
    },
  }
}
