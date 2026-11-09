import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { resolveAtumObservabilityConfig, resolveAtumProductDefaultModel, resolveAtumPublicAccountConfig, resolveAtumUpdateFeedUrl } from './public-config'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function configFile(value: unknown, mode = 0o644): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-public-config-'))
  directories.push(directory)
  const path = join(directory, 'atum-public-config.json')
  writeFileSync(path, JSON.stringify(value))
  chmodSync(path, mode)

  return path
}

const packaged = {
  schemaVersion: 1,
  hostedBaseUrl: 'https://nonprod.example.com',
  supabaseUrl: 'https://project.supabase.co',
  supabaseAnonKey: 'packaged-public-key',
  defaultModel: 'binh-minh',
  providers: { google: false, password: true }
}

test('packaged Resources config is the Finder-launch fallback', () => {
  assert.deepEqual(resolveAtumPublicAccountConfig({ environment: {}, packagedPath: configFile(packaged) }), {
    hostedBaseUrl: packaged.hostedBaseUrl,
    supabaseUrl: packaged.supabaseUrl,
    supabaseAnonKey: packaged.supabaseAnonKey,
    providers: packaged.providers
  })
})

test('a complete development environment overrides the package without merging partial values', () => {
  assert.deepEqual(resolveAtumPublicAccountConfig({
    environment: {
      hostedBaseUrl: 'http://127.0.0.1:3000',
      supabaseUrl: 'http://127.0.0.1:55321',
      supabaseAnonKey: 'local-public-key',
      providers: { google: true, password: true }
    },
    packagedPath: configFile(packaged)
  }), {
    hostedBaseUrl: 'http://127.0.0.1:3000',
    supabaseUrl: 'http://127.0.0.1:55321',
    supabaseAnonKey: 'local-public-key',
    providers: { google: true, password: true }
  })

  assert.throws(() => resolveAtumPublicAccountConfig({
    environment: { hostedBaseUrl: 'http://127.0.0.1:3000' },
    packagedPath: configFile(packaged)
  }), /incomplete/)
})

test('the packaged product default model is the managed Atum alias', () => {
  assert.equal(
    resolveAtumProductDefaultModel({ environment: {}, packagedPath: configFile(packaged) }),
    'binh-minh'
  )
})

test('the product default model is overridable at runtime and absent without a package', () => {
  // Build-time name is ATUM_PUBLIC_DEFAULT_MODEL; the runtime override is
  // ATUM_DEFAULT_MODEL. Same deliberate split as hosted/Supabase.
  assert.equal(
    resolveAtumProductDefaultModel({
      environment: { ATUM_DEFAULT_MODEL: '  gpt-5.5  ' },
      packagedPath: configFile(packaged)
    }),
    'gpt-5.5'
  )
  assert.equal(resolveAtumProductDefaultModel({ environment: {}, packagedPath: null }), null)

  // Pre-pin packages parse; present-but-blank is a packing bug and must not
  // masquerade as "the user has no preference".
  const { defaultModel: _omitted, ...withoutPin } = packaged

  assert.equal(resolveAtumProductDefaultModel({ environment: {}, packagedPath: configFile(withoutPin) }), null)
  assert.throws(() => resolveAtumProductDefaultModel({
    environment: {},
    packagedPath: configFile({ ...packaged, defaultModel: '   ' })
  }), /default_model_invalid/)
})

test('the update feed is optional, HTTPS-only, and comes only from the baked config', () => {
  assert.equal(resolveAtumUpdateFeedUrl(configFile(packaged)), null)
  assert.equal(
    resolveAtumUpdateFeedUrl(configFile({ ...packaged, updateFeedUrl: 'https://updates.atum.example/mac' })),
    'https://updates.atum.example/mac'
  )
  assert.throws(
    () => resolveAtumUpdateFeedUrl(configFile({ ...packaged, updateFeedUrl: 'http://updates.atum.example/mac' })),
    /update_feed_invalid/
  )
  assert.throws(
    () => resolveAtumUpdateFeedUrl(configFile({ ...packaged, updateFeedUrl: '   ' })),
    /update_feed_invalid/
  )
})

test('packaged config rejects unknown fields, world-write access, and excessive bytes', () => {
  assert.throws(() => resolveAtumPublicAccountConfig({
    environment: {},
    packagedPath: configFile({ ...packaged, serviceRoleKey: 'must-not-ship' })
  }), /unknown_field/)
  assert.throws(() => resolveAtumPublicAccountConfig({
    environment: {},
    packagedPath: configFile(packaged, 0o666)
  }), /file_invalid/)
  assert.throws(() => resolveAtumPublicAccountConfig({
    environment: {},
    packagedPath: configFile({ ...packaged, supabaseAnonKey: 'x'.repeat(40_000) })
  }), /file_invalid/)
  assert.throws(() => resolveAtumPublicAccountConfig({
    environment: {},
    packagedPath: configFile({ ...packaged, providers: { google: 'yes', password: true } })
  }), /providers_invalid/)
})


test('bad reporting config cannot disable account authentication', () => {
  const packagedPath = configFile({ ...packaged, observability: { sentryDsn: 'not-a-url' } })
  assert.ok(resolveAtumPublicAccountConfig({ environment: {}, packagedPath }))
  assert.throws(() => resolveAtumObservabilityConfig(packagedPath), /reporting_config_invalid/)
})

test('only public vendor capture configuration is accepted', () => {
  const reporting = { posthogKey: 'phc_test000000000', posthogHost: 'https://us.i.posthog.com', sentryDsn: 'https://public@o1.ingest.sentry.io/1', environment: 'test' }
  assert.deepEqual(resolveAtumObservabilityConfig(configFile({ ...packaged, observability: reporting })), reporting)

  for (const change of [{ posthogKey: 'phx_secret000000' }, { posthogHost: 'http://us.i.posthog.com' }, { sentryDsn: 'https://public:secret@o1.ingest.sentry.io/1' }]) {
    assert.throws(() => resolveAtumObservabilityConfig(configFile({ ...packaged, observability: { ...reporting, ...change } })))
  }
})
