#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

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
} from './accept-support.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repository = path.resolve(root, '../..')
const worktrees = '/home/example/Projects/atum-app-worktrees'
const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.toLowerCase()
const appId = disposableBundleId(runId)
// Last custom-updater revision; origin/atum-main now contains only stock modules.
const bridgeRevision = '25ac50a91a6^'
const appName = `Atum Updater Test ${runId}`
const updaterCacheName = `atum-updater-test-${runId}-updater`
// A caller running inside an Electron app (an IDE, a coding tool) exports this; `open` and the
// builds inherit it, so the packaged test app would start as plain Node and quit without a window.
delete process.env.ELECTRON_RUN_AS_NODE

const rawIdentity = process.env.ATUM_UPDATER_TEST_SIGN_IDENTITY?.trim() ?? ''
const identity = signingIdentity(rawIdentity)
const fromVersion = process.env.ATUM_UPDATER_TEST_FROM_VERSION?.trim() || '90.0.0'
const toVersion = process.env.ATUM_UPDATER_TEST_TO_VERSION?.trim() || '90.0.1'
const finalVersion = process.env.ATUM_UPDATER_TEST_FINAL_VERSION?.trim() || '90.0.2'
const quitVersion = process.env.ATUM_UPDATER_TEST_QUIT_VERSION?.trim() || '90.0.3'
const [wrongMajor, wrongMinor, wrongPatch] = quitVersion.split('.').map(Number)
const wrongVersion = `${wrongMajor}.${wrongMinor}.${wrongPatch + 1}`
const port = Number(process.env.ATUM_UPDATER_TEST_PORT || 18765)
const keep = process.env.ATUM_UPDATER_TEST_KEEP === '1'

if (process.platform !== 'darwin') throw new Error('The stock updater acceptance harness requires macOS.')
if (!identity) throw new Error('Set ATUM_UPDATER_TEST_SIGN_IDENTITY to a Developer ID Application identity name.')
if (!appId.startsWith('com.atum.updater-test.') || appId === 'com.atum.desktop') throw new Error('Refusing a production identity.')
const versions = [fromVersion, toVersion, finalVersion, quitVersion]
if (!versions.every(version => /^\d+\.\d+\.\d+$/.test(version)) || new Set(versions).size !== versions.length) {
  throw new Error('Set four distinct semantic FROM/TO/FINAL/QUIT versions.')
}
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.')

function availableKiB() {
  const result = spawnSync('/bin/df', ['-k', '/System/Volumes/Data'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Could not read free disk space.')
  return dfAvailableKiB(result.stdout)
}

function requireDisk(gibibytes, purpose) {
  const required = gibibytes * 1024 * 1024
  const available = availableKiB()

  if (available < required) {
    throw new Error(`${purpose} needs ${gibibytes} GiB free; only ${(available / 1024 / 1024).toFixed(1)} GiB is available.`)
  }
}

// Four signed Electron builds plus the old client's ~6 GiB preflight need
// materially more headroom than the worker's ordinary 5 GiB stop threshold.
requireDisk(10, 'Updater acceptance')

const work = mkdtempSync(path.join(os.tmpdir(), 'atum-updater-stock-'))
const bridgeWorktree = path.join(worktrees, `updater-stock-bridge-${runId}`)
const stateFile = path.join(work, 'acceptance-state.jsonl')
const userData = path.join(work, 'user-data')
const cache = path.join(work, 'cache')
const temporary = path.join(work, 'temp')
const logs = path.join(work, 'logs')
const applications = path.join(work, 'Applications')
const feed = path.join(work, 'feed')
const secondFeedReady = path.join(work, 'second-feed-ready')
const ordinaryFeedReady = path.join(work, 'ordinary-feed-ready')
const wrongHashReady = path.join(work, 'wrong-hash-ready')
const feedLog = path.join(work, 'feed.log')
const feedUrl = `http://127.0.0.1:${port}/`
const installed = path.join(applications, `${appName}.app`)
const shipItCache = path.join(os.homedir(), 'Library', 'Caches', `${appId}.ShipIt`)
const shipItDefaultsDomain = `${appId}.ShipIt`
let bridgeCreated = false
let server
let serverLogFd = null

for (const directory of [userData, cache, temporary, logs, applications]) mkdirSync(directory, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options })

  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}`)
}

function bundleApp(source, stage) {
  return build({
    stdin: { contents: source, loader: 'ts', resolveDir: repository },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(stage, 'main.mjs'),
    external: ['electron'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
  })
}

function appIn(directory) {
  const queue = [directory]

  while (queue.length) {
    const current = queue.shift()

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)

      if (entry.isDirectory() && entry.name === `${appName}.app`) return candidate
      if (entry.isDirectory() && !entry.name.endsWith('.app')) queue.push(candidate)
    }
  }

  throw new Error(`No ${appName}.app beneath ${directory}`)
}

function builderConfig(stage, output) {
  return {
    appId,
    productName: appName,
    executableName: appName,
    electronVersion: '44.10.1',
    directories: { app: stage, output },
    files: ['main.mjs', 'package.json'],
    npmRebuild: false,
    asar: true,
    artifactName: `${appName.replaceAll(' ', '-')}-\${version}-\${os}-\${arch}.\${ext}`,
    publish: { provider: 'generic', url: feedUrl },
    mac: {
      identity,
      hardenedRuntime: true,
      category: 'public.app-category.developer-tools',
      target: [{ target: 'zip', arch: ['arm64'] }, { target: 'dir', arch: ['arm64'] }]
    }
  }
}

function buildPackaged(stage, output, version) {
  requireDisk(7, `Building ${version}`)
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: `atum-updater-test-${runId}`, productName: appName, version, type: 'module', main: 'main.mjs'
  }, null, 2))
  const configPath = path.join(work, `builder-${version}.json`)
  writeFileSync(configPath, JSON.stringify(builderConfig(stage, output), null, 2))
  run(path.join(repository, 'node_modules/.bin/electron-builder'), [
    '--config', configPath, '--mac', '--arm64', '--publish', 'never'
  ])

  return output
}

async function buildNewVersion(version, options) {
  const stage = path.join(work, `stage-${version}`)
  const output = path.join(work, `release-${version}`)
  mkdirSync(stage, { recursive: true })
  const source = `
    import { app, BrowserWindow, autoUpdater as nativeAutoUpdater } from 'electron'
    import { autoUpdater as appUpdater } from 'electron-updater'
    import { spawn, spawnSync } from 'node:child_process'
    import { appendFileSync, existsSync, readFileSync } from 'node:fs'
    import path from 'node:path'
    import {
      createShipItOperationLease,
      createDesktopUpdateSettings,
      retireLegacyShipItState,
      sweepLegacyShipItQuarantines
    } from ${JSON.stringify(path.join(root, 'electron/desktop-update-settings.ts'))}
    import { createDesktopUpdater } from ${JSON.stringify(path.join(root, 'electron/desktop-updater.ts'))}
    import { ownedBackgroundChildren } from ${JSON.stringify(path.join(root, 'electron/owned-background-children.ts'))}
    import { createMatrixQuitHandler } from ${JSON.stringify(path.join(root, 'electron/matrix/quit.ts'))}

    const stateFile = ${JSON.stringify(stateFile)}
    const waitForFeed = ${JSON.stringify(options.waitForFeed)}
    const mode = ${JSON.stringify(options.mode)}
    const migrationCases = ${JSON.stringify(options.migrationCases ?? [])}
    app.setPath('userData', ${JSON.stringify(userData)})
    app.setPath('cache', ${JSON.stringify(cache)})
    app.setPath('temp', ${JSON.stringify(temporary)})
    app.setPath('logs', ${JSON.stringify(logs)})
    const write = value => appendFileSync(stateFile, JSON.stringify({ ...value, at: Date.now() }) + '\\n')
    const logger = {
      info: message => write({ event: 'log', level: 'info', version: app.getVersion(), message: String(message) }),
      warn: message => write({ event: 'log', level: 'warn', version: app.getVersion(), message: String(message) }),
      error: message => write({ event: 'log', level: 'error', version: app.getVersion(), message: String(message) })
    }
    let actionTaken = false
    let closing = false
    let window
    const childPids = []
    const forceCleanup = () => { closing = true; ownedBackgroundChildren.killNow() }
    const forceExit = () => { forceCleanup(); app.exit(0) }
    app.on('will-quit', forceCleanup)
    process.on('exit', forceCleanup)
    nativeAutoUpdater.on('update-downloaded', () => {
      write({ event: 'native-ready', version: app.getVersion(), mode })
    })
    app.on('quit', () => write({ event: 'process-exit', version: app.getVersion(), mode }))
    let updater
    const afterClose = success => {
      if (!success) {
        updater.cancelRestart()
        return 'retry'
      }
      if (mode === 'restart' && updater.afterTeardown()) return 'handled'
      return 'quit'
    }
    const quit = createMatrixQuitHandler(
      async () => { write({ event: 'teardown', version: app.getVersion(), mode }); await Promise.resolve() },
      () => app.quit(),
      afterClose,
      { deadlineMs: 100, forceCleanup, forceExit }
    )
    app.on('before-quit', quit)
    const settings = createDesktopUpdateSettings({
      file: path.join(${JSON.stringify(userData)}, 'updates.json'),
      legacyMarkers: [
        path.join(${JSON.stringify(userData)}, 'downloaded-update.json'),
        path.join(${JSON.stringify(userData)}, 'pending-update.json')
      ],
      retireLegacyNativeState: complete => retireLegacyShipItState({
        applicationIdentifier: ${JSON.stringify(appId)},
        cacheDirectory: ${JSON.stringify(shipItCache)},
        complete,
        progress: step => logger.info('Stock updater migration ' + step)
      }),
      sweepLegacyNativeState: () => sweepLegacyShipItQuarantines({
        applicationIdentifier: ${JSON.stringify(appId)},
        cacheDirectory: ${JSON.stringify(shipItCache)},
        progress: step => logger.info('Stock updater migration ' + step)
      })
    })
    const migrate = settings.migrate.bind(settings)
    settings.migrate = async currentVersion => {
      const result = await migrate(currentVersion)
      const attempts = spawnSync('/usr/bin/defaults', [
        '-currentHost', 'read', ${JSON.stringify(shipItDefaultsDomain)}, 'SQRLShipItInstallationAttempts'
      ], { encoding: 'utf8' })
      const saved = JSON.parse(readFileSync(path.join(${JSON.stringify(userData)}, 'updates.json'), 'utf8'))
      const savedUpdates = saved.updates && typeof saved.updates === 'object' ? saved.updates : {}
      write({
        event: 'migration', version: app.getVersion(), cases: migrationCases, channel: result.channel,
        attemptsCleared: attempts.status !== 0 && /domain\\/default pair .* does not exist/iu.test(attempts.stderr),
        completed: result.deferred !== true,
        failureDaysAbsent: !Object.hasOwn(saved, 'failureDays') && !Object.hasOwn(savedUpdates, 'failureDays'),
        legacyMarkersAbsent:
          !existsSync(path.join(${JSON.stringify(userData)}, 'downloaded-update.json')) &&
          !existsSync(path.join(${JSON.stringify(userData)}, 'pending-update.json')),
        legacyRootFieldsAbsent:
          !Object.hasOwn(saved, 'channel') && !Object.hasOwn(saved, 'lastVersion'),
        shipItCacheExists: existsSync(${JSON.stringify(shipItCache)}),
        shipItStateExists: existsSync(path.join(${JSON.stringify(shipItCache)}, 'ShipItState.plist')),
        stockMigration: saved.updates?.stockMigration
      })
      return result
    }
    updater = createDesktopUpdater({
      busy: () => false,
      changed: status => {
        write({ event: 'state', version: app.getVersion(), state: status.state, next: status.version })
        if (status.state === 'downloaded' && !actionTaken) {
          actionTaken = true
          if (mode === 'restart') {
            write({ event: 'restart-click', version: app.getVersion(), childPids,
              live: childPids.every(pid => {try {process.kill(pid, 0); return true} catch {return false}}) })
            updater.restart()
          }
          else if (mode === 'ordinary-quit') app.quit()
        }
        if (mode === 'wrong-hash' && status.state === 'error' && !actionTaken) {
          actionTaken = true
          write({ event: 'wrong-hash-refused', version: app.getVersion(), code: status.error?.code })
          write({ event: 'accepted', version: app.getVersion() })
          app.quit()
        }
      },
      currentVersion: app.getVersion(),
      feedUrl: ${JSON.stringify(feedUrl)},
      isPackaged: app.isPackaged,
      loadUpdater: async () => appUpdater,
      logger,
      nativeUpdater: nativeAutoUpdater,
      nativeStateLease: createShipItOperationLease({
        applicationIdentifier: ${JSON.stringify(appId)},
        cacheDirectory: ${JSON.stringify(shipItCache)}
      }),
      quit: () => app.quit(),
      forceExit,
      beforeInstall: () => {
        forceCleanup()
        write({ event: 'install-handoff', version: app.getVersion(), childPids })
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      },
      record: event => write({ event: 'telemetry', version: app.getVersion(), name: event.name, properties: event.properties }),
      setInterval: callback => setInterval(callback, 60 * 60_000).unref(),
      settings,
      supported: true
    })
    void app.whenReady().then(async () => {
      write({ event: 'launched', version: app.getVersion(), bundleId: ${JSON.stringify(appId)}, mode })
      if (mode === 'restart') {
        window = new BrowserWindow({ show: false })
        window.on('close', event => { if (!closing) {event.preventDefault(); window.hide()} })
        await window.loadURL('data:text/html,<title>Updater background child test</title>')
        // Real processes from the signed app's own executable. One cooperates;
        // one ignores SIGTERM and EOF, reproducing an invisible running copy.
        for (const stubborn of [false, true]) {
          const script = "if (" + stubborn + ") process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"
          const child = ownedBackgroundChildren.track(spawn(process.execPath, ['-e', script], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: ['ignore', 'pipe', 'ignore']
          }), true)
          await new Promise((resolve, reject) => {
            child.stdout.once('data', resolve); child.once('error', reject)
            child.once('exit', () => reject(new Error('Background child exited before ready')))
          })
          childPids.push(child.pid)
        }
        write({ event: 'background-ready', version: app.getVersion(), childPids })
      }
      if (waitForFeed) {
        const deadline = Date.now() + 180_000
        while (!existsSync(waitForFeed) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!existsSync(waitForFeed)) throw new Error('Next feed was not published in time')
      }
      if (!(await updater.start())) throw new Error('Updater did not arm')
    }).catch(error => { write({ event: 'fatal', version: app.getVersion(), message: String(error) }); app.exit(1) })
  `
  await bundleApp(source, stage)

  return buildPackaged(stage, output, version)
}

async function createBridgeWorktree() {
  if (existsSync(bridgeWorktree)) throw new Error(`Bridge worktree path already exists: ${bridgeWorktree}`)
  run('/usr/bin/git', ['-C', repository, 'worktree', 'add', '--detach', bridgeWorktree, bridgeRevision])
  bridgeCreated = true
  symlinkSync(path.join(worktrees, 'shared-deps/node_modules'), path.join(bridgeWorktree, 'node_modules'))
  symlinkSync(
    path.join(worktrees, 'shared-deps/apps/desktop/node_modules'),
    path.join(bridgeWorktree, 'apps/desktop/node_modules')
  )
}

async function buildOldBridgeVersion(version) {
  await createBridgeWorktree()
  const oldDesktop = path.join(bridgeWorktree, 'apps/desktop')
  const stage = path.join(work, `stage-${version}`)
  const output = path.join(work, `release-${version}`)
  mkdirSync(stage, { recursive: true })
  const source = `
    import { app, autoUpdater as nativeAutoUpdater } from 'electron'
    import { autoUpdater as appUpdater } from 'electron-updater'
    import { appendFileSync } from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { createAtumUpdateFlow } from ${JSON.stringify(path.join(oldDesktop, 'electron/atum-update-flow.ts'))}
    import { loadAtumMacUpdater } from ${JSON.stringify(path.join(oldDesktop, 'electron/atum-mac-updater.ts'))}
    import { createUpdatePreferences, stagedMacUpdate, updateDisk } from ${JSON.stringify(path.join(oldDesktop, 'electron/atum-update-native.ts'))}
    import { AtumUpdateRestart } from ${JSON.stringify(path.join(oldDesktop, 'electron/atum-update-restart.ts'))}
    import { QuitTeardownCoordinator } from ${JSON.stringify(path.join(oldDesktop, 'electron/quit-teardown-coordinator.ts'))}

    const stateFile = ${JSON.stringify(stateFile)}
    app.setPath('userData', ${JSON.stringify(userData)})
    app.setPath('cache', ${JSON.stringify(cache)})
    app.setPath('temp', ${JSON.stringify(temporary)})
    app.setPath('logs', ${JSON.stringify(logs)})
    const write = value => appendFileSync(stateFile, JSON.stringify({ ...value, at: Date.now() }) + '\\n')
    const logger = {
      info: message => write({ event: 'log', level: 'info', version: app.getVersion(), message: String(message) }),
      warn: message => write({ event: 'log', level: 'warn', version: app.getVersion(), message: String(message) }),
      error: message => write({ event: 'log', level: 'error', version: app.getVersion(), message: String(message) })
    }
    appUpdater.logger = logger
    nativeAutoUpdater.on('update-downloaded', () => {
      write({ event: 'native-ready', version: app.getVersion(), mode: 'old-bridge' })
    })
    app.on('quit', () => write({ event: 'process-exit', version: app.getVersion(), mode: 'old-bridge' }))
    const nativeCache = path.join(os.homedir(), 'Library', 'Caches')
    const persisted = createUpdatePreferences(path.join(${JSON.stringify(userData)}, 'updates.json'))
    const staging = stagedMacUpdate({
      shipItCachePath: path.join(nativeCache, ${JSON.stringify(`${appId}.ShipIt`)}),
      shipItJobLabel: ${JSON.stringify(`${appId}.ShipIt`)},
      shipItTemporaryPrefix: ${JSON.stringify(`${appId}.ShipIt`)},
      temporaryPath: ${JSON.stringify(temporary)},
      updaterCachePath: path.join(nativeCache, ${JSON.stringify(updaterCacheName)})
    })
    let actionTaken = false
    let restart
    const flow = createAtumUpdateFlow({
      ...persisted,
      disk: updateDisk({
        bundlePath: path.resolve(process.resourcesPath, '..', '..'),
        cachePath: path.join(nativeCache, ${JSON.stringify(updaterCacheName)}),
        temporaryPath: ${JSON.stringify(temporary)}
      }),
      staging,
      busy: () => false,
      feedUrl: ${JSON.stringify(feedUrl)},
      isPackaged: app.isPackaged,
      supported: true,
      currentVersion: app.getVersion(),
      loadUpdater: loadAtumMacUpdater,
      setTimer: (callback, delay) => setTimeout(callback, delay).unref(),
      clearTimer: timer => clearTimeout(timer),
      log: message => write({ event: 'log', version: app.getVersion(), message }),
      stateChanged: status => {
        write({ event: 'state', version: app.getVersion(), state: status.state, next: status.version })
        if (status.state === 'downloaded' && !actionTaken) {
          actionTaken = true
          restart.request()
        }
      },
      record: event => write({ event: 'telemetry', version: app.getVersion(), name: event.name, properties: event.properties })
    })
    restart = new AtumUpdateRestart({
      ready: () => flow.status().state === 'downloaded',
      busy: () => false,
      quit: () => app.quit(),
      install: (forceRunAfter) => flow.relaunch(forceRunAfter),
      defer: callback => setImmediate(callback)
    })
    const teardown = new QuitTeardownCoordinator({ onComplete: () => app.quit(), timeoutMilliseconds: 4_000 })
    app.on('before-quit', event => {
      if (teardown.defer([async () => { write({ event: 'teardown', version: app.getVersion(), mode: 'old-bridge' }); await Promise.resolve() }])) {
        event.preventDefault()
        return
      }
      restart.afterTeardown(event)
    })
    void app.whenReady().then(async () => {
      write({ event: 'launched', version: app.getVersion(), bundleId: ${JSON.stringify(appId)}, mode: 'old-bridge' })
      if (!(await flow.start())) throw new Error('Old updater did not arm')
    }).catch(error => { write({ event: 'fatal', version: app.getVersion(), message: String(error) }); app.exit(1) })
  `
  await bundleApp(source, stage)

  return buildPackaged(stage, output, version)
}

function recordSeed(name, version, next, properties = {}) {
  appendFileSync(stateFile, `${JSON.stringify({
    event: 'case-seeded', case: name, version, next, ...properties, at: Date.now()
  })}\n`)
}

function seedLegacyUpdaterState(version, next) {
  writeFileSync(path.join(userData, 'updates.json'), `${JSON.stringify(legacyUpdaterSeed(fromVersion), null, 2)}\n`)
  writeFileSync(path.join(userData, 'downloaded-update.json'), JSON.stringify({
    previous: fromVersion, expected: version, attempted: 'relaunch'
  }))
  writeFileSync(path.join(userData, 'pending-update.json'), JSON.stringify({
    previous: fromVersion, expected: version
  }))
  recordSeed(updaterAcceptanceCases.legacyMarkers, version, next)
  recordSeed(updaterAcceptanceCases.betaChannel, version, next)
}

function seedPostAbortResidue(version, next) {
  rmSync(shipItCache, { recursive: true, force: true })
  const stagedApp = path.join(shipItCache, 'update.cBjc8P9', `${appName}.app`)
  mkdirSync(path.dirname(stagedApp), { recursive: true })
  run('/usr/bin/ditto', [installed, stagedApp])
  const stderr = path.join(shipItCache, 'ShipIt_stderr.log')
  writeFileSync(stderr, 'Too many attempts to install, aborting update\nShipIt quitting\n')
  truncateSync(stderr, 42 * 1024 * 1024)
  writeFileSync(path.join(shipItCache, 'ShipIt_stdout.log'), '')
  rmSync(path.join(shipItCache, 'ShipItState.plist'), { force: true })
  recordSeed(updaterAcceptanceCases.postAbortResidue, version, next, {
    logBytes: 42 * 1024 * 1024, statePlist: false, stagedApp: true
  })
}

function seedExhaustedAttempts(version, next) {
  rmSync(shipItCache, { recursive: true, force: true })
  const stagedApp = path.join(shipItCache, 'update.exhausted', `${appName}.app`)
  mkdirSync(path.dirname(stagedApp), { recursive: true })
  run('/usr/bin/ditto', [installed, stagedApp])
  writeFileSync(
    path.join(shipItCache, 'ShipItState.plist'),
    `${JSON.stringify(staleShipItRequest({ appId, stagedApp, targetApp: installed }), null, 2)}\n`
  )
  run('/usr/bin/defaults', [
    '-currentHost', 'write', shipItDefaultsDomain, 'SQRLShipItInstallationAttempts', '-int', '3'
  ])
  recordSeed(updaterAcceptanceCases.exhaustedAttempts, version, next, {
    attempts: 3, statePlist: true, stagedApp: true
  })
}

function assertMigration(version, expected) {
  const migration = events().find(item => item.event === 'migration' && item.version === version)

  if (!migration) throw new Error(`No stock migration evidence for ${version}.`)
  for (const [property, value] of Object.entries(expected)) {
    if (migration[property] !== value) {
      throw new Error(`${version} migration ${property}=${migration[property]}; expected ${value}.`)
    }
  }
}

function pointFeed(output) {
  const next = `${feed}.next`
  rmSync(next, { force: true })
  symlinkSync(output, next)
  renameSync(next, feed)
}

function addBetaManifest(output) {
  writeFileSync(
    path.join(output, 'beta-mac.yml'),
    readFileSync(path.join(output, 'latest-mac.yml'), 'utf8')
  )
}

function wrongHashFeed(output) {
  const directory = path.join(work, 'wrong-hash-feed')
  mkdirSync(directory, { recursive: true })

  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'latest-mac.yml' || entry.name === 'beta-mac.yml') continue
    symlinkSync(path.join(output, entry.name), path.join(directory, entry.name))
  }

  const wrongHash = Buffer.alloc(64).toString('base64')
  for (const channelManifest of ['latest-mac.yml', 'beta-mac.yml']) {
    const manifest = readFileSync(path.join(output, channelManifest), 'utf8')
      .replace(/^version: .*$/mu, `version: ${wrongVersion}`)
      .replace(/^\s*sha512: .*$/gmu, line => `${line.slice(0, line.indexOf('sha512:'))}sha512: ${wrongHash}`)
    writeFileSync(path.join(directory, channelManifest), manifest)
  }

  return directory
}

function events() {
  if (!existsSync(stateFile)) return []

  return readFileSync(stateFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function feedRequests(manifest) {
  return existsSync(feedLog) ? manifestRequestCount(readFileSync(feedLog, 'utf8'), manifest) : 0
}

async function waitForEvent(event, version, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (events().some(item => item.event === event && item.version === version)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error(`${event} ${version} was not observed within ${timeoutMs / 1000} seconds.`)
}

function installedVersion() {
  const plist = path.join(installed, 'Contents/Info.plist')
  const result = spawnSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', plist
  ], { encoding: 'utf8' })

  return result.status === 0 ? result.stdout.trim() : null
}

async function waitForInstalledVersion(version, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (installedVersion() === version) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error(`Installed bundle did not become ${version} within ${timeoutMs / 1000} seconds.`)
}

function assertEventCounts() {
  const all = events()

  for (const version of [fromVersion, toVersion, finalVersion]) {
    const evidence = rawUpdaterEvidence(all, version)
    for (const [label, count] of [
      ['check logger lines', evidence.checks],
      ['download logger lines', evidence.downloads],
      ['native readiness events', evidence.nativeReady],
      ['downloaded state transitions', evidence.downloaded]
    ]) {
      if (count !== 1) throw new Error(`${version} recorded ${count} ${label}; expected exactly one.`)
    }
  }

  if (!restartWithChildrenProof(all, toVersion, finalVersion)) {
    throw new Error('One Restart with live background children did not install and automatically relaunch.')
  }
  const click = all.find(item => item.event === 'restart-click' && item.version === toVersion)
  for (const pid of click.childPids) {
    try {process.kill(pid, 0)} catch {continue}
    throw new Error('A background app process survived Restart: ' + pid)
  }

  const oldHandoffs = rawUpdaterEvidence(all, fromVersion).restarting
  const restartHandoffs = rawUpdaterEvidence(all, toVersion).restarting
  const ordinaryExits = rawUpdaterEvidence(all, finalVersion).processExits
  if (oldHandoffs !== 1 || restartHandoffs !== 1 || ordinaryExits !== 1) {
    throw new Error(
      `Install handoffs were old=${oldHandoffs}, restart=${restartHandoffs}, ordinary-exit=${ordinaryExits}; expected one each.`
    )
  }

  const invalid = rawUpdaterEvidence(all, quitVersion)
  const { checks, downloaded, downloads, hashRefusals: refusals, nativeReady, restarting } = invalid
  if (checks !== 1 || downloads !== 1 || nativeReady !== 0 || downloaded !== 0 || restarting !== 0 || refusals !== 1) {
    throw new Error(
      `Wrong-hash proof recorded checks=${checks}, downloads=${downloads}, native=${nativeReady}, ready=${downloaded}, ` +
      `restarting=${restarting}, refusals=${refusals}.`
    )
  }

  for (const name of Object.values(updaterAcceptanceCases)) {
    const proof = acceptanceCaseProof(all, name)

    if (!proof.seeded || !proof.migrated || !proof.launched) {
      throw new Error(`${name} proof was seeded=${proof.seeded}, migrated=${proof.migrated}, launched=${proof.launched}.`)
    }
  }
}

function testProcessPids() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return []
  const found = []

  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]

    if (pid !== process.pid && (command.includes(work) || command.includes(installed))) found.push(pid)
  }

  return found
}

async function killTestProcesses() {
  for (const pid of testProcessPids()) {
    try {process.kill(pid, 'SIGTERM')} catch { /* Already exited. */ }
  }
  await new Promise(resolve => setTimeout(resolve, 500))

  for (const pid of testProcessPids()) {
    try {process.kill(pid, 'SIGKILL')} catch { /* Already exited. */ }
  }
}

try {
  const nextOutput = await buildNewVersion(toVersion, {
    migrationCases: [
      updaterAcceptanceCases.betaChannel,
      updaterAcceptanceCases.legacyMarkers,
      updaterAcceptanceCases.postAbortResidue
    ],
    mode: updaterAcceptanceModes.restart,
    waitForFeed: secondFeedReady
  })
  const finalOutput = await buildNewVersion(finalVersion, {
    migrationCases: [updaterAcceptanceCases.exhaustedAttempts],
    mode: updaterAcceptanceModes.ordinaryQuit,
    waitForFeed: ordinaryFeedReady
  })
  const quitOutput = await buildNewVersion(quitVersion, {
    mode: updaterAcceptanceModes.wrongHash, waitForFeed: wrongHashReady
  })
  const baseOutput = await buildOldBridgeVersion(fromVersion)
  addBetaManifest(finalOutput)
  addBetaManifest(quitOutput)
  if (!existsSync(path.join(nextOutput, 'latest-mac.yml'))) throw new Error('N+1 latest-mac.yml was not generated.')
  if (!existsSync(path.join(finalOutput, 'latest-mac.yml'))) throw new Error('N+2 latest-mac.yml was not generated.')
  if (!existsSync(path.join(quitOutput, 'latest-mac.yml'))) throw new Error('Ordinary-Quit latest-mac.yml was not generated.')
  requireDisk(6, 'The old updater disk preflight')
  run('/usr/bin/ditto', [appIn(baseOutput), installed])
  pointFeed(nextOutput)
  // Persist the exact requested manifest path as release evidence.
  serverLogFd = openSync(feedLog, 'a')
  server = spawn('/usr/bin/python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', feed], {
    stdio: ['ignore', serverLogFd, serverLogFd]
  })
  closeSync(serverLogFd)
  serverLogFd = null
  // http.server prints its banner to stdout, block-buffered when piped, so poll the feed itself instead.
  let feedExit = null
  server.once('exit', code => {feedExit = code})
  for (const started = Date.now(); ; await new Promise(resolve => setTimeout(resolve, 200))) {
    if (feedExit !== null) {throw new Error(`Local feed exited ${feedExit}`)}
    const ready = await fetch(`http://127.0.0.1:${port}/latest-mac.yml`).then(response => response.ok, () => false)
    if (ready) {break}
    if (Date.now() - started > 15_000) {throw new Error('Local feed did not start.')}
  }
  // Baseline before 90.0.1 starts: its stock check may run as soon as the bounded migration ends,
  // before seeding returns. 90.0.0 is on the latest channel and never requests beta-mac.yml.
  const firstBetaRequests = feedRequests('beta-mac.yml')
  run('/usr/bin/open', ['-n', installed])
  await waitForEvent('launched', toVersion)
  seedLegacyUpdaterState(toVersion, finalVersion)
  seedPostAbortResidue(toVersion, finalVersion)
  pointFeed(finalOutput)
  writeFileSync(secondFeedReady, `${finalVersion}\n`)
  await waitForEvent('migration', toVersion)
  assertMigration(toVersion, {
    attemptsCleared: true,
    channel: 'beta',
    completed: true,
    failureDaysAbsent: true,
    legacyMarkersAbsent: true,
    legacyRootFieldsAbsent: true,
    shipItCacheExists: false,
    shipItStateExists: false,
    stockMigration: 1
  })
  await waitForEvent('launched', finalVersion)
  if (feedRequests('beta-mac.yml') !== firstBetaRequests + 1) {
    throw new Error('The legacy beta case did not request beta-mac.yml exactly once.')
  }
  writeFileSync(path.join(userData, 'updates.json'), `${JSON.stringify(legacyUpdaterSeed(toVersion), null, 2)}\n`)
  seedExhaustedAttempts(finalVersion, quitVersion)
  pointFeed(quitOutput)
  const secondBetaRequests = feedRequests('beta-mac.yml')
  writeFileSync(ordinaryFeedReady, `${quitVersion}\n`)
  await waitForEvent('migration', finalVersion)
  assertMigration(finalVersion, {
    attemptsCleared: true,
    channel: 'beta',
    completed: true,
    failureDaysAbsent: true,
    legacyMarkersAbsent: true,
    legacyRootFieldsAbsent: true,
    shipItCacheExists: false,
    shipItStateExists: false,
    stockMigration: 1
  })
  await waitForEvent('process-exit', finalVersion)
  await waitForInstalledVersion(quitVersion)
  run('/usr/bin/open', ['-n', installed])
  await waitForEvent('launched', quitVersion)
  if (feedRequests('beta-mac.yml') !== secondBetaRequests + 1) {
    throw new Error('The exhausted-attempt case did not request beta-mac.yml exactly once.')
  }
  pointFeed(wrongHashFeed(quitOutput))
  writeFileSync(wrongHashReady, `${wrongVersion}\n`)
  await waitForEvent('wrong-hash-refused', quitVersion)
  await waitForEvent('accepted', quitVersion)
  if (installedVersion() !== quitVersion) throw new Error(`Installed version is ${installedVersion()}, expected ${quitVersion}.`)
  assertEventCounts()
  console.log(
    `UPDATER_STOCK_ACCEPTED ${fromVersion} (old) -> ${toVersion} -> ${finalVersion} -> ` +
    `${quitVersion} (ordinary quit); wrong hash refused`
  )
  console.log(`Disposable bundle id: ${appId}`)
  console.log(`Evidence: ${stateFile}`)
} catch (error) {
  appendFileSync(stateFile, `${JSON.stringify({ event: 'harness-failed', message: String(error) })}\n`)
  console.error(`Updater acceptance failed. Evidence kept at ${work}`)
  throw error
} finally {
  server?.kill('SIGTERM')
  if (serverLogFd !== null) {closeSync(serverLogFd)}
  await killTestProcesses()

  if (bridgeCreated) {
    spawnSync('/usr/bin/git', ['-C', repository, 'worktree', 'remove', '--force', bridgeWorktree], { stdio: 'inherit' })
  }

  if (!keep && existsSync(stateFile) && readFileSync(stateFile, 'utf8').includes('"event":"accepted"')) {
    rmSync(work, { recursive: true, force: true })
  }
}
