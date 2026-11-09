/** Cold native asset reader and actual generic stage sizing; no account/home. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMatrixBundledPet } from '../../apps/desktop/electron/matrix/pet-assets'
import { petDrawScale } from '../../apps/desktop/shared/pet'
import { roamSize } from '../../apps/desktop/shared/pet-engine/lane'
import { stageSize } from '../../apps/desktop/shared/pet-engine/profile'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = { python: path.join(source, '.venv/bin/python'), source, profiles: '/unused' }
const results = []
for (const slug of ['gigi', 'cookie', 'mochi', 'bailey']) {
  const info = await readMatrixBundledPet(runtime, slug, 1)
  assert.equal(info.frameW, 192)
  assert.equal(info.frameH, 208)
  const cell = stageSize({ w: info.frameW!, h: info.frameH! }, info)
  const visibleHeight = cell.height * info.bounds!.idle.height / info.frameH!
  results.push({ slug, cell, visibleHeight, nominal: info.sizeClass?.naturalHeightPt })
  if (slug === 'mochi' || slug === 'bailey') {
    assert.equal(info.locomotion, 'walk')
    assert.ok(info.anchor && Object.keys(info.bounds!).length === 14)
    assert.equal(info.sizeClass?.naturalHeightPt, slug === 'mochi' ? 100 : 210)
  } else {
    assert.equal(info.sizeClass, undefined)
    assert.deepEqual(cell, roamSize({ w: info.frameW!, h: info.frameH! }, petDrawScale(info)))
  }
}
const gigi = results.find(row => row.slug === 'gigi')!
const bailey = results.find(row => row.slug === 'bailey')!
assert.ok(bailey.visibleHeight / gigi.visibleHeight >= 2)
console.log(JSON.stringify({ result: 'PASS', coldNativeReader: true, baileyGigiRatio: bailey.visibleHeight / gigi.visibleHeight, results }, null, 2))
