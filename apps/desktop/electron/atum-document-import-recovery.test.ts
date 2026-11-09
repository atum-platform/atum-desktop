import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate/browser'
import { afterEach, test } from 'vitest'

import { ATUM_CONSUMER_FILES_IPC_CHANNELS, AtumConsumerFilesService, registerAtumConsumerFilesIpc } from './atum-consumer-files'
import { AtumDocumentRecoveryJournal } from './atum-document-recovery'
import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { ATUM_FILESYSTEM_IPC_CHANNELS, registerAtumFilesystemIpc } from './atum-filesystem-ipc'
import { AccountRootAuthority } from './atum-messaging'
import { AtumOfficeImportService } from './atum-office-import'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

for (const route of ['picker', 'files-panel'] as const) {
  test(`${route} Word import supports recovery and save/reopen for its owning window`, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'atum-import-recovery-')))
    cleanups.push(home)
    const documents = join(home, 'Documents')
    mkdirSync(documents)
    const source = join(documents, 'Báo cáo.docx')

    const original = zipSync({
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Xin chào</w:t></w:r></w:p></w:body></w:document>')
    })

    writeFileSync(source, original)
    const untrustedSource = join(documents, 'untrusted.docx')

    writeFileSync(untrustedSource, zipSync({
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Untrusted argument</w:t></w:r></w:p></w:body></w:document>')
    }))

    const roots = new AccountRootAuthority(join(home, 'user-data'))
    const accountId = '00000000-0000-4000-8000-bd7662a5eeb4'
    const paths = roots.prepare(accountId)
    roots.commit(accountId, 1)
    const authority = new AtumFilesystemCapabilityAuthority()
    authority.activateAccount({ accountId, generation: 1, paths })

    const leases = new WorkspaceTextFileLeaseProvider(authority, {
      prepareFileReplacement: (ref, identity) => recovery.prepareFileReplacement(ref, identity)
    })

    const recovery = new AtumDocumentRecoveryJournal(authority, ref => leases.resolveDocumentRecoveryLease(ref), {
      journalRootFor: account => join(roots.pathsForAccount(account.accountId).root, 'document-recovery')
    })

    const imports = new AtumOfficeImportService(leases, authority, { selectDocx: async () => source })
    const handlers = new Map<string, (...args: any[]) => any>()
    const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) }

    const assertTrustedSender = (event: { sender: { id: number } }) => {
      if (![7, 8].includes(event.sender.id)) { throw new Error('untrusted') }
    }

    registerAtumFilesystemIpc(ipc as never, authority, {
      assertTrustedSender,
      selectReadRoot: async () => paths.workspaceRoot,
      selectTextFile: async () => null
    }, leases, undefined, imports, recovery)
    registerAtumConsumerFilesIpc(ipc as never, new AtumConsumerFilesService({
      leases,
      importDocx: (sourcePath, ownerId) => imports.importDocx({ ownerId, sourcePath }),
      roots: () => ({ home, documents, desktop: home, downloads: home }),
      shell: { openPath: async () => '', showItemInFolder: () => {}, trashItem: async () => {} }
    }), assertTrustedSender)

    const mine = { sender: { id: 7 } }
    const other = { sender: { id: 8 } }
    const open = handlers.get(route === 'picker' ? ATUM_FILESYSTEM_IPC_CHANNELS.importDocx : ATUM_CONSUMER_FILES_IPC_CHANNELS.open)!
    // A forged extra owner argument cannot replace the authenticated sender.
    const opened = await open(mine, route === 'picker' ? untrustedSource : source, '8')
    const descriptor = opened.descriptor
    assert.ok(descriptor.workspaceRelativePath)
    assert.equal(JSON.stringify(descriptor).includes(home), false)
    const readDraft = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryRead)!
    const writeDraft = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryWrite)!
    const discardDraft = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryDiscard)!
    assert.deepEqual(await readDraft(mine, descriptor.fileRef), { outcome: 'absent', record: null })
    await assert.rejects(readDraft(other, descriptor.fileRef), /CAPABILITY_DENIED/u)

    const snapshot = await leases.read(descriptor.fileRef)
    assert.equal(snapshot.text, 'Xin chào')
    const text = `${snapshot.text}\n\nTiếng Việt đã lưu.`

    const draft = await writeDraft(mine, descriptor.fileRef, {
      baseRevision: snapshot.revision, editorRevision: 'edit-1', expectedDraftRevision: null, text
    })

    assert.equal(draft.outcome, 'saved')
    await assert.rejects(writeDraft(other, descriptor.fileRef, {
      baseRevision: snapshot.revision, editorRevision: 'foreign', expectedDraftRevision: null, text: 'foreign'
    }), /CAPABILITY_DENIED/u)

    await handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseWrite)!(mine, descriptor.fileRef, {
      expectedRevision: snapshot.revision, text
    })
    assert.equal((await readDraft(mine, descriptor.fileRef)).record.text, text)
    await assert.rejects(discardDraft(other, descriptor.fileRef, draft.record.draftRevision), /CAPABILITY_DENIED/u)
    assert.deepEqual(await discardDraft(mine, descriptor.fileRef, draft.record.draftRevision), { outcome: 'discarded', record: null })
    await leases.release(descriptor.fileRef)
    const reopened = await handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseOpenWorkspace)!(mine, descriptor.workspaceRelativePath)
    assert.equal((await leases.read(reopened.fileRef)).text, text)
    assert.deepEqual(await readDraft(mine, reopened.fileRef), { outcome: 'absent', record: null })
    assert.deepEqual(new Uint8Array(readFileSync(source)), original)

    // External deletion reaches real fs checks during owner resolution. Keep
    // those errors inside the same path-free boundary as journal operations.
    rmSync(join(paths.workspaceRoot, descriptor.workspaceRelativePath))
    await assert.rejects(readDraft(mine, reopened.fileRef), { message: 'WORKSPACE_IO_FAILED' })
    await assert.rejects(writeDraft(mine, reopened.fileRef, {
      baseRevision: snapshot.revision, editorRevision: 'deleted', expectedDraftRevision: null, text
    }), { message: 'WORKSPACE_IO_FAILED' })
    await assert.rejects(discardDraft(mine, reopened.fileRef, draft.record.draftRevision), { message: 'WORKSPACE_IO_FAILED' })
    await assert.rejects(readDraft(other, reopened.fileRef), { message: 'CAPABILITY_DENIED' })
  })
}
