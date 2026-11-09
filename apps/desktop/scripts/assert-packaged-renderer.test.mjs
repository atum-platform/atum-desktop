import assert from 'node:assert/strict'
import { test } from 'vitest'

import { checkPackagedRendererEntries } from '../scripts/assert-packaged-renderer.mjs'

test('accepts a package containing every renderer entry referenced by index.html', () => {
  const html = '<link href="./assets/index-a.css"><script type="module" src="./assets/index-b.js"></script>'

  assert.deepEqual(
    checkPackagedRendererEntries(html, ['/dist/index.html', '/dist/assets/index-a.css', '/dist/assets/index-b.js']),
    { ok: true }
  )
})

test('rejects a stale asar header that omits the current renderer entry', () => {
  const html = '<script type="module" src="./assets/index-current.js"></script>'
  const result = checkPackagedRendererEntries(html, ['/dist/index.html', '/dist/assets/index-stale.js'])

  assert.equal(result.ok, false)
  assert.match(result.error, /missing referenced assets: dist\/assets\/index-current\.js/)
})

test('rejects index.html without a local JavaScript entry', () => {
  const result = checkPackagedRendererEntries('<link href="./assets/index.css">', [
    '/dist/index.html',
    '/dist/assets/index.css'
  ])

  assert.equal(result.ok, false)
  assert.match(result.error, /no local JavaScript entry reference/)
})

