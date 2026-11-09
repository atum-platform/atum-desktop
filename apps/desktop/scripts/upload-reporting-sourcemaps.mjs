#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function reportingRelease(version, stamp, { composition = 'legacy' } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || !/^[a-f0-9]{40}$/.test(stamp.commit) || stamp.dirty) {
    throw new Error('Source maps require an exact clean build stamp and version')
  }
  if (composition === 'legacy') return `atum-desktop@${version}+${stamp.commit}`
  if (composition === 'matrix') return `atum-matrix-desktop@${version}+${stamp.commit}`
  throw new Error(`Unknown desktop source-map composition: ${composition}`)
}

export function uploadReportingSourceMaps({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  environment = process.env,
  run = spawnSync,
  composition = 'legacy'
} = {}) {
  if (!['legacy', 'matrix'].includes(composition)) {
    throw new Error(`Unknown desktop source-map composition: ${composition}`)
  }
  for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
    if (!environment[key]) {
      throw new Error(`Missing ${key} for source map upload`)
    }
  }
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const buildDirectory = composition === 'matrix' ? 'dist-matrix' : 'dist'
  const stampPath =
    composition === 'matrix'
      ? path.join(root, buildDirectory, 'matrix-build-stamp.json')
      : path.join(root, 'build', 'install-stamp.json')
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
  const release = reportingRelease(version, stamp, { composition })
  const result = run(
    'npx',
    [
      '--no-install',
      'sentry-cli',
      'sourcemaps',
      'upload',
      '--release',
      release,
      '--url-prefix',
      'app:///',
      '--validate',
      path.join(root, buildDirectory)
    ],
    {
      cwd: root,
      env: environment,
      stdio: 'inherit'
    }
  )
  if (result.error || result.status !== 0) {
    throw new Error('Source map upload failed')
  }
  return release
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  uploadReportingSourceMaps({ composition: process.argv.includes('--matrix') ? 'matrix' : 'legacy' })
}
