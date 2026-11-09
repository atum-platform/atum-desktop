import { describe, expect, it, vi } from 'vitest'

import { createAtumWindowModeController } from './atum-window-mode'
import { WordCompanionController, wordCompanionLayout } from './word-companion'
import type { WordWindowSnapshot } from './word-companion-mac'

const firstId = '00000000-0000-4000-8000-bd7662a5eeb4'
const secondId = '00000000-0000-4000-8000-b454f82c5857'
const original = { x: 180, y: 100, width: 1200, height: 780 }
const wordOriginal = { x: 90, y: 80, width: 1000, height: 800 }

function setup() {
  let bounds = { ...original }
  let authority = 'account-a:1'

  const window = {
    isDestroyed: vi.fn(() => false), isFullScreen: vi.fn(() => false), isMaximized: vi.fn(() => false),
    getNormalBounds: vi.fn(() => ({ ...bounds })), getBounds: vi.fn(() => ({ ...bounds })),
    getMinimumSize: vi.fn(() => [800, 600]), setMinimumSize: vi.fn(),
    unmaximize: vi.fn(), maximize: vi.fn(), setBounds: vi.fn(value => {bounds = value}), show: vi.fn()
  }

  const snapshot = (path: string): WordWindowSnapshot => ({ path, saved: true, bounds: wordOriginal,
    windowNumber: path.includes('/b/') ? 2 : 1, windowId: path.includes('/b/') ? 42 : 41, topInset: 40 })

  const word = { open: vi.fn(async (path: string) => snapshot(path)), arrange: vi.fn(async () => undefined),
    bind: vi.fn(async (path: string) => snapshot(path)), bringToFront: vi.fn(async () => undefined),
    listDocuments: vi.fn(async () => [{ path: '/home/a/report.docx', name: 'report.docx', windowNumber: 1 }]),
    inspect: vi.fn(async () => ({ saved: true })), restore: vi.fn(async () => undefined) }

  const live = { read: vi.fn(async () => ({ text: 'Unsaved text', saved: false })),
    replace: vi.fn(async () => ({ text: 'Changed text', saved: false })) }

  const resolveRequest = vi.fn(async (_ref: unknown): Promise<unknown> => ({ action: 'read', session_id: 'live',
    durable_session_id: 'chat', turn_id: 'turn', expires_at: Date.now() / 1000 + 45 }))

  const ended = vi.fn()
  const bindingEnded = vi.fn()

  const controller = new WordCompanionController({ window: () => window, authority: () => authority,
    authorizePath: value => String(value), live, resolveRequest, workArea: () => ({ x: -1920, y: 25, width: 1920, height: 1055 }), word, ended, bindingEnded })

  return { controller, window, word, live, resolveRequest, ended, bindingEnded, snapshot, changeAccount: () => {authority = 'account-b:2'} }
}

describe('Word companion native lifecycle', () => {
  const ref = { profile: 'default', request_id: 'request', session_id: 'live', turn_id: 'turn' }

  it('binds and reads an existing document without taking ownership of geometry', async () => {
    const s = setup()
    const inventory = await s.controller.listDocuments('owner')
    await s.controller.bind('owner', { requestId: firstId, candidateId: inventory.documents[0].id })
    expect(await s.controller.capture('owner', firstId)).toMatchObject({ text: 'Unsaved text', saved: false })
    expect(s.controller.isArranged()).toBe(false)
    expect(s.word.open).not.toHaveBeenCalled()
    expect(s.word.arrange).not.toHaveBeenCalled()
    expect(s.word.bringToFront).not.toHaveBeenCalled()
    await s.controller.unbind('owner', firstId)
    expect(s.window.setBounds).not.toHaveBeenCalled()
    expect(s.word.restore).not.toHaveBeenCalled()
    await expect(s.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
  })

  it('retains linked A when normal open arranges B and refuses B content', async () => {
    const s = setup()
    await s.controller.bind('owner', { requestId: firstId, path: '/home/a/report.docx' })
    await s.controller.open('owner', '/home/b/report.docx', secondId)
    await expect(s.controller.capture('owner', secondId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    await s.controller.capture('owner', firstId)
    expect(s.live.read).toHaveBeenCalledWith(s.snapshot('/home/a/report.docx'))
    await s.controller.clearArrangement()
    await expect(s.controller.capture('owner', firstId)).resolves.toMatchObject({ text: 'Unsaved text' })
    expect(s.bindingEnded).not.toHaveBeenCalled()
  })

  it('arranges a link, reuses that arrangement, and ends only geometry', async () => {
    const s = setup()
    await s.controller.bind('owner', { requestId: firstId, path: '/home/a/report.docx' })
    const arrangement = await s.controller.showBeside('owner', firstId)
    expect(arrangement.id).not.toBe(firstId)
    expect((await s.controller.showBeside('owner', firstId)).id).toBe(arrangement.id)
    expect(s.word.arrange).toHaveBeenCalledOnce()
    await s.controller.end('owner', arrangement.id)
    expect(s.window.getBounds()).toEqual(original)
    await expect(s.controller.capture('owner', firstId)).resolves.toMatchObject({ saved: false })
    await s.controller.unbind('owner', firstId)
    await expect(s.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
  })

  it('keeps a valid link when placement fails or full-screen prevents placement', async () => {
    const s = setup()
    await s.controller.bind('owner', { requestId: firstId, path: '/home/a/report.docx' })
    s.window.isFullScreen.mockReturnValueOnce(true)
    await expect(s.controller.showBeside('owner', firstId)).rejects.toThrow('WORD_EXIT_FULLSCREEN')
    s.word.arrange.mockRejectedValueOnce(new Error('WORD_LAYOUT_FAILED'))
    await expect(s.controller.showBeside('owner', firstId)).rejects.toThrow('WORD_LAYOUT_FAILED')
    await expect(s.controller.capture('owner', firstId)).resolves.toMatchObject({ saved: false })
    expect(s.window.setBounds).not.toHaveBeenCalled()
  })

  it('rejects stale, foreign and account-switched candidate ids', async () => {
    const s = setup()
    const first = (await s.controller.listDocuments('owner')).documents[0]
    await expect(s.controller.bind('other', { requestId: firstId, candidateId: first.id })).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    const second = (await s.controller.listDocuments('owner')).documents[0]
    await expect(s.controller.bind('owner', { requestId: firstId, candidateId: first.id })).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    s.changeAccount()
    await expect(s.controller.bind('owner', { requestId: firstId, candidateId: second.id })).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    expect(s.word.bind).not.toHaveBeenCalled()
  })

  it('retains the previous binding on replacement failure and revokes on clear', async () => {
    const s = setup()
    await s.controller.bind('owner', { requestId: firstId, path: '/home/a/report.docx' })
    s.word.bind.mockRejectedValueOnce(new Error('WORD_DOCUMENT_UNAVAILABLE'))
    await expect(s.controller.bind('owner', { requestId: secondId, path: '/home/b/report.docx' })).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    await expect(s.controller.capture('owner', firstId)).resolves.toMatchObject({ saved: false })
    await s.controller.clear()
    await expect(s.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    expect(s.bindingEnded).toHaveBeenCalledWith(firstId)
    expect(s.window.setBounds).not.toHaveBeenCalled()
  })

  it('resolves the operation from the live gateway and consumes each edit revision once', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    const snapshot = await s.controller.capture('owner', firstId)
    s.resolveRequest.mockResolvedValue({ action: 'replace_text', session_id: 'live', durable_session_id: 'chat',
      turn_id: 'turn', expires_at: Date.now() / 1000 + 45, revision: snapshot.revision, find: 'Unsaved', replacement: 'Changed' })
    const result = await s.controller.execute('owner', firstId, ref)
    expect(result.applied).toBe(true)
    expect(s.live.replace).toHaveBeenCalledWith(s.snapshot('/home/a/report.docx'), {
      expectedText: 'Unsaved text', find: 'Unsaved', replacement: 'Changed'
    })
    await expect(s.controller.execute('owner', firstId, ref)).rejects.toThrow('WORD_REQUEST_ALREADY_USED')
    await expect(s.controller.execute('owner', firstId, { ...ref, request_id: 'next' })).rejects.toThrow('WORD_CONTENT_CHANGED')
    expect(s.live.replace).toHaveBeenCalledOnce()
  })

  it('does not dispatch a native write after the account changes during request resolution', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    s.resolveRequest.mockImplementation(async () => {s.changeAccount();

 return { action: 'replace_text' }})
    await expect(s.controller.execute('owner', firstId, ref)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    expect(s.live.replace).not.toHaveBeenCalled()
  })

  it('refuses expired turns and cross-conversation requests before native access', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    s.resolveRequest.mockResolvedValueOnce({ action: 'read', session_id: 'live', durable_session_id: 'chat',
      turn_id: 'turn', expires_at: 0 })
    await expect(s.controller.execute('owner', firstId, ref)).rejects.toThrow('WORD_TURN_UNAVAILABLE')
    expect(s.live.read).not.toHaveBeenCalled()
    await s.controller.execute('owner', firstId, { ...ref, request_id: 'valid' })
    s.resolveRequest.mockResolvedValueOnce({ action: 'read', session_id: 'live', durable_session_id: 'other-chat',
      turn_id: 'turn', expires_at: Date.now() / 1000 + 45 })
    await expect(s.controller.execute('owner', firstId, { ...ref, request_id: 'other' })).rejects.toThrow('WORD_CONVERSATION_CHANGED')
    expect(s.live.read).toHaveBeenCalledOnce()
  })

  it('keeps uncertain writes blocked even after a fresh read', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    const snapshot = await s.controller.capture('owner', firstId)

    const edit = { action: 'replace_text', session_id: 'live', durable_session_id: 'chat', turn_id: 'turn',
      expires_at: Date.now() / 1000 + 45, revision: snapshot.revision, find: 'Unsaved', replacement: 'Changed' }

    s.resolveRequest.mockResolvedValue(edit)
    s.live.replace.mockRejectedValue(new Error('WORD_EDIT_UNCERTAIN'))
    await expect(s.controller.execute('owner', firstId, ref)).rejects.toThrow('WORD_EDIT_UNCERTAIN')
    const fresh = await s.controller.capture('owner', firstId)
    s.resolveRequest.mockResolvedValue({ ...edit, revision: fresh.revision })
    await expect(s.controller.execute('owner', firstId, { ...ref, request_id: 'next' })).rejects.toThrow('WORD_EDIT_UNCERTAIN')
    expect(s.live.replace).toHaveBeenCalledOnce()
  })

  it('restores product geometry before auth snapshots it, even while Word restoration is blocked', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    let releaseWord!: () => void
    let cleanup!: Promise<void>
    s.word.restore.mockImplementation(() => new Promise<void>(resolve => {releaseWord = resolve}))

    const mode = createAtumWindowModeController({
      getWindow: () => s.window, getWorkArea: () => ({ x: 0, y: 25, width: 1920, height: 1055 }),
      isOwnerSender: sender => sender === 'owner',
      beforeAuth: () => {cleanup = s.controller.clear()}
    })

    expect(mode.handleSetMode({ sender: 'owner' }, 'auth')).toEqual({ ok: true, mode: 'auth' })
    expect(s.window.getBounds().width).toBeLessThan(original.width)
    expect(s.controller.isActive()).toBe(false)
    expect(mode.handleSetMode({ sender: 'owner' }, 'normal')).toEqual({ ok: true, mode: 'normal' })
    expect(s.window.getBounds()).toEqual(original)
    await vi.waitFor(() => expect(s.word.restore).toHaveBeenCalledOnce())
    releaseWord()
    await cleanup
    expect(s.window.getBounds()).toEqual(original)
  })

  it('coalesces focus checks and does not let an old unavailable result cancel a newer open', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    let rejectInspect!: (error: Error) => void
    s.word.inspect.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectInspect = reject}))
    const refresh = s.controller.refresh()
    expect(s.controller.refresh()).toBe(refresh)
    expect(s.controller.refresh()).toBe(refresh)
    await vi.waitFor(() => expect(s.word.inspect).toHaveBeenCalledOnce())
    const opening = s.controller.open('owner', '/home/b/report.docx', secondId)
    expect(s.word.open).toHaveBeenCalledTimes(1)
    rejectInspect(new Error('WORD_DOCUMENT_UNAVAILABLE'))
    await refresh
    await opening
    expect(s.controller.isActive()).toBe(true)
    await s.controller.capture('owner', secondId)
    expect(s.live.read).toHaveBeenCalledWith(s.snapshot('/home/b/report.docx'))
  })

  it.each([
    ['WORD_DOCUMENT_UNAVAILABLE', false],
    ['WORD_AUTOMATION_TIMEOUT', true]
  ])('handles focus inspection failure %s without guessing that Word closed', async (code, remainsActive) => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    s.word.inspect.mockRejectedValue(new Error(code))
    await s.controller.refresh()
    expect(s.controller.isActive()).toBe(remainsActive)
    expect(s.ended).toHaveBeenCalledTimes(remainsActive ? 0 : 1)
  })

  it('revokes an old account on focus even when the Word document still exists', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    s.changeAccount()
    await s.controller.refresh()
    expect(s.controller.isActive()).toBe(false)
    expect(s.window.getBounds()).toEqual(original)
  })

  it('tiles on Atum’s display, then restores both windows and minimum size', async () => {
    const s = setup()
    s.window.isMaximized.mockReturnValue(true)
    const descriptor = await s.controller.open('owner', '/home/a/report.docx', firstId)
    expect(descriptor).toEqual({ id: firstId, name: 'report.docx', path: '/home/a/report.docx' })
    expect(s.controller.isActive()).toBe(true)
    expect(s.window.setBounds).toHaveBeenCalledWith({ x: -1920, y: 25, width: 669, height: 1055 })
    expect(s.word.arrange).toHaveBeenCalledWith(s.snapshot(descriptor.path), { x: -1243, y: 25, width: 1243, height: 1055 })
    await s.controller.end('owner', firstId)
    expect(s.window.setBounds).toHaveBeenLastCalledWith(original)
    expect(s.window.setMinimumSize).toHaveBeenLastCalledWith(800, 600)
    expect(s.window.maximize).toHaveBeenCalledOnce()
    expect(s.word.restore).toHaveBeenCalledWith(s.snapshot(descriptor.path))
    expect(s.ended).toHaveBeenCalledWith(firstId)
    expect(s.controller.isActive()).toBe(false)
  })

  it('cancels an in-flight open before arrangement without moving Atum', async () => {
    const s = setup()
    let complete!: (snapshot: WordWindowSnapshot) => void
    s.word.open.mockImplementation(() => new Promise(resolve => {complete = resolve}))
    const opening = s.controller.open('owner', '/home/a/report.docx', firstId)
    const rejected = expect(opening).rejects.toThrow('WORD_OPEN_CANCELLED')
    await vi.waitFor(() => expect(s.word.open).toHaveBeenCalledOnce())
    const ending = s.controller.end('owner', firstId)
    complete(s.snapshot('/home/a/report.docx'))
    await rejected
    await ending
    expect(s.word.arrange).not.toHaveBeenCalled()
    expect(s.window.setBounds).not.toHaveBeenCalled()
    expect(s.controller.isActive()).toBe(false)
  })

  it('does not let an old release detach a newer same-basename document', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    await s.controller.open('owner', '/home/b/report.docx', secondId)
    await s.controller.end('owner', firstId)
    expect(s.controller.isActive()).toBe(true)
    await s.controller.capture('owner', secondId)
    expect(s.live.read).toHaveBeenCalledWith(s.snapshot('/home/b/report.docx'))
    await expect(s.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
  })

  it('captures fresh unsaved text and gives every snapshot a new revision', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    const first = await s.controller.capture('owner', firstId)
    expect(first).toMatchObject({ saved: false, text: 'Unsaved text' })
    s.live.read.mockResolvedValue({ text: 'New typing', saved: false })
    const next = await s.controller.capture('owner', firstId)
    expect(next.text).toBe('New typing')
    expect(next.revision).not.toBe(first.revision)
    await expect(s.controller.capture('other-owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
  })

  it('refuses a changed account or Save As during capture', async () => {
    const s = setup()
    await s.controller.open('owner', '/home/a/report.docx', firstId)
    s.live.read.mockImplementation(async () => {s.changeAccount();

 return { text: '', saved: false }})
    await expect(s.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
    await s.controller.clear()
    expect(s.controller.isActive()).toBe(false)
    const another = setup()
    await another.controller.open('owner', '/home/a/report.docx', firstId)
    another.live.read.mockRejectedValue(new Error('WORD_DOCUMENT_UNAVAILABLE'))
    await expect(another.controller.capture('owner', firstId)).rejects.toThrow('WORD_DOCUMENT_UNAVAILABLE')
  })

  it('leaves Atum geometry alone on layout failure and rejects fullscreen before opening', async () => {
    const s = setup()
    s.word.arrange.mockRejectedValue(new Error('WORD_LAYOUT_FAILED'))
    await expect(s.controller.open('owner', '/home/a/report.docx', firstId)).rejects.toThrow('WORD_LAYOUT_FAILED')
    expect(s.window.setBounds).not.toHaveBeenCalled()
    expect(s.word.restore).toHaveBeenCalledOnce()
    expect(s.controller.isActive()).toBe(false)
    s.window.isFullScreen.mockReturnValue(true)
    await expect(s.controller.open('owner', '/home/a/report.docx', secondId)).rejects.toThrow('WORD_EXIT_FULLSCREEN')
    expect(s.word.open).toHaveBeenCalledOnce()
  })

  it('refuses unsupported files and screens that cannot fit usable windows', async () => {
    const s = setup()
    await expect(s.controller.open('owner', '/home/a/file.app', firstId)).rejects.toThrow('WORD_UNSUPPORTED_FILE')
    expect(() => wordCompanionLayout({ x: 0, y: 0, width: 800, height: 600 })).toThrow('WORD_SCREEN_TOO_SMALL')
    expect(s.word.open).not.toHaveBeenCalled()
  })
})
