import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MATRIX_APP_BUNDLE_ID,
  MATRIX_APP_BUNDLE_NAME,
  MATRIX_APP_DISPLAY_NAME,
  matrixAppNameProblems,
  readLocalizedDisplayName,
  readMatrixAppName,
  withLocalizedDisplayName,
  writeMatrixLocalizedName
} from './matrix-app-name.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const configs = Object.fromEntries(
  ['matrix-builder.json', 'matrix-release-builder.json'].map(file => [
    file,
    JSON.parse(readFileSync(path.join(desktop, file), 'utf8'))
  ])
)
const temporary = []

afterEach(() => temporary.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function directory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'matrix-app-name-'))
  temporary.push(root)
  return root
}

/**
 * A bundle as electron-builder 26 lays it out from a config: the file and CFBundleExecutable
 * come from executableName, CFBundleName and the helper apps from productName, and
 * extendInfo is applied last (app-builder-lib macPackager.applyCommonInfo, electronMac.createMacApp).
 */
function packedBundle(root, config, { locales = ['en', 'vi', 'ja', 'zh_CN', 'zh_TW'] } = {}) {
  const file = config.executableName ?? config.productName
  const app = path.join(root, `${file}.app`)
  const plist = {
    CFBundleIdentifier: config.appId,
    CFBundleName: config.productName,
    CFBundleDisplayName: config.productName,
    CFBundleExecutable: file,
    ...config.mac.extendInfo
  }
  mkdirSync(path.join(app, 'Contents', 'Frameworks', `${config.productName} Helper.app`), { recursive: true })
  for (const locale of locales)
    mkdirSync(path.join(app, 'Contents', 'Resources', `${locale}.lproj`), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'fixture')
  return { app, plist }
}

/** plutil -extract <key> raw, over a fixture Info.plist. */
function plutil(plist) {
  return (command, args) => {
    expect(command).toBe('plutil')
    const value = plist[args[1]]
    if (value === undefined) throw new Error('No value at that key path')
    return `${value}\n`
  }
}

function inspect(app, plist) {
  return readMatrixAppName(app, { run: plutil(plist) })
}

describe('the Matrix app is called Atum', () => {
  it.each(Object.keys(configs))('%s shows Atum and keeps the identity installed copies have', file => {
    const config = configs[file]

    // The menu bar, the About panel and the helper apps Electron finds by CFBundleName.
    expect(config.productName).toBe(MATRIX_APP_DISPLAY_NAME)
    // The bundle's file and executable name: Squirrel.Mac moves an installed copy to its
    // update's executable name, so this never changes.
    expect(config.executableName).toBe(MATRIX_APP_BUNDLE_NAME)
    expect(config.appId).toBe(MATRIX_APP_BUNDLE_ID)
    // macOS shows the localized "Atum" only while the file name equals this non-localized value.
    expect(config.mac.extendInfo.CFBundleDisplayName).toBe(config.executableName)
    expect(config.mac.extendInfo.LSHasLocalizedDisplayName).toBe(true)
    // The hook that writes the localized name before signing.
    expect(config.afterPack).toBe('scripts/matrix-after-pack.mjs')
  })

  it('names the installer disk Atum', () => {
    expect(configs['matrix-release-builder.json'].dmg.title).toBe(MATRIX_APP_DISPLAY_NAME)
  })

  it.each(Object.keys(configs))('a bundle packed from %s passes the name check once afterPack ran', file => {
    const { app, plist } = packedBundle(directory(), configs[file])

    expect(matrixAppNameProblems(inspect(app, plist))).toContain('localized_display_name')
    writeMatrixLocalizedName(path.join(app, 'Contents', 'Resources'))
    expect(matrixAppNameProblems(inspect(app, plist))).toEqual([])
  })
})

describe('writing the localized name', () => {
  it('names the app in every language the bundle lists and keeps other localized keys', () => {
    const resources = path.join(directory(), 'Resources')
    for (const locale of ['vi', 'ja', 'zh_TW']) mkdirSync(path.join(resources, `${locale}.lproj`), { recursive: true })
    writeFileSync(path.join(resources, 'icon.icns'), 'icon')
    writeFileSync(
      path.join(resources, 'vi.lproj', 'InfoPlist.strings'),
      '"NSMicrophoneUsageDescription" = "Atum nghe khi bạn nói.";\n"CFBundleDisplayName" = "Atum Matrix Candidate";\n'
    )

    // English is ensured: macOS falls back to it for a language the bundle does not list.
    expect(writeMatrixLocalizedName(resources)).toEqual(['en', 'ja', 'vi', 'zh_TW'])
    for (const locale of ['en', 'ja', 'vi', 'zh_TW']) {
      expect(
        readLocalizedDisplayName(readFileSync(path.join(resources, `${locale}.lproj`, 'InfoPlist.strings'), 'utf8'))
      ).toBe('Atum')
    }
    expect(readFileSync(path.join(resources, 'vi.lproj', 'InfoPlist.strings'), 'utf8')).toContain(
      'NSMicrophoneUsageDescription'
    )
    expect(readdirSync(resources).sort()).toEqual(['en.lproj', 'icon.icns', 'ja.lproj', 'vi.lproj', 'zh_TW.lproj'])
    expect(existsSync(path.join(resources, 'icon.icns', 'InfoPlist.strings'))).toBe(false)
  })

  it('reads and replaces only the display-name line', () => {
    expect(readLocalizedDisplayName('/* app */\nCFBundleDisplayName = "Atum";\n')).toBe('Atum')
    expect(readLocalizedDisplayName('"CFBundleName" = "Atum";\n')).toBeUndefined()
    expect(withLocalizedDisplayName('"CFBundleDisplayName" = "Old";\n"CFBundleName" = "Atum";\n')).toBe(
      '"CFBundleName" = "Atum";\n"CFBundleDisplayName" = "Atum";\n'
    )
    expect(withLocalizedDisplayName('')).toBe('"CFBundleDisplayName" = "Atum";\n')
  })
})

describe('the name check on a built bundle', () => {
  const release = configs['matrix-release-builder.json']

  function localized(root, config, options) {
    const bundle = packedBundle(root, config, options)
    writeMatrixLocalizedName(path.join(bundle.app, 'Contents', 'Resources'))
    return bundle
  }

  it('flags the shipped 0.18 layout: the menu bar, Finder and the Dock all said Atum Matrix Candidate', () => {
    const before = { ...release, productName: MATRIX_APP_BUNDLE_NAME, mac: { ...release.mac, extendInfo: {} } }
    const { app, plist } = packedBundle(directory(), before)

    expect(matrixAppNameProblems(inspect(app, plist))).toEqual([
      'menu_bar_name',
      'display_name_not_localizable',
      'localized_display_name'
    ])
  })

  it('refuses a renamed executable, which would make Squirrel move every installed copy', () => {
    const renamed = {
      ...release,
      executableName: 'Atum',
      mac: { ...release.mac, extendInfo: { ...release.mac.extendInfo, CFBundleDisplayName: 'Atum' } }
    }
    const { app, plist } = localized(directory(), renamed)

    expect(matrixAppNameProblems(inspect(app, plist))).toEqual(['executable_name', 'bundle_file_name'])
  })

  it('refuses a bundle Finder would still call Atum Matrix Candidate', () => {
    const root = directory()
    const { app, plist } = localized(root, release)

    rmSync(path.join(app, 'Contents', 'Resources', 'ja.lproj', 'InfoPlist.strings'))
    expect(matrixAppNameProblems(inspect(app, plist))).toEqual(['localized_display_name'])
    expect(matrixAppNameProblems(inspect(app, { ...plist, CFBundleDisplayName: 'Atum' }))).toContain(
      'display_name_not_localizable'
    )
    expect(matrixAppNameProblems(inspect(app, { ...plist, LSHasLocalizedDisplayName: false }))).toContain(
      'display_name_not_localizable'
    )
  })

  it('refuses a menu-bar name the helper apps do not match, and another bundle identifier', () => {
    const { app, plist } = localized(directory(), release)

    // Electron finds "<CFBundleName> Helper.app"; a mismatch would not launch.
    expect(matrixAppNameProblems(inspect(app, { ...plist, CFBundleName: 'Atum Beta' }))).toEqual([
      'menu_bar_name',
      'helper_name'
    ])
    expect(matrixAppNameProblems(inspect(app, { ...plist, CFBundleIdentifier: 'com.atum.desktop' }))).toEqual([
      'bundle_identifier'
    ])
  })
})
