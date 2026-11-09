// Public endpoint/CORS probe only. It does not start OAuth, create an account, or prove crypto.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FIXED_PUBLIC_ENDPOINTS = Object.freeze({
  browserOrigin: 'http://localhost:4317',
  masDiscovery: 'https://localhost:22981/.well-known/openid-configuration',
  masAuthorization: 'https://localhost:22981/authorize',
  masToken: 'https://localhost:22981/oauth2/token',
  masJwks: 'https://localhost:22981/oauth2/keys.json',
  masRevocation: 'https://localhost:22981/oauth2/revoke',
  matrixAuthMetadata: 'https://localhost:22909/_matrix/client/v1/auth_metadata',
  matrixVersions: 'https://localhost:22909/_matrix/client/versions'
})

export const PUBLIC_ENDPOINT_CLASSES = Object.freeze([
  'browser-origin',
  'mas-discovery',
  'mas-authorization',
  'mas-token',
  'mas-jwks',
  'mas-revocation',
  'matrix-auth-metadata',
  'matrix-versions'
])

const issuer = 'https://localhost:22981/'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArrayIncludes(value, required) {
  return Array.isArray(value) && value.every(item => typeof item === 'string') && value.includes(required)
}

/** Returns true only for one of the probe's fixed public URLs, without query text. */
export function isFixedPublicEndpoint(value) {
  return typeof value === 'string' && Object.values(FIXED_PUBLIC_ENDPOINTS).includes(value)
}

/** Validates the minimum public-client OIDC metadata contract without following metadata URLs. */
export function validateDiscoveryMetadata(metadata) {
  return object(metadata) &&
    metadata.issuer === issuer &&
    metadata.authorization_endpoint === FIXED_PUBLIC_ENDPOINTS.masAuthorization &&
    metadata.token_endpoint === FIXED_PUBLIC_ENDPOINTS.masToken &&
    metadata.jwks_uri === FIXED_PUBLIC_ENDPOINTS.masJwks &&
    metadata.revocation_endpoint === FIXED_PUBLIC_ENDPOINTS.masRevocation &&
    stringArrayIncludes(metadata.response_types_supported, 'code') &&
    stringArrayIncludes(metadata.grant_types_supported, 'authorization_code') &&
    stringArrayIncludes(metadata.grant_types_supported, 'refresh_token') &&
    stringArrayIncludes(metadata.code_challenge_methods_supported, 'S256') &&
    stringArrayIncludes(metadata.token_endpoint_auth_methods_supported, 'none')
}

/** Binds Synapse's public metadata to the same exact browser-facing issuer. */
export function validateMatrixAuthMetadata(metadata) {
  return object(metadata) && metadata.issuer === issuer
}

/** Accept only a non-empty, object-shaped JWKS; key contents remain unlogged. */
export function validateJwks(jwks) {
  return object(jwks) && Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.every(object)
}

/** A Matrix versions response must be readable JSON with at least one advertised version. */
export function validateMatrixVersions(versions) {
  return object(versions) && Array.isArray(versions.versions) && versions.versions.length > 0 &&
    versions.versions.every(version => typeof version === 'string')
}

/** Chromium's exception list receives precisely one SHA-256 SPKI digest, never a list or flag. */
export function isSingleSpkiSha256(value) {
  return typeof value === 'string' && /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{43})$/.test(value)
}

export function parseProbeArguments(args) {
  const anonymousInvalidPosts = args.at(-1) === '--anonymous-invalid-posts'
  const positional = anonymousInvalidPosts ? args.slice(0, -1) : args
  if (positional.length !== 3 || !isAbsolute(positional[0]) || !isAbsolute(positional[1]) ||
      !isSingleSpkiSha256(positional[2]) || args.length !== positional.length + Number(anonymousInvalidPosts)) {
    return null
  }

  return {
    playwrightModule: resolve(positional[0]),
    chromiumExecutable: resolve(positional[1]),
    certificateSpkiSha256: positional[2],
    anonymousInvalidPosts
  }
}

function emptyResult(anonymousInvalidPosts) {
  const result = {
    status: 'failed',
    publicEndpointClasses: PUBLIC_ENDPOINT_CLASSES,
    browserOrigin: false,
    masDiscovery: false,
    discoveryContract: false,
    masJwks: false,
    matrixAuthMetadata: false,
    matrixVersions: false,
    browserCors: false,
    realOAuthOrCryptoAcceptance: false
  }
  if (anonymousInvalidPosts) {
    result.anonymousInvalidTokenPost = false
    result.anonymousInvalidRevocationPost = false
  }
  return result
}

async function browserJson(page, url) {
  return page.evaluate(async endpoint => {
    const response = await fetch(endpoint, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    })
    if (!response.ok) throw new Error('public_endpoint_unavailable')
    return response.json()
  }, url)
}

async function anonymousInvalidFormPost(page, url) {
  return page.evaluate(async endpoint => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'invalid_probe=1',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    })
    return response.status >= 400 && response.status < 500
  }, url)
}

async function run() {
  const options = parseProbeArguments(process.argv.slice(2))
  const result = emptyResult(options?.anonymousInvalidPosts === true)
  let context
  let profile

  try {
    if (!options || !existsSync(options.playwrightModule) || !existsSync(options.chromiumExecutable)) throw new Error('invalid_input')

    const { chromium } = createRequire(import.meta.url)(options.playwrightModule)
    profile = mkdtempSync(join(tmpdir(), 'atum-public-endpoints-'))
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: options.chromiumExecutable,
      args: [`--ignore-certificate-errors-spki-list=${options.certificateSpkiSha256}`]
    })
    const page = await context.newPage()
    await page.goto(FIXED_PUBLIC_ENDPOINTS.browserOrigin, { waitUntil: 'domcontentloaded' })
    result.browserOrigin = true

    const discovery = await browserJson(page, FIXED_PUBLIC_ENDPOINTS.masDiscovery)
    result.masDiscovery = true
    if (!validateDiscoveryMetadata(discovery)) throw new Error('discovery_contract')
    result.discoveryContract = true

    const jwks = await browserJson(page, FIXED_PUBLIC_ENDPOINTS.masJwks)
    if (!validateJwks(jwks)) throw new Error('jwks_contract')
    result.masJwks = true

    const authMetadata = await browserJson(page, FIXED_PUBLIC_ENDPOINTS.matrixAuthMetadata)
    if (!validateMatrixAuthMetadata(authMetadata)) throw new Error('matrix_auth_contract')
    result.matrixAuthMetadata = true

    const versions = await browserJson(page, FIXED_PUBLIC_ENDPOINTS.matrixVersions)
    if (!validateMatrixVersions(versions)) throw new Error('matrix_versions_contract')
    result.matrixVersions = true
    // Public GET CORS is proven independently of malformed POST error semantics.
    result.browserCors = true

    if (options.anonymousInvalidPosts) {
      result.anonymousInvalidTokenPost = await anonymousInvalidFormPost(page, FIXED_PUBLIC_ENDPOINTS.masToken)
      result.anonymousInvalidRevocationPost = await anonymousInvalidFormPost(page, FIXED_PUBLIC_ENDPOINTS.masRevocation)
      if (!result.anonymousInvalidTokenPost || !result.anonymousInvalidRevocationPost) throw new Error('anonymous_post_contract')
    }

    result.status = 'passed'
  } catch {
    // Deliberately do not print errors, URLs, response bodies, cookies, or query text.
  } finally {
    await context?.close()
    // This exact directory was created above, contains no authenticated state, and is ours alone.
    if (profile) rmSync(profile, { recursive: true, force: true })
  }

  console.log(JSON.stringify(result))
  if (result.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run()
}
