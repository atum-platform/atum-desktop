import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { reportingRelease, uploadReportingSourceMaps } from './upload-reporting-sourcemaps.mjs'

test('source maps use the exact clean stamp; dirty or unidentifiable releases cannot upload', () => {
  assert.equal(
    reportingRelease('1.2.3', { commit: 'a'.repeat(40), dirty: false }),
    `atum-desktop@1.2.3+${'a'.repeat(40)}`
  )
  assert.throws(() => reportingRelease('1.2.3', { commit: 'a'.repeat(40), dirty: true }))
  assert.throws(() => reportingRelease('1.2.3', { commit: 'unknown' }))
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-source-map-'))
  try {
    mkdirSync(path.join(root, 'build'))
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(path.join(root, 'build/install-stamp.json'), JSON.stringify({ commit: 'a'.repeat(40), dirty: false }))
    let calls = 0
    uploadReportingSourceMaps({
      root,
      environment: { SENTRY_AUTH_TOKEN: 'fake-test-token', SENTRY_ORG: 'test', SENTRY_PROJECT: 'test' },
      run: (_cmd, args) => {
        calls++
        assert.ok(args.includes(`atum-desktop@1.2.3+${'a'.repeat(40)}`))
        assert.ok(args.includes('app:///'))
        return { status: 0 }
      }
    })
    assert.equal(calls, 1)
    assert.throws(
      () =>
        uploadReportingSourceMaps({
          root,
          environment: {},
          run: () => {
            throw new Error('must not run')
          }
        }),
      /Missing SENTRY_AUTH_TOKEN/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Matrix source maps use an independent release and its own build stamp', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'atum-matrix-source-map-'))
  try {
    mkdirSync(path.join(root, 'dist-matrix'))
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(
      path.join(root, 'dist-matrix', 'matrix-build-stamp.json'),
      JSON.stringify({ commit: 'b'.repeat(40), dirty: false })
    )
    const calls = []
    const release = uploadReportingSourceMaps({
      root,
      composition: 'matrix',
      environment: { SENTRY_AUTH_TOKEN: 'fake-test-token', SENTRY_ORG: 'test', SENTRY_PROJECT: 'test' },
      run: (command, args) => {
        calls.push({ command, args })
        return { status: 0 }
      }
    })
    assert.equal(release, `atum-matrix-desktop@1.2.3+${'b'.repeat(40)}`)
    assert.deepEqual(calls[0].args.at(-1), path.join(root, 'dist-matrix'))
    assert.ok(calls[0].args.includes(release))
    assert.throws(
      () => reportingRelease('1.2.3', { commit: 'b'.repeat(40), dirty: false }, { composition: 'unknown' }),
      /Unknown desktop source-map composition/
    )
    assert.throws(
      () => uploadReportingSourceMaps({ root, composition: 'unknown', environment: {} }),
      /Unknown desktop source-map composition/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
