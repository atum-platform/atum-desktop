import { describe, expect, it } from 'vitest'

import {
  acceptanceCaseProof,
  dfAvailableKiB,
  disposableBundleId,
  legacyUpdaterSeed,
  manifestRequestCount,
  rawUpdaterEvidence,
  restartWithChildrenProof,
  signingIdentity,
  staleShipItRequest,
  updaterAcceptanceCases,
  updaterAcceptanceModes
} from './updater-stock/accept-support.mjs'

describe('stock updater acceptance boundaries', () => {
  it('reads Available blocks from df by header rather than the inode columns', () => {
    const output = `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on
/dev/disk3s5 239362496 204471812 9124284 96% 3604024 91242840 4% /System/Volumes/Data\n`
    expect(dfAvailableKiB(output)).toBe(9_124_284)
  })

  it('passes electron-builder the bare signing identity name', () => {
    expect(signingIdentity('Developer ID Application: Example Company (TEAMID)'))
      .toBe('Example Company (TEAMID)')
    expect(signingIdentity('Example Company (TEAMID)')).toBe('Example Company (TEAMID)')
  })

  it('constructs only per-run test bundle identities', () => {
    expect(disposableBundleId('mabc123')).toBe('com.atum.updater-test.mabc123')
    expect(() => disposableBundleId('../desktop')).toThrow('Invalid updater test run id.')
  })

  it('assigns Restart and ordinary Quit to separate stock hops', () => {
    expect(updaterAcceptanceModes).toEqual({
      bridge: 'old-bridge', restart: 'restart', ordinaryQuit: 'ordinary-quit', wrongHash: 'wrong-hash'
    })
  })

  it('counts duplicate raw updater evidence instead of hiding it behind an action guard', () => {
    const rows = [
      { event: 'log', version: '1.0.0', message: 'Checking for update' },
      { event: 'log', version: '1.0.0', message: 'Checking for update' },
      { event: 'log', version: '1.0.0', message: 'Downloading update from local feed' },
      { event: 'native-ready', version: '1.0.0' },
      { event: 'state', version: '1.0.0', state: 'downloaded' },
      { event: 'state', version: '1.0.0', state: 'restarting' }
    ]
    expect(rawUpdaterEvidence(rows, '1.0.0')).toMatchObject({
      checks: 2, downloads: 1, nativeReady: 1, downloaded: 1, restarting: 1
    })
  })

  it('describes the exact legacy beta and stale ShipIt seeds without a production identity', () => {
    expect(legacyUpdaterSeed('0.20.34')).toEqual({
      channel: 'beta', failureDays: [1, 2, 3], lastVersion: '0.20.34'
    })
    expect(staleShipItRequest({
      appId: 'com.atum.updater-test.case1',
      stagedApp: '/tmp/case/update.stale/Test.app',
      targetApp: '/tmp/case/Applications/Test.app'
    })).toMatchObject({
      bundleIdentifier: 'com.atum.updater-test.case1',
      launchAfterInstallation: true,
      useUpdateBundleName: false
    })
    expect(() => staleShipItRequest({
      appId: 'com.atum.matrix-candidate', stagedApp: '/tmp/a', targetApp: '/tmp/b'
    })).toThrow('Refusing non-test ShipIt request.')
  })

  it('requires each seeded migration case to be followed by migration and a launch', () => {
    const name = updaterAcceptanceCases.postAbortResidue
    const rows = [
      { event: 'case-seeded', case: name, version: '1.0.0', next: '1.0.1', at: 1 },
      { event: 'migration', cases: [name], version: '1.0.0', at: 2 },
      { event: 'launched', version: '1.0.1', at: 3 }
    ]
    expect(acceptanceCaseProof(rows, name)).toEqual({ seeded: true, migrated: true, launched: true })
    expect(acceptanceCaseProof(rows, updaterAcceptanceCases.exhaustedAttempts)).toEqual({
      seeded: false, migrated: false, launched: false
    })
  })

  it('distinguishes beta acceptance through the requested manifest path', () => {
    // electron-updater appends ?noCache=<random> to checks after the first (seen in packaged runs).
    const log = [
      '127.0.0.1 - - [03/Nov/2026] "GET /latest-mac.yml HTTP/1.1" 200 -',
      '127.0.0.1 - - [03/Nov/2026] "GET /latest-mac.yml?noCache=1k6g377ur HTTP/1.1" 200 -',
      '127.0.0.1 - - [03/Nov/2026] "GET /beta-mac.yml?noCache=1k6g3857v HTTP/1.1" 200 -',
      '127.0.0.1 - - [03/Nov/2026] "GET /beta-mac.ymlx HTTP/1.1" 200 -',
      '127.0.0.1 - - [03/Nov/2026] "GET /beta-macXyml HTTP/1.1" 200 -'
    ].join('\n')
    expect(manifestRequestCount(log, 'beta-mac.yml')).toBe(1)
    expect(manifestRequestCount(log, 'latest-mac.yml')).toBe(2)
  })
})

it('requires one Restart with live children and an automatic new-version launch', () => {
  const rows = [
    { event: 'background-ready', version: '1.0.0', at: 1 },
    { event: 'native-ready', version: '1.0.0', at: 2 },
    { event: 'restart-click', version: '1.0.0', live: true, childPids: [1, 2], at: 3 },
    { event: 'install-handoff', version: '1.0.0', at: 4 },
    { event: 'process-exit', version: '1.0.0', at: 5 },
    { event: 'launched', version: '1.0.1', at: 6 }
  ]
  expect(restartWithChildrenProof(rows, '1.0.0', '1.0.1')).toBe(true)
  expect(restartWithChildrenProof(rows.slice(0, -1), '1.0.0', '1.0.1')).toBe(false)
  expect(restartWithChildrenProof([...rows, rows[2]], '1.0.0', '1.0.1')).toBe(false)
  expect(restartWithChildrenProof(rows.map(row => ({ ...row, live: false })), '1.0.0', '1.0.1')).toBe(false)
})
