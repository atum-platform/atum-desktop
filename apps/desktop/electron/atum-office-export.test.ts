import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { resolveDocumentTheme } from '../shared/atum-office/document-theme'

import { AtumDocumentThemeStore } from './atum-document-theme'
import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import { AtumOfficeExportService } from './atum-office-export'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const ACCOUNT = '00000000-0000-4000-8000-bd7662a5eeb4'
const cleanups: string[] = []
afterEach(() => {
  for (const value of cleanups.splice(0)) {
    rmSync(value, { recursive: true, force: true })
  }
})

function harness(beforePublish?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'atum-export-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 3)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 3, paths })
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const sourcePath = join(paths.workspaceRoot, 'Tài liệu 1.md')
  writeFileSync(sourcePath, '# Xin chào')
  const lease = leases.openLocal(sourcePath, { workspaceRelativePath: 'Tài liệu 1.md' })
  const revealed: string[] = []
  const shared: string[] = []

  const pdfPrinter = {
    cancelAll: vi.fn(),
    render: vi.fn(async (_input: { html: string; title: string }) => new Uint8Array(Buffer.from('%PDF-fake')))
  }

  const documentThemes = new AtumDocumentThemeStore()
  documentThemes.activateAccount({ accountId: ACCOUNT, generation: 3, paths })

  const service = new AtumOfficeExportService(leases, authority, pdfPrinter as never, {
    beforePublish,
    documentThemes,
    shareFile: value => shared.push(value),
    showItemInFolder: value => revealed.push(value)
  })

  return { authority, documentThemes, lease, leases, paths, pdfPrinter, revealed, service, shared, sourcePath }
}

test('DOCX export returns opaque metadata, numbers collisions, and reveals only a verified reference', async () => {
  const { lease, paths, revealed, service } = harness()
  const first = await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' })
  const second = await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' })
  assert.equal(first.displayName, 'Tài liệu 1.docx')
  assert.equal(second.displayName, 'Tài liệu 1 (2).docx')
  assert.equal(JSON.stringify(first).includes(paths.workspaceRoot), false)
  assert.ok(readFileSync(join(paths.workspaceRoot, first.displayName)).byteLength > 0)
  assert.deepEqual(service.revealExport(first.exportRef, '7'), { revealed: true })
  assert.equal(revealed.length, 1)
  assert.throws(() => service.revealExport(first.exportRef, '8'), /EXPORT_REF_INVALID/u)
  assert.throws(() => service.revealExport('forged', '7'), /EXPORT_REF_INVALID/u)
})

test('source change during conversion fails before publication', async () => {
  let sourcePath = ''
  const setup = harness(() => writeFileSync(sourcePath, 'changed'))
  sourcePath = setup.sourcePath
  await assert.rejects(
    setup.service.exportDocument({ fileRef: setup.lease.fileRef, format: 'docx', ownerId: '1' }),
    /EXPORT_SOURCE_CHANGED/u
  )
  assert.equal(readFileSync(sourcePath, 'utf8'), 'changed')
})

test('account revocation expires export references', async () => {
  const { authority, lease, service } = harness()
  const result = await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '1' })
  service.revokeAccount({ accountId: ACCOUNT, accountGeneration: 3 })
  authority.revokeAccount({ accountId: ACCOUNT, accountGeneration: 3 })
  assert.throws(() => service.revealExport(result.exportRef, '1'), /EXPORT_REF_INVALID/u)
})

test('PDF export publishes collision-numbered files and share revalidates the opaque reference', async () => {
  const { lease, paths, pdfPrinter, service, shared } = harness()
  const first = await service.exportDocument({ fileRef: lease.fileRef, format: 'pdf', ownerId: '7' })
  const second = await service.exportDocument({ fileRef: lease.fileRef, format: 'pdf', ownerId: '7' })
  assert.equal(first.displayName, 'Tài liệu 1.pdf')
  assert.equal(second.displayName, 'Tài liệu 1 (2).pdf')
  assert.equal(first.format, 'pdf')
  assert.match(pdfPrinter.render.mock.calls[0]?.[0].html ?? '', /Xin chào/u)
  assert.equal(readFileSync(join(paths.workspaceRoot, first.displayName), 'utf8'), '%PDF-fake')
  assert.deepEqual(service.shareExport(first.exportRef, '7'), { shared: true })
  assert.equal(shared.length, 1)
  assert.throws(() => service.shareExport(first.exportRef, '8'), /EXPORT_REF_INVALID/u)
  writeFileSync(join(paths.workspaceRoot, first.displayName), 'replaced')
  assert.throws(() => service.shareExport(first.exportRef, '7'), /EXPORT_REF_INVALID/u)
})

test('a foreign file appearing at the target between conversion and commit is never replaced', async () => {
  let paths: { workspaceRoot: string } | null = null

  const setup = harness(() => {
    // Adversary wins the race for the first name after our bytes are ready.
    writeFileSync(join(paths!.workspaceRoot, 'Tài liệu 1.docx'), 'foreign')
  })

  paths = setup.paths
  const result = await setup.service.exportDocument({ fileRef: setup.lease.fileRef, format: 'docx', ownerId: '1' })
  assert.equal(result.displayName, 'Tài liệu 1 (2).docx')
  assert.equal(readFileSync(join(paths.workspaceRoot, 'Tài liệu 1.docx'), 'utf8'), 'foreign')
  assert.ok(readFileSync(join(paths.workspaceRoot, result.displayName)).byteLength > 7)
})

test('an audit-log failure never turns a published export into a reported failure', async () => {
  const { authority, lease, paths, service } = harness()

  authority.auditOfficeExport = () => {
    throw new Error('ENOSPC')
  }

  const result = await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '1' })
  assert.equal(result.displayName, 'Tài liệu 1.docx')
  assert.ok(readFileSync(join(paths.workspaceRoot, result.displayName)).byteLength > 0)
})

test('a pinned expected revision that no longer matches the disk is a conflict, not an export', async () => {
  const { lease, paths, service } = harness()
  await assert.rejects(
    service.exportDocument({ expectedRevision: 'sha256:stale', fileRef: lease.fileRef, format: 'docx', ownerId: '1' }),
    /EXPORT_SOURCE_CHANGED/u
  )
  assert.equal(readFileSync(join(paths.workspaceRoot, 'Tài liệu 1.md'), 'utf8'), '# Xin chào')
})

test('an owner that cannot be resolved or is destroyed before publication never gets a file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atum-export-owner-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 3)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 3, paths })
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const sourcePath = join(paths.workspaceRoot, 'Tài liệu 1.md')
  writeFileSync(sourcePath, '# Xin chào')
  const lease = leases.openLocal(sourcePath, { workspaceRelativePath: 'Tài liệu 1.md' })
  let destroyed = false
  const contents = { isDestroyed: () => destroyed, once: vi.fn() }

  const pdfPrinter = {
    cancelAll: vi.fn(),
    cancelOwner: vi.fn(),
    render: vi.fn(async () => {
      destroyed = true

      return new Uint8Array(Buffer.from('%PDF-fake'))
    })
  }

  const service = new AtumOfficeExportService(leases, authority, pdfPrinter as never, {
    ownerContents: ownerId => (ownerId === 'live' ? contents : undefined),
    shareFile: () => undefined,
    showItemInFolder: () => undefined
  })

  await assert.rejects(
    service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: 'missing' }),
    /EXPORT_OWNER_DESTROYED/u
  )
  await assert.rejects(
    service.exportDocument({ fileRef: lease.fileRef, format: 'pdf', ownerId: 'live' }),
    /EXPORT_OWNER_DESTROYED/u
  )
  assert.deepEqual(
    readdirSync(paths.workspaceRoot).filter(name => name.endsWith('.docx') || name.endsWith('.pdf')),
    []
  )
})

test('export pins the document theme and records its provenance in the audit log', async () => {
  const { documentThemes, lease, paths, service } = harness()
  documentThemes.setFor(
    { account: { accountGeneration: 3, accountId: ACCOUNT }, workspaceRelativePath: 'Tài liệu 1.md' },
    { themeId: 'report' }
  )

  await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' })

  const record = JSON.parse(readFileSync(paths.capabilityAuditLog, 'utf8').trim().split('\n').at(-1)!)
  assert.equal(record.reason, 'ok')
  assert.equal(record.themeId, 'report')
  assert.equal(record.themeRevision, 1)
  assert.equal(record.themeSchemaVersion, 1)
  // Bounded metadata only: no font names, no paths.
  assert.equal(JSON.stringify(record).includes(paths.workspaceRoot), false)
  assert.equal(JSON.stringify(record).toLowerCase().includes('times'), false)
})

test('an untouched document exports under the inferred default theme', async () => {
  const { lease, paths, service } = harness()

  await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' })

  const record = JSON.parse(readFileSync(paths.capabilityAuditLog, 'utf8').trim().split('\n').at(-1)!)
  assert.equal(record.themeId, 'manuscript')
  assert.equal(record.themeRevision, 0)
})

test('the chosen theme reaches the exported file', async () => {
  // A0 pinned the theme and recorded it; A1 makes it drive the output. Two
  // documents that differ only by theme must not produce the same bytes.
  const plain = harness()
  const plainResult = await plain.service.exportDocument({ fileRef: plain.lease.fileRef, format: 'docx', ownerId: '7' })
  const plainBytes = readFileSync(join(plain.paths.workspaceRoot, plainResult.displayName))

  const themed = harness()
  themed.documentThemes.setFor(
    { account: { accountGeneration: 3, accountId: ACCOUNT }, workspaceRelativePath: 'Tài liệu 1.md' },
    { overrides: { pageSize: 'letter' }, themeId: 'book' }
  )

  const themedResult = await themed.service.exportDocument({
    fileRef: themed.lease.fileRef,
    format: 'docx',
    ownerId: '7'
  })

  const themedBytes = readFileSync(join(themed.paths.workspaceRoot, themedResult.displayName))

  assert.equal(themedBytes.equals(plainBytes), false, 'the theme must change the exported file')
})

test('a theme changed mid-export is caught before publication', async () => {
  // The fence is deliberately separate from the document revision fence: the
  // two have different causes and different remedies.
  const account = { accountGeneration: 3, accountId: ACCOUNT }

  const racy = harness(() => {
    // Runs inside beforeCommit, between the fsync and the link(2) commit.
    racy.documentThemes.setFor({ account, workspaceRelativePath: 'Tài liệu 1.md' }, { themeId: 'note' })
  })

  await assert.rejects(
    racy.service.exportDocument({ fileRef: racy.lease.fileRef, format: 'docx', ownerId: '1' }),
    /EXPORT_THEME_CHANGED/u
  )

  const record = JSON.parse(readFileSync(racy.paths.capabilityAuditLog, 'utf8').trim().split('\n').at(-1)!)
  assert.equal(record.reason, 'EXPORT_THEME_CHANGED')
  // Nothing was published.
  assert.equal(readdirSync(racy.paths.workspaceRoot).includes('Tài liệu 1.docx'), false)
})

test('an unchanged theme passes the fence at both points', async () => {
  const { documentThemes, lease, service } = harness()
  documentThemes.setFor(
    { account: { accountGeneration: 3, accountId: ACCOUNT }, workspaceRelativePath: 'Tài liệu 1.md' },
    { themeId: 'report' }
  )

  const result = await service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' })

  assert.ok(result.exportRef)
})

test('the PDF page box comes from the theme, not from the printer', async () => {
  const { documentThemes, lease, pdfPrinter, service } = harness()
  documentThemes.setFor(
    { account: { accountGeneration: 3, accountId: ACCOUNT }, workspaceRelativePath: 'Tài liệu 1.md' },
    { overrides: { pageSize: 'letter' }, themeId: 'note' }
  )

  await service.exportDocument({ fileRef: lease.fileRef, format: 'pdf', ownerId: '7' })

  const call = pdfPrinter.render.mock.calls.at(-1)![0] as unknown as {
    page: { width: number; height: number; margins: { top: number; left: number } }
  }

  // Letter, and the note theme's 19 mm margins, both in inches.
  assert.equal(Math.round(call.page.width * 1000) / 1000, 8.5)
  assert.equal(Math.round(call.page.height * 1000) / 1000, 11)
  assert.equal(Math.round(call.page.margins.top * 1000) / 1000, Math.round((19 / 25.4) * 1000) / 1000)
  assert.equal(Math.round(call.page.margins.left * 1000) / 1000, Math.round((19 / 25.4) * 1000) / 1000)
})

test('a theme store that fails mid-export fails the export closed', async () => {
  const { lease, paths, service } = harness()

  let calls = 0

  ;(service as never as { options: { documentThemes: { resolveFor: () => unknown } } }).options.documentThemes = {
    resolveFor: () => {
      calls += 1

      // The pin succeeds; the fence lookups throw.
      if (calls === 1) {
        return resolveDocumentTheme(null)
      }

      throw new Error('DOCUMENT_THEME_EXPLODED')
    }
  }

  await assert.rejects(
    service.exportDocument({ fileRef: lease.fileRef, format: 'docx', ownerId: '7' }),
    /EXPORT_THEME_UNAVAILABLE/u
  )
  assert.equal(readdirSync(paths.workspaceRoot).includes('Tài liệu 1.docx'), false)
  const record = JSON.parse(readFileSync(paths.capabilityAuditLog, 'utf8').trim().split('\n').at(-1)!)
  assert.equal(record.reason, 'EXPORT_THEME_UNAVAILABLE')
})

test('a theme changed during PDF rendering is reported as a theme conflict, not a PDF failure', async () => {
  const account = { accountGeneration: 3, accountId: ACCOUNT }

  const racy = harness(() => {
    racy.documentThemes.setFor({ account, workspaceRelativePath: 'Tài liệu 1.md' }, { themeId: 'note' })
  })

  await assert.rejects(
    racy.service.exportDocument({ fileRef: racy.lease.fileRef, format: 'pdf', ownerId: '1' }),
    /EXPORT_THEME_CHANGED/u
  )
  const record = JSON.parse(readFileSync(racy.paths.capabilityAuditLog, 'utf8').trim().split('\n').at(-1)!)
  assert.equal(record.reason, 'EXPORT_THEME_CHANGED')
  assert.equal(readdirSync(racy.paths.workspaceRoot).includes('Tài liệu 1.pdf'), false)
})

test('resolves the canvas theme for an open lease, falling back to the default when the store is broken', () => {
  const { documentThemes, lease, service } = harness()
  assert.equal(service.resolveDocumentTheme(lease.fileRef, '7').isDefault, true)

  documentThemes.setFor(
    { account: { accountGeneration: 3, accountId: ACCOUNT }, workspaceRelativePath: 'Tài liệu 1.md' },
    { themeId: 'book' }
  )
  assert.equal(service.resolveDocumentTheme(lease.fileRef, '7').id, 'book')
  ;(service as never as { options: { documentThemes: { resolveFor: () => never } } }).options.documentThemes = {
    resolveFor: () => {
      throw new Error('DOCUMENT_THEME_EXPLODED')
    }
  }
  assert.equal(service.resolveDocumentTheme(lease.fileRef, '7').isDefault, true)
})

test('a lease opened for one renderer cannot be read for its theme or exported by another', async () => {
  const { authority, leases, paths, service } = harness()
  const sourcePath = join(paths.workspaceRoot, 'Riêng.md')
  writeFileSync(sourcePath, '# riêng')
  const owned = leases.openLocal(sourcePath, { ownerId: '7', workspaceRelativePath: 'Riêng.md' })

  assert.equal(service.resolveDocumentTheme(owned.fileRef, '7').isDefault, true)
  assert.throws(() => service.resolveDocumentTheme(owned.fileRef, '8'), /CAPABILITY_DENIED/u)
  await assert.rejects(
    service.exportDocument({ fileRef: owned.fileRef, format: 'docx', ownerId: '8' }),
    /CAPABILITY_DENIED/u
  )
  assert.ok(authority)
})

test('setDocumentTheme is owner-bound, refuses off-catalogue choices, and reports durability', () => {
  const { lease, paths, service } = harness()

  const chosen = service.setDocumentTheme(lease.fileRef, '7', { overrides: { pageSize: 'letter' }, themeId: 'report' })
  assert.equal(chosen.theme.id, 'report')
  assert.equal(chosen.theme.pageSize, 'letter')
  assert.equal(chosen.persisted, true)
  assert.equal(service.resolveDocumentTheme(lease.fileRef, '7').revision, chosen.theme.revision)

  assert.throws(
    () => service.setDocumentTheme(lease.fileRef, '7', { themeId: 'comic-sans' as never }),
    /DOCUMENT_THEME_INVALID_SELECTION/u
  )

  const cleared = service.setDocumentTheme(lease.fileRef, '7', null)
  assert.equal(cleared.theme.isDefault, true)
  assert.equal(JSON.stringify(cleared).includes(paths.workspaceRoot), false)
})
