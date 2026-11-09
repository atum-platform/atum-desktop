import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { undo } from '@codemirror/commands'
import { history } from '@codemirror/commands'
import { EditorState as CodeMirrorState } from '@codemirror/state'
import { strFromU8, unzipSync } from 'fflate/browser'
import { EditorState } from 'prosemirror-state'
import { afterEach, test, vi } from 'vitest'

import { parseRichMarkdown } from '../src/app/chat/document/rich-markdown-model'
import { prepareRichTransaction } from '../src/app/chat/document/rich-markdown-transactions'

import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import { AtumOfficeExportService } from './atum-office-export'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const ACCOUNT = '00000000-0000-4000-8000-bd7662a5eeb4'
const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'atum-rich-document-lifecycle-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 7)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 7, paths })
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const sourcePath = join(paths.workspaceRoot, 'Ke hoach.md')
  const source = '# Kế hoạch\r\n\r\n| Hạng mục | Trạng thái |\r\n| --- | --- |\r\n| Họp | Chờ |\r\n'
  writeFileSync(sourcePath, source)
  const lease = leases.openLocal(sourcePath, { ownerId: 'document-owner', workspaceRelativePath: 'Ke hoach.md' })
  const pdfPrinter = { cancelAll: vi.fn(), render: vi.fn() }

  const exports = new AtumOfficeExportService(leases, authority, pdfPrinter as never, {
    shareFile: () => undefined,
    showItemInFolder: () => undefined
  })

  return { exports, lease, leases, paths, pdfPrinter, source, sourcePath }
}

function undoSourceChange(source: string, patch: { from: number; insert: string; to: number }): string {
  let state = CodeMirrorState.create({
    doc: source,
    extensions: [CodeMirrorState.lineSeparator.of('\n'), history()]
  })

  state = state.update({ changes: patch }).state

  // `undo` only needs state plus dispatch. This keeps the canonical source
  // history proof in-process without mounting a DOM editor.
  const view = {
    dispatch: (transaction: { state: CodeMirrorState }) => {
      state = transaction.state
    },
    get state() {
      return state
    }
  }

  assert.equal(undo(view as never), true)

  return state.doc.toString()
}

test('rich source transaction remains fenced, exportable, undoable, and byte-identical after a clean reopen', async () => {
  const { exports, lease, leases, paths, pdfPrinter, source, sourcePath } = harness()
  const opened = await leases.read(lease.fileRef)
  assert.equal(opened.text, source)
  assert.ok(opened.text.includes('\r\n'))

  const parsed = parseRichMarkdown(opened.text)
  assert.equal(parsed.kind, 'parsed')

  if (parsed.kind !== 'parsed') {
    return
  }

  const range = parsed.textRanges.find(item => item.text === 'Chờ')
  assert.ok(range)
  const pmState = EditorState.create({ doc: parsed.doc })

  const prepared = prepareRichTransaction(
    parsed,
    pmState,
    pmState.tr.insertText('Đã xong', range!.pos, range!.pos + range!.text.length)
  )

  assert.equal(prepared.kind, 'accepted')

  if (prepared.kind !== 'accepted' || !prepared.patch) {
    return
  }

  assert.ok(prepared.parsed.source.includes('| Họp | Đã xong |\r\n'))
  assert.ok(prepared.parsed.source.includes('\r\n'))

  const changed = await leases.write(lease.fileRef, {
    expectedRevision: opened.revision,
    text: prepared.parsed.source
  })

  assert.equal(readFileSync(sourcePath, 'utf8'), prepared.parsed.source)

  const docx = await exports.exportDocument({
    expectedRevision: changed.revision,
    fileRef: lease.fileRef,
    format: 'docx',
    ownerId: 'document-owner'
  })

  assert.equal(pdfPrinter.render.mock.calls.length, 0)

  const documentXml = strFromU8(
    unzipSync(readFileSync(join(paths.workspaceRoot, docx.displayName)))['word/document.xml']!
  )

  assert.match(documentXml, /Đã xong/u)
  assert.match(documentXml, /Hạng mục/u)
  assert.match(documentXml, /<w:tbl[ >]/u)

  // A concurrent assistant/file update wins. The stale rich save is fenced and
  // cannot restore the in-memory source over the external revision.
  writeFileSync(sourcePath, '# Agent changed this\r\n')
  await assert.rejects(
    leases.write(lease.fileRef, { expectedRevision: changed.revision, text: prepared.parsed.source }),
    /WORKSPACE_CONFLICT/u
  )
  assert.equal(readFileSync(sourcePath, 'utf8'), '# Agent changed this\r\n')

  // The separate source-history record restores original CRLF bytes exactly.
  // An explicit clean reread grants current authority for this deliberate restore;
  // the production pane resets its history when accepting an external revision.
  const reread = await leases.read(lease.fileRef)
  assert.equal(reread.text, '# Agent changed this\r\n')
  const undone = undoSourceChange(source, prepared.patch)
  assert.equal(undone, source)
  await leases.write(lease.fileRef, { expectedRevision: reread.revision, text: undone })
  assert.equal(readFileSync(sourcePath, 'utf8'), source)

  await leases.release(lease.fileRef)

  const reopenedLease = leases.openLocal(sourcePath, {
    ownerId: 'document-owner',
    workspaceRelativePath: 'Ke hoach.md'
  })

  const reopened = await leases.read(reopenedLease.fileRef)
  assert.equal(reopened.text, source)
  await leases.release(reopenedLease.fileRef)
})
