import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_CONNECTIONS_FIXTURE,
  ACCOUNT_CONNECTIONS_PROFILE,
  localAccountConnections,
  parseAccountConnections,
  parseAccountConnectionsView
} from './account-connections'

const registry = { profile: ACCOUNT_CONNECTIONS_PROFILE, connections: ACCOUNT_CONNECTIONS_FIXTURE.connections }

describe('atum.account-connections/1 as the desktop reads it', () => {
  it('accepts the contract and refuses a row whose id is not its provider', () => {
    expect(parseAccountConnections(registry)?.connections).toHaveLength(ACCOUNT_CONNECTIONS_FIXTURE.connections.length)

    const [first, ...rest] = ACCOUNT_CONNECTIONS_FIXTURE.connections
    expect(parseAccountConnections({ ...registry, connections: [{ ...first, provider: 'claude' }, ...rest] })).toBeNull()
  })

  it('never carries an e-mail or an unknown field', () => {
    const codex = ACCOUNT_CONNECTIONS_FIXTURE.connections[0]!

    if (codex.kind !== 'plan') {
      throw new Error('fixture')
    }

    const withEmail = { ...codex, devices: [{ ...codex.devices[0]!, displayName: 'support@example.com' }] }
    expect(parseAccountConnections({ ...registry, connections: [withEmail] })).toBeNull()
    expect(parseAccountConnections({ ...registry, connections: [{ ...codex, token: 'x' }] })).toBeNull()
  })

  it('checks main’s answer: the source and this Mac’s id must be what they say', () => {
    expect(parseAccountConnectionsView(ACCOUNT_CONNECTIONS_FIXTURE)).toEqual(ACCOUNT_CONNECTIONS_FIXTURE)
    expect(parseAccountConnectionsView({ ...ACCOUNT_CONNECTIONS_FIXTURE, source: 'cloud' })).toBeNull()
    expect(parseAccountConnectionsView({ ...ACCOUNT_CONNECTIONS_FIXTURE, thisDevice: 'mac' })).toBeNull()
  })

  it('answers from this Mac alone as a valid registry, inventing nothing about the cloud', () => {
    const local = localAccountConnections({
      capabilities: { claude: { state: 'connected', models: [{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }] }, codex: { state: 'disconnected' } },
      thisDevice: '11111111-1111-4111-8111-11111111abcd',
      deviceName: 'Mac',
      now: 5
    })

    expect(parseAccountConnectionsView(local)).toEqual(local)
    expect(local.source).toBe('this_mac')
    expect(local.connections.map(row => [row.id, row.status])).toEqual([
      ['codex', 'not_connected'],
      ['claude', 'connected'],
      ['antigravity', 'not_connected']
    ])
    expect(local.connections.every(row => row.custody === 'device')).toBe(true)
  })
})
