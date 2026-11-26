import { describe, expect, it } from 'vitest'

import { workPairingOrigin, workProvider } from './process'

describe('Work pairing handoff', () => {
  it('accepts the pinned loopback form and returns only the origin', () => {
    expect(workPairingOrigin('http://127.0.0.1:61275/pair#token=abc_DEF-xyz')).toBe('http://127.0.0.1:61275')
  })

  it.each([
    'http://127.0.0.1.evil.example:61275/pair#token=abc',
    'http://127.0.0.1:65536/pair#token=abc',
    'http://127.0.0.1:61275/pair?redirect=x#token=abc',
    'http://127.0.0.1:61275/pair#token=abc&other=true',
    'http://127.0.0.1:61275/pair#token=',
    'http://user@127.0.0.1:61275/pair#token=abc'
  ])('rejects a malformed grant URL (%s)', url => {
    expect(workPairingOrigin(url)).toBeUndefined()
  })
})

it('starts the owner provider with the managed gateway wait enabled', () => {
  const provider = workProvider('/python', '/account/work/owner')
  expect(provider.config.commandArgs.slice(-3)).toEqual(['-m', 'acp_adapter.managed', '--wait-for-gateway'])
})
