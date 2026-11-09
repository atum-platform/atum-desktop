import path from 'node:path'

import type { AboutPanelOptionsOptions, App } from 'electron'

import { ATUM_COPYRIGHT } from '../../shared/atum-company'

/**
 * What people call the app. The menu bar and the About panel show it (productName in
 * matrix-*-builder.json is the bundle's CFBundleName), and so do Finder, the Dock,
 * Launchpad, notifications and privacy prompts (the localized display name that
 * scripts/matrix-app-name.mjs writes into every .lproj of the bundle).
 */
export const MATRIX_APP_NAME = 'Atum'

/**
 * The name the app runs under (`app.setName`). Installed copies depend on it, so it never
 * changes and is never derived from the name people see:
 * - Electron names the Keychain item behind `safeStorage` after it ("<name> Safe Storage",
 *   account "<name> Key"), and every encrypted store (credentials, documents, Drive,
 *   outcomes) is sealed with that key. Running under "Atum" would read the old app's
 *   "Atum Safe Storage" key instead, and everyone would appear signed out.
 * - The data folder (`<appData>/<name>/<profile>/<configuration key>`), the logs folder
 *   (`~/Library/Logs/<name>`) and `public-config.json` (`<appData>/<name>/`) live under it.
 * The bundle's file and executable name keep it too: see scripts/matrix-app-name.mjs.
 */
export const MATRIX_IDENTITY_NAME = 'Atum Matrix Candidate'
export const MATRIX_BUNDLE_ID = 'com.atum.matrix-candidate'
export const MATRIX_UPDATER_CACHE_NAME = 'atum-matrix-candidate-updater'

/** A profile's data folder, exactly where installed copies keep it. */
export function matrixUserDataPath(appData: string, profile: string, configurationKey: string): string {
  return path.join(appData, MATRIX_IDENTITY_NAME, profile, configurationKey)
}

/**
 * A packaged copy on macOS: Electron's default logs folder follows the bundle's name
 * (CFBundleName, now "Atum", which is also the old app's folder), so it is pinned to where
 * installed copies write main.log. A development run (Electron's own bundle) and other
 * platforms keep Electron's default.
 */
export function matrixLogsPath(platform: NodeJS.Platform, home: string, packaged: boolean): string | undefined {
  return platform === 'darwin' && packaged ? path.join(home, 'Library', 'Logs', MATRIX_IDENTITY_NAME) : undefined
}

/** The About panel: Atum, the running version, and the company that publishes it (the
 * bundle's NSHumanReadableCopyright says the same: matrix-*-builder.json). */
export function matrixAboutPanelOptions(version: string): AboutPanelOptionsOptions {
  return { applicationName: MATRIX_APP_NAME, applicationVersion: version, copyright: ATUM_COPYRIGHT }
}

type IdentityApp = Pick<
  App,
  'getPath' | 'getVersion' | 'isPackaged' | 'setAboutPanelOptions' | 'setAppLogsPath' | 'setName' | 'setPath'
>

/**
 * Runs at startup, before anything reads a path or the Keychain: the app keeps its
 * identity (Keychain key, data, logs) and only shows its new name.
 */
export function applyMatrixAppIdentity(
  app: IdentityApp,
  options: { profile: string; configurationKey: string; platform?: NodeJS.Platform; packaged?: boolean }
): { userData: string } {
  app.setName(MATRIX_IDENTITY_NAME)

  const userData = matrixUserDataPath(app.getPath('appData'), options.profile, options.configurationKey)

  app.setPath('userData', userData)
  app.setPath('sessionData', userData)

  const logs = matrixLogsPath(
    options.platform ?? process.platform,
    app.getPath('home'),
    options.packaged ?? app.isPackaged
  )

  if (logs) {
    app.setAppLogsPath(logs)
  }

  app.setAboutPanelOptions(matrixAboutPanelOptions(app.getVersion()))

  return { userData }
}
