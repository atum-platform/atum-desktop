import { describe, expect, it, vi } from 'vitest'

import { MatrixAliasError } from './aliases'
import { handleMatrixAliasPending, handleMatrixAliasRequest } from './main-aliases'

function fixture() {
  const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }

  return { event: { sender: ui as object, senderFrame: ui.mainFrame as object }, ui, uiUrl: ui.mainFrame.url, closing: false, available: vi.fn(() => true), request: vi.fn(async () => ({ kind: 'current' as const, alias: null })), pending: vi.fn(() => null) }
}

describe('alias IPC authority boundary', () => {
  it.each(['window', 'frame', 'navigation'])('rejects wrong %s before touching input or authority', async kind => {
    const context = fixture()

    if (kind === 'window') { context.event.sender = {} }

    if (kind === 'frame') { context.event.senderFrame = {} }

    if (kind === 'navigation') { context.ui.mainFrame.url = 'https://foreign.test' }
    const input = new Proxy({}, { get() { throw Error('input was read') } })
    await expect(handleMatrixAliasRequest(input, context)).rejects.toThrow('matrix_ipc_denied')
    await expect(handleMatrixAliasPending(context)).rejects.toThrow('matrix_ipc_denied')
    expect(context.available).not.toHaveBeenCalled()
    expect(context.request).not.toHaveBeenCalled()
    expect(context.pending).not.toHaveBeenCalled()
  })
  it('keeps closing and signed-out calls inert and refuses forged authority', async () => {
    const context = fixture()
    expect(await handleMatrixAliasRequest({ action: 'current', owner: 'forged' }, context)).toEqual({ ok: false, error: 'invalid' })
    expect(context.request).not.toHaveBeenCalled()
    expect(await handleMatrixAliasRequest({ action: 'current' }, { ...context, closing: true })).toEqual({ ok: false, error: 'unavailable' })
    expect(await handleMatrixAliasRequest({ action: 'current' }, { ...context, available: () => false })).toEqual({ ok: false, error: 'authentication' })
  })
  it('logs a contacts read by counts only, never the IDs or handles', async () => {
    const context = fixture()
    const log = vi.fn()
    context.request.mockResolvedValueOnce({ kind: 'contacts', contacts: [{ matrixUser: '@poon:test', handle: 'poon' }, { matrixUser: '@lan:test', handle: null }] } as never)
    expect(await handleMatrixAliasRequest({ action: 'contacts', matrixUsers: ['@poon:test', '@lan:test'] }, { ...context, log }))
      .toMatchObject({ ok: true, value: { kind: 'contacts' } })
    expect(log).toHaveBeenCalledExactlyOnceWith('[Matrix] handle action=contacts target=person outcome=ok asked=2 found=1')
  })
  it('counts the IDs of a failed contacts read (a 400 included), never which', async () => {
    const context = fixture()
    const log = vi.fn()
    context.request.mockRejectedValueOnce(new MatrixAliasError('invalid'))
    expect(await handleMatrixAliasRequest({ action: 'contacts', matrixUsers: ['@poon:test', '@lan:test', '@hoa:test'] }, { ...context, log }))
      .toEqual({ ok: false, error: 'invalid' })
    expect(log).toHaveBeenCalledExactlyOnceWith('[Matrix] handle action=contacts target=person outcome=error code=invalid asked=3')
  })
  it('passes a lookup through with only its handle, and refuses an assistant selector on it', async () => {
    const context = fixture()
    context.request.mockResolvedValueOnce({ kind: 'lookup', handle: 'lan', state: 'available' } as never)
    expect(await handleMatrixAliasRequest({ action: 'lookup', handle: '@lan' }, context)).toEqual({ ok: true, value: { kind: 'lookup', handle: 'lan', state: 'available' } })
    expect(context.request).toHaveBeenCalledExactlyOnceWith({ action: 'lookup', handle: '@lan' })
    expect(await handleMatrixAliasRequest({ action: 'lookup', handle: 'lan', assistantId: '00000000-0000-4000-8000-95eb2692c90e' }, context)).toEqual({ ok: false, error: 'invalid' })
    expect(context.request).toHaveBeenCalledOnce()
  })
  it('retains the unavailable journal state and returns only bounded errors', async () => {
    const context = fixture()
    context.pending.mockImplementationOnce(() => { throw Error('private vault') })
    expect(await handleMatrixAliasPending(context)).toEqual({ ok: false, error: 'unavailable' })
    context.request.mockRejectedValueOnce(new MatrixAliasError('limit', 60))
    expect(await handleMatrixAliasRequest({ action: 'current' }, context)).toEqual({ ok: false, error: 'limit', retryAfterSeconds: 60 })
    context.request.mockRejectedValueOnce(Error('private bearer'))
    expect(await handleMatrixAliasRequest({ action: 'current' }, context)).toEqual({ ok: false, error: 'unavailable' })
    context.request.mockRejectedValueOnce(Error('matrix_domain_signed_out'))
    expect(await handleMatrixAliasRequest({ action: 'current' }, context)).toEqual({ ok: false, error: 'authentication' })
  })
})

describe('alias request log lines', () => {
  it('writes one closed-code line per answered request, never the handle or any ID', async () => {
    const context = fixture()
    const lines: string[] = []
    const assistantId = '00000000-0000-4000-8000-95eb2692c90e'
    const requestId = '00000000-0000-4000-8000-b4b6412c243e'
    context.request
      .mockResolvedValueOnce({ kind: 'current', alias: null })
      .mockResolvedValueOnce({ kind: 'check', handle: 'tiep_thi_bot', available: false, code: 'alias_unavailable' } as never)
      .mockRejectedValueOnce(new MatrixAliasError('conflict'))
      .mockResolvedValueOnce({ kind: 'claim', handle: 'tiep_thi42_bot', generation: 1 } as never)
    const log = (line: string) => void lines.push(line)

    await handleMatrixAliasRequest({ action: 'current', assistantId }, { ...context, log })
    await handleMatrixAliasRequest({ action: 'check', handle: 'tiep_thi_bot', assistantId }, { ...context, log })
    await handleMatrixAliasRequest({ action: 'claim', handle: 'tiep_thi7_bot', assistantId, requestId }, { ...context, log })
    await handleMatrixAliasRequest({ action: 'claim', handle: 'tiep_thi42_bot', assistantId, requestId }, { ...context, log })
    await handleMatrixAliasRequest({ action: 'current' }, { ...context, closing: true, log })

    expect(lines).toEqual([
      '[Matrix] handle action=current target=agent outcome=ok assigned=false',
      '[Matrix] handle action=check target=agent outcome=ok available=false code=alias_unavailable',
      '[Matrix] handle action=claim target=agent outcome=error code=conflict',
      '[Matrix] handle action=claim target=agent outcome=ok replayed=false',
      '[Matrix] handle action=current target=person outcome=error code=unavailable'
    ])

    for (const line of lines) {
      expect(line).not.toMatch(/tiep_thi|2000|3000/)
    }
  })

  it('says whether an unanswered change is still kept, never its handle or any ID', async () => {
    const context = fixture()
    const lines: string[] = []
    const log = (line: string) => void lines.push(line)
    const held = { action: 'claim' as const, handle: 'tiep_thi_bot', assistantId: '00000000-0000-4000-8000-95eb2692c90e', requestId: '00000000-0000-4000-8000-b4b6412c243e' }
    context.pending.mockImplementationOnce(() => held as never)

    expect(await handleMatrixAliasPending({ ...context, log })).toEqual({ ok: true, request: held })
    expect(await handleMatrixAliasPending({ ...context, log })).toEqual({ ok: true, request: null })
    expect(await handleMatrixAliasPending({ ...context, available: () => false, log })).toEqual({ ok: false, error: 'authentication' })

    expect(lines).toEqual([
      '[Matrix] handle action=pending outcome=ok held=claim target=agent',
      '[Matrix] handle action=pending outcome=ok held=none target=none',
      '[Matrix] handle action=pending outcome=error code=authentication'
    ])

    for (const line of lines) {
      expect(line).not.toMatch(/tiep_thi|2000|3000/)
    }
  })

  it('keeps answering when the log sink throws', async () => {
    const context = fixture()

    const log = () => {
      throw new Error('disk full')
    }

    expect(await handleMatrixAliasRequest({ action: 'current' }, { ...context, log })).toEqual({
      ok: true,
      value: { kind: 'current', alias: null }
    })
  })
})
