import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { ATUM_PINNED_DEFAULT_MODEL } from './atum-product-defaults.mjs'
import { publicConfigFromEnvironment, writeAtumPublicConfig } from './write-atum-public-config.mjs'

const environment = {
  ATUM_PUBLIC_HOSTED_BASE_URL: 'https://nonprod.example.com',
  ATUM_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  ATUM_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key',
  ATUM_PUBLIC_GOOGLE_AUTH_ENABLED: 'false',
  ATUM_PUBLIC_PASSWORD_AUTH_ENABLED: 'true',
  SUPABASE_SERVICE_ROLE_KEY: 'must-not-ship',
  ATUM_APP_SERVICE_CREDENTIALS: 'must-not-ship',
  CRON_SECRET: 'must-not-ship'
}

test('reporting configuration is complete, trimmed and restricted to an explicit environment', () => {
  const reporting = {
    ATUM_PUBLIC_POSTHOG_KEY: ' phc_test000000000 ',
    ATUM_PUBLIC_POSTHOG_HOST: ' https://us.i.posthog.com ',
    ATUM_PUBLIC_SENTRY_DSN: ' https://public@o1.ingest.sentry.io/1 ',
    ATUM_PUBLIC_REPORTING_ENVIRONMENT: ' test '
  }
  assert.deepEqual(publicConfigFromEnvironment({ ...environment, ...reporting }).observability, {
    posthogKey: 'phc_test000000000', posthogHost: 'https://us.i.posthog.com',
    sentryDsn: 'https://public@o1.ingest.sentry.io/1', environment: 'test'
  })
  for (const missing of Object.keys(reporting)) {
    assert.throws(() => publicConfigFromEnvironment({ ...environment, ...reporting, [missing]: '' }), /required together/)
  }
  assert.throws(() => publicConfigFromEnvironment({ ...environment, ...reporting, ATUM_PUBLIC_REPORTING_ENVIRONMENT: 'staging' }), /Invalid reporting environment/)
})

test('build config generator emits only the allowlisted public fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atum-public-config-script-'))
  const outputPath = path.join(directory, 'atum-public-config.json')

  try {
    writeAtumPublicConfig({ environment, outputPath })
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      schemaVersion: 1,
      defaultModel: ATUM_PINNED_DEFAULT_MODEL,
      hostedBaseUrl: environment.ATUM_PUBLIC_HOSTED_BASE_URL,
      supabaseUrl: environment.ATUM_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: environment.ATUM_PUBLIC_SUPABASE_ANON_KEY,
      providers: { google: false, password: true }
    })
    assert.doesNotMatch(readFileSync(outputPath, 'utf8'), /service|credential|cron|must-not-ship/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the update feed is optional and is baked only when explicitly configured', () => {
  assert.equal('updateFeedUrl' in publicConfigFromEnvironment(environment), false)
  assert.equal(
    publicConfigFromEnvironment({ ...environment, ATUM_PUBLIC_UPDATE_FEED_URL: '  https://updates.atum.example/mac  ' })
      .updateFeedUrl,
    'https://updates.atum.example/mac'
  )
})

test('the copilot default is pinned by the product, not inherited from the build host', () => {
  // G7: the packaged app must not fall through to the engine's silent default
  // (hermes_cli/models.py PREFERRED_SILENT_DEFAULT_MODEL) or to whatever the
  // packaging machine's ~/.hermes/config.yaml says.
  assert.equal(ATUM_PINNED_DEFAULT_MODEL, 'binh-minh')
  assert.equal(publicConfigFromEnvironment(environment).defaultModel, 'binh-minh')

  // A build may still rotate the pin explicitly.
  assert.equal(
    publicConfigFromEnvironment({ ...environment, ATUM_PUBLIC_DEFAULT_MODEL: '  gpt-5.5  ' }).defaultModel,
    'gpt-5.5'
  )
  // Blank means "unset", not "no default".
  assert.equal(
    publicConfigFromEnvironment({ ...environment, ATUM_PUBLIC_DEFAULT_MODEL: '   ' }).defaultModel,
    ATUM_PINNED_DEFAULT_MODEL
  )
})

test('generator fails closed rather than creating a partial config', () => {
  assert.throws(() => publicConfigFromEnvironment({
    ATUM_PUBLIC_HOSTED_BASE_URL: environment.ATUM_PUBLIC_HOSTED_BASE_URL,
    ATUM_PUBLIC_SUPABASE_URL: environment.ATUM_PUBLIC_SUPABASE_URL
  }), /ATUM_PUBLIC_SUPABASE_ANON_KEY/)
})
