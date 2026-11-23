import { describe, expect, it } from 'vitest'

import { createT3Client } from './t3-client'

// Gate 4a: the plan's status is T3's own, from `orchestrator_capabilities`. The shapes below are what the pinned t3 v0.1.11 answers
// (recorded from a real server: a Codex that is not signed in lists no models and says why).

const capabilities = (providers: unknown[]) => ({ result: { structuredContent: { providers } } })

function client(providers: unknown[], plan: { instanceId: string } | null = { instanceId: 'codex' }) {
  return createT3Client({
    origin: () => 'http://127.0.0.1:1',
    incarnation: () => 'i',
    settingsFile: '/nonexistent',
    delegated: { instanceId: 'a', model: 'b' },
    plan: plan ?? undefined,
    fetch: (async () => new Response(JSON.stringify(capabilities(providers)), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } })) as unknown as typeof fetch
  })
}

const SIGNED_OUT = { providerInstanceId: 'codex', driverKind: 'codex', displayName: 'Codex', models: [], constraints: ['Codex CLI is not authenticated. Run `codex login` and try again.', 'Provider is not authenticated.'] }
const DISABLED = { providerInstanceId: 'codex', driverKind: 'codex', displayName: 'Codex', models: [], constraints: ['Provider instance is disabled.'] }
const READY = { providerInstanceId: 'codex', driverKind: 'codex', displayName: 'Codex', models: [{ id: 'gpt-x', label: 'X' }, { id: 'gpt-y' }], constraints: [] }

describe('T3\'s own provider status for the plan', () => {
  it('connected only when T3 lists a model and no constraint says it is not ready; the model is the first T3 lists', async () => {
    expect(await client([READY]).planProvider?.('t')).toEqual({ status: 'connected', selection: { instanceId: 'codex', model: 'gpt-x' }, models: ['gpt-x', 'gpt-y'] })
  })

  it.each([
    ['not signed in (the real pin\'s answer for a fresh home)', [SIGNED_OUT]],
    ['the instance disabled (how the sidecar ships it until the Connect step)', [DISABLED]],
    ['models listed but a constraint says it is not authenticated', [{ ...READY, constraints: ['Provider is not authenticated.'] }]],
    ['no such instance', [{ ...READY, providerInstanceId: 'other' }]],
    ['no providers at all', []]
  ])('disconnected: %s', async (_name, providers) => {
    expect(await client(providers).planProvider?.('t')).toEqual({ status: 'disconnected' })
  })

  it('unknown when T3 could not be asked (a transport failure, an error result, a body that is not the list)', async () => {
    const failing = createT3Client({
      origin: () => 'http://127.0.0.1:1',
      incarnation: () => 'i',
      settingsFile: '/nonexistent',
      delegated: { instanceId: 'a', model: 'b' },
      plan: { instanceId: 'codex' },
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
    })

    expect(await failing.planProvider?.('t')).toEqual({ status: 'unknown' })
    expect(await client('nope' as unknown as unknown[]).planProvider?.('t')).toEqual({ status: 'unknown' })
  })

  it('a client built with no plan instance has no way to read, set or report a plan', () => {
    expect(client([READY], null).planProvider).toBeUndefined()
  })
})

describe('the thread read names the provider the thread runs on now', () => {
  it('from `thread.providerInstanceId`, and not at all when T3 does not say', async () => {
    const read = (thread: Record<string, unknown>) =>
      createT3Client({
        origin: () => 'http://127.0.0.1:1',
        incarnation: () => 'i',
        settingsFile: '/nonexistent',
        delegated: { instanceId: 'a', model: 'b' },
        fetch: (async () => new Response(JSON.stringify({ result: { structuredContent: { thread, recentRuns: [] } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } })) as unknown as typeof fetch
      }).read('t', 'th')

    expect(await read({ status: 'idle', providerInstanceId: 'codex' })).toMatchObject({ kind: 'found', provider: 'codex' })
    expect(await read({ status: 'idle' })).not.toHaveProperty('provider')
  })
})
