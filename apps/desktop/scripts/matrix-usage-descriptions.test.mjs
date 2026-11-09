import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MATRIX_JUST_IN_TIME_FOLDERS,
  matrixJustInTimeFolderDenied
} from '../electron/matrix/just-in-time-folders.ts'

import {
  assertMatrixUsageDescriptions,
  MATRIX_USAGE_DESCRIPTIONS,
  MATRIX_USAGE_LOCALES,
  matrixBaseUsageDescription,
  matrixUsageDescriptionProblems,
  parseInfoPlistStrings,
  readMatrixUsageDescriptions
} from './matrix-usage-descriptions.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const BUILDERS = ['matrix-builder.json', 'matrix-release-builder.json']
const KEYS = Object.keys(MATRIX_USAGE_DESCRIPTIONS)
const builder = file => JSON.parse(readFileSync(path.join(desktop, file), 'utf8'))

/** What a builder puts in the bundle: its Info.plist additions and each copied InfoPlist.strings. */
function packed(file) {
  const { mac } = builder(file)
  const localized = {}

  for (const resource of mac.extraResources ?? []) {
    const match = /^([A-Za-z_]+)\.lproj\/InfoPlist\.strings$/u.exec(resource.to)

    if (match) {
      localized[match[1]] = parseInfoPlistStrings(readFileSync(path.join(desktop, resource.from), 'utf8'))
    }
  }

  return { info: mac.extendInfo, localized }
}

/** Electron's own Info.plist sentences, as an unconfigured build ships them. */
const ELECTRON_DEFAULTS = {
  NSAudioCaptureUsageDescription: 'This app needs access to audio capture',
  NSBluetoothAlwaysUsageDescription: 'This app needs access to Bluetooth',
  NSBluetoothPeripheralUsageDescription: 'This app needs access to Bluetooth',
  NSCameraUsageDescription: 'This app needs access to the camera',
  NSMicrophoneUsageDescription: 'This app needs access to the microphone'
}

const good = () => ({
  info: Object.fromEntries(KEYS.map(key => [key, matrixBaseUsageDescription(key)])),
  localized: Object.fromEntries(
    MATRIX_USAGE_LOCALES.map(locale => [locale, Object.fromEntries(KEYS.map(key => [key, MATRIX_USAGE_DESCRIPTIONS[key][locale]]))])
  )
})

describe('what a permission prompt says', () => {
  it('has a sentence for every folder a real task may open and for the microphone', () => {
    for (const key of [...MATRIX_JUST_IN_TIME_FOLDERS.map(folder => folder.usage), 'NSMicrophoneUsageDescription']) {
      expect(KEYS, key).toContain(key)
    }
  })

  it('recognizes only a protected-folder permission refusal, without exporting tool data', () => {
    expect(
      matrixJustInTimeFolderDenied('read_file', {
        args: { path: '/home/example/Documents/plan.md' },
        result: { error: 'Operation not permitted' }
      })
    ).toBe(true)
    expect(
      matrixJustInTimeFolderDenied('read_file', {
        args: { path: '/home/example/Projects/plan.md' },
        result: { error: 'Operation not permitted' }
      })
    ).toBe(false)
    expect(matrixJustInTimeFolderDenied('write_file', '/home/example/Desktop: EPERM')).toBe(false)
  })

  it('says each one in Vietnamese first, then English, and in each language Atum speaks', () => {
    for (const key of KEYS) {
      const entry = MATRIX_USAGE_DESCRIPTIONS[key]

      expect(matrixBaseUsageDescription(key)).toBe(`${entry.vi}\n${entry.en}`)
      expect(entry.vi, key).toMatch(/[ạảãàáâậầấẩẫăặằắẳẵđẹẻẽèéêệềếểễọỏõòóôộồốổỗơợờớởỡụủũùúưựừứửữịỉĩìíỵỷỹỳý]/u)
      expect(entry.en, key).toMatch(/\bassistant\b/u)

      for (const locale of ['en', ...MATRIX_USAGE_LOCALES]) {
        expect(entry[locale]?.trim(), `${locale} ${key}`).toBeTruthy()
        expect(entry[locale].length, `${locale} ${key}`).toBeLessThan(120)
        expect(entry[locale], `${locale} ${key}`).not.toMatch(/this app|needs access|Matrix|Hermes/iu)
      }
    }
  })

  it('finds Electron\'s developer sentences, a missing reason and an English-only one', () => {
    expect(matrixUsageDescriptionProblems(good())).toEqual([])

    const electron = good()
    Object.assign(electron.info, ELECTRON_DEFAULTS)
    expect(matrixUsageDescriptionProblems(electron)).toEqual(
      expect.arrayContaining(Object.keys(ELECTRON_DEFAULTS).map(key => `base_unusable:${key}`))
    )

    const english = good()
    english.info.NSCameraUsageDescription = MATRIX_USAGE_DESCRIPTIONS.NSCameraUsageDescription.en
    expect(matrixUsageDescriptionProblems(english)).toEqual(['base_not_vietnamese_first:NSCameraUsageDescription'])

    const missing = good()
    delete missing.info.NSLocalNetworkUsageDescription
    delete missing.localized.vi.NSContactsUsageDescription
    expect(matrixUsageDescriptionProblems(missing).sort()).toEqual([
      'base_unusable:NSLocalNetworkUsageDescription',
      'localized_unusable:vi:NSContactsUsageDescription'
    ])
  })

  it('finds a future key that arrives with developer text or empty', () => {
    const future = good()
    future.info.NSSpeechRecognitionUsageDescription = 'This app needs access to speech recognition'
    future.localized.fr = { NSMotionUsageDescription: ' ' }

    expect(matrixUsageDescriptionProblems(future)).toEqual([
      'undeclared_unusable:NSSpeechRecognitionUsageDescription',
      'localized_unusable:fr:NSMotionUsageDescription'
    ])
  })
})

describe.each(BUILDERS)('%s', file => {
  it('puts exactly these sentences in the bundle, with nothing a prompt could show empty', () => {
    const { info, localized } = packed(file)

    for (const key of KEYS) {
      expect(info[key], key).toBe(matrixBaseUsageDescription(key))

      for (const locale of MATRIX_USAGE_LOCALES) {
        expect(localized[locale]?.[key], `${locale} ${key}`).toBe(MATRIX_USAGE_DESCRIPTIONS[key][locale])
      }
    }

    // As packed over Electron's defaults: every developer sentence is replaced.
    expect(matrixUsageDescriptionProblems({ info: { ...ELECTRON_DEFAULTS, ...info }, localized })).toEqual([])
  })
})

const temporary = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'darwin')('a packed bundle, read as macOS reads it', () => {
  it('reads Info.plist and every InfoPlist.strings with plutil, and refuses a bundle still saying Electron\'s words', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'atum-usage-'))
    temporary.push(root)

    const app = path.join(root, 'Atum Matrix Candidate.app')
    const resources = path.join(app, 'Contents', 'Resources')
    const { info, localized } = packed('matrix-release-builder.json')

    for (const locale of [...MATRIX_USAGE_LOCALES, 'en', 'fr']) {
      mkdirSync(path.join(resources, `${locale}.lproj`), { recursive: true })
    }

    for (const locale of MATRIX_USAGE_LOCALES) {
      writeFileSync(
        path.join(resources, `${locale}.lproj`, 'InfoPlist.strings'),
        readFileSync(path.join(desktop, 'assets', 'macos', `${locale}.lproj`, 'InfoPlist.strings'))
      )
    }

    // As matrix-app-name.mjs leaves English: only the display name.
    writeFileSync(path.join(resources, 'en.lproj', 'InfoPlist.strings'), '"CFBundleDisplayName" = "Atum";\n')

    const plist = path.join(app, 'Contents', 'Info.plist')
    const json = path.join(root, 'info.json')
    writeFileSync(json, JSON.stringify({ CFBundleIdentifier: 'com.atum.matrix-candidate', ...ELECTRON_DEFAULTS, ...info }))
    execFileSync('plutil', ['-convert', 'xml1', '-o', plist, json])

    const read = readMatrixUsageDescriptions(app)
    expect(read.info.NSCameraUsageDescription).toBe(matrixBaseUsageDescription('NSCameraUsageDescription'))
    expect(read.localized.vi).toEqual(localized.vi)
    expect(() => assertMatrixUsageDescriptions(app)).not.toThrow()

    writeFileSync(json, JSON.stringify({ CFBundleIdentifier: 'com.atum.matrix-candidate', ...info, ...ELECTRON_DEFAULTS }))
    execFileSync('plutil', ['-convert', 'xml1', '-o', plist, json])
    expect(() => assertMatrixUsageDescriptions(app)).toThrow(/matrix_usage_descriptions_invalid:base_unusable:NSMicrophoneUsageDescription/u)
  })
})
