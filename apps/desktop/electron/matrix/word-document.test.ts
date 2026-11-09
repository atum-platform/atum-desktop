import { expect, it, vi } from 'vitest'

import type { WordDocumentRequest } from '../../shared/word-companion'

import { MatrixWordDocument } from './word-document'

function fixture() {
  let authority = 'owner:1:room'
  const original = { x: 100, y: 100, width: 1200, height: 800 }
  let bounds = original

  const window = {
    isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false,
    getNormalBounds: () => bounds, getBounds: () => bounds, getMinimumSize: () => [800, 600],
    setMinimumSize: vi.fn(), unmaximize: vi.fn(), maximize: vi.fn(),
    setBounds: vi.fn(next => {bounds = next}), show: vi.fn()
  }

  const snapshot = { path: '/fixture/one.docx', windowNumber: 1, windowId: 3, topInset: 40,
    saved: false, bounds: { x: 90, y: 80, width: 1000, height: 800 } }

  const word = {
    open: vi.fn(async () => snapshot), bind: vi.fn(async () => snapshot),
    arrange: vi.fn(async () => {}), inspect: vi.fn(async () => ({ saved: false })),
    restore: vi.fn(async () => {}), bringToFront: vi.fn(async () => {})
  }

  const live = {
    read: vi.fn(async () => ({ text: 'Unsaved old text', saved: false,
      selection: { text: 'old', start: 8, end: 11 } })),
    replace: vi.fn(async () => ({ text: 'Unsaved new text', saved: false }))
  }

  const document = new MatrixWordDocument('room-owner', {
    window: () => window, authority: () => authority, authorizePath: requested => String(requested),
    live, word, workArea: () => ({ x: 0, y: 25, width: 1920, height: 1055 }), ended: vi.fn()
  })

  const ref = { profile: 'matrix', request_id: 'request', session_id: 'live', turn_id: 'turn' }

  const request = (extra = {}): WordDocumentRequest => ({ ...ref, action: 'read', durable_session_id: 'conversation',
    expires_at: Date.now() / 1000 + 30, ...extra })

  return { document, word, live, window, original, ref, request, changeOwner: () => {authority = 'other:2:room'} }
}

it('ends and restores only arrangement; the explicit room link still reads unsaved text and selection', async () => {
  const f = fixture()
  await f.document.open('/fixture/one.docx')
  await f.document.hide()
  expect(f.window.getBounds()).toEqual(f.original)
  expect(await f.document.capture()).toMatchObject({ text: 'Unsaved old text', saved: false, selection: { text: 'old' } })
  await f.document.show()
  await f.document.dispose()
  expect(f.window.getBounds()).toEqual(f.original)
  await expect(f.document.capture()).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
})

it('uses only independently resolved arguments, spends revisions once and refuses another durable conversation', async () => {
  const f = fixture()
  await f.document.open('/fixture/one.docx')
  const snapshot = await f.document.capture()
  const edit = () => Promise.resolve(f.request({ action: 'replace_text', revision: snapshot.revision, find: 'old', replacement: 'new' }))
  const signal = new AbortController().signal
  expect(await f.document.execute(f.ref, edit, signal)).toMatchObject({ applied: true, saved: false })
  expect(f.live.replace).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    expectedText: 'Unsaved old text', find: 'old', replacement: 'new'
  })
  await expect(f.document.execute(f.ref, edit, signal)).rejects.toThrow('WORD_REQUEST_ALREADY_USED')
  const next = { ...f.ref, request_id: 'another' }
  await expect(f.document.execute(next, async () => ({ ...f.request(), durable_session_id: 'foreign' }), signal))
    .rejects.toThrow('WORD_CONVERSATION_CHANGED')
  expect(f.live.replace).toHaveBeenCalledTimes(1)
})

it.each(['abort', 'dispose', 'owner'] as const)('refuses a delayed resolver after %s before dispatching Word', async action => {
  const f = fixture()
  await f.document.open('/fixture/one.docx')
  const snapshot = await f.document.capture()
  let release!: (request: WordDocumentRequest) => void
  const resolve = vi.fn(() => new Promise<WordDocumentRequest>(done => {release = done}))
  const stop = new AbortController()
  const pending = f.document.execute(f.ref, resolve, stop.signal)
  const refused = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(resolve).toHaveBeenCalled())

  if (action === 'abort') {stop.abort()}

  if (action === 'dispose') {void f.document.dispose()}

  if (action === 'owner') {f.changeOwner()}
  release(f.request({ action: 'replace_text', revision: snapshot.revision, find: 'old', replacement: 'new' }))
  await refused
  expect(f.live.replace).not.toHaveBeenCalled()
})

it('a cancellation after native dispatch is uncertain and cannot replay the edit', async () => {
  const f = fixture()
  await f.document.open('/fixture/one.docx')
  const snapshot = await f.document.capture()
  let release!: () => void
  f.live.replace.mockImplementationOnce(() => new Promise(done => {release = () => done({ text: 'possibly changed', saved: false })}))
  const stop = new AbortController()
  const resolve = async () => f.request({ action: 'replace_text', revision: snapshot.revision, find: 'old', replacement: 'new' })
  const pending = f.document.execute(f.ref, resolve, stop.signal)
  const refused = expect(pending).rejects.toThrow('WORD_EDIT_UNCERTAIN')
  await vi.waitFor(() => expect(f.live.replace).toHaveBeenCalled())
  stop.abort()
  release()
  await refused
  await expect(f.document.execute({ ...f.ref, request_id: 'next' }, resolve, new AbortController().signal))
    .rejects.toThrow('WORD_EDIT_UNCERTAIN')
  expect(f.live.replace).toHaveBeenCalledTimes(1)
})
