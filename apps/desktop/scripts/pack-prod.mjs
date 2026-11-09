#!/usr/bin/env node
/**
 * pack-prod.mjs — pack Atum against the PRODUCTION control plane.
 *
 * `npm run pack` builds against whatever ATUM_PUBLIC_* happens to be in the
 * shell. That is fine for nonprod and dangerous for prod: the plane a build
 * points at is baked into Contents/Resources/atum-public-config.json and can
 * only be changed by rebuilding. This wrapper makes the prod plane explicit
 * and refuses to guess.
 *
 * Usage:
 *
 *   ATUM_PUBLIC_SUPABASE_ANON_KEY="$(
 *     supabase projects api-keys --project-ref example-project-ref \
 *       --output json | jq -r '.[] | select(.name=="anon") | .api_key'
 *   )" npm run pack:prod --workspace apps/desktop
 *
 * Extra arguments are forwarded to electron-builder, e.g.
 *
 *   npm run pack:prod --workspace apps/desktop -- --mac dmg
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE NAME TRAP — build-time names are NOT the runtime override names.
 *
 *   what                 BUILD time (baked in)           RUN time (override)
 *   hosted base URL      ATUM_PUBLIC_HOSTED_BASE_URL     ATUM_PLATFORM_URL
 *   Supabase URL         ATUM_PUBLIC_SUPABASE_URL        NEXT_PUBLIC_SUPABASE_URL
 *                                                        (or SUPABASE_URL)
 *   Supabase anon key    ATUM_PUBLIC_SUPABASE_ANON_KEY   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   copilot default      ATUM_PUBLIC_DEFAULT_MODEL       ATUM_DEFAULT_MODEL
 *   Google auth          ATUM_PUBLIC_GOOGLE_AUTH_ENABLED (none; baked product policy)
 *
 * Only the BUILD-time column matters here. Exporting the runtime names before
 * a pack does nothing: `publicConfigFromEnvironment` reads ATUM_PUBLIC_* and
 * nothing else, and the runtime names are read by main.ts on launch, where
 * they exist as a complete dev override of the packaged file. Setting the
 * wrong column produces a build that silently points at the wrong plane —
 * which is exactly why this script fails closed instead of defaulting.
 * See electron/atum-messaging/public-config.ts and main.ts.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Secrets: ATUM_PUBLIC_SUPABASE_ANON_KEY is a publishable anon key and DOES
 * ship inside the app — but it is still not committed to this repo. It is read
 * from the environment at build time and fetched with:
 *
 *   supabase projects api-keys --project-ref example-project-ref
 *
 * Never put a service-role key in any ATUM_PUBLIC_* variable. The generator's
 * allowlist would drop it, but the shell history would still have it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ATUM_PROD_PLANE, ATUM_PROD_SUPABASE_PROJECT_REF } from './atum-product-defaults.mjs'
import { isMain } from './utils.mjs'
import { PUBLIC_CONFIG_FIELDS, publicConfigFromEnvironment } from './write-atum-public-config.mjs'

export { ATUM_PROD_PLANE, ATUM_PROD_SUPABASE_PROJECT_REF } from './atum-product-defaults.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function git(command, args, cwd = REPO_ROOT) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function assertCanonicalCleanCheckout({ exec = git } = {}) {
  const status = exec('git', ['status', '--porcelain'])
  if (status) throw new Error('working tree is dirty — commit or remove every change before building the demo app')

  const head = exec('git', ['rev-parse', 'HEAD'])
  const canonical = exec('git', ['rev-parse', 'origin/atum-main'])
  if (head !== canonical) {
    throw new Error(`HEAD ${head.slice(0, 12)} is not origin/atum-main ${canonical.slice(0, 12)}`)
  }

  return head
}

/**
 * Compose the prod build environment, or throw with an operator-readable
 * message. Pure so the tests can exercise every failure without packing.
 */
export function resolveProdPackEnvironment(environment = process.env) {
  const problems = []
  const resolved = { ...environment }

  // The public production settings are canon. An operator may re-state them,
  // but a MISMATCH is a prod build pointed somewhere else or with a required
  // production capability disabled — never silently honoured.
  for (const [variable, canonical] of Object.entries(ATUM_PROD_PLANE)) {
    const provided = String(environment?.[variable] ?? '').trim()

    if (provided && provided !== canonical) {
      problems.push(`${variable}=${provided} does not match the prod plane (${canonical})`)
      continue
    }

    resolved[variable] = canonical
  }

  // The anon key is the one value that cannot be canon in-repo. Fail closed.
  const anonKey = String(environment?.ATUM_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

  if (!anonKey) {
    problems.push(
      'ATUM_PUBLIC_SUPABASE_ANON_KEY is not set — fetch it with: ' +
        `supabase projects api-keys --project-ref ${ATUM_PROD_SUPABASE_PROJECT_REF}`
    )
  } else if (anonKey.includes('service_role')) {
    problems.push('ATUM_PUBLIC_SUPABASE_ANON_KEY looks like a service-role key — refusing to bake it into the app')
  } else {
    resolved.ATUM_PUBLIC_SUPABASE_ANON_KEY = anonKey
  }

  if (problems.length > 0) {
    throw new Error(`refusing to pack a prod build:\n  - ${problems.join('\n  - ')}`)
  }

  // Belt and braces: run the real generator's fail-closed check over the
  // composed env so pack:prod can never hand electron-builder something
  // after-pack would reject minutes later, mid-build.
  publicConfigFromEnvironment(resolved)

  return resolved
}

export const API_SIGNING_ENV_VARIABLES = Object.freeze(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
export const SIGNING_ENV_VARIABLES = Object.freeze([...API_SIGNING_ENV_VARIABLES, 'APPLE_NOTARY_PROFILE'])
export const DEFAULT_SIGNING_ENV_FILE = path.join(os.homedir(), '.atum-signing.env')

/**
 * Parse `~/.atum-signing.env` (KEY=VALUE lines, `#` comments, no shell
 * features — the file is never sourced, so nothing in it can execute).
 * Explicit environment variables always win over file values.
 */
export function loadSigningEnvironment(environment = process.env, { readFile = readFileSync } = {}) {
  const filePath = String(environment?.ATUM_SIGNING_ENV_FILE ?? '').trim() || DEFAULT_SIGNING_ENV_FILE
  let text = null

  try {
    text = readFile(filePath, 'utf8')
  } catch {
    return { filePath, found: false, values: {} }
  }

  const values = {}

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)

    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')

    if (SIGNING_ENV_VARIABLES.includes(match[1]) && value) values[match[1]] = value
  }

  return { filePath, found: true, values }
}

/**
 * Demo DMGs must be distributable to strangers' Macs: a Developer ID identity
 * in the keychain plus complete notary credentials, or an EXPLICIT unsigned
 * escape for local dogfood installs — never a silent adhoc fallback.
 */
export function resolveDemoSigning(environment = process.env, { readFile = readFileSync, exec = git } = {}) {
  const signing = loadSigningEnvironment(environment, { readFile })
  const resolved = {}
  const problems = []
  const profile = String(environment?.APPLE_NOTARY_PROFILE ?? '').trim() || signing.values.APPLE_NOTARY_PROFILE || ''
  const apiValues = Object.fromEntries(API_SIGNING_ENV_VARIABLES.map(variable => [
    variable,
    String(environment?.[variable] ?? '').trim() || signing.values[variable] || ''
  ]))
  const apiValueCount = Object.values(apiValues).filter(Boolean).length
  let notaryMode = ''

  if (profile && apiValueCount > 0) {
    problems.push('configure either APPLE_NOTARY_PROFILE or the complete APPLE_API_KEY credential trio, not both')
  } else if (profile) {
    resolved.APPLE_NOTARY_PROFILE = profile
    notaryMode = 'keychain-profile'
  } else {
    for (const variable of API_SIGNING_ENV_VARIABLES) {
      if (apiValues[variable]) resolved[variable] = apiValues[variable]
      else problems.push(`${variable} is not set (checked the environment and ${signing.filePath})`)
    }

    notaryMode = 'api-key'
  }

  let identities = ''

  try {
    identities = exec('security', ['find-identity', '-v', '-p', 'codesigning'])
  } catch (error) {
    problems.push(`could not enumerate codesigning identities (${error instanceof Error ? error.message : error})`)
  }

  if (!identities.includes('Developer ID Application')) {
    problems.push('no "Developer ID Application" identity in the keychain — install the distribution certificate via Xcode')
  }

  if (problems.length === 0) return { mode: 'signed', notaryMode, values: resolved }

  if (!profile && apiValueCount < API_SIGNING_ENV_VARIABLES.length) {
    problems.push(`or set APPLE_NOTARY_PROFILE to an existing notarytool Keychain profile (checked the environment and ${signing.filePath})`)
  }

  if (String(environment?.ATUM_ALLOW_UNSIGNED_DEMO ?? '').trim() === '1') {
    return { mode: 'unsigned', values: {}, problems }
  }

  throw new Error(
    'refusing to pack an UNSIGNED demo DMG:\n  - ' +
      problems.join('\n  - ') +
      '\n  Set ATUM_ALLOW_UNSIGNED_DEMO=1 only for a local dogfood install on this Mac.'
  )
}

export function packProd({
  argv = [],
  environment = process.env,
  spawn = spawnSync,
  canonicalCheck = assertCanonicalCleanCheckout,
  npmScript = 'pack',
  demoDmg = false,
  readFile = readFileSync
} = {}) {
  const commit = canonicalCheck()
  const resolved = resolveProdPackEnvironment(environment)

  if (demoDmg) {
    const signing = resolveDemoSigning(environment, { readFile })

    if (signing.mode === 'signed') {
      Object.assign(resolved, signing.values)
      console.log(`[pack:prod] demo signing armed: Developer ID + ${signing.notaryMode} credentials present`)
    } else {
      // Deterministic adhoc instead of electron-builder guessing at identities.
      resolved.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
      // electron-updater cannot apply an unsigned macOS artifact safely. Even
      // if the caller inherited a production feed, dogfood output is inert.
      delete resolved.ATUM_PUBLIC_UPDATE_FEED_URL
      if (resolved.ATUM_PUBLIC_REPORTING_ENVIRONMENT !== 'test') {
        for (const key of ['ATUM_PUBLIC_POSTHOG_KEY', 'ATUM_PUBLIC_POSTHOG_HOST', 'ATUM_PUBLIC_SENTRY_DSN', 'ATUM_PUBLIC_REPORTING_ENVIRONMENT']) {delete resolved[key]}
      }
      console.warn('[pack:prod] WARNING: ATUM_ALLOW_UNSIGNED_DEMO=1 — this DMG is for THIS Mac only:')

      for (const problem of signing.problems) console.warn(`[pack:prod]   - ${problem}`)
    }
  }

  // write-build-stamp prefers CI metadata when present. Pin those inputs to
  // the checkout we just verified so a stale inherited shell variable cannot
  // stamp different bytes than the commit this command approved.
  resolved.GITHUB_SHA = commit
  resolved.GITHUB_REF_NAME = 'atum-main'

  console.log(`[pack:prod] commit=${commit}`)

  const displayedVariables = [...Object.values(PUBLIC_CONFIG_FIELDS), 'ATUM_PUBLIC_GOOGLE_AUTH_ENABLED']

  for (const variable of displayedVariables) {
    const value = resolved[variable]
    const shown = variable.endsWith('ANON_KEY') ? `${value.slice(0, 6)}…(${value.length} chars)` : value

    console.log(`[pack:prod] ${variable}=${shown}`)
  }

  const result = spawn('npm', ['run', npmScript, '--', ...argv], {
    cwd: process.cwd(),
    env: resolved,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.error) {
    throw new Error(`could not start electron-builder: ${result.error.message}`)
  }

  return result.status ?? 0
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const demoDmg = args[0] === '--demo-dmg'
    process.exit(packProd({ argv: demoDmg ? args.slice(1) : args, npmScript: demoDmg ? 'dist:mac:dmg' : 'pack', demoDmg }))
  } catch (error) {
    console.error(`[pack:prod] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
