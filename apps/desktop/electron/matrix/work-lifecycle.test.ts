import { describe, expect, it } from 'vitest'

import type { WorkSurfaceParts } from '../work/surface'

import { MatrixWorkLifecycle, type MatrixWorkLifecyclePorts, type WorkAccount, workAccountFor } from './work-lifecycle'

const LUNA: WorkAccount = { key: 'k1', generation: 1, root: '/w/k1', accountId: '67000000-0000-4000-8000-0000000000a1' }

function lab(initial: WorkAccount | null = LUNA) {
  const events: string[] = []
  const state = { account: initial ?? undefined as WorkAccount | undefined, prepareFails: false }

  const parts = (account: WorkAccount) => ({ account } as unknown as WorkSurfaceParts)

  const ports: MatrixWorkLifecyclePorts = {
    account: () => state.account,
    prepare: async () => {
      events.push('prepare')

      if (state.prepareFails) {
        throw new Error('services_down')
      }
    },
    retire: async account => void events.push(`retire:${account.key}.${account.generation}`),
    quit: async () => void events.push('quit'),
    attach: value => void events.push(value ? `attach:${(value as unknown as { account: WorkAccount }).account.key}` : 'detach'),
    parts,
    log: line => void events.push(`log:${line}`)
  }

  return { lifecycle: new MatrixWorkLifecycle(ports), events, state }
}

describe('workAccountFor', () => {
  const base = { scope: { accountKey: 'abc', generation: 3 }, ownerPrincipal: 'p', deviceServiceId: 'd', rootFor: (key: string) => `/root/${key}` }

  it('names the account for Work only when the Matrix account, its owner principal and this Mac\'s enrollment all exist', () => {
    expect(workAccountFor(base)).toEqual({ key: 'abc', generation: 3, root: '/root/abc', accountId: 'p' })
    expect(workAccountFor({ ...base, scope: null })).toBeUndefined()
    expect(workAccountFor({ ...base, ownerPrincipal: undefined })).toBeUndefined()
    expect(workAccountFor({ ...base, deviceServiceId: undefined })).toBeUndefined()
  })
})

describe('MatrixWorkLifecycle', () => {
  it('builds Work once per account: services, then the page’s parts', async () => {
    const { events, lifecycle } = lab()

    await lifecycle.activate()
    await lifecycle.activate()
    await lifecycle.activate()

    expect(events).toEqual(['prepare', 'attach:k1'])
    expect(lifecycle.boundAccount()).toEqual(LUNA)
  })

  it('draws nothing before there is an enrolled account, and starts once there is', async () => {
    const { events, lifecycle, state } = lab(null)

    await lifecycle.activate()
    expect(events).toEqual([])

    state.account = LUNA
    await lifecycle.activate()
    expect(events).toEqual(['prepare', 'attach:k1'])
  })

  it('an account change retires the old one (page detached first) before the new one is built', async () => {
    const { events, lifecycle, state } = lab()
    await lifecycle.activate()
    events.length = 0

    state.account = { ...LUNA, key: 'k2', root: '/w/k2' }
    await lifecycle.activate()

    expect(events).toEqual(['detach', 'retire:k1.1', 'prepare', 'attach:k2'])
  })

  it('a new generation of the same account is a different Work: the old server stops first', async () => {
    const { events, lifecycle, state } = lab()
    await lifecycle.activate()
    events.length = 0

    state.account = { ...LUNA, generation: 2 }
    await lifecycle.activate()

    expect(events.slice(0, 2)).toEqual(['detach', 'retire:k1.1'])
    expect(events.at(-1)).toBe('attach:k1')
  })

  it('sign-out: the page detaches before the mount retires, and a second retire does nothing', async () => {
    const { events, lifecycle, state } = lab()
    await lifecycle.activate()
    events.length = 0

    state.account = undefined
    const first = await lifecycle.retire()
    const second = await lifecycle.retire()

    expect(events).toEqual(['detach', 'retire:k1.1'])
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(lifecycle.boundAccount()).toBeUndefined()
  })

  it('a sign-out that arrives while the account is still being bound waits for the bind and binds nothing', async () => {
    const { events, lifecycle, state } = lab()
    const ports = (lifecycle as unknown as { ports: MatrixWorkLifecyclePorts }).ports
    const prepare = ports.prepare
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    ports.prepare = async () => {
      await prepare()
      await gate
    }

    const binding = lifecycle.activate()
    await Promise.resolve()
    await Promise.resolve()
    const ending = lifecycle.retire()
    state.account = undefined
    release()
    await Promise.all([binding, ending])

    // the account signed out while services started: it is never bound, so there is nothing to retire
    expect(events).toEqual(['prepare'])
    expect(lifecycle.boundAccount()).toBeUndefined()
  })

  it('a start the services refuse leaves nothing attached, and the next activation tries again', async () => {
    const { events, lifecycle, state } = lab()

    state.prepareFails = true
    await lifecycle.activate()
    expect(events).toEqual(['prepare', 'log:[atum-work] bind_failed services_down'])
    expect(lifecycle.boundAccount()).toBeUndefined()

    state.prepareFails = false
    events.length = 0
    await lifecycle.activate()
    expect(events).toEqual(['prepare', 'attach:k1'])
  })

  it('an account that signed out while services started is never bound', async () => {
    const { events, lifecycle, state } = lab()
    state.prepareFails = false

    const ports = (lifecycle as unknown as { ports: MatrixWorkLifecyclePorts }).ports
    const prepare = ports.prepare
    ports.prepare = async () => {
      await prepare()
      state.account = undefined
    }

    await lifecycle.activate()
    expect(events).toEqual(['prepare'])
    expect(lifecycle.boundAccount()).toBeUndefined()
  })

  it('quit is not a revocation: detach and close, with no retire, and nothing binds afterwards', async () => {
    const { events, lifecycle } = lab()
    await lifecycle.activate()
    events.length = 0

    await lifecycle.quit()
    await lifecycle.activate()

    expect(events).toEqual(['detach', 'quit'])
  })
})
