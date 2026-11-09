export function dfAvailableKiB(output) {
  const lines = String(output).trim().split('\n')
  const headers = lines[0]?.trim().split(/\s+/u) ?? []
  const values = lines.at(-1)?.trim().split(/\s+/u) ?? []
  const index = headers.indexOf('Available')
  const available = index >= 0 ? Number(values[index]) : Number.NaN

  if (!Number.isSafeInteger(available) || available < 0) throw new Error('Could not parse df Available blocks.')

  return available
}

export function signingIdentity(value) {
  return String(value ?? '').trim().replace(/^Developer ID Application:\s*/u, '').trim()
}

export function disposableBundleId(runId) {
  if (!/^[a-z0-9]+$/u.test(runId)) throw new Error('Invalid updater test run id.')

  return `com.atum.updater-test.${runId}`
}

export const updaterAcceptanceModes = Object.freeze({
  bridge: 'old-bridge',
  ordinaryQuit: 'ordinary-quit',
  restart: 'restart',
  wrongHash: 'wrong-hash'
})

export const updaterAcceptanceCases = Object.freeze({
  betaChannel: 'legacy-beta-channel',
  exhaustedAttempts: 'exhausted-attempts-and-stale-request',
  legacyMarkers: 'legacy-updater-markers',
  postAbortResidue: 'post-abort-shipit-residue'
})

export function legacyUpdaterSeed(previousVersion) {
  if (!/^\d+\.\d+\.\d+$/u.test(previousVersion)) throw new Error('Invalid legacy updater version.')

  return { channel: 'beta', failureDays: [1, 2, 3], lastVersion: previousVersion }
}

export function staleShipItRequest({ appId, stagedApp, targetApp }) {
  if (!appId.startsWith('com.atum.updater-test.')) throw new Error('Refusing non-test ShipIt request.')

  return {
    updateBundleURL: new URL(`file://${stagedApp}`).href,
    targetBundleURL: new URL(`file://${targetApp}`).href,
    bundleIdentifier: appId,
    launchAfterInstallation: true,
    useUpdateBundleName: false
  }
}

export function acceptanceCaseProof(events, name) {
  const seed = events.find(item => item.event === 'case-seeded' && item.case === name)
  if (!seed) return { launched: false, migrated: false, seeded: false }

  return {
    seeded: true,
    migrated: events.some(item =>
      item.event === 'migration' && item.version === seed.version && item.cases?.includes(name) && item.at >= seed.at
    ),
    launched: events.some(item => item.event === 'launched' && item.version === seed.next && item.at >= seed.at)
  }
}

export function manifestRequestCount(log, manifest) {
  if (!['latest-mac.yml', 'beta-mac.yml'].includes(manifest)) throw new Error('Invalid manifest name.')
  // electron-updater appends ?noCache=<random> to every check after the first, so match the path
  // with or without a query string.
  const target = new RegExp(`"GET /${manifest.replace('.', '\\.')}(?:\\?[^ "]*)? HTTP/1\\.1"`)

  return String(log).split('\n').filter(line => target.test(line)).length
}

export function rawUpdaterEvidence(events, version) {
  const rows = events.filter(item => item.version === version)
  const logs = pattern => rows.filter(item => item.event === 'log' && String(item.message).includes(pattern)).length
  const states = state => rows.filter(item => item.event === 'state' && item.state === state).length
  const named = event => rows.filter(item => item.event === event).length

  return {
    checks: logs('Checking for update'),
    downloads: logs('Downloading update from'),
    nativeReady: named('native-ready'),
    downloaded: states('downloaded'),
    restarting: states('restarting') + states('relaunching'),
    processExits: named('process-exit'),
    hashRefusals: rows.filter(item => item.event === 'wrong-hash-refused' && item.code === 'hash_mismatch').length
  }
}

/** The next launch is recorded before the harness can open it. Require one
 * click with genuinely live children, native readiness, exit and new launch. */
export function restartWithChildrenProof(events, from, to) {
  const rows = events.filter(item => item.version === from)
  const clicks = rows.filter(item => item.event === 'restart-click')
  const click = clicks[0]
  const ready = rows.find(item => item.event === 'native-ready')
  const children = rows.find(item => item.event === 'background-ready')
  const handoff = rows.find(item => item.event === 'install-handoff')
  const exit = rows.find(item => item.event === 'process-exit')
  const launched = events.find(item => item.event === 'launched' && item.version === to)
  return clicks.length === 1 && click.live === true && click.childPids?.length >= 2 &&
    children?.at <= click.at && ready?.at <= click.at && handoff?.at >= click.at &&
    exit?.at >= handoff.at && launched?.at >= exit.at
}
