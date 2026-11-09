import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { createNativeAppInventory, type NativeAppInventoryDependencies, NativeAppInventoryError } from './native-app-inventory'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atum-native-app-inventory-'))
  temporaryDirectories.push(directory)

  return directory
}

async function appBundle(root: string, name: string, bundleId: string, options: { backgroundOnly?: boolean | string } = {}): Promise<string> {
  const bundle = path.join(root, name)
  const contents = path.join(bundle, 'Contents')
  await fs.mkdir(contents, { recursive: true })

  const background = options.backgroundOnly === true ? '<key>LSBackgroundOnly</key><true/>'
    : typeof options.backgroundOnly === 'string' ? `<key>LSBackgroundOnly</key><string>${options.backgroundOnly}</string>` : ''

  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleDisplayName</key><string>${name.replace(/\.app$/u, '')}</string>
${background}
</dict></plist>\n`)

  return bundle
}

function dependencies(root: string, extra: NativeAppInventoryDependencies = {}): NativeAppInventoryDependencies {
  return { applicationRoots: [root], homeDirectory: root, platform: 'linux', ...extra }
}

test('lists one canonical app, skips nested helpers and background-only apps', async () => {
  const root = await fixture()
  const main = await appBundle(root, 'Primary.app', 'dev.atum.primary')
  await appBundle(path.join(main, 'Contents', 'Helpers'), 'Nested Helper.app', 'dev.atum.helper')
  await appBundle(root, 'Background.app', 'dev.atum.background', { backgroundOnly: true })
  await fs.symlink(main, path.join(root, 'Primary alias.app'))
  const iconRequests: string[] = []

  const inventory = createNativeAppInventory(dependencies(root, {
    getAppPresentation: async paths => {
      iconRequests.push(...paths)

      return { icons: Object.fromEntries(paths.map(candidate => [candidate, `icon:${path.basename(candidate)}`])), names: {} }
    }
  }))

  const apps = await inventory.list()
  const canonicalMain = await fs.realpath(main)

  assert.deepEqual(apps, [{
    id: apps[0].id,
    name: 'Primary',
    bundleId: 'dev.atum.primary',
    icon: 'icon:Primary.app'
  }])
  assert.equal(iconRequests.length, 1)
  assert.deepEqual(await inventory.resolve(apps[0].id), { entry: apps[0], path: canonicalMain })
})

test('coalesces concurrent inventories and batches canonical app icons', async () => {
  const root = await fixture()
  const first = await appBundle(root, 'First.app', 'dev.atum.first')
  const second = await appBundle(root, 'Second.app', 'dev.atum.second')
  const batches: string[][] = []
  let release!: () => void
  const ready = new Promise<void>(resolve => {release = resolve})

  const inventory = createNativeAppInventory(dependencies(root, {
    getAppPresentation: async paths => {
      batches.push([...paths])
      await ready

      return { icons: Object.fromEntries(paths.map(candidate => [candidate, `icon:${path.basename(candidate)}`])), names: {} }
    }
  }))

  const one = inventory.list()
  const two = inventory.list(true)
  release()
  const [left, right] = await Promise.all([one, two])
  assert.deepEqual(left, right)
  assert.equal(batches.length, 1)
  assert.deepEqual([...batches[0]].sort(), [await fs.realpath(first), await fs.realpath(second)].sort())
  assert.deepEqual(left.map(entry => entry.icon), ['icon:First.app', 'icon:Second.app'])
})

test('scans exactly the launcher roots and never asks Spotlight', async () => {
  const read: string[] = []
  const processes: string[] = []

  const inventory = createNativeAppInventory({
    homeDirectory: '/home/example',
    platform: 'darwin',
    readDirectory: async directory => {
      read.push(directory)

      return []
    },
    execFile(file, _args, _options, callback) {
      processes.push(file)
      callback(null, '', '')
    }
  })

  assert.deepEqual(await inventory.list(), [])
  assert.deepEqual(read.sort(), ['/Applications', '/System/Applications', '/home/example/Applications'])
  assert.deepEqual(processes, [])
})

test('lists apps in Applications subfolders but not bundles elsewhere on disk', async () => {
  const root = await fixture()
  const applications = path.join(root, 'Applications')
  await appBundle(path.join(applications, 'Utilities'), 'Utility.app', 'dev.atum.utility')
  await appBundle(path.join(root, 'Library', 'Application Support', 'Vendor'), 'Uninstaller.app', 'dev.atum.uninstaller')

  const inventory = createNativeAppInventory(dependencies(applications))

  assert.deepEqual((await inventory.list()).map(entry => entry.bundleId), ['dev.atum.utility'])
})

test('never lists helpers inside a renamed bundle copy', async () => {
  const root = await fixture()
  const copy = path.join(root, 'Atum.app.rollback-pre-1234')
  await appBundle(path.join(copy, 'Contents', 'Frameworks'), 'Atum Helper.app', 'dev.atum.helper')
  await appBundle(root, 'Atum.app', 'dev.atum.app')

  const inventory = createNativeAppInventory(dependencies(root))

  assert.deepEqual((await inventory.list()).map(entry => entry.bundleId), ['dev.atum.app'])
})

test('names apps by their localized Finder display name and sorts by it', async () => {
  const root = await fixture()
  await appBundle(root, 'Calendar.app', 'com.apple.iCal')
  await appBundle(root, 'Notes.app', 'com.apple.Notes')
  const localized: Record<string, string> = { 'Calendar.app': 'Lịch.app', 'Notes.app': 'Ghi chú' }

  const inventory = createNativeAppInventory(dependencies(root, {
    getAppPresentation: async paths => ({ icons: {}, names: Object.fromEntries(paths.map(candidate => [candidate, localized[path.basename(candidate)]!])) })
  }))

  assert.deepEqual((await inventory.list()).map(entry => entry.name), ['Ghi chú', 'Lịch'])
})

test('keeps the Info.plist name when Finder presentation is unavailable, and asks again next time', async () => {
  const root = await fixture()
  await appBundle(root, 'Plain.app', 'dev.atum.plain')
  let calls = 0

  const inventory = createNativeAppInventory(dependencies(root, {
    getAppPresentation: async paths => {
      calls += 1

      if (calls === 1) {throw new Error('helper unavailable')}

      return { icons: {}, names: Object.fromEntries(paths.map(candidate => [candidate, 'Đơn giản'])) }
    }
  }))

  assert.deepEqual((await inventory.list()).map(entry => entry.name), ['Plain'])
  assert.deepEqual((await inventory.list(true)).map(entry => entry.name), ['Đơn giản'])
})

test('a rescan asks the helper only for new or changed bundles', async () => {
  const root = await fixture()
  await appBundle(root, 'First.app', 'dev.atum.first')
  const requested: string[][] = []

  const inventory = createNativeAppInventory(dependencies(root, {
    getAppPresentation: async paths => {
      requested.push(paths.map(candidate => path.basename(candidate)))

      return { icons: Object.fromEntries(paths.map(candidate => [candidate, `icon:${path.basename(candidate)}`])), names: {} }
    }
  }))

  await inventory.list()
  await appBundle(root, 'Second.app', 'dev.atum.second')
  const entries = await inventory.list(true)

  assert.deepEqual(requested, [['First.app'], ['Second.app']])
  assert.deepEqual(entries.map(entry => entry.icon), ['icon:First.app', 'icon:Second.app'])
})

test('lists every real install even when two share a bundle id, as Launchpad does', async () => {
  const root = await fixture()
  const release = await appBundle(path.join(root, 'Applications'), 'Xcode.app', 'com.apple.dt.Xcode')
  const beta = await appBundle(path.join(root, 'Applications'), 'Xcode-beta.app', 'com.apple.dt.Xcode')

  const inventory = createNativeAppInventory({ applicationRoots: [path.join(root, 'Applications')], platform: 'linux' })
  const entries = await inventory.list()

  assert.deepEqual(entries.map(entry => entry.name), ['Xcode', 'Xcode-beta'])
  assert.deepEqual(
    await Promise.all(entries.map(async entry => (await inventory.resolve(entry.id)).path)),
    [await fs.realpath(release), await fs.realpath(beta)]
  )
})

test('does not list a symlink that points out of the launcher roots', async () => {
  const root = await fixture()
  const applications = path.join(root, 'Applications')
  const outside = await appBundle(path.join(root, 'Library', 'Application Support', 'Vendor'), 'CleanUp.app', 'dev.atum.cleanup')
  const inside = await appBundle(applications, 'Real.app', 'dev.atum.real')
  await fs.mkdir(path.join(applications, 'Utilities'), { recursive: true })
  await fs.symlink(outside, path.join(applications, 'Utilities', 'CleanUp.app'))
  await fs.symlink(inside, path.join(applications, 'Utilities', 'Real alias.app'))

  const inventory = createNativeAppInventory(dependencies(applications))

  assert.deepEqual((await inventory.list()).map(entry => entry.bundleId), ['dev.atum.real'])
})

test('treats a loosely written LSBackgroundOnly as background-only', async () => {
  const root = await fixture()
  await appBundle(root, 'LogTransport2.app', 'dev.atum.log', { backgroundOnly: '1' })
  await appBundle(root, 'Agent.app', 'dev.atum.agent', { backgroundOnly: 'YES' })
  await appBundle(root, 'Visible.app', 'dev.atum.visible', { backgroundOnly: '0' })

  const inventory = createNativeAppInventory(dependencies(root))

  assert.deepEqual((await inventory.list()).map(entry => entry.bundleId), ['dev.atum.visible'])
})

test('lists a wrapped iPhone/iPad app and launches its outer bundle', async () => {
  const root = await fixture()
  const outer = path.join(root, 'Tiny Game.app')
  const inner = path.join(outer, 'Wrapper', 'TinyGame.app')
  await fs.mkdir(inner, { recursive: true })
  await fs.writeFile(path.join(inner, 'Info.plist'), `<?xml version="1.0"?><plist><dict>
<key>CFBundleIdentifier</key><string>dev.atum.tiny</string>
<key>CFBundleDisplayName</key><string>Tiny Game</string>
</dict></plist>\n`)
  await fs.symlink('Wrapper/TinyGame.app', path.join(outer, 'WrappedBundle'))
  const calls: Array<readonly string[]> = []

  const inventory = createNativeAppInventory(dependencies(root, {
    execFile(_file, args, _options, callback) {
      calls.push(args)
      callback(null, '', '')
    }
  }))

  const [entry] = await inventory.list()

  assert.equal(entry?.bundleId, 'dev.atum.tiny')
  await inventory.launch(entry!.id)
  assert.deepEqual(calls, [['-a', await fs.realpath(outer)]])
})

test('rejects a removed or replaced bundle before launching it', async () => {
  const root = await fixture()
  const app = await appBundle(root, 'Replace Me.app', 'dev.atum.original')
  const launchCalls: Array<{ file: string; args: readonly string[] }> = []

  const inventory = createNativeAppInventory(dependencies(root, {
    execFile(file, args, _options, callback) {
      launchCalls.push({ file, args })
      callback(null, '', '')
    }
  }))

  const [entry] = await inventory.list()
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
<key>CFBundleIdentifier</key><string>dev.atum.replacement</string>
<key>CFBundleName</key><string>Replacement</string>
</dict></plist>\n`)

  await assert.rejects(inventory.launch(entry.id), error => error instanceof NativeAppInventoryError && error.code === 'APP_CHANGED')
  assert.deepEqual(launchCalls, [])
})

test('passes bundle and document paths as literal open argv values', async () => {
  const root = await fixture()
  const app = await appBundle(root, 'Odd $(touch should-not-run).app', 'dev.atum.safe')
  const document = '/tmp/quote "$(open /Applications/Calculator.app)"\nreport.docx'
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = []

  const inventory = createNativeAppInventory(dependencies(root, {
    execFile(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, '', '')
    }
  }))

  const [entry] = await inventory.list()
  const canonicalApp = await fs.realpath(app)

  const result = await inventory.launch(entry.id, document)

  assert.deepEqual(result, { entry, path: canonicalApp })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/usr/bin/open')
  assert.deepEqual(calls[0].args, ['-a', canonicalApp, '--', document])
  assert.deepEqual(calls[0].options, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
})
