import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FIXED_PUBLIC_ENDPOINTS,
  isFixedPublicEndpoint,
  isSingleSpkiSha256,
  parseProbeArguments,
  validateDiscoveryMetadata,
  validateJwks,
  validateMatrixAuthMetadata,
  validateMatrixVersions
} from './public-endpoints.mjs'

function discovery() {
  return {
    issuer: 'https://localhost:22981/',
    authorization_endpoint: FIXED_PUBLIC_ENDPOINTS.masAuthorization,
    token_endpoint: FIXED_PUBLIC_ENDPOINTS.masToken,
    jwks_uri: FIXED_PUBLIC_ENDPOINTS.masJwks,
    revocation_endpoint: FIXED_PUBLIC_ENDPOINTS.masRevocation,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  }
}

test('fixed public endpoint allowlist accepts only exact public URLs', () => {
  for (const endpoint of Object.values(FIXED_PUBLIC_ENDPOINTS)) assert.equal(isFixedPublicEndpoint(endpoint), true)
  for (const foreign of [
    'https://localhost:22981/oauth2/token?debug=1',
    'https://localhost:22981.evil.example/oauth2/token',
    'http://localhost:22981/oauth2/token',
    'https://localhost:22909/_matrix/client/v3/account/whoami'
  ]) assert.equal(isFixedPublicEndpoint(foreign), false)
})

test('discovery contract requires the exact issuer, endpoints, grants, S256, and public auth', () => {
  assert.equal(validateDiscoveryMetadata(discovery()), true)
  for (const change of [
    { issuer: 'https://foreign.example/' },
    { token_endpoint: 'https://foreign.example/token' },
    { jwks_uri: 'https://localhost:22981/oauth2/keys.json?x=1' },
    { grant_types_supported: ['authorization_code'] },
    { code_challenge_methods_supported: ['plain'] },
    { token_endpoint_auth_methods_supported: ['client_secret_basic'] }
  ]) assert.equal(validateDiscoveryMetadata({ ...discovery(), ...change }), false)
  assert.equal(validateDiscoveryMetadata(null), false)
  assert.equal(validateDiscoveryMetadata({}), false)
})

test('Matrix metadata and readable public JSON fail closed when malformed or foreign', () => {
  assert.equal(validateMatrixAuthMetadata({ issuer: 'https://localhost:22981/' }), true)
  assert.equal(validateMatrixAuthMetadata({ issuer: 'https://foreign.example/' }), false)
  assert.equal(validateMatrixAuthMetadata([]), false)
  assert.equal(validateJwks({ keys: [{ kty: 'RSA' }] }), true)
  assert.equal(validateJwks({ keys: [] }), false)
  assert.equal(validateJwks({ keys: ['not-a-key'] }), false)
  assert.equal(validateMatrixVersions({ versions: ['v1.11'] }), true)
  assert.equal(validateMatrixVersions({ versions: [] }), false)
  assert.equal(validateMatrixVersions({ versions: [1] }), false)
})

test('CLI accepts absolute paths and exactly one SHA-256 SPKI hash', () => {
  const hash = 'A'.repeat(43) + '='
  assert.equal(isSingleSpkiSha256(hash), true)
  assert.equal(isSingleSpkiSha256(`${hash},${hash}`), false)
  assert.equal(isSingleSpkiSha256('sha256/' + hash), false)
  assert.deepEqual(parseProbeArguments(['/tmp/playwright.mjs', '/tmp/chromium', hash]), {
    playwrightModule: '/tmp/playwright.mjs',
    chromiumExecutable: '/tmp/chromium',
    certificateSpkiSha256: hash,
    anonymousInvalidPosts: false
  })
  assert.equal(parseProbeArguments(['/tmp/playwright.mjs', '/tmp/chromium', hash, '--anonymous-invalid-posts'])?.anonymousInvalidPosts, true)
  assert.equal(parseProbeArguments(['relative', '/tmp/chromium', hash]), null)
  assert.equal(parseProbeArguments(['/tmp/playwright.mjs', '/tmp/chromium', hash, '--unexpected']), null)
})
