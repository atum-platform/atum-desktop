import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { workDelegatedEnvironment, workPairingOrigin, workProvider, workRuntimeEnvironment } from './process'

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

it('isolates delegated gateway and connector HOME while owner providers inherit the real HOME', () => {
  const owner = workRuntimeEnvironment('/account/work', '/resources')
  const delegated = { ...owner, ...workDelegatedEnvironment('/account/work/delegated') }
  expect(owner.HOME).toBe(homedir())
  expect(delegated.HOME).not.toBe(homedir())
  expect(delegated.CODEX_HOME).toBe('/account/work/delegated/.codex')
  const connector = workProvider('/python', '/account/work/delegated', 'Delegated', false, true)
  expect(connector.environment).toContainEqual({ name: 'HOME', value: delegated.HOME, sensitive: false })
  expect(workProvider('/python', '/owner', 'Owner', true).environment.some(entry => entry.name === 'HOME')).toBe(false)
})
