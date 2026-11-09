import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate/browser'
import { afterEach, test } from 'vitest'

import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import {
  AtumOfficeImportService,
  DOCX_IMPORT_DIALOG_OPTIONS,
  DOCX_IMPORT_MAX_FILE_BYTES,
  DOCX_IMPORT_MAX_XML_BYTES
} from './atum-office-import'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const ACCOUNT = '00000000-0000-4000-8000-bd7662a5eeb4'
const cleanups: string[] = []
afterEach(() => {
  for (const root of cleanups.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function docx(text: string): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    )
  })
}

function harness(sourceName = 'Ghi chú.docx', bytes = docx('Xin chào')) {
  const root = mkdtempSync(join(tmpdir(), 'atum-import-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 2)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 2, paths })
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const source = join(root, sourceName)
  writeFileSync(source, bytes)
  const service = new AtumOfficeImportService(leases, authority, { selectDocx: async () => source })

  return { authority, leases, paths, service, source }
}

test('imports converted Markdown, opens a workspace lease, numbers collisions, and preserves the source bytes', async () => {
  const setup = harness()
  const original = readFileSync(setup.source)
  const first = await setup.service.importDocx({ ownerId: '7' })
  const second = await setup.service.importDocx({ ownerId: '7' })
  assert.equal(first.descriptor.displayName, 'Ghi chú.md')
  assert.equal(second.descriptor.displayName, 'Ghi chú (2).md')
  assert.equal(first.sourceDisplayName, 'Ghi chú.docx')
  assert.equal(readFileSync(join(setup.paths.workspaceRoot, 'Ghi chú.md'), 'utf8'), 'Xin chào')
  assert.deepEqual(readFileSync(setup.source), original)
  assert.equal((await setup.leases.read(first.descriptor.fileRef)).text, 'Xin chào')
  // The importing window must be able to journal its first edit. A lease
  // without an owner renders normally but fails the recovery IPC boundary.
  assert.doesNotThrow(() => setup.leases.resolveDocumentRecoveryLease(first.descriptor.fileRef, '7'))
  assert.throws(() => setup.leases.resolveDocumentRecoveryLease(first.descriptor.fileRef, '8'), /CAPABILITY_DENIED/u)
})

test('cancel, malformed packages, over-limit packages, and truncation create no document or temp entry', async () => {
  const setup = harness('bad.docx', new Uint8Array([1, 2, 3]))
  const cancelled = new AtumOfficeImportService(setup.leases, setup.authority, { selectDocx: async () => null })
  await assert.rejects(cancelled.importDocx({ ownerId: '1' }), /DOCX_IMPORT_CANCELLED/u)
  await assert.rejects(setup.service.importDocx({ ownerId: '1' }), /DOCX_IMPORT_INVALID/u)

  const oversized = join(setup.paths.workspaceRoot, '..', 'large.docx')
  writeFileSync(oversized, Buffer.alloc(DOCX_IMPORT_MAX_FILE_BYTES + 1))
  const tooLarge = new AtumOfficeImportService(setup.leases, setup.authority, { selectDocx: async () => oversized })
  await assert.rejects(tooLarge.importDocx({ ownerId: '1' }), /DOCX_IMPORT_TOO_LARGE/u)

  const truncated = new AtumOfficeImportService(setup.leases, setup.authority, {
    selectDocx: async () => setup.source,
    extract: async selected => ({ blockCount: 1, byteSize: 3, markdown: 'partial', path: selected, truncated: true })
  })

  await assert.rejects(truncated.importDocx({ ownerId: '1' }), /DOCX_IMPORT_TRUNCATED/u)

  const publishFailure = new AtumOfficeImportService(setup.leases, setup.authority, {
    selectDocx: async () => setup.source,
    extract: async selected => ({
      blockCount: 1,
      byteSize: 3,
      markdown: 'x'.repeat(1024 * 1024 + 1),
      path: selected,
      truncated: false
    })
  })

  await assert.rejects(publishFailure.importDocx({ ownerId: '1' }), /DOCX_IMPORT_FAILED/u)
  assert.deepEqual(readdirSync(setup.paths.workspaceRoot), [])
})

test('import limits and picker contract exclude macro/template formats', () => {
  assert.equal(DOCX_IMPORT_MAX_FILE_BYTES, 64 * 1024 * 1024)
  assert.equal(DOCX_IMPORT_MAX_XML_BYTES, 32 * 1024 * 1024)
  assert.deepEqual(DOCX_IMPORT_DIALOG_OPTIONS.filters, [{ name: 'Word document', extensions: ['docx'] }])
  assert.equal(DOCX_IMPORT_DIALOG_OPTIONS.filters[0].extensions.includes('docm' as 'docx'), false)
})

test('sanitizes Unicode stems, separators, leading dots, and Windows reserved names', () => {
  const setup = harness()

  for (const [stem, expected] of [
    ['Điều lệ', 'Điều lệ.md'],
    ['../a\\b', 'a b.md'],
    ['CON', 'Tài liệu CON.md']
  ] as const) {
    const created = setup.authority.createWorkspaceTextDocument({ preferredStem: stem, text: 'x' })
    assert.equal(created.displayName, expected)
    assert.equal(readFileSync(created.canonicalPath, 'utf8'), 'x')
  }
})
