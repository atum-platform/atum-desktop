import { describe, expect, it } from 'vitest'

import { workPairingOrigin, workProvider, workThreadMcpEnvironment } from './process'

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

describe('Work thread MCP environment', () => {
  const first = 'https://modeb-fixture.atumplatform.com'
  const second = 'https://modeb-fixture-two.atumplatform.com'

  it('joins the exact approved origins and drops invalid entries', () => {
    expect(workThreadMcpEnvironment([
      first,
      'not a URL',
      'http://modeb-fixture.atumplatform.com',
      'https://atumplatform.com',
      'https://notatumplatform.com',
      'https://modeb-fixture.atumplatform.com.example',
      'https://.atumplatform.com',
      `https://user@${new URL(first).hostname}`,
      `${first}:443`,
      `${first}:8443`,
      `${first}/`,
      `${first}/a/fixture/mcp`,
      `${first}?`,
      `${first}#`,
      second
    ])).toEqual({ T3CODE_THREAD_MCP_ORIGIN: `${first},${second}` })
  })

  it('omits the variable when there are no valid origins', () => {
    expect(workThreadMcpEnvironment([])).not.toHaveProperty('T3CODE_THREAD_MCP_ORIGIN')
    expect(workThreadMcpEnvironment(['https://example.org'])).not.toHaveProperty('T3CODE_THREAD_MCP_ORIGIN')
  })
})


it('starts the owner provider with the managed gateway wait enabled', () => {
  const provider = workProvider('/python', '/account/work/owner')
  expect(provider.config.commandArgs.slice(-3)).toEqual(['-m', 'acp_adapter.managed', '--wait-for-gateway'])
})
