import { describe, expect, it } from 'vitest'

import { runtimeConfiguration } from '../src/configuration'

const launchOrigin = 'https://web.atum.test'
const launch = {
  mode: 'launch', issuer: 'https://mas.atum.test/', baseUrl: 'https://matrix.atum.test', clientId: 'matrix-public-client',
  redirectUri: `${launchOrigin}/callback`, domain: { clientId: 'domain-public-client', apiBaseUrl: 'https://api.atum.test' },
}

describe('browser two-grant runtime configuration', () => {
  it('accepts only a launch configuration bound to this HTTPS callback and distinct public clients', () => {
    expect(runtimeConfiguration(launch, launchOrigin)).toMatchObject({ launch: true,
      matrix: { redirectUri: `${launchOrigin}/callback`, clientId: 'matrix-public-client', baseUrl: 'https://matrix.atum.test' },
      domain: { redirectUri: `${launchOrigin}/callback`, clientId: 'domain-public-client', apiBaseUrl: 'https://api.atum.test' },
    })
  })

  it.each([
    ['non-HTTPS current origin', { ...launch }, 'http://web.atum.test'],
    ['redirect with another path', { ...launch, redirectUri: `${launchOrigin}/other` }, launchOrigin],
    ['redirect with a query', { ...launch, redirectUri: `${launchOrigin}/callback?next=elsewhere` }, launchOrigin],
    ['missing domain grant', { ...launch, domain: undefined }, launchOrigin],
    ['shared Matrix/domain client id', { ...launch, domain: { ...launch.domain, clientId: launch.clientId } }, launchOrigin],
    ['non-HTTPS domain API', { ...launch, domain: { ...launch.domain, apiBaseUrl: 'http://api.atum.test' } }, launchOrigin],
    ['non-HTTPS Matrix base URL', { ...launch, baseUrl: 'http://matrix.atum.test' }, launchOrigin],
  ])('rejects launch %s', (_name, value, origin) => {
    expect(() => runtimeConfiguration(value, origin)).toThrow('configuration_required')
  })

  it('keeps the localhost proof mode independent and permits an omitted or local optional domain grant', () => {
    const origin = 'http://localhost:4317'
    const proof = { issuer: 'https://mas.localhost/', baseUrl: 'http://localhost:8008', clientId: 'matrix-proof-client', redirectUri: `${origin}/callback` }
    expect(runtimeConfiguration(proof, origin)).toMatchObject({ launch: false, matrix: proof, domain: undefined })
    expect(runtimeConfiguration({ ...proof, mode: 'proof', domain: { clientId: 'domain-proof-client', apiBaseUrl: 'http://localhost:3000' } }, origin)).toMatchObject({
      launch: false, domain: { clientId: 'domain-proof-client', apiBaseUrl: 'http://localhost:3000' },
    })
  })
})
