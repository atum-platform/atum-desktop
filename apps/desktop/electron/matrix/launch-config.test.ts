import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { matrixConfigurationKey, matrixGoogleFullPower, parseMatrixConfig } from './config'
import {
  MATRIX_BUNDLED_CONFIG_NAME,
  matrixLaunchConfigPath,
  matrixLaunchConfigurationErrorCopy,
  readMatrixLaunchConfig
} from './launch-config'

const publicConfig = {
  issuer: 'https://identity.example.test/',
  server: 'https://matrix.example.test',
  nativeClientId: 'native-client'
}

let appData: string

beforeEach(() => {
  appData = mkdtempSync(path.join(os.tmpdir(), 'matrix-launch-config-'))
  mkdirSync(path.dirname(matrixLaunchConfigPath(appData)), { recursive: true })
  writeFileSync(matrixLaunchConfigPath(appData), JSON.stringify(publicConfig))
})

afterEach(() => rmSync(appData, { recursive: true, force: true }))

describe('native public launch configuration', () => {
  it('uses Atum-only startup refusal copy while keeping the custody folder internal', () => {
    const copy = matrixLaunchConfigurationErrorCopy()
    const words = `${copy.title}\n${copy.message}`

    expect(copy.title).toMatch(/^Atum/u)
    expect(copy.message).toContain('public-config.json')
    expect(words).not.toMatch(/Hermes|Matrix|candidate/u)
  })

  it('opens with no command-line config and keeps the same account partition on restart', () => {
    const first = readMatrixLaunchConfig(appData)
    const restart = readMatrixLaunchConfig(appData)
    expect(first).toEqual(parseMatrixConfig(publicConfig))
    expect(matrixConfigurationKey(restart)).toBe(matrixConfigurationKey(first))
  })

  it('keeps an explicit test/operator file authoritative without overwriting the default', () => {
    const explicit = path.join(appData, 'separate.json')
    const other = { ...publicConfig, server: 'https://other.example.test' }
    writeFileSync(explicit, JSON.stringify(other))
    expect(readMatrixLaunchConfig(appData, explicit)).toEqual(parseMatrixConfig(other))
    expect(readMatrixLaunchConfig(appData)).toEqual(parseMatrixConfig(publicConfig))
    expect(matrixConfigurationKey(readMatrixLaunchConfig(appData, explicit))).not.toBe(
      matrixConfigurationKey(readMatrixLaunchConfig(appData))
    )
  })

  it('never falls back to a different authority when the explicit file is missing or relative', () => {
    expect(() => readMatrixLaunchConfig(appData, path.join(appData, 'missing.json'))).toThrow(
      'matrix_public_configuration_missing'
    )
    expect(() => readMatrixLaunchConfig(appData, 'relative.json')).toThrow('matrix_public_configuration_invalid')
    expect(() => readMatrixLaunchConfig(appData, '')).toThrow('matrix_public_configuration_invalid')
  })

  it('reports missing default configuration without discovering a proof or developer server', () => {
    rmSync(matrixLaunchConfigPath(appData))
    expect(() => readMatrixLaunchConfig(appData)).toThrow('matrix_public_configuration_missing')
  })

  it.each(['{private-invalid-json', JSON.stringify({ ...publicConfig, issuer: 'http://remote.test' })])(
    'redacts invalid config instead of exposing file contents', value => {
      writeFileSync(matrixLaunchConfigPath(appData), value)
      expect(() => readMatrixLaunchConfig(appData)).toThrow(/^matrix_public_configuration_invalid$/)
    }
  )
})


/** The production account partition every installed Mac already keeps its profile under:
 * `matrixConfigurationKey` of the public configuration the owner's Macs were set up with. */
const PRODUCTION_CONFIGURATION_KEY = '1257f07a102fa61dfe36dfbc400e2ac28256de41aa064f88c252d74a644b2c1a'

const shippedDefault = () =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${MATRIX_BUNDLED_CONFIG_NAME}`, import.meta.url)), 'utf8')
  ) as Record<string, unknown>

describe('the production default carried by the app', () => {
  const bundledConfig = { ...publicConfig, server: 'https://bundled.example.test', appWorkspace: false }
  let bundled: string

  beforeEach(() => {
    bundled = path.join(appData, 'Resources', MATRIX_BUNDLED_CONFIG_NAME)
    mkdirSync(path.dirname(bundled), { recursive: true })
    writeFileSync(bundled, JSON.stringify(bundledConfig))
  })

  it('opens a fresh Mac (no operator file) on the bundled default, the same partition every launch', () => {
    rmSync(matrixLaunchConfigPath(appData))
    const first = readMatrixLaunchConfig(appData, undefined, bundled)
    expect(first).toEqual(parseMatrixConfig(bundledConfig))
    expect(matrixConfigurationKey(readMatrixLaunchConfig(appData, undefined, bundled))).toBe(
      matrixConfigurationKey(first)
    )
  })

  it('lets an operator file in Application Support win over the bundled default', () => {
    expect(readMatrixLaunchConfig(appData, undefined, bundled)).toEqual(parseMatrixConfig(publicConfig))
  })

  it('never falls back to the bundled default from a broken operator file or an explicit file', () => {
    writeFileSync(matrixLaunchConfigPath(appData), '{broken')
    expect(() => readMatrixLaunchConfig(appData, undefined, bundled)).toThrow(/^matrix_public_configuration_invalid$/)
    expect(() => readMatrixLaunchConfig(appData, path.join(appData, 'missing.json'), bundled)).toThrow(
      'matrix_public_configuration_missing'
    )
  })

  it('reports a missing or broken bundle, as a development build without one does', () => {
    rmSync(matrixLaunchConfigPath(appData))
    expect(() => readMatrixLaunchConfig(appData, undefined, path.join(appData, 'absent.json'))).toThrow(
      'matrix_public_configuration_missing'
    )
    expect(() => readMatrixLaunchConfig(appData, undefined, 'relative.json')).toThrow(
      'matrix_public_configuration_invalid'
    )
    writeFileSync(bundled, JSON.stringify({ ...bundledConfig, issuer: 'http://remote.test' }))
    expect(() => readMatrixLaunchConfig(appData, undefined, bundled)).toThrow(/^matrix_public_configuration_invalid$/)
  })

  it('ships the production endpoints: installed Macs keep their profile, and the Store is on', () => {
    const config = parseMatrixConfig(shippedDefault())
    expect(matrixConfigurationKey(config)).toBe(PRODUCTION_CONFIGURATION_KEY)
    expect(config.appWorkspace).toBe(true)
    expect(config.companyWorkspace).toBe(true)
    expect(config.companyDriveFiles).toBeUndefined()
    expect(config.companyProjectSources).toBeUndefined()
    expect(config.companyProjectReader).toBeUndefined()
    expect(config.companyFunding).toBeUndefined()
    expect(config.managedModel?.gateway).toMatch(/^https:\/\//)
    // The owner's file without the Store gate keeps the very same partition.
    const { appWorkspace: _gate, ...withoutGate } = shippedDefault()
    expect(matrixConfigurationKey(parseMatrixConfig(withoutGate))).toBe(PRODUCTION_CONFIGURATION_KEY)
  })

  it('holds only fields of the public configuration: nothing that could be a credential', () => {
    // Every field parseMatrixConfig defines is a public endpoint, a client name, a port or a gate.
    const fields: Record<string, string[] | null> = {
      issuer: null,
      server: null,
      nativeClientId: null,
      callbackPort: null,
      domain: ['nativeClientId', 'resource', 'callbackPort'],
      appWorkspace: null,
      companyWorkspace: null,
      companyDriveFiles: null,
      companyProjectSources: null,
      companyProjectReader: null,
      companyFunding: null,
      managedModel: ['gateway', 'port'],
      assistantPath: null,
      agentHandoff: null,
      googleFullPower: null
    }

    const value = shippedDefault()

    for (const [key, nested] of Object.entries(value)) {
      expect(Object.hasOwn(fields, key)).toBe(true)

      if (fields[key]) {
        expect(Object.keys(nested as object).every(name => fields[key]!.includes(name))).toBe(true)
      }
    }
  })
})

describe('company workspace rollout configuration', () => {
  it('requires company before funding or company files without changing the person account partition', () => {
    const base = { ...publicConfig, domain: { nativeClientId: 'domain', resource: 'https://api.test/matrix/v1' } }
    expect(parseMatrixConfig({ ...base, companyFunding: true }).companyFunding).toBeUndefined()
    expect(parseMatrixConfig({ ...base, companyDriveFiles: true }).companyDriveFiles).toBeUndefined()
    expect(parseMatrixConfig({ ...base, companyProjectSources: true }).companyProjectSources).toBeUndefined()
    expect(parseMatrixConfig({ ...base, companyProjectReader: true }).companyProjectReader).toBeUndefined()
    expect(parseMatrixConfig({ ...publicConfig, companyWorkspace: true, companyFunding: true }).companyFunding).toBeUndefined()
    const enabled = parseMatrixConfig({
      ...base,
      companyWorkspace: true,
      companyDriveFiles: true,
      companyProjectSources: true,
      companyProjectReader: true,
      companyFunding: true
    })
    expect(enabled.companyFunding).toBe(true)
    expect(enabled.companyDriveFiles).toBe(true)
    expect(enabled.companyProjectSources).toBe(true)
    expect(enabled.companyProjectReader).toBe(true)
    expect(matrixConfigurationKey(enabled)).toBe(matrixConfigurationKey(parseMatrixConfig(base)))
    expect(() => parseMatrixConfig({ ...base, companyFunding: 'true' })).toThrow('matrix_configuration_invalid')
    expect(() => parseMatrixConfig({ ...base, companyDriveFiles: 'true' })).toThrow('matrix_configuration_invalid')
    expect(() => parseMatrixConfig({ ...base, companyProjectSources: 'true' })).toThrow('matrix_configuration_invalid')
    expect(() => parseMatrixConfig({ ...base, companyProjectReader: 'true' })).toThrow('matrix_configuration_invalid')
  })

  it('requires an explicit boolean gate and a configured domain; toggling it retains the same account partition', () => {
    const base = { ...publicConfig, domain: { nativeClientId: 'domain', resource: 'https://api.test/matrix/v1' } }
    expect(parseMatrixConfig(base).companyWorkspace).toBeUndefined()
    expect(parseMatrixConfig({ ...publicConfig, companyWorkspace: true }).companyWorkspace).toBeUndefined()
    const enabled = parseMatrixConfig({ ...base, companyWorkspace: true })
    expect(enabled.companyWorkspace).toBe(true)
    expect(matrixConfigurationKey(enabled)).toBe(matrixConfigurationKey(parseMatrixConfig(base)))
    expect(() => parseMatrixConfig({ ...base, companyWorkspace: 'true' })).toThrow('matrix_configuration_invalid')
  })
})

describe('agent handoff configuration', () => {
  it('is off unless switched on with an explicit boolean, and never changes the account partition', () => {
    expect(parseMatrixConfig(publicConfig).agentHandoff).toBeUndefined()
    expect(parseMatrixConfig({ ...publicConfig, agentHandoff: false }).agentHandoff).toBeUndefined()
    const on = parseMatrixConfig({ ...publicConfig, agentHandoff: true })
    expect(on.agentHandoff).toBe(true)
    expect(matrixConfigurationKey(on)).toBe(matrixConfigurationKey(parseMatrixConfig(publicConfig)))
    expect(() => parseMatrixConfig({ ...publicConfig, agentHandoff: 'false' })).toThrow('matrix_configuration_invalid')
  })
})

describe('Google full power configuration', () => {
  it('is on for every configuration that does not say otherwise, the shipped default included', () => {
    expect(matrixGoogleFullPower(parseMatrixConfig(publicConfig))).toBe(true)
    expect(matrixGoogleFullPower(parseMatrixConfig(shippedDefault()))).toBe(true)
    expect(matrixGoogleFullPower(parseMatrixConfig({ ...publicConfig, googleFullPower: true }))).toBe(true)
    // The parsed shape of an existing configuration does not change.
    expect(Object.hasOwn(parseMatrixConfig(publicConfig), 'googleFullPower')).toBe(false)
    expect(Object.hasOwn(parseMatrixConfig({ ...publicConfig, googleFullPower: true }), 'googleFullPower')).toBe(false)
  })

  it('goes off only with an explicit false, takes a boolean only, and never changes the account partition', () => {
    const off = parseMatrixConfig({ ...publicConfig, googleFullPower: false })
    expect(off.googleFullPower).toBe(false)
    expect(matrixGoogleFullPower(off)).toBe(false)
    expect(matrixConfigurationKey(off)).toBe(matrixConfigurationKey(parseMatrixConfig(publicConfig)))

    for (const bad of ['false', 0, null, {}]) {
      expect(() => parseMatrixConfig({ ...publicConfig, googleFullPower: bad })).toThrow('matrix_configuration_invalid')
    }
  })

  it('is read from the operator file, which replaces the bundled default whole', () => {
    // Local/cloud placement follows the saved execution policy and current lease.
    // cloudMigrationTestAgents) keeps full power on.
    expect(matrixGoogleFullPower(readMatrixLaunchConfig(appData))).toBe(true)
    writeFileSync(matrixLaunchConfigPath(appData), JSON.stringify({ ...publicConfig, googleFullPower: false }))
    expect(matrixGoogleFullPower(readMatrixLaunchConfig(appData))).toBe(false)
  })
})
