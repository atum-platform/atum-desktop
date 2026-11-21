import { afterEach, describe, expect, it } from 'vitest'

import { pairOwnerView } from './pairing'
import { FakeHost, FakeView, removeAccount, tempAccount } from './test-support'

const roots: string[] = []

async function lab(mode: ConstructorParameters<typeof FakeView>[1] = 'ok') {
  const { account, home } = tempAccount()
  roots.push(account.root)
  const host = new FakeHost(home)
  const incarnation = await host.start({ continuation: false })
  const view = new FakeView(home, mode)

  return { home, host, incarnation, view, cli: home.cli(), grants: home.grants() }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeAccount(root)
  }
})

describe('owner view pairing', () => {
  it('delivers the grant once to the one view and observes the three facts', async () => {
    const { incarnation, view, cli, grants, home } = await lab()

    expect(await pairOwnerView({ incarnation, view, cli, grants })).toEqual({ state: 'paired' })

    expect(view.seen).toHaveLength(1)
    expect(view.currentUrl()).not.toContain('#')
    expect(view.historyCleared).toBe(true)
    expect(home.accepts(view.cookie)).toBe(true)
    // The grant is spent: the same URL cannot be delivered or replayed.
    expect(incarnation.takePairingUrl()).toBeUndefined()
    expect(home.acceptsGrant(/#token=(.+)$/u.exec(view.seen[0])![1])).toBe(false)
  })

  it('never delivers a URL that is not the exact loopback form on this incarnation port', async () => {
    const { incarnation, view, cli, grants, home } = await lab()
    const credential = home.createLink(true)

    const other = {
      ...incarnation,
      takePairingUrl: () => `http://127.0.0.1:1/pair#token=${credential}`
    }

    expect(await pairOwnerView({ incarnation: other, view, cli, grants })).toEqual({ state: 'failed', reason: 'grant_invalid' })
    expect(view.seen).toEqual([])
    expect(home.acceptsGrant(credential)).toBe(true)
  })

  it('reports an already-taken grant instead of pairing', async () => {
    const { incarnation, view, cli, grants } = await lab()
    incarnation.takePairingUrl()

    expect(await pairOwnerView({ incarnation, view, cli, grants })).toEqual({ state: 'failed', reason: 'grant_unavailable' })
  })

  it('on a timeout AFTER the browser session was minted, kills that session too and clears the partition', async () => {
    const { incarnation, view, cli, grants, home } = await lab('mint_then_hang')

    const outcome = await pairOwnerView({ incarnation, view, cli, grants, timeoutMs: 150, pollMs: 20 })

    expect(outcome).toEqual({ state: 'failed', reason: 'timeout' })
    expect(view.cookie).toBeDefined()
    expect(home.accepts(view.cookie)).toBe(false) // the minted cookie's row is revoked
    expect(view.closed).toBe(true)
    expect(view.partitionCleared).toBe(true)
    expect(home.sessionCount()).toBe(0)
  })

  it('revokes the unused grant, hidden startup grant included, when the view cannot load', async () => {
    const { incarnation, view, cli, grants, home } = await lab('dead_load')
    const credential = /#token=(.+)$/u.exec(incarnation.takePairingUrl() ?? '')?.[1] ?? ''
    expect(home.acceptsGrant(credential)).toBe(true)
    // Re-offer the same grant to pairOwnerView by handing it back once.
    let offered: string | undefined = `${incarnation.origin}/pair#token=${credential}`

    const again = { ...incarnation, takePairingUrl: () => { const url = offered; offered = undefined;

 return url } }

    expect(await pairOwnerView({ incarnation: again, view, cli, grants })).toEqual({ state: 'failed', reason: 'load_failed' })

    expect(home.acceptsGrant(credential)).toBe(false)
    expect(view.closed).toBe(true)
    expect(view.partitionCleared).toBe(true)
  })

  it('keeps the token out of every call except the one load', async () => {
    const { incarnation, view, cli, grants } = await lab()
    const calls: string[] = []

    const spy = (name: string, fn: (...args: never[]) => unknown) => (...args: never[]) => {
      calls.push(`${name}:${JSON.stringify(args)}`)

      return fn(...args)
    }

    const traced = {
      ...cli,
      revokePairing: spy('revokePairing', cli.revokePairing),
      revokeSession: spy('revokeSession', cli.revokeSession)
    } as typeof cli

    await pairOwnerView({ incarnation, view, cli: traced, grants })
    const token = /#token=(.+)$/u.exec(view.seen[0])![1]

    expect(calls.join('|')).not.toContain(token)
  })
})
