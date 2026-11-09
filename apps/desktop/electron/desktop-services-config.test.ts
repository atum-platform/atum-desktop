import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { readDesktopServicesConfig } from './desktop-services-config'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function configFile(value: unknown, mode = 0o644): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-desktop-services-config-'))
  directories.push(directory)
  const filename = join(directory, 'atum-desktop-services.json')
  writeFileSync(filename, JSON.stringify(value))
  chmodSync(filename, mode)

  return filename
}

const observability = {
  posthogKey: 'phc_test000000000',
  posthogHost: 'https://us.i.posthog.com',
  sentryDsn: 'https://public@o1.ingest.sentry.io/1',
  environment: 'test' as const
}

test('missing Matrix services config explicitly disables reporting and updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atum-desktop-services-config-'))
  directories.push(directory)

  assert.deepEqual(readDesktopServicesConfig(join(directory, 'atum-desktop-services.json')), {
    observability: null,
    updateFeedUrl: null
  })
})

test('accepts only the reporting and update services intended for a Matrix package', () => {
  assert.deepEqual(
    readDesktopServicesConfig(
      configFile({
        schemaVersion: 1,
        observability: { ...observability, posthogHost: 'https://us.i.posthog.com/' },
        updateFeedUrl: 'https://updates.atum.example/matrix'
      })
    ),
    {
      observability,
      updateFeedUrl: 'https://updates.atum.example/matrix'
    }
  )
})

test('rejects a present Matrix services file with insecure, partial, or unrelated configuration', () => {
  assert.throws(
    () =>
      readDesktopServicesConfig(configFile({ schemaVersion: 1, updateFeedUrl: 'http://updates.atum.example/matrix' })),
    /update_feed_invalid/
  )
  assert.throws(
    () =>
      readDesktopServicesConfig(
        configFile({ schemaVersion: 1, observability: { posthogKey: observability.posthogKey } })
      ),
    /observability_invalid/
  )
  assert.throws(
    () => readDesktopServicesConfig(configFile({ schemaVersion: 1, supabaseAnonKey: 'must-not-ship' })),
    /unknown_field/
  )
  assert.throws(() => readDesktopServicesConfig(configFile({ schemaVersion: 1 }, 0o666)), /file_invalid/)
  assert.throws(() => readDesktopServicesConfig(configFile({ schemaVersion: 1 }, 0o664)), /file_invalid/)
  assert.throws(
    () => readDesktopServicesConfig(configFile({ schemaVersion: 1, updateFeedUrl: 'not a URL' })),
    /update_feed_invalid/
  )
})
