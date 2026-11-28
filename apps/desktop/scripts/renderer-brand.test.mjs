import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { hasLegacyBrand, scanRendererScript, verifyRendererBrand } from './renderer-brand.mjs'

describe('desktop release branding', () => {
  it('normalizes rendered encodings and matches names alongside non-Latin text', () => {
    for (const value of ['Ｔ３ Code', '登入Nous入口網站', 'H&#101;rmes', '%4Eous Portal', 'mcp__t3_thread_launch']) {
      assert.equal(hasLegacyBrand(value), true, value)
    }
    assert.equal(hasLegacyBrand('Atum Work · Continue with your provider'), false)
  })

  it('finds decoded literal values and static concatenation in emitted JS', () => {
    const code = "const key = 'hermes:open'; const text = 'Her' + 'mes ready'; const aria = '\\x54' + '3 Code';"
    const path = () => 'src/recovery.ts'
    const exceptions = { 'src/recovery.ts': ['hermes:open'] }
    assert.deepEqual(scanRendererScript(code, path, exceptions).map(hit => hit.value), ['Hermes ready', 'T3 Code'])
    assert.equal(scanRendererScript(code, () => 'src/other.ts', exceptions).length, 3)
    assert.equal(scanRendererScript(code, () => undefined, exceptions).length, 3)
  })

  it('requires the build entries and catches changes in HTML and unmapped JS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atum-renderer-brand-'))
    try {
      const check = () => verifyRendererBrand(dir, dir, ['matrix.html'], {})
      assert.throws(check, /Missing renderer entry/)
      writeFileSync(join(dir, 'matrix.html'), '<title>Atum</title>')
      writeFileSync(join(dir, 'matrix-ui-preload.js'), "const channel = 'hermes:open'")
      assert.doesNotThrow(check)
      writeFileSync(join(dir, 'settings.js'), "const title = 'Nous Portal'")
      assert.throws(check, /settings\.js/)
      writeFileSync(join(dir, 'settings.js'), "const title = 'Provider account'")
      writeFileSync(join(dir, 'matrix.html'), '<img alt="T3 Code">')
      assert.throws(check, /matrix\.html/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
