import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The production public configuration a packaged Matrix app opens with
 * (electron/matrix/launch-config.ts MATRIX_BUNDLED_CONFIG_NAME). */
export const MATRIX_BUNDLED_CONFIG_NAME = 'matrix-public-config.json'
export const MATRIX_PUBLIC_CONFIG_SOURCE = path.resolve(import.meta.dirname, '..', MATRIX_BUNDLED_CONFIG_NAME)

// Every field electron/matrix/config.ts defines: public endpoints, client names, ports and
// gates. Anything else (a token, a secret, a stray key) refuses the build.
const FIELDS = {
  issuer: 'endpoint',
  server: 'endpoint',
  nativeClientId: 'client',
  callbackPort: 'port',
  domain: { nativeClientId: 'client', resource: 'endpoint', callbackPort: 'port' },
  appWorkspace: 'boolean',
  companyWorkspace: 'boolean',
  companyDriveFiles: 'boolean',
  companyProjectSources: 'boolean',
  companyProjectReader: 'boolean',
  companyFunding: 'boolean',
  managedModel: { gateway: 'endpoint', port: 'port' },
  assistantPath: 'path',
  agentHandoff: 'boolean',
  googleFullPower: 'boolean'
}
const REQUIRED = ['issuer', 'server', 'nativeClientId']

function invalid(detail) {
  return new Error(`matrix_public_config_invalid:${detail}`)
}

function checkValue(kind, value, name) {
  if (kind === 'endpoint') {
    let url

    try {
      url = new URL(value)
    } catch {
      throw invalid(name)
    }

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw invalid(name)
    }
  } else if (kind === 'client') {
    if (typeof value !== 'string' || !/^[\w.-]{1,200}$/u.test(value)) throw invalid(name)
  } else if (kind === 'port') {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw invalid(name)
  } else if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(name)
  } else if (kind === 'path') {
    if (value !== 'local' && value !== 'server') throw invalid(name)
  }
}

function checkObject(fields, value, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(prefix || 'root')

  for (const [key, field] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    const kind = Object.hasOwn(fields, key) ? fields[key] : undefined

    if (kind === undefined) throw invalid(`unknown_field:${name}`)
    if (typeof kind === 'object') checkObject(kind, field, name)
    else checkValue(kind, field, name)
  }
}

/** The bundle's file, checked: production endpoints over HTTPS and nothing else. The
 * full parse (and the account partition it keeps) is electron/matrix/launch-config.test.ts. */
export function parseMatrixPublicConfigForBundle(text) {
  let value

  try {
    value = JSON.parse(text)
  } catch {
    throw invalid('json')
  }

  checkObject(FIELDS, value, '')

  for (const key of REQUIRED) {
    if (!Object.hasOwn(value, key)) throw invalid(`missing:${key}`)
  }

  if (value.managedModel !== undefined && value.domain === undefined) throw invalid('managedModel_without_domain')
  if (value.domain && (!value.domain.nativeClientId || !value.domain.resource)) throw invalid('domain')
  if (value.domain && value.domain.nativeClientId === value.nativeClientId) throw invalid('domain.nativeClientId')
  if (value.managedModel && !value.managedModel.gateway) throw invalid('managedModel')

  return value
}

/** Copies the committed configuration into the app's Resources byte for byte, after the
 * check above, and returns the digest a release verifier compares against the source. */
export function stageMatrixPublicConfig({ resources, source = MATRIX_PUBLIC_CONFIG_SOURCE, read = readFileSync, write = writeFileSync }) {
  const bytes = read(source)
  parseMatrixPublicConfigForBundle(bytes.toString('utf8'))
  const target = path.join(resources, MATRIX_BUNDLED_CONFIG_NAME)
  write(target, bytes, { mode: 0o644 })

  return { path: target, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** The committed source's digest: what every packaged app must carry. */
export function matrixPublicConfigDigest(source = MATRIX_PUBLIC_CONFIG_SOURCE, read = readFileSync) {
  const bytes = read(source)
  parseMatrixPublicConfigForBundle(bytes.toString('utf8'))

  return createHash('sha256').update(bytes).digest('hex')
}
