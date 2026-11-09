import assert from 'node:assert/strict'
import { test } from 'vitest'

import { ATUM_PINNED_DEFAULT_MODEL } from './atum-product-defaults.mjs'
import {
  ATUM_PROD_PLANE,
  assertCanonicalCleanCheckout,
  loadSigningEnvironment,
  packProd,
  resolveDemoSigning,
  resolveProdPackEnvironment
} from './pack-prod.mjs'
import { publicConfigFromEnvironment } from './write-atum-public-config.mjs'

const anonKey = 'PUBLIC_FIXTURE_ONLY_d328d517e09060d1.anon.signature'

test('the prod plane is canon and does not have to be typed by the operator', () => {
  const resolved = resolveProdPackEnvironment({ ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey })

  assert.equal(resolved.ATUM_PUBLIC_HOSTED_BASE_URL, 'https://api.atumplatform.com')
  assert.equal(resolved.ATUM_PUBLIC_SUPABASE_URL, 'https://public-config.example.invalid')
  assert.equal(resolved.ATUM_PUBLIC_GOOGLE_AUTH_ENABLED, 'true')
  assert.equal(resolved.ATUM_PUBLIC_SUPABASE_ANON_KEY, anonKey)

  // Restating the canonical values is fine; contradicting them is not.
  assert.doesNotThrow(() => resolveProdPackEnvironment({ ...ATUM_PROD_PLANE, ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey }))
  assert.throws(
    () =>
      resolveProdPackEnvironment({
        ATUM_PUBLIC_HOSTED_BASE_URL: 'https://nonprod.example.com',
        ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey
      }),
    /does not match the prod plane/
  )
  assert.throws(
    () =>
      resolveProdPackEnvironment({
        ATUM_PUBLIC_GOOGLE_AUTH_ENABLED: 'false',
        ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey
      }),
    /ATUM_PUBLIC_GOOGLE_AUTH_ENABLED=false does not match the prod plane \(true\)/
  )
})

test('pack:prod fails closed on the one value that cannot be canon in-repo', () => {
  assert.throws(() => resolveProdPackEnvironment({}), /ATUM_PUBLIC_SUPABASE_ANON_KEY is not set/)
  assert.throws(() => resolveProdPackEnvironment({ ATUM_PUBLIC_SUPABASE_ANON_KEY: '   ' }), /is not set/)
  // And names the exact command that produces it.
  assert.throws(() => resolveProdPackEnvironment({}), /supabase projects api-keys --project-ref example-project-ref/)
})

test('a service-role key never gets baked into the app', () => {
  assert.throws(
    () =>
      resolveProdPackEnvironment({
        ATUM_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.service_role.sig'
      }),
    /service-role/
  )
})

test('the composed environment satisfies the generator that after-pack actually runs', () => {
  // The fail-closed check in write-atum-public-config.mjs already existed;
  // this proves pack:prod hands it a complete environment rather than
  // discovering a hole minutes into electron-builder.
  const config = publicConfigFromEnvironment(resolveProdPackEnvironment({ ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey }))

  assert.equal(config.hostedBaseUrl, ATUM_PROD_PLANE.ATUM_PUBLIC_HOSTED_BASE_URL)
  assert.equal(config.supabaseUrl, ATUM_PROD_PLANE.ATUM_PUBLIC_SUPABASE_URL)
  assert.equal(config.supabaseAnonKey, anonKey)
  assert.equal(config.defaultModel, ATUM_PINNED_DEFAULT_MODEL)
  assert.equal(config.providers.google, true)
})

test('runtime override names are NOT accepted as build-time input', () => {
  // The trap: exporting ATUM_PLATFORM_URL / NEXT_PUBLIC_SUPABASE_* before a
  // pack looks right and does nothing. The anon key must still be missing.
  assert.throws(
    () =>
      resolveProdPackEnvironment({
        ATUM_PLATFORM_URL: 'https://deployment.example.invalid',
        NEXT_PUBLIC_SUPABASE_URL: 'https://public-config.example.invalid',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey
      }),
    /ATUM_PUBLIC_SUPABASE_ANON_KEY is not set/
  )
})

test('the build is forwarded the resolved environment and the caller-supplied targets', () => {
  const calls = []
  const status = packProd({
    argv: ['--mac', 'dmg'],
    environment: { ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey, PATH: '/usr/bin' },
    canonicalCheck: () => 'a'.repeat(40),
    spawn: (command, args, options) => {
      calls.push({ args, command, env: options.env })

      return { status: 0 }
    }
  })

  assert.equal(status, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'npm')
  assert.deepEqual(calls[0].args, ['run', 'pack', '--', '--mac', 'dmg'])
  assert.equal(calls[0].env.ATUM_PUBLIC_HOSTED_BASE_URL, ATUM_PROD_PLANE.ATUM_PUBLIC_HOSTED_BASE_URL)
  assert.equal(calls[0].env.ATUM_PUBLIC_GOOGLE_AUTH_ENABLED, 'true')
  assert.equal(calls[0].env.GITHUB_SHA, 'a'.repeat(40))
  assert.equal(calls[0].env.GITHUB_REF_NAME, 'atum-main')
  assert.equal(calls[0].env.PATH, '/usr/bin')
})

test('an unsigned dogfood pack cannot inherit an update feed', () => {
  const calls = []

  packProd({
    argv: ['--mac', 'dmg'],
    environment: {
      ATUM_ALLOW_UNSIGNED_DEMO: '1',
      ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      ATUM_PUBLIC_UPDATE_FEED_URL: 'https://updates.atum.example/mac'
    },
    canonicalCheck: () => 'a'.repeat(40),
    demoDmg: true,
    readFile: () => {
      throw new Error('missing')
    },
    spawn: (_command, _args, options) => {
      calls.push(options.env)

      return { status: 0 }
    }
  })

  assert.equal(calls[0].ATUM_PUBLIC_UPDATE_FEED_URL, undefined)
})

test('the demo build can select the installable macOS DMG pipeline', () => {
  const calls = []
  assert.equal(
    packProd({
      environment: { ATUM_PUBLIC_SUPABASE_ANON_KEY: anonKey },
      canonicalCheck: () => 'a'.repeat(40),
      npmScript: 'dist:mac:dmg',
      spawn: (command, args) => {
        calls.push({ command, args })
        return { status: 0 }
      }
    }),
    0
  )
  assert.deepEqual(calls, [{ command: 'npm', args: ['run', 'dist:mac:dmg', '--'] }])
})

test('the demo pack requires a clean checkout exactly at origin/atum-main', () => {
  assert.throws(
    () =>
      assertCanonicalCleanCheckout({
        exec: (_command, args) => (args[0] === 'status' ? ' M file' : 'a'.repeat(40))
      }),
    /working tree is dirty/
  )
  assert.throws(
    () =>
      assertCanonicalCleanCheckout({
        exec: (_command, args) => {
          if (args[0] === 'status') return ''
          return args.join(' ') === 'rev-parse HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)
        }
      }),
    /is not origin\/atum-main/
  )
  assert.equal(
    assertCanonicalCleanCheckout({
      exec: (_command, args) => (args[0] === 'status' ? '' : 'a'.repeat(40))
    }),
    'a'.repeat(40)
  )
})

const SIGNING_FILE = [
  '# Atum demo signing credentials',
  'APPLE_API_KEY=/home/example/keys/AuthKey_ABC123.p8',
  "APPLE_API_KEY_ID='ABC123'",
  'export APPLE_API_ISSUER=11111111-2222-3333-4444-555555555555',
  'UNRELATED_SECRET=must-not-leak-through'
].join('\n')

const DEV_ID_IDENTITY = '  1) ABCDEF0123456789 "Developer ID Application: Anka Ventures (ABCDE12345)"\n     1 valid identities found'

function signingIo({ file = SIGNING_FILE, identities = DEV_ID_IDENTITY } = {}) {
  return {
    readFile: (filePath) => {
      if (file === null) {
        const error = new Error(`ENOENT: ${filePath}`)
        error.code = 'ENOENT'
        throw error
      }

      return file
    },
    exec: (command, args) => {
      assert.equal(command, 'security')
      assert.deepEqual(args, ['find-identity', '-v', '-p', 'codesigning'])

      return identities
    }
  }
}

test('the signing env file is parsed without being sourced, and explicit env wins', () => {
  const signing = loadSigningEnvironment({}, { readFile: () => SIGNING_FILE })

  assert.deepEqual(signing.values, {
    APPLE_API_KEY: '/home/example/keys/AuthKey_ABC123.p8',
    APPLE_API_KEY_ID: 'ABC123',
    APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555'
  })
  assert.equal('UNRELATED_SECRET' in signing.values, false)

  const resolved = resolveDemoSigning({ APPLE_API_KEY_ID: 'FROM_ENV' }, signingIo())

  assert.equal(resolved.mode, 'signed')
  assert.equal(resolved.notaryMode, 'api-key')
  assert.equal(resolved.values.APPLE_API_KEY_ID, 'FROM_ENV')
})

test('a Keychain profile is a complete alternative to the API key trio', () => {
  const profileFile = 'APPLE_NOTARY_PROFILE=atum-notary'
  assert.deepEqual(loadSigningEnvironment({}, { readFile: () => profileFile }).values, {
    APPLE_NOTARY_PROFILE: 'atum-notary'
  })
  const signing = resolveDemoSigning({}, signingIo({ file: profileFile }))

  assert.deepEqual(signing, {
    mode: 'signed',
    notaryMode: 'keychain-profile',
    values: { APPLE_NOTARY_PROFILE: 'atum-notary' }
  })

  const fromEnvironment = resolveDemoSigning({ APPLE_NOTARY_PROFILE: 'env-profile' }, signingIo({ file: null }))
  assert.deepEqual(fromEnvironment.values, { APPLE_NOTARY_PROFILE: 'env-profile' })
})

test('notary auth rejects mixed profile and API credentials', () => {
  assert.throws(
    () => resolveDemoSigning({
      APPLE_NOTARY_PROFILE: 'atum-notary',
      APPLE_API_KEY: '/home/example/keys/AuthKey_ABC123.p8'
    }, signingIo({ file: null })),
    /configure either APPLE_NOTARY_PROFILE or the complete APPLE_API_KEY credential trio, not both/
  )
})

test('a demo DMG refuses to pack unsigned unless the operator says so explicitly', () => {
  assert.throws(() => resolveDemoSigning({}, signingIo({ file: null })), /refusing to pack an UNSIGNED demo DMG/)
  assert.throws(() => resolveDemoSigning({}, signingIo({ file: null })), /APPLE_API_KEY is not set/)
  assert.throws(() => resolveDemoSigning({}, signingIo({ file: null })), /APPLE_NOTARY_PROFILE to an existing notarytool Keychain profile/)

  const escaped = resolveDemoSigning({ ATUM_ALLOW_UNSIGNED_DEMO: '1' }, signingIo({ file: null }))

  assert.equal(escaped.mode, 'unsigned')
  assert.ok(escaped.problems.length >= 3)
})

test('complete notary credentials without a Developer ID identity still fail closed', () => {
  assert.throws(
    () => resolveDemoSigning({ APPLE_NOTARY_PROFILE: 'atum-notary' }, signingIo({ identities: '     0 valid identities found' })),
    /no "Developer ID Application" identity/
  )
})
