import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { resolveDocumentTheme } from '../shared/atum-office/document-theme'

import { AtumDocumentRecoveryJournal } from './atum-document-recovery'
import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import {
  ATUM_FILESYSTEM_IPC_CHANNELS,
  denyLegacyFilesystemIpcWhenAuthorityInstalled,
  registerAtumFilesystemIpc
} from './atum-filesystem-ipc'
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

test('trusted main-frame picker issues an opaque intent while spoofed renderer calls fail closed', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 8)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 8, paths })
  writeFileSync(join(paths.workspaceRoot, 'note.txt'), 'trusted')
  const handlers = new Map<string, (...args: any[]) => any>()

  const ipcMain = {
    handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler)
  }

  registerAtumFilesystemIpc(ipcMain as never, authority, {
    assertTrustedSender: event => {
      if ((event as unknown as { trusted?: boolean }).trusted !== true) {
        throw new Error('filesystem_sender_not_allowed')
      }
    },
    selectReadRoot: async () => paths.workspaceRoot
  })

  const select = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.selectReadRoot)!
  const read = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.readIntent)!
  await assert.rejects(select({ sender: { id: 1 }, trusted: false }), /filesystem_sender_not_allowed/u)
  const intent = await select({ sender: { id: 1 }, trusted: true })
  assert.equal(typeof intent.intentId, 'string')
  assert.equal(JSON.stringify(intent).includes(paths.workspaceRoot), false)
  await assert.rejects(
    read({ sender: { id: 1 }, trusted: false }, intent.intentId, 'note.txt'),
    /filesystem_sender_not_allowed/u
  )
  assert.deepEqual(await read({ sender: { id: 1 }, trusted: true }, intent.intentId, 'note.txt'), {
    byteSize: 7,
    text: 'trusted',
    truncated: false
  })
  await assert.rejects(read({ sender: { id: 1 }, trusted: true }, intent.intentId, 'note.txt'), /CAPABILITY_REPLAYED/u)
})

test('installed Atum authority disables legacy raw-path IPC before login and checks sender first', () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-legacy-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 8)
  const authority = new AtumFilesystemCapabilityAuthority()
  const event = { sender: { id: 1 }, trusted: true } as never

  assert.doesNotThrow(() => denyLegacyFilesystemIpcWhenAuthorityInstalled(event, null, () => undefined))
  assert.throws(
    () => denyLegacyFilesystemIpcWhenAuthorityInstalled(event, authority, () => undefined),
    /CAPABILITY_DENIED/u
  )

  authority.activateAccount({ accountId: ACCOUNT, generation: 8, paths })
  assert.throws(
    () => denyLegacyFilesystemIpcWhenAuthorityInstalled(event, authority, () => undefined),
    /CAPABILITY_DENIED/u
  )
  assert.throws(
    () =>
      denyLegacyFilesystemIpcWhenAuthorityInstalled(event, authority, () => {
        throw new Error('untrusted')
      }),
    /untrusted/u
  )
})

test('lease IPC returns no path and rejects spoofed reads, stale writes, and replay after release', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-lease-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 9)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 9, paths })
  const target = join(paths.workspaceRoot, 'lease.txt')
  writeFileSync(target, 'base')
  const handlers = new Map<string, (...args: any[]) => any>()

  registerAtumFilesystemIpc(
    { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as never,
    authority,
    {
      assertTrustedSender: event => {
        if ((event as unknown as { trusted?: boolean }).trusted !== true) {
          throw new Error('filesystem_sender_not_allowed')
        }
      },
      selectReadRoot: async () => paths.workspaceRoot,
      selectTextFile: async () => target
    },
    new WorkspaceTextFileLeaseProvider(authority)
  )

  const select = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.selectTextFile)!
  const read = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRead)!
  const write = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseWrite)!
  const release = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRelease)!
  assert.equal(handlers.has(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryRead), false)
  await assert.rejects(select({ sender: { id: 1 }, trusted: false }), /filesystem_sender_not_allowed/u)
  const lease = await select({ sender: { id: 1 }, trusted: true })
  assert.equal(JSON.stringify(lease).includes(target), false)
  assert.throws(() => read({ sender: { id: 1 }, trusted: false }, lease.fileRef), /filesystem_sender_not_allowed/u)
  const snapshot = await read({ sender: { id: 1 }, trusted: true }, lease.fileRef)
  await assert.rejects(
    write({ sender: { id: 1 }, trusted: true }, lease.fileRef, { expectedRevision: 'sha256:spoofed', text: 'lost' }),
    /WORKSPACE_CONFLICT/u
  )
  await write({ sender: { id: 1 }, trusted: true }, lease.fileRef, {
    expectedRevision: snapshot.revision,
    text: 'saved'
  })
  await release({ sender: { id: 1 }, trusted: true }, lease.fileRef)
  await assert.rejects(read({ sender: { id: 1 }, trusted: true }, lease.fileRef), /CAPABILITY_REVOKED/u)
})

test('recovery IPC is version-gated, lease-owner-bound, and returns only opaque draft records', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-recovery-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 11)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 11, paths })
  writeFileSync(join(paths.workspaceRoot, 'recover.md'), 'saved text')
  const handlers = new Map<string, (...args: any[]) => any>()
  const leases = new WorkspaceTextFileLeaseProvider(authority)

  const recovery = new AtumDocumentRecoveryJournal(authority, fileRef => leases.resolveDocumentRecoveryLease(fileRef), {
    journalRootFor: account => join(roots.pathsForAccount(account.accountId).root, 'document-recovery')
  })

  registerAtumFilesystemIpc(
    { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as never,
    authority,
    {
      assertTrustedSender: event => {
        if ((event as unknown as { trusted?: boolean }).trusted !== true) {
          throw new Error('filesystem_sender_not_allowed')
        }
      },
      selectReadRoot: async () => paths.workspaceRoot,
      selectTextFile: async () => null
    },
    leases,
    undefined,
    undefined,
    recovery
  )

  const open = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseOpenWorkspace)!
  const read = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryRead)!
  const write = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryWrite)!
  const discard = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryDiscard)!
  const mine = { sender: { id: 1 }, trusted: true }
  const other = { sender: { id: 2 }, trusted: true }
  const descriptor = await open(mine, 'recover.md')

  assert.deepEqual(await read(mine, descriptor.fileRef), { outcome: 'absent', record: null })

  const saved = await write(mine, descriptor.fileRef, {
    baseRevision: 'sha256:saved-text',
    editorRevision: 'editor-1',
    expectedDraftRevision: null,
    text: 'recoverable edit'
  })

  assert.equal(saved.outcome, 'saved')
  assert.equal(JSON.stringify(saved).includes(paths.workspaceRoot), false)
  await assert.rejects(read(other, descriptor.fileRef), /CAPABILITY_DENIED/u)

  const current = await read(mine, descriptor.fileRef)
  assert.equal(current.outcome, 'present')

  if (current.outcome !== 'present') {
    return
  }

  await assert.deepEqual(await discard(mine, descriptor.fileRef, current.record.draftRevision), {
    outcome: 'discarded',
    record: null
  })
  await assert.rejects(
    write(mine, descriptor.fileRef, {
      baseRevision: 'sha256:saved-text',
      editorRevision: 'editor-2',
      expectedDraftRevision: {},
      text: 'invalid'
    }),
    /DOCUMENT_RECOVERY_INVALID_INPUT/u
  )
})

test('assistant lease IPC forwards trusted window identity for adopt and dismiss', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-assistant-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 10)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 10, paths })
  const handlers = new Map<string, (...args: any[]) => any>()
  const calls: unknown[] = []

  registerAtumFilesystemIpc(
    { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as never,
    authority,
    {
      assistantLeases: {
        adopt: (fileRef, ownerId) => {
          calls.push({ action: 'adopt', fileRef, ownerId })

          return { adopted: true }
        },
        assertAccess: () => undefined,
        dismiss: async (fileRef, ownerId) => {
          calls.push({ action: 'dismiss', fileRef, ownerId })

          return { released: false }
        },
        release: async () => undefined
      },
      assertTrustedSender: event => {
        if ((event as unknown as { trusted?: boolean }).trusted !== true) {
          throw new Error('filesystem_sender_not_allowed')
        }
      },
      selectReadRoot: async () => paths.workspaceRoot,
      selectTextFile: async () => null
    },
    new WorkspaceTextFileLeaseProvider(authority)
  )

  const event = { sender: { id: 42 }, trusted: true }
  assert.deepEqual(await handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.assistantLeaseAdopt)!(event, 'opaque-file'), {
    adopted: true
  })
  assert.deepEqual(await handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.assistantLeaseDismiss)!(event, 'opaque-file'), {
    released: false
  })
  assert.deepEqual(calls, [
    { action: 'adopt', fileRef: 'opaque-file', ownerId: '42' },
    { action: 'dismiss', fileRef: 'opaque-file', ownerId: '42' }
  ])
})

test('workspace document creation names files without collisions and reopens them by relative path only', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-document-ipc-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 10)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 10, paths })
  const handlers = new Map<string, (...args: any[]) => any>()

  registerAtumFilesystemIpc(
    { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as never,
    authority,
    {
      assertTrustedSender: event => {
        if ((event as unknown as { trusted?: boolean }).trusted !== true) {
          throw new Error('filesystem_sender_not_allowed')
        }
      },
      selectReadRoot: async () => paths.workspaceRoot,
      selectTextFile: async () => null
    },
    new WorkspaceTextFileLeaseProvider(authority)
  )

  const create = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseCreateDocument)!
  const openWorkspace = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseOpenWorkspace)!
  const read = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRead)!

  assert.throws(
    () => create({ sender: { id: 1 }, trusted: false }, { baseName: 'Tài liệu' }),
    /filesystem_sender_not_allowed/u
  )
  const first = await create({ sender: { id: 1 }, trusted: true }, { baseName: 'Tài liệu' })
  const second = await create({ sender: { id: 1 }, trusted: true }, { baseName: 'Tài liệu' })
  assert.equal(first.displayName, 'Tài liệu 1.md')
  assert.equal(first.workspaceRelativePath, 'Tài liệu 1.md')
  assert.equal(second.workspaceRelativePath, 'Tài liệu 2.md')
  assert.equal(JSON.stringify(first).includes(paths.workspaceRoot), false)
  assert.deepEqual(await read({ sender: { id: 1 }, trusted: true }, first.fileRef), {
    revision: (await read({ sender: { id: 1 }, trusted: true }, first.fileRef)).revision,
    text: '',
    truncated: false
  })

  const reopened = await openWorkspace({ sender: { id: 1 }, trusted: true }, 'Tài liệu 2.md')
  assert.equal(reopened.workspaceRelativePath, 'Tài liệu 2.md')
  assert.notEqual(reopened.fileRef, second.fileRef)
  await assert.rejects(openWorkspace({ sender: { id: 1 }, trusted: true }, '../outside.md'), /CAPABILITY_SCOPE_ESCAPE/u)
  await assert.rejects(
    openWorkspace({ sender: { id: 1 }, trusted: true }, paths.workspaceRoot + '/Tài liệu 1.md'),
    /CAPABILITY_SCOPE_ESCAPE/u
  )
  await assert.rejects(openWorkspace({ sender: { id: 1 }, trusted: true }, 'Tài liệu 9.md'), /WORKSPACE_OPEN_FAILED/u)
  await assert.rejects(create({ sender: { id: 1 }, trusted: true }, { baseName: '../escape' }), /CAPABILITY_DENIED/u)
  const txt = await create({ sender: { id: 1 }, trusted: true }, { baseName: 'Ghi chú', extension: '.txt' })
  assert.equal(txt.displayName, 'Ghi chú 1.txt')
})

test('the theme read is owner-bound: another trusted renderer holding the reference is denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atum-theme-ipc-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare('00000000-0000-4000-8000-bd7662a5eeb4')
  roots.commit('00000000-0000-4000-8000-bd7662a5eeb4', 1)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: '00000000-0000-4000-8000-bd7662a5eeb4', generation: 1, paths })
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const handlers = new Map<string, (...args: any[]) => any>()

  const themes = {
    clearFor: () => undefined,
    lastMutationDurable: true,
    resolveFor: () => resolveDocumentTheme({ themeId: 'book' }, 1),
    setFor: () => resolveDocumentTheme({ themeId: 'book' }, 2)
  }

  const exportsService = new AtumOfficeExportService(
    leases,
    authority,
    { cancelAll() {}, render: async () => new Uint8Array() } as never,
    {
      documentThemes: themes,
      shareFile: () => undefined,
      showItemInFolder: () => undefined
    }
  )

  registerAtumFilesystemIpc(
    { handle: (channel, handler) => handlers.set(channel, handler as never) } as never,
    authority,
    {
      assertTrustedSender: () => undefined,
      selectReadRoot: async () => null,
      selectTextFile: async () => null
    } as never,
    leases,
    exportsService
  )

  const create = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.leaseCreateDocument)!

  const descriptor = (await create({ sender: { id: 7 } }, { baseName: 'Riêng', extension: '.md' })) as {
    fileRef: string
  }

  const theme = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.documentTheme)!

  const mine = (await theme({ sender: { id: 7 } }, { fileRef: descriptor.fileRef })) as { id: string }
  assert.equal(mine.id, 'book')
  assert.equal(JSON.stringify(mine).includes(paths.workspaceRoot), false)
  await assert.rejects(theme({ sender: { id: 8 } }, { fileRef: descriptor.fileRef }), /CAPABILITY_DENIED/u)

  // The write is parsed at the boundary and owner-bound the same way.
  const set = handlers.get(ATUM_FILESYSTEM_IPC_CHANNELS.documentThemeSet)!

  const chosen = (await set(
    { sender: { id: 7 } },
    { fileRef: descriptor.fileRef, selection: { themeId: 'book' } }
  )) as {
    theme: { id: string }
    persisted: boolean
  }

  assert.equal(chosen.theme.id, 'book')

  // Strict at the boundary: an unknown override key, an out-of-range size or an
  // unknown page size is refused, not silently dropped.
  for (const overrides of [{ css: 'x' }, { bodySizePt: 400 }, { pageSize: 'a3' }, { bodySizePt: 11.25 }]) {
    await assert.rejects(
      set({ sender: { id: 7 } }, { fileRef: descriptor.fileRef, selection: { overrides, themeId: 'book' } }),
      /DOCUMENT_THEME_INVALID_SELECTION/u
    )
  }

  await assert.rejects(
    set({ sender: { id: 8 } }, { fileRef: descriptor.fileRef, selection: null }),
    /CAPABILITY_DENIED/u
  )
})
