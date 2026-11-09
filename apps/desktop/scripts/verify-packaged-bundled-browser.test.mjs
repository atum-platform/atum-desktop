import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import {
  buildIsolatedBrowserProofEnv,
  packagedBrowserLayout,
  validateProofEvidence,
  validateProofUrl
} from './verify-packaged-bundled-browser.mjs'

test('browser proof accepts only explicit credential-free HTTPS fixtures', () => {
  assert.equal(validateProofUrl('https://proof.atum.example/path'), 'https://proof.atum.example/path')
  assert.throws(() => validateProofUrl(undefined), /credential-free HTTPS/u)
  assert.throws(() => validateProofUrl('http://proof.atum.example'), /credential-free HTTPS/u)
  assert.throws(() => validateProofUrl('https://user:secret@proof.atum.example'), /credential-free HTTPS/u)
})

test('browser proof accepts only same-origin direct-navigation evidence', () => {
  const evidence = {
    browser_navigate_published: true,
    result: { url: 'https://proof.atum.example/complete', title: 'Atum browser proof' }
  }

  assert.equal(validateProofEvidence(evidence, 'https://proof.atum.example/start'), evidence)
  assert.throws(
    () =>
      validateProofEvidence(
        { ...evidence, result: { ...evidence.result, url: 'https://redirect.example/complete' } },
        'https://proof.atum.example/start'
      ),
    /left the controlled direct-navigation origin/u
  )
})

test('browser proof excludes inherited provider and host runtime state', () => {
  const layout = packagedBrowserLayout({ root: '/tmp/desktop', arch: 'arm64' })
  const env = buildIsolatedBrowserProofEnv(layout, '/tmp/isolated')

  assert.deepEqual(Object.keys(env).sort(), [
    'AGENT_BROWSER_EXECUTABLE_PATH',
    'AGENT_BROWSER_HOME',
    'HERMES_HOME',
    'HOME',
    'PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONPATH'
  ])
  assert.deepEqual(env.PATH.split(path.delimiter).slice(0, 2), [layout.browserBin, layout.nodeBin])
  assert.equal(env.AGENT_BROWSER_EXECUTABLE_PATH, layout.chromium)
  assert.equal(env.PYTHONPATH, layout.source)
})
