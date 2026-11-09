import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ENGINE_EXCLUSIONS_COMMIT,
  expandEngineExclusionEscapes,
  generateDriveExclusions
} from './gen-drive-exclusions.mjs'

test('the full snapshot retains baseline rules and every small-print promise from the pinned engine', () => {
  const snapshot = JSON.parse(
    readFileSync(new URL('../apps/desktop/electron/matrix/drive-exclusions.json', import.meta.url), 'utf8')
  )
  assert.equal(snapshot.engine.commit, ENGINE_EXCLUSIONS_COMMIT)
  assert.ok(snapshot.patterns.includes('*token*'))
  assert.ok(snapshot.patterns.includes('.env*'))
  assert.ok(snapshot.patterns.includes('.git/'))
  assert.ok(snapshot.patterns.includes('node_modules/'))
  assert.ok(snapshot.patterns.includes(']Icon\r*'))
  assert.ok(snapshot.patterns.includes('*.crdownload'))
  assert.equal(new Set(snapshot.patterns).size, snapshot.patterns.length)
})

test('generation derives both source lists, expands engine escapes and keeps unknown escapes', () => {
  const cpp = String.raw`_atumExcludes = {QStringLiteral(".env*"), QStringLiteral(".git/")};`
  const list = '# comment\n]*.tmp\n]Icon\\r*\nfoo\\z\n.env*\n'
  const result = generateDriveExclusions(cpp, list)
  assert.deepEqual(result.patterns, [']*.tmp', ']Icon\r*', String.raw`foo\z`, '.env*', '.git/'])
  assert.equal(expandEngineExclusionEscapes(String.raw`a\?b\\*c\#d`), String.raw`a?b\\*c#d`)
  assert.deepEqual(generateDriveExclusions(cpp, list), result)
  assert.notDeepEqual(generateDriveExclusions(cpp, list + '*.part\n').engine.sources, result.engine.sources)
})

test('unknown source syntax or conditional versions fail rather than exporting a partial list', () => {
  assert.throws(() => generateDriveExclusions('_atumExcludes = {variable};', ''), /source_unsupported/u)
  assert.throws(() => generateDriveExclusions('', ''), /source_ambiguous/u)
  assert.throws(
    () => generateDriveExclusions('_atumExcludes = {QStringLiteral("a")};', '#!version >= 1.2.3\na'),
    /version_unsupported/u
  )
})
