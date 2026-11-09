import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ATUM_COMPANY } from '../../shared/atum-company'

import {
  applyMatrixAppIdentity,
  MATRIX_APP_NAME,
  MATRIX_IDENTITY_NAME,
  matrixAboutPanelOptions,
  matrixLogsPath,
  matrixUserDataPath
} from './app-identity'
import { matrixLaunchConfigPath } from './launch-config'

// Preserve the recovery and user-visible behavior covered by this path.
const INSTALLED_FOLDER = 'Atum Matrix Candidate'
const configurationKey = '1257f07a102fa61dfe36dfbc400e2ac28256de41aa064f88c252d74a644b2c1a'
const temporary: string[] = []

afterEach(() => temporary.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function fakeApp(home: string, version = '0.19.0') {
  const calls: string[] = []

  const app = {
    getPath: vi.fn((name: string) => {
      if (name === 'appData') {
        return path.join(home, 'Library', 'Application Support')
      }

      if (name === 'home') {
        return home
      }

      throw new Error(`unexpected path ${name}`)
    }),
    getVersion: vi.fn(() => version),
    isPackaged: true,
    setName: vi.fn((name: string) => void calls.push(`name:${name}`)),
    setPath: vi.fn((name: string, value: string) => void calls.push(`path:${name}:${value}`)),
    setAppLogsPath: vi.fn((value?: string) => void calls.push(`logs:${value}`)),
    setAboutPanelOptions: vi.fn(() => void calls.push('about'))
  }

  return { app: app as unknown as Parameters<typeof applyMatrixAppIdentity>[0], fake: app, calls }
}

describe('the app shows Atum but keeps its identity', () => {
  it('opens the data an installed copy already has, not the old app’s folder', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'matrix-identity-'))
    temporary.push(home)
    const appData = path.join(home, 'Library', 'Application Support')
    const installed = path.join(appData, INSTALLED_FOLDER, 'candidate', configurationKey)
    mkdirSync(installed, { recursive: true })
    writeFileSync(path.join(installed, 'credentials.json'), 'sealed')
    // The retired app's folder sits beside it; the renamed app must never read it.
    mkdirSync(path.join(appData, 'Atum'), { recursive: true })

    const { app } = fakeApp(home)
    const { userData } = applyMatrixAppIdentity(app, { profile: 'candidate', configurationKey, platform: 'darwin' })

    expect(userData).toBe(installed)
    expect(existsSync(path.join(userData, 'credentials.json'))).toBe(true)
    expect(userData.startsWith(path.join(appData, MATRIX_APP_NAME) + path.sep)).toBe(false)
    expect(matrixUserDataPath(appData, 'candidate', configurationKey)).toBe(installed)
  })

  it('runs under the identity name, so safeStorage keeps the Keychain key that sealed the data', () => {
    const { app, fake } = fakeApp('/home/example')

    applyMatrixAppIdentity(app, { profile: 'candidate', configurationKey, platform: 'darwin' })

    expect(fake.setName).toHaveBeenCalledOnce()
    const [name] = fake.setName.mock.calls[0]
    // Electron's Keychain item is "<app name> Safe Storage" / "<app name> Key".
    expect(`${name} Safe Storage`).toBe('Atum Matrix Candidate Safe Storage')
    expect(name).not.toBe(MATRIX_APP_NAME)
  })

  it('sets the name before any path, and the session shares the data folder', () => {
    const { app, calls } = fakeApp('/home/example')
    const appData = '/home/example/Library/Application Support'
    const expected = path.join(appData, INSTALLED_FOLDER, 'candidate', configurationKey)

    applyMatrixAppIdentity(app, { profile: 'candidate', configurationKey, platform: 'darwin' })

    expect(calls).toEqual([
      `name:${MATRIX_IDENTITY_NAME}`,
      `path:userData:${expected}`,
      `path:sessionData:${expected}`,
      `logs:${path.join('/home/example', 'Library', 'Logs', INSTALLED_FOLDER)}`,
      'about'
    ])
  })

  it('keeps main.log where installed copies write it on macOS, and Electron’s default elsewhere', () => {
    expect(matrixLogsPath('darwin', '/home/example', true)).toBe('/home/example/Library/Logs/Atum Matrix Candidate')
    // CFBundleName is now "Atum": the unpinned default would be the old app's folder.
    expect(matrixLogsPath('darwin', '/home/example', true)).not.toBe('/home/example/Library/Logs/Atum')
    // A development run is Electron's own bundle, whose default folder never changed.
    expect(matrixLogsPath('darwin', '/home/example', false)).toBeUndefined()
    expect(matrixLogsPath('linux', '/home/someone', true)).toBeUndefined()

    const linux = fakeApp('/home/someone')
    applyMatrixAppIdentity(linux.app, { profile: 'candidate', configurationKey, platform: 'linux' })
    expect(linux.fake.setAppLogsPath).not.toHaveBeenCalled()

    const development = fakeApp('/home/example')
    applyMatrixAppIdentity(development.app, {
      profile: 'candidate',
      configurationKey,
      platform: 'darwin',
      packaged: false
    })
    expect(development.fake.setAppLogsPath).not.toHaveBeenCalled()
  })

  it('names the About panel Atum with the running version and the company that publishes it', () => {
    const { app, fake } = fakeApp('/home/example', '0.19.0')

    applyMatrixAppIdentity(app, { profile: 'candidate', configurationKey, platform: 'darwin' })

    expect(fake.setAboutPanelOptions).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: 'Atum', applicationVersion: '0.19.0' })
    )
    const about = matrixAboutPanelOptions('1.2.3')
    expect(about).toMatchObject({ applicationName: MATRIX_APP_NAME, applicationVersion: '1.2.3' })
    // The company, never the engine's maker.
    expect(about.copyright).toContain(ATUM_COMPANY.englishName)
    expect(about.copyright).not.toMatch(/Nous/i)
  })

  it.each(['matrix-builder.json', 'matrix-release-builder.json'])(
    "%s gives the bundle the About panel's copyright (Finder's Get Info reads it)",
    file => {
      const builder = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8')) as {
        copyright?: string
      }

      expect(builder.copyright).toBe(matrixAboutPanelOptions('1.2.3').copyright)
    }
  )

  it('reads the service configuration from the folder installed copies were set up with', () => {
    const appData = '/home/example/Library/Application Support'

    expect(matrixLaunchConfigPath(appData)).toBe(path.join(appData, INSTALLED_FOLDER, 'public-config.json'))
  })
})
