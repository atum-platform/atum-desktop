import { lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { matrixDocumentRecoveryRoot } from './document-recovery-root'

const roots: string[] = []
afterEach(() => {for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}})

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'matrix-recovery-factory-'))
  roots.push(root)

  return root
}

it('creates every missing private parent used by the real main factory', () => {
  const root = freshRoot()
  const journal = matrixDocumentRecoveryRoot(root, 'account', 'DEVICE', '!room:test')
  expect(lstatSync(journal).isDirectory()).toBe(true)

  for (const directory of [join(root, 'matrix-documents'), join(root, 'matrix-documents', 'account'), journal]) {
    expect(lstatSync(directory).mode & 0o777).toBe(0o700)
  }

  expect(matrixDocumentRecoveryRoot(root, 'account', 'DEVICE', '!room:test')).toBe(journal)
  expect(matrixDocumentRecoveryRoot(root, 'account', 'DEVICE', '!other:test')).not.toBe(journal)
  expect(matrixDocumentRecoveryRoot(root, 'account', 'OTHER', '!room:test')).not.toBe(journal)
})

it('rejects a replaced private parent and invalid account segments without following them', () => {
  const root = freshRoot()
  const foreign = freshRoot()
  symlinkSync(foreign, join(root, 'matrix-documents'))
  expect(() => matrixDocumentRecoveryRoot(root, 'account', 'DEVICE', '!room:test')).toThrow('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
  expect(() => matrixDocumentRecoveryRoot(root, '../foreign', 'DEVICE', '!room:test')).toThrow('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
})
