import { expect, test } from 'vitest'

import { DEVICE_HUB_URL, deviceHubUrl } from '../electron/matrix/device/connection.ts'

import { deviceHubDefine } from './stage-atum-device-key.mjs'

const compiled = environment => JSON.parse(deviceHubDefine(environment))

test('a build without an override compiles no hub, so the Mac dials only the production hub', () => {
  expect(compiled({})).toBe('')
  expect(compiled({ ATUM_DEVICE_HUB_URL: '   ' })).toBe('')
  expect(deviceHubUrl(compiled({}))).toBe(DEVICE_HUB_URL)
})

test('a dev build for the SSM port-forward compiles a loopback hub that the Mac then dials', () => {
  for (const hub of ['ws://127.0.0.1:8790/v1', 'ws://localhost:18790/v1']) {
    expect(compiled({ ATUM_DEVICE_HUB_URL: hub })).toBe(hub)
    // Whatever the build accepts, the running app honours: a dev build never falls back silently.
    expect(deviceHubUrl(compiled({ ATUM_DEVICE_HUB_URL: hub }))).toBe(new URL(hub).href)
  }
})

test('a release never compiles a hub override, even a loopback one', () => {
  expect(() =>
    deviceHubDefine({
      ATUM_DEVICE_HUB_URL: 'ws://127.0.0.1:8790/v1',
      ATUM_MATRIX_SIGNING_IDENTITY: 'Developer ID Application: Atum (TEAM123456)'
    })
  ).toThrow('device_hub_override_in_release')

  // A release without an override builds as usual.
  expect(compiled({ ATUM_MATRIX_SIGNING_IDENTITY: 'Developer ID Application: Atum (TEAM123456)' })).toBe('')
})

test('only a loopback hub on /v1 may be compiled in', () => {
  for (const hub of [
    'wss://devices.example.com/v1',
    'ws://10.0.0.5:8790/v1',
    'ws://127.0.0.1/v1',
    'ws://127.0.0.1:8790/',
    'ws://127.0.0.1:8790/v1?next=1',
    'ws://user:pass@127.0.0.1:8790/v1',
    'http://127.0.0.1:8790/v1'
  ]) {
    expect(() => deviceHubDefine({ ATUM_DEVICE_HUB_URL: hub }), hub).toThrow('device_hub_override_not_loopback')
  }
})
