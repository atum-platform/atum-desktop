import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  atumKeysProfileProblems,
  parseProvisioningProfile,
  restrictedEntitlements,
  stageAtumKeys
} from './stage-atum-keys.mjs'

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'atum-keys-stage-'))
  directories.push(root)
  mkdirSync(path.join(root, 'native', 'atum-keys'), { recursive: true })
  writeFileSync(path.join(root, 'native', 'atum-keys', 'Info.plist'), '<plist/>')
  writeFileSync(path.join(root, 'native', 'atum-keys', 'main.swift'), '// helper')

  return root
}

/** A decoded Developer ID profile for the helper, as `security cms -D` prints it. */
function profileXml({
  team = '7D5FC62RXD',
  appId = '7D5FC62RXD.com.atum.matrix-candidate.keys',
  groups = ['7D5FC62RXD.*'],
  expires = '2044-10-05T08:00:00Z',
  all = true
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>AppIDName</key><string>Atum Keys</string>
  <key>ExpirationDate</key><date>${expires}</date>
  <key>Entitlements</key><dict>
    <key>com.apple.application-identifier</key><string>${appId}</string>
    <key>keychain-access-groups</key><array>${groups.map(group => `<string>${group}</string>`).join('')}</array>
    <key>com.apple.developer.team-identifier</key><string>${team}</string>
  </dict>
  ${all ? '<key>ProvisionsAllDevices</key><true/>' : ''}
  <key>TeamIdentifier</key><array><string>${team}</string></array>
</dict></plist>`
}

const NOW = Date.parse('2026-10-05T08:00:00Z')

describe('staging Atum Keys for a release', () => {
  test('ships without the helper, and says so, when there is no provisioning profile', () => {
    const root = workspace()
    const run = vi.fn()
    const lines = []

    expect(stageAtumKeys({ root, profile: undefined, platform: 'darwin', run, log: line => lines.push(line) })).toEqual(
      {
        staged: false,
        reason: 'profile'
      }
    )
    expect(run).not.toHaveBeenCalled()
    // The builder's source folder exists, empty.
    expect(readdirSync(path.join(root, 'build', 'atum-keys'))).toEqual([])
    expect(lines[0]).toMatch(/no provisioning profile/)
  })

  test('builds the helper bundle with its profile embedded', () => {
    const root = workspace()
    const profile = path.join(root, 'keys.provisionprofile')
    writeFileSync(profile, 'profile-bytes')
    const run = vi.fn(() => ({ status: 0 }))

    expect(stageAtumKeys({ root, profile, platform: 'darwin', arch: 'arm64', run, log: () => {} })).toEqual({
      staged: true
    })

    const contents = path.join(root, 'build', 'atum-keys', 'Atum Keys.app', 'Contents')
    expect(existsSync(path.join(contents, 'embedded.provisionprofile'))).toBe(true)
    expect(existsSync(path.join(contents, 'Info.plist'))).toBe(true)
    expect(run).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['swiftc', 'arm64-apple-macosx14.0', path.join(contents, 'MacOS', 'atum-keys')]),
      expect.anything()
    )
  })

  test('fails the build when the helper does not compile', () => {
    const root = workspace()
    const profile = path.join(root, 'keys.provisionprofile')
    writeFileSync(profile, 'profile-bytes')

    expect(() =>
      stageAtumKeys({ root, profile, platform: 'darwin', run: () => ({ status: 1, stderr: 'boom' }), log: () => {} })
    ).toThrow('atum_keys_build_failed')
  })
})

describe('the release check of the helper’s provisioning profile', () => {
  test('passes a Developer ID profile for the helper’s App ID and group, with years ahead', () => {
    expect(atumKeysProfileProblems(parseProvisioningProfile(profileXml()), { now: NOW })).toEqual([])
    expect(
      atumKeysProfileProblems(parseProvisioningProfile(profileXml({ groups: ['7D5FC62RXD.com.atum.shared'] })), {
        now: NOW
      })
    ).toEqual([])
  })

  test('names each problem: team, App ID, group, expiry, development profile', () => {
    expect(
      atumKeysProfileProblems(parseProvisioningProfile(profileXml({ team: 'ABCDE12345' })), { now: NOW })
    ).toContain('team')
    expect(
      atumKeysProfileProblems(parseProvisioningProfile(profileXml({ appId: '7D5FC62RXD.com.atum.matrix-candidate' })), {
        now: NOW
      })
    ).toEqual(['app_id'])
    expect(
      atumKeysProfileProblems(parseProvisioningProfile(profileXml({ groups: ['7D5FC62RXD.other'] })), { now: NOW })
    ).toEqual(['access_group'])
    expect(
      atumKeysProfileProblems(parseProvisioningProfile(profileXml({ expires: '2027-03-01T00:00:00Z' })), { now: NOW })
    ).toEqual(['expiry'])
    expect(atumKeysProfileProblems(parseProvisioningProfile(profileXml({ all: false })), { now: NOW })).toEqual([
      'not_developer_id'
    ])
    expect(atumKeysProfileProblems(parseProvisioningProfile('not a plist'), { now: NOW })).toEqual([
      'team',
      'app_id',
      'access_group',
      'expiry',
      'not_developer_id'
    ])
  })

  test('finds entitlements that need a profile', () => {
    expect(restrictedEntitlements('<dict><key>com.apple.security.cs.allow-jit</key><true/></dict>')).toEqual([])
    expect(
      restrictedEntitlements(
        '<dict><key>keychain-access-groups</key><array/><key>com.apple.application-identifier</key></dict>'
      )
    ).toEqual(['keychain-access-groups', 'com.apple.application-identifier'])
  })
})
