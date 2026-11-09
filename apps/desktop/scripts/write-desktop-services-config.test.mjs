import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { desktopServicesConfigFromEnvironment, writeDesktopServicesConfig } from './write-desktop-services-config.mjs'

const reporting = {
  ATUM_PUBLIC_POSTHOG_KEY: ' phc_test000000000 ',
  ATUM_PUBLIC_POSTHOG_HOST: ' https://us.i.posthog.com ',
  ATUM_PUBLIC_SENTRY_DSN: ' https://public@o1.ingest.sentry.io/1 ',
  ATUM_PUBLIC_REPORTING_ENVIRONMENT: ' test '
}

test('writes an allowlisted Matrix services config without account or secret build inputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atum-desktop-services-config-script-'))
  const outputPath = path.join(directory, 'Resources', 'atum-desktop-services.json')

  try {
    writeDesktopServicesConfig({
      environment: {
        ...reporting,
        ATUM_PUBLIC_UPDATE_FEED_URL: ' https://updates.atum.example/matrix ',
        SUPABASE_SERVICE_ROLE_KEY: 'must-not-ship',
        ATUM_APP_SERVICE_CREDENTIALS: 'must-not-ship'
      },
      outputPath
    })

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      schemaVersion: 1,
      updateFeedUrl: 'https://updates.atum.example/matrix',
      observability: {
        posthogKey: 'phc_test000000000',
        posthogHost: 'https://us.i.posthog.com',
        sentryDsn: 'https://public@o1.ingest.sentry.io/1',
        environment: 'test'
      }
    })
    assert.doesNotMatch(readFileSync(outputPath, 'utf8'), /service|credential|must-not-ship/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps both services disabled when omitted and fails closed on partial or insecure input', () => {
  assert.deepEqual(desktopServicesConfigFromEnvironment({}), { schemaVersion: 1 })

  for (const missing of Object.keys(reporting)) {
    assert.throws(() => desktopServicesConfigFromEnvironment({ ...reporting, [missing]: '' }), /required together/)
  }

  assert.throws(
    () => desktopServicesConfigFromEnvironment({ ATUM_PUBLIC_UPDATE_FEED_URL: 'http://updates.atum.example/matrix' }),
    /Invalid update feed URL/
  )
  assert.throws(
    () => desktopServicesConfigFromEnvironment({ ATUM_PUBLIC_UPDATE_FEED_URL: 'not a URL' }),
    /Invalid update feed URL/
  )
  assert.throws(
    () => desktopServicesConfigFromEnvironment({ ...reporting, ATUM_PUBLIC_POSTHOG_KEY: 'phx_secret000000' }),
    /Invalid public PostHog capture key/
  )
  assert.throws(
    () =>
      desktopServicesConfigFromEnvironment({
        ...reporting,
        ATUM_PUBLIC_SENTRY_DSN: 'https://public:secret@o1.ingest.sentry.io/1'
      }),
    /Invalid public reporting endpoint/
  )
})
