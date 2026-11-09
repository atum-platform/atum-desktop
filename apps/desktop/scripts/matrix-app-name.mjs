#!/usr/bin/env node
// The Matrix app's name as macOS shows it, and the bundle identity installed copies keep.
//
// People see "Atum": productName is the bundle's CFBundleName (the menu bar, the About
// panel and the helper apps Electron looks up by that name), and every .lproj carries a
// localized display name (Finder, the Dock, Launchpad, Spotlight, notifications, privacy
// prompts). macOS shows a localized display name only while the bundle's file name equals
// its non-localized CFBundleDisplayName, so that one stays the file name.
//
// The bundle keeps its file and executable name, "Atum Matrix Candidate", and its bundle
// identifier. Squirrel.Mac moves an installed app to its update's executable name whenever
// the person never renamed it (SQRLUpdater -prepareUpdateForInstallation: and SQRLInstaller
// -renamedTargetIfNeededWithTargetURL:sourceURL:), which would move every
// /Applications/Atum Matrix Candidate.app away from whatever names that path.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isMain } from './utils.mjs'

export const MATRIX_APP_DISPLAY_NAME = 'Atum'
export const MATRIX_APP_BUNDLE_NAME = 'Atum Matrix Candidate'
export const MATRIX_APP_BUNDLE_ID = 'com.atum.matrix-candidate'

const STRINGS_FILE = 'InfoPlist.strings'
const DISPLAY_NAME_LINE = /^[ \t]*"?CFBundleDisplayName"?[ \t]*=[ \t]*"((?:[^"\\\n]|\\.)*)"[ \t]*;[ \t]*$/mu

/** The localized display name from an InfoPlist.strings file, if it sets one. */
export function readLocalizedDisplayName(text) {
  return DISPLAY_NAME_LINE.exec(text)?.[1]
}

/** An InfoPlist.strings file that names the app, keeping any other localized key it had. */
export function withLocalizedDisplayName(text, name = MATRIX_APP_DISPLAY_NAME) {
  const others = String(text ?? '')
    .split('\n')
    .filter(line => line.trim() && !DISPLAY_NAME_LINE.test(line))

  return [...others, `"CFBundleDisplayName" = "${name}";`].join('\n') + '\n'
}

/**
 * Names the app in every .lproj of a packed bundle's Resources. Runs from afterPack, before
 * signing seals the bundle. English is ensured: macOS falls back to the development region
 * for a language the bundle does not list.
 */
export function writeMatrixLocalizedName(
  resources,
  fs = { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync }
) {
  const locales = fs.readdirSync(resources).filter(entry => entry.endsWith('.lproj'))

  if (!locales.includes('en.lproj')) {
    fs.mkdirSync(path.join(resources, 'en.lproj'), { recursive: true })
    locales.push('en.lproj')
  }

  for (const locale of locales) {
    const file = path.join(resources, locale, STRINGS_FILE)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

    fs.writeFileSync(file, withLocalizedDisplayName(current))
  }

  return locales.map(locale => locale.slice(0, -'.lproj'.length)).sort()
}

function plistValue(run, plist, key) {
  try {
    // A missing key is an answer here, not noise on stderr.
    return String(
      run('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    ).trim()
  } catch {
    return undefined
  }
}

/** What macOS will call a built bundle, and the identity it keeps. Reads only. */
export function readMatrixAppName(
  app,
  { run = execFileSync, readdir = readdirSync, read = readFileSync, exists = existsSync } = {}
) {
  const contents = path.join(app, 'Contents')
  const plist = path.join(contents, 'Info.plist')
  const resources = path.join(contents, 'Resources')
  const name = plistValue(run, plist, 'CFBundleName')
  const localized = {}
  let entries = []

  try {
    entries = readdir(resources).filter(entry => entry.endsWith('.lproj'))
  } catch {
    entries = []
  }

  for (const entry of entries) {
    let text

    try {
      text = read(path.join(resources, entry, STRINGS_FILE), 'utf8')
    } catch {
      text = undefined
    }

    localized[entry.slice(0, -'.lproj'.length)] =
      (text === undefined ? undefined : readLocalizedDisplayName(text)) ?? null
  }

  return {
    file: path.basename(app, '.app'),
    identifier: plistValue(run, plist, 'CFBundleIdentifier'),
    name,
    displayName: plistValue(run, plist, 'CFBundleDisplayName'),
    executable: plistValue(run, plist, 'CFBundleExecutable'),
    localizesDisplayName: plistValue(run, plist, 'LSHasLocalizedDisplayName') === 'true',
    localized,
    helper: Boolean(name) && exists(path.join(contents, 'Frameworks', `${name} Helper.app`))
  }
}

/** Closed codes for anything that would show another name, or move or orphan installed copies. */
export function matrixAppNameProblems(facts) {
  const problems = []
  const locales = Object.entries(facts.localized ?? {})

  if (facts.identifier !== MATRIX_APP_BUNDLE_ID) problems.push('bundle_identifier')
  if (facts.executable !== MATRIX_APP_BUNDLE_NAME) problems.push('executable_name')
  if (facts.file !== MATRIX_APP_BUNDLE_NAME) problems.push('bundle_file_name')
  if (facts.name !== MATRIX_APP_DISPLAY_NAME) problems.push('menu_bar_name')
  if (!facts.localizesDisplayName || facts.displayName !== facts.file) problems.push('display_name_not_localizable')
  if (!('en' in (facts.localized ?? {})) || locales.some(([, name]) => name !== MATRIX_APP_DISPLAY_NAME)) {
    problems.push('localized_display_name')
  }
  if (!facts.helper) problems.push('helper_name')

  return problems
}

function summary(facts) {
  const { localized, ...rest } = facts
  const locales = Object.entries(localized)
  const notAtum = locales.filter(([, name]) => name !== MATRIX_APP_DISPLAY_NAME).map(([locale]) => locale)

  return {
    ...rest,
    localized: {
      locales: locales.length,
      notAtum: notAtum.length && notAtum.length === locales.length ? 'all' : notAtum
    }
  }
}

if (isMain(import.meta.url)) {
  const app = process.argv[2]

  if (!app || !app.endsWith('.app')) {
    console.error('Usage: node scripts/matrix-app-name.mjs "<path>/Atum Matrix Candidate.app"')
    process.exitCode = 2
  } else {
    const facts = readMatrixAppName(path.resolve(app))
    const problems = matrixAppNameProblems(facts)

    console.log(JSON.stringify({ ...summary(facts), problems }, null, 2))
    process.exitCode = problems.length ? 1 : 0
  }
}
