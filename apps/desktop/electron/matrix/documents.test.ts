import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_MAX_FILE_BYTES } from '../../shared/matrix'
import { AtumConsumerFilesService } from '../atum-consumer-files'
import { AtumFilesystemCapabilityAuthority } from '../atum-filesystem-capability'
import { AccountRootAuthority } from '../atum-messaging'
import { AtumPdfViewController } from '../atum-pdf-view'
import { EncryptedStore } from '../encrypted-store'

import { MatrixRoomDocuments } from './documents'
import { MatrixTextDocument } from './text-document'
import { MatrixWordDocument } from './word-document'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-documents-')))
  cleanups.push(home)
  const file = join(home, 'document.txt')
  writeFileSync(file, 'saved version one')

  const files = new AtumConsumerFilesService({
    roots: () => ({ home, documents: home, desktop: home, downloads: home }),
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
  })

  const vaultPath = join(home, 'vault.json')

  // Test-only safeStorage, never consults the OS Keychain.
  const store = new EncryptedStore(vaultPath, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })

  const documents = new MatrixRoomDocuments(files, store)
  const scope = { userId: '@alice:test', roomId: '!one:test' }

  return {
    home,
    file,
    files,
    store,
    vaultPath,
    documents,
    scope,
    choose: () => documents.choose(scope, async () => file)
  }
}

it('keeps a local per-room link, reads current saved bytes, and persists no path or body', async () => {
  const f = fixture()
  expect(f.documents.describe(f.scope)).toBeNull()
  const capture = vi.spyOn(f.files, 'capture')
  await f.choose()
  expect(capture).not.toHaveBeenCalled()
  expect(f.documents.describe(f.scope)).toMatchObject({ name: 'document.txt', state: 'linked' })
  const pending = f.documents.forInvocation(f.scope)!
  expect(capture).not.toHaveBeenCalled()
  writeFileSync(f.file, 'saved version two')
  const result = await pending.capture()
  expect(Buffer.from(result.bytes).toString()).toBe('saved version two')
  const entries = JSON.parse(readFileSync(f.vaultPath, 'utf8')).entries

  for (const entry of Object.values(entries) as { value: string }[]) {
    const intent = JSON.parse(Buffer.from(entry.value, 'base64').toString())
    expect(Object.keys(intent).sort()).toEqual(['name', 'revision'])
    expect(JSON.stringify(intent)).not.toContain(f.home)
    expect(JSON.stringify(intent)).not.toContain('saved version')
  }

  expect(f.documents.describe({ ...f.scope, roomId: '!two:test' })).toBeNull()
  expect(f.documents.describe({ ...f.scope, userId: '@bob:test' })).toBeNull()
})

it('edits an explicitly linked real text file through opaque preview custody and captures its own atomic replacement', async () => {
  const f = fixture()
  const roots = new AccountRootAuthority(join(f.home, 'private'))
  const paths = roots.prepare('matrix-test-account')
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: 'matrix-test-account', generation: 1, paths })
  const fixedScope = { ...f.scope, deviceId: 'TEST', account: { accountId: 'matrix-test-account', accountGeneration: 1 } }

  const documents = new MatrixRoomDocuments(f.files, f.store, undefined, undefined, () => new MatrixTextDocument(fixedScope, {
    authority, currentScope: () => fixedScope, confine: requested => f.files.confine(requested),
    journalRootFor: () => join(paths.root, 'recovery')
  }))

  await documents.choose(f.scope, async () => f.file)
  const preview = await documents.preview(f.scope)
  expect(preview).toMatchObject({ kind: 'editable', name: 'document.txt', recovery: false })
  expect(JSON.stringify(preview)).not.toContain(f.home)
  expect(() => documents.textForPreview({ ...f.scope, roomId: '!foreign:test' }, preview.token)).toThrow('matrix_document_unavailable')
  const invocation = documents.forInvocation(f.scope)!
  const text = documents.textForPreview(f.scope, preview.token)
  const first = await text.read()
  await text.write({ expectedRevision: first.revision, text: 'own atomic save' })
  expect(Buffer.from((await invocation.capture()).bytes).toString()).toBe('own atomic save')
  expect(readFileSync(f.file, 'utf8')).toBe('own atomic save')
  documents.retainTextRoom({ ...f.scope, roomId: '!next:test' })
  expect(documents.describe(f.scope)?.state).toBe('reconnect_required')
  expect(() => documents.textForPreview(f.scope, preview.token)).toThrow('matrix_document_unavailable')
  await expect(text.write({ expectedRevision: first.revision, text: 'foreign write' })).rejects.toThrow('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
  await expect(invocation.capture()).rejects.toThrow('matrix_document_unavailable')
  expect(readFileSync(f.file, 'utf8')).toBe('own atomic save')
})

it.each(['inode-replaced', 'file-moved', 'unsupported-text', 'oversized', 'offline'] as const)(
  'keeps editable preview custody when invocation capture fails because of %s', async cause => {
    const f = fixture()
    const fixedScope = { ...f.scope, deviceId: 'TEST', account: { accountId: 'matrix-test-account', accountGeneration: 1 } }
    let available = true
    const documents = new MatrixRoomDocuments(f.files, f.store, undefined, undefined, () => new MatrixTextDocument(fixedScope, {
      authority: { currentAuthority: () => ({ account: fixedScope.account }) },
      currentScope: () => fixedScope, available: () => available,
      confine: requested => f.files.confine(requested), journalRootFor: () => join(f.home, 'recovery')
    }))
    await documents.choose(f.scope, async () => f.file)
    const preview = await documents.preview(f.scope)
    const text = documents.textForPreview(f.scope, preview.token)
    const capture = documents.forInvocation(f.scope)!

    if (cause === 'inode-replaced') {
      const replacement = join(f.home, 'replacement.txt')
      writeFileSync(replacement, 'saved version one')
      renameSync(replacement, f.file)
    } else if (cause === 'file-moved') {
      renameSync(f.file, join(f.home, 'moved.txt'))
    } else if (cause === 'unsupported-text') {
      writeFileSync(f.file, 'one\r\ntwo\n')
    } else if (cause === 'oversized') {
      writeFileSync(f.file, Buffer.alloc(1024 * 1024 + 1, 65))
    } else {
      available = false
    }

    await expect(capture.capture()).rejects.toThrow('matrix_document_unavailable')
    expect(documents.describe(f.scope)?.state).toBe('linked')
    // Offline I/O remains fenced; reconnect must preserve this same custody.
    available = true
    expect(documents.textForPreview(f.scope, preview.token)).toBe(text)
    // Scope retirement, unlike a recoverable capture failure, ends custody.
    documents.retainTextRoom({ ...f.scope, roomId: '!next:test' })
    expect(() => documents.textForPreview(f.scope, preview.token)).toThrow('matrix_document_unavailable')
  }
)

it.each([
  ['oversized', Buffer.alloc(1024 * 1024 + 1, 65)],
  ['invalid-utf8', Buffer.from([0xe9, 10])],
  ['nul', Buffer.from('plain\0binary')],
  ['mixed-line-endings', Buffer.from('one\r\ntwo\n')]
] as const)('keeps %s text on the read-only raw-byte grant instead of losing the link', async (_kind, bytes) => {
  const f = fixture()
  writeFileSync(f.file, bytes)
  const fixedScope = { ...f.scope, deviceId: 'TEST', account: { accountId: 'matrix-test-account', accountGeneration: 1 } }

  const documents = new MatrixRoomDocuments(f.files, f.store, undefined, undefined, () => new MatrixTextDocument(fixedScope, {
    authority: { currentAuthority: () => ({ account: fixedScope.account }) },
    currentScope: () => fixedScope,
    confine: requested => f.files.confine(requested),
    journalRootFor: () => join(f.home, 'recovery')
  }))

  await documents.choose(f.scope, async () => f.file)
  expect(documents.describe(f.scope)).toMatchObject({ name: 'document.txt', state: 'linked' })
  expect((await documents.preview(f.scope)).kind).not.toBe('editable')
  expect(Buffer.from((await documents.forInvocation(f.scope)!.capture()).bytes).equals(bytes)).toBe(true)
  expect(readFileSync(f.file).equals(bytes)).toBe(true)
})

it('captures a chosen Word live buffer and freezes its operation port to the room link, never saved OOXML or a later link', async () => {
  const f = fixture()
  const file = join(f.home, 'proof.docx')
  writeFileSync(file, 'synthetic OOXML bytes')

  const live = { read: vi.fn(async () => ({ text: 'unsaved WORD_PROOF', saved: false,
    selection: { text: 'WORD_PROOF', start: 8, end: 18 } })), replace: vi.fn() }

  const word = { open: vi.fn(async (path: string) => ({ path, windowNumber: 1, windowId: 3,
    topInset: 40, saved: false, bounds: { x: 0, y: 25, width: 1000, height: 800 } })),
    arrange: vi.fn(async () => {}), restore: vi.fn(async () => {}), inspect: vi.fn(async () => ({ saved: false })),
    bind: vi.fn(async (path: string) => ({ path, windowNumber: 1, windowId: 3,
      topInset: 40, saved: false, bounds: { x: 0, y: 25, width: 1000, height: 800 } })) }

  const window = { isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false,
    getNormalBounds: () => ({ x: 0, y: 25, width: 1200, height: 800 }),
    getBounds: () => ({ x: 0, y: 25, width: 1200, height: 800 }),
    getMinimumSize: () => [800, 600], setMinimumSize: vi.fn(), unmaximize: vi.fn(), maximize: vi.fn(),
    setBounds: vi.fn(), show: vi.fn() }

  const documents = new MatrixRoomDocuments(f.files, f.store, undefined, (scope, token) => new MatrixWordDocument(
    JSON.stringify(scope), { window: () => window, authority: () => {
      if (!f.files.resolveCapture(token)) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}

      return 'owner:1'
    }, authorizePath: requested => {
      const target = f.files.resolveCapture(token)

      if (!target || target !== f.files.confine(requested)) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}

      return target
    }, word, live, ended: vi.fn(), workArea: () => ({ x: 0, y: 25, width: 1920, height: 1055 }) }
  ))

  await documents.choose(f.scope, async () => file)
  expect(documents.describe(f.scope)).toMatchObject({ name: 'proof.docx', kind: 'word', state: 'linked' })
  const invocation = documents.forInvocation(f.scope)!
  const capture = await invocation.capture()
  expect(capture.name).toBe('proof.docx.context.json')
  const context = JSON.parse(Buffer.from(capture.bytes).toString())
  expect(context).toMatchObject({ text: 'unsaved WORD_PROOF', saved: false, selection: { text: 'WORD_PROOF' } })
  expect(context.source_revision).toBeTruthy()
  expect(JSON.stringify(context)).not.toContain(f.home)
  expect(await documents.preview(f.scope)).toMatchObject({ kind: 'word', saved: false, text: 'unsaved WORD_PROOF' })
  await documents.arrangeWord(f.scope, false)
  expect((await invocation.capture()).bytes.byteLength).toBeGreaterThan(0)
  expect(word.restore).toHaveBeenCalledOnce()
  expect(documents.forInvocation({ ...f.scope, roomId: '!elsewhere:test' })).toBeUndefined()
  const entries = JSON.parse(readFileSync(f.vaultPath, 'utf8')).entries
  expect(JSON.stringify(entries)).not.toContain('WORD_PROOF')
  await documents.choose(f.scope, async () => f.file)
  await expect(invocation.capture()).rejects.toThrow('matrix_document_unavailable')
  await expect(invocation.word!({ profile: 'matrix', request_id: 'q', session_id: 's', turn_id: 't' }, vi.fn(), new AbortController().signal))
    .rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
})

it('restart and logout preserve intent but revoke read authority; remove never falls back to another document', async () => {
  const f = fixture()
  await f.choose()
  const captured = f.documents.forInvocation(f.scope)!
  f.documents.reset()
  await expect(captured.capture()).rejects.toThrow('matrix_document_unavailable')

  for (const docs of [f.documents, new MatrixRoomDocuments(f.files, f.store)]) {
    expect(docs.describe(f.scope)?.state).toBe('reconnect_required')
    expect(() => docs.forInvocation(f.scope)).toThrow('matrix_document_unavailable')
  }

  await f.choose()
  f.documents.remove(f.scope)
  expect(f.documents.forInvocation(f.scope)).toBeUndefined()
  expect(new MatrixRoomDocuments(f.files, f.store).describe(f.scope)).toBeNull()
})

it.each(['replaced', 'symlink', 'grown', 'missing'] as const)(
  'refuses a %s target without substituting another file',
  async mode => {
    const f = fixture()
    await f.choose()
    const context = f.documents.forInvocation(f.scope)!

    if (mode === 'grown') {
      truncateSync(f.file, MATRIX_MAX_FILE_BYTES + 1)
    } else {
      renameSync(f.file, join(f.home, 'original.txt'))

      if (mode === 'replaced') {
        writeFileSync(f.file, 'different file')
      }

      if (mode === 'symlink') {
        writeFileSync(join(f.home, '.env'), 'PRIVATE=fixture')
        symlinkSync(join(f.home, '.env'), f.file)
      }
    }

    await expect(context.capture()).rejects.toThrow('matrix_document_unavailable')
    expect(f.documents.describe(f.scope)?.state).toBe('unavailable')
  }
)

it('cancelled or rejected replacements retain the earlier link', async () => {
  const f = fixture()
  await f.choose()
  await f.documents.choose(f.scope, async () => null)
  writeFileSync(join(f.home, '.env'), 'fixture')
  await expect(f.documents.choose(f.scope, async () => join(f.home, '.env'))).rejects.toThrow()
  await expect(f.documents.choose(f.scope, async () => f.home)).rejects.toThrow()
  expect(Buffer.from((await f.documents.forInvocation(f.scope)!.capture()).bytes).toString()).toBe('saved version one')
})

it.each(['reset', 'remove'] as const)('a late chooser cannot restore authority after %s', async action => {
  const f = fixture()
  let finish!: (path: string) => void

  const pending = f.documents.choose(
    f.scope,
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )

  if (action === 'reset') {
    f.documents.reset()
  } else {
    f.documents.remove(f.scope)
  }

  finish(f.file)
  await expect(pending).rejects.toThrow('matrix_document_unavailable')
  expect(f.documents.describe(f.scope)).toBeNull()
})

it('relinking or logout while reading discards the old bytes and releases the grant', async () => {
  const f = fixture()
  await f.choose()
  const context = f.documents.forInvocation(f.scope)!
  let finish!: (value: { dataUrl: string; revision: string }) => void
  vi.spyOn(f.files, 'capture').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = context.capture()
  const release = vi.spyOn(f.files, 'releaseView')
  await f.choose()
  finish({ dataUrl: 'data:application/octet-stream;base64,b2xk', revision: 'old' })
  await expect(pending).rejects.toThrow('matrix_document_unavailable')
  expect(release).toHaveBeenCalledOnce()
  expect(f.documents.describe(f.scope)?.state).toBe('linked')
})

it('vault corruption is unavailable, never an implicit no-document turn', () => {
  const f = fixture()
  writeFileSync(f.vaultPath, '{broken')
  expect(f.documents.describe(f.scope)?.state).toBe('unavailable')
  expect(() => f.documents.forInvocation(f.scope)).toThrow('matrix_document_unavailable')
})

it('previews bounded saved text, keeps a closed preview linked, and refreshes only on request', async () => {
  const f = fixture()
  await f.choose()
  const first = await f.documents.preview(f.scope)
  expect(first).toMatchObject({ kind: 'text', name: 'document.txt', text: 'saved version one' })
  expect(JSON.stringify(first)).not.toContain(f.home)
  f.documents.closePreview(first.token)
  expect(f.documents.describe(f.scope)?.state).toBe('linked')
  writeFileSync(f.file, 'later saved bytes')
  expect(first).toMatchObject({ text: 'saved version one' })
  expect(await f.documents.preview(f.scope)).toMatchObject({ text: 'later saved bytes' })
  expect(Buffer.from((await f.documents.forInvocation(f.scope)!.capture()).bytes).toString()).toBe('later saved bytes')
})

it('ignores malformed membership ids without losing valid joined-room grants', async () => {
  const f = fixture()
  await f.choose()
  f.documents.retainRooms(f.scope.userId, ['malformed', f.scope.roomId])
  expect(await f.documents.preview(f.scope)).toMatchObject({ kind: 'text', text: 'saved version one' })
})

it.each(['remove', 'reset', 'reselect', 'switch', 'membership'] as const)(
  'revokes a pending preview on %s',
  async action => {
    const f = fixture()
    await f.choose()
    let finish!: (value: { dataUrl: string; revision: string }) => void
    vi.spyOn(f.files, 'capture').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = f.documents.preview(f.scope)

    if (action === 'remove') {
      f.documents.remove(f.scope)
    }

    if (action === 'reset') {
      f.documents.reset()
    }

    if (action === 'reselect') {
      await f.choose()
    }

    if (action === 'switch') {
      f.documents.closePreviews()
    }

    if (action === 'membership') {
      f.documents.retainRooms(f.scope.userId, [])
    }

    finish({ dataUrl: 'data:application/octet-stream;base64,c2VjcmV0', revision: 'old' })
    await expect(pending).rejects.toThrow('matrix_document_unavailable')

    if (action === 'membership') {
      expect(f.documents.describe(f.scope)?.state).toBe('reconnect_required')
    }
  }
)

it('same-name reselection changes display revision; membership loss invalidates invocation reads too', async () => {
  const f = fixture()
  await f.choose()
  const first = f.documents.describe(f.scope)!.revision
  await f.choose()
  expect(f.documents.describe(f.scope)!.revision).not.toBe(first)
  const invocation = f.documents.forInvocation(f.scope)!
  f.documents.retainRooms(f.scope.userId, ['!elsewhere:test'])
  await expect(invocation.capture()).rejects.toThrow('matrix_document_unavailable')
})

it('returns inert image bytes and an honest unsupported state for binary, large text and unknown formats', async () => {
  const f = fixture()

  for (const [name, body, kind] of [
    ['image.png', Buffer.from([137, 80, 78, 71]), 'image'],
    ['data.txt', Buffer.from([255, 0]), 'unsupported'],
    ['large.txt', Buffer.alloc(512 * 1024 + 1, 65), 'unsupported'],
    ['book.docx', Buffer.from('not a text format'), 'unsupported']
  ] as const) {
    const file = join(f.home, name)
    writeFileSync(file, body)
    await f.documents.choose(f.scope, async () => file)
    const preview = await f.documents.preview(f.scope)
    expect(preview.kind).toBe(kind)

    if (preview.kind === 'image') {
      expect(preview.dataUrl).toBe(`data:image/png;base64,${body.toString('base64')}`)
    }
  }
})

it.each(['remove', 'reset', 'reselect', 'switch', 'membership'] as const)(
  'does not attach a pending native PDF after %s',
  async action => {
    const f = fixture()
    const file = join(f.home, 'report.pdf')
    writeFileSync(file, '%PDF-1.7\nfixture')
    let loaded!: () => void

    const host = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentSize: () => [900, 700] as [number, number],
      isDestroyed: () => false
    }

    const view = {
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      webContents: {
        close: vi.fn(),
        isDestroyed: () => false,
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        loadURL: vi.fn(
          () =>
            new Promise<void>(resolve => {
              loaded = resolve
            })
        )
      }
    }

    const docs = new MatrixRoomDocuments(f.files, f.store, token => pdf.close(token))

    const pdf = new AtumPdfViewController({
      host: () => host,
      createView: () => view,
      resolvePath: token => docs.resolvePreview(f.scope, token),
      pathToUrl: file => `file://${file}`,
      zoomFactor: () => 1
    })

    await docs.choose(f.scope, async () => file)
    const preview = await docs.preview(f.scope)
    expect(preview.kind).toBe('pdf')
    expect(docs.resolvePreview({ ...f.scope, roomId: '!other:test' }, preview.token)).toBeNull()
    expect(docs.resolvePreview({ ...f.scope, userId: '@bob:test' }, preview.token)).toBeNull()
    const showing = pdf.show(preview.token, { x: 400, y: 60, width: 400, height: 600 })

    if (action === 'remove') {
      docs.remove(f.scope)
    }

    if (action === 'reset') {
      docs.reset()
    }

    if (action === 'reselect') {
      await docs.choose(f.scope, async () => file)
    }

    if (action === 'switch') {
      docs.closePreviews()
    }

    if (action === 'membership') {
      docs.retainRooms(f.scope.userId, [])
    }

    loaded()
    expect(await showing).toEqual({ shown: false })
    expect(host.contentView.addChildView).not.toHaveBeenCalled()
    expect(view.webContents.close).toHaveBeenCalledOnce()
    expect(docs.resolvePreview(f.scope, preview.token)).toBeNull()
  }
)
