import { expect, test } from 'vitest'

import { driveExclusionExpression, matrixDriveImportPatterns } from './drive-exclusions'

const patterns = matrixDriveImportPatterns()

const excluded = (name: string, directory = false, platform = 'darwin') =>
  patterns.some(
    rule =>
      (!rule.directoryOnly || directory) && new RegExp(rule.expression, platform === 'linux' ? 'u' : 'iu').test(name)
  )

test('the engine rules keep promised private files and directory trees out, including Mac case variants', () => {
  for (const name of [
    'project/.env.production',
    'TOKEN.txt',
    'key.pem',
    'work.db',
    'Icon\r',
    '.DS_Store',
    'download.crdownload'
  ]) {
    expect(excluded(name)).toBe(true)
  }

  for (const name of ['project/.git', 'project/node_modules', 'project/.venv']) {
    expect(excluded(name, true)).toBe(true)
    expect(excluded(name, false)).toBe(false)
  }

  for (const name of ['report.pdf', 'project/main.py', 'notes.txt']) {
    expect(excluded(name)).toBe(false)
  }

  expect(excluded('TOKEN.txt', false, 'linux')).toBe(false)
})

test('glob conversion preserves the actual slash, literal escape and bracket behavior', () => {
  const regex = (glob: string) => new RegExp(`^(?:${driveExclusionExpression(glob)})$`, 'u')
  expect(regex('*.txt').test('folder/file.txt')).toBe(false)
  expect(regex('a?c').test('a/c')).toBe(false)
  expect(regex(String.raw`\*.txt`).test('*.txt')).toBe(true)
  expect(regex(String.raw`a\z`).test(String.raw`a\z`)).toBe(true)
  expect(regex('file[!0-9]').test('fileA')).toBe(true)
  expect(regex('file[!0-9]').test('file1')).toBe(false)
  expect(regex('a[').test('a[')).toBe(true)
  const rooted = matrixDriveImportPatterns(['build/cache/', 'artifact?.bin'])
  expect(new RegExp(rooted[0].expression, 'u').test('build/cache')).toBe(true)
  expect(new RegExp(rooted[0].expression, 'u').test('project/build/cache')).toBe(false)
  expect(new RegExp(rooted[1].expression, 'u').test('project/artifact1.bin')).toBe(true)
})
