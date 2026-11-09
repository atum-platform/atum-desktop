import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MATRIX_BUNDLED_CONFIG_NAME,
  MATRIX_PUBLIC_CONFIG_SOURCE,
  matrixPublicConfigDigest,
  parseMatrixPublicConfigForBundle,
  stageMatrixPublicConfig
} from './stage-matrix-public-config.mjs'

const valid = {
  issuer: 'https://auth.example.test/',
  server: 'https://chat.example.test',
  nativeClientId: 'native-client',
  domain: { nativeClientId: 'domain-client', resource: 'https://api.example.test/api/matrix/v1' },
  managedModel: { gateway: 'https://gateway.example.test' },
  appWorkspace: true
}

let root

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'matrix-public-config-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the public configuration a Matrix bundle carries', () => {
  it('copies the committed file into Resources byte for byte, readable by the app', () => {
    const source = path.join(root, 'source.json')
    const text = `${JSON.stringify(valid, null, 2)}\n`
    writeFileSync(source, text)

    const staged = stageMatrixPublicConfig({ resources: root, source })

    expect(staged.path).toBe(path.join(root, MATRIX_BUNDLED_CONFIG_NAME))
    expect(readFileSync(staged.path, 'utf8')).toBe(text)
    expect(staged.sha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(staged.sha256).toBe(matrixPublicConfigDigest(source))
    // The app refuses a group/world-writable services file; keep the config the same.
    expect(statSync(staged.path).mode & 0o022).toBe(0)
  })

  it.each([
    ['a credential-looking field', { ...valid, accessToken: 'secret' }],
    ['a nested unknown field', { ...valid, managedModel: { gateway: 'https://gateway.example.test', key: 'x' } }],
    ['a plain-HTTP endpoint', { ...valid, server: 'http://chat.example.test' }],
    ['credentials in an endpoint', { ...valid, issuer: 'https://user:pass@auth.example.test/' }],
    ['a missing issuer', { ...valid, issuer: undefined }],
    ['the model gateway without the domain API', { ...valid, domain: undefined }],
    ['the same client for chat and the domain API', { ...valid, domain: { ...valid.domain, nativeClientId: 'native-client' } }],
    ['a gate that is not a boolean', { ...valid, appWorkspace: 'true' }],
    ['a Google full power switch that is not a boolean', { ...valid, googleFullPower: 'false' }]
  ])('refuses %s, before anything is written', (_name, value) => {
    const source = path.join(root, 'source.json')
    writeFileSync(source, JSON.stringify(value))
    expect(() => stageMatrixPublicConfig({ resources: root, source })).toThrow(/^matrix_public_config_invalid:/)
    expect(() => statSync(path.join(root, MATRIX_BUNDLED_CONFIG_NAME))).toThrow()
  })

  it('lets a release carry the Google full power switch either way', () => {
    for (const googleFullPower of [true, false]) {
      expect(parseMatrixPublicConfigForBundle(JSON.stringify({ ...valid, googleFullPower })).googleFullPower).toBe(googleFullPower)
    }
  })

  it('refuses a file that is not JSON', () => {
    expect(() => parseMatrixPublicConfigForBundle('{not json')).toThrow('matrix_public_config_invalid:json')
  })

  it('accepts the committed production configuration', () => {
    const text = readFileSync(MATRIX_PUBLIC_CONFIG_SOURCE, 'utf8')
    const value = parseMatrixPublicConfigForBundle(text)
    expect(value.appWorkspace).toBe(true)
    expect(value.companyWorkspace).toBe(true)
    expect('companyDriveFiles' in value).toBe(false)
    expect('companyProjectSources' in value).toBe(false)
    expect('companyProjectReader' in value).toBe(false)
    expect('companyFunding' in value).toBe(false)
    expect(new URL(value.server).protocol).toBe('https:')
    // What the bundle check accepts is exactly what staging copies and a release verifies.
    const staged = stageMatrixPublicConfig({ resources: root })
    expect(readFileSync(staged.path, 'utf8')).toBe(text)
    expect(staged.sha256).toBe(matrixPublicConfigDigest())
  })
})
