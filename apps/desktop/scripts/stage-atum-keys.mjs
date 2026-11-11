import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { isMain } from './utils.mjs'

/**
 * Atum Keys (native/atum-keys): the helper app that keeps the person's recovery key in iCloud
 * Keychain. It needs its own Developer ID
 * provisioning profile, for the App ID `com.atum.matrix-candidate.keys` with the keychain access
 * group `7D5FC62RXD.com.atum.shared`, which only the owner can create in the Apple Developer
 * portal. Without one (`ATUM_KEYS_PROFILE` unset) the build ships without the helper and the app
 * keeps the key in its own vault, as before: never a half-provisioned helper.
 *
 * The staged folder always exists (empty without the helper), so the builder's extraResources
 * entry never points at nothing.
 */
export const ATUM_KEYS_TEAM = '7D5FC62RXD'
export const ATUM_KEYS_APP_ID = `${ATUM_KEYS_TEAM}.com.atum.matrix-candidate.keys`
export const ATUM_KEYS_GROUP = `${ATUM_KEYS_TEAM}.com.atum.shared`
export const ATUM_KEYS_BUNDLE = 'Atum Keys.app'
/** A profile must outlive a release by this much: Gatekeeper refuses an expired one. */
const PROFILE_MARGIN_MS = 365 * 24 * 60 * 60 * 1000

const desktopRoot = path.resolve(import.meta.dirname, '..')

export function stageAtumKeys({
  root = desktopRoot,
  output = path.join(root, 'build', 'atum-keys'),
  profile = process.env.ATUM_KEYS_PROFILE,
  platform = process.platform,
  arch = process.arch,
  run = spawnSync,
  log = console.log
} = {}) {
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })

  if (platform !== 'darwin') {
    return { staged: false, reason: 'platform' }
  }

  if (!profile || !existsSync(profile)) {
    log('atum-keys: no provisioning profile (ATUM_KEYS_PROFILE); this build keeps the key in its own vault only')

    return { staged: false, reason: 'profile' }
  }

  const source = path.join(root, 'native', 'atum-keys')
  const contents = path.join(output, ATUM_KEYS_BUNDLE, 'Contents')
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  copyFileSync(path.join(source, 'Info.plist'), path.join(contents, 'Info.plist'))
  copyFileSync(profile, path.join(contents, 'embedded.provisionprofile'))

  const result = run(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx14.0`,
      path.join(source, 'main.swift'),
      '-o',
      path.join(contents, 'MacOS', 'atum-keys')
    ],
    { encoding: 'utf8' }
  )

  if (result.status !== 0) {
    throw new Error(`atum_keys_build_failed: ${result.stderr ?? ''}`)
  }

  log('atum-keys: staged with its provisioning profile')

  return { staged: true }
}

/**
 * The release check of a decoded provisioning profile (`security cms -D -i`, as JSON): the right
 * team, App ID and keychain group, and a long life ahead. Returns the problems, empty when it
 * may ship.
 */
export function atumKeysProfileProblems(profile, { now = Date.now() } = {}) {
  const problems = []
  const entitlements = profile?.Entitlements ?? {}
  const groups = Array.isArray(entitlements['keychain-access-groups']) ? entitlements['keychain-access-groups'] : []
  const expires = Date.parse(profile?.ExpirationDate ?? '')

  if (!Array.isArray(profile?.TeamIdentifier) || !profile.TeamIdentifier.includes(ATUM_KEYS_TEAM)) {
    problems.push('team')
  }

  if (entitlements['com.apple.application-identifier'] !== ATUM_KEYS_APP_ID) {
    problems.push('app_id')
  }

  if (!groups.some(group => group === ATUM_KEYS_GROUP || group === `${ATUM_KEYS_TEAM}.*`)) {
    problems.push('access_group')
  }

  if (!Number.isFinite(expires) || expires - now < PROFILE_MARGIN_MS) {
    problems.push('expiry')
  }

  if (profile?.ProvisionsAllDevices !== true) {
    // A Developer ID profile is for every Mac; a development profile names devices.
    problems.push('not_developer_id')
  }

  return problems
}

/** Entitlements that need a provisioning profile: the main app must never carry them, or a bad
 * profile could stop Atum itself from launching. */
const RESTRICTED = ['keychain-access-groups', 'com.apple.application-identifier', 'com.apple.developer.team-identifier']

export function restrictedEntitlements(xml) {
  return RESTRICTED.filter(name => String(xml ?? '').includes(`<key>${name}</key>`))
}

/** Decodes a provisioning profile's signed plist (macOS `security cms`), as XML text. */
export function readProvisioningProfile(file, run = spawnSync) {
  const decoded = run('security', ['cms', '-D', '-i', file], { encoding: 'utf8' })

  if (decoded.status !== 0 || typeof decoded.stdout !== 'string') {
    throw new Error('atum_keys_profile_unreadable')
  }

  return parseProvisioningProfile(decoded.stdout)
}

/** The few fields the release check reads, from a provisioning profile's XML plist. */
export function parseProvisioningProfile(xml) {
  const text = String(xml ?? '')
  const string = key =>
    text.match(new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<string>([^<]*)</string>`))?.[1]
  const strings = key =>
    [
      ...(text.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`))?.[1] ?? '').matchAll(
        /<string>([^<]*)<\/string>/g
      )
    ].map(match => match[1])

  return {
    TeamIdentifier: strings('TeamIdentifier'),
    ExpirationDate: text.match(/<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/)?.[1],
    ProvisionsAllDevices: /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(text),
    Entitlements: {
      'com.apple.application-identifier': string('com.apple.application-identifier'),
      'keychain-access-groups': strings('keychain-access-groups')
    }
  }
}

if (isMain(import.meta.url)) {
  stageAtumKeys()
}
