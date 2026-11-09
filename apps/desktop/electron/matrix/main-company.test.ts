import { describe, expect, it, vi } from 'vitest'

import { MatrixCompanyError } from './company'
import { handleMatrixCompanyCommand, handleMatrixCompanyPending, type MatrixCompanyCommandContext } from './main-company'

const directory = { schemaVersion: 1 as const, companies: [], invitations: [] }

function fixture(): MatrixCompanyCommandContext {
  const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }

  return { event: { sender: ui, senderFrame: ui.mainFrame }, ui, uiUrl: ui.mainFrame.url,
    enabled: true, closing: false, available: vi.fn(() => true), request: vi.fn(async () => directory) }
}

describe('Company native IPC branch', () => {
  it('keeps funding separately disabled while preserving C1 and pending recovery', async () => {
    const companyId = '00000000-0000-4000-8000-576f18824476'
    const input = { action: 'funding' as const, companyId, requestId: '00000000-0000-4000-8000-b4b6412c243e', enabled: true, taskLimit: 1 }
    const context = fixture()
    expect(await handleMatrixCompanyCommand({ action: 'wallet', companyId }, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(await handleMatrixCompanyCommand(input, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(context.request).not.toHaveBeenCalled()
    expect(await handleMatrixCompanyPending({ ...context, pending: () => input })).toEqual({ ok: true, request: input })
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: true, value: directory })
    context.fundingEnabled = true
    await handleMatrixCompanyCommand(input, context)
    expect(context.request).toHaveBeenLastCalledWith(input)
    context.event.senderFrame = {}
    await expect(handleMatrixCompanyCommand(input, context)).rejects.toThrow('matrix_ipc_denied')
  })

  it('keeps project source reads and mutations behind their own default-off gate', async () => {
    const companyId = '00000000-0000-4000-8000-576f18824476'
    const projectId = '00000000-0000-4000-8000-95eb2692c90e'
    const context = fixture()
    const read = { action: 'project-sources' as const, companyId, projectId }
    const mutation = { action: 'include-project-channel-source' as const, companyId, projectId,
      requestId: '00000000-0000-4000-8000-b4b6412c243e', channelId: '00000000-0000-4000-8000-676a3a34ff0f',
      expectedSourceGeneration: 0 }

    expect(await handleMatrixCompanyCommand(read, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(await handleMatrixCompanyCommand(mutation, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(context.request).not.toHaveBeenCalled()
    context.projectSourcesEnabled = true
    await handleMatrixCompanyCommand(read, context)
    await handleMatrixCompanyCommand(mutation, context)
    expect(context.request).toHaveBeenNthCalledWith(1, read)
    expect(context.request).toHaveBeenNthCalledWith(2, mutation)
  })

  it('keeps hosted reader coverage behind its own gate without widening source enrollment', async () => {
    const companyId = '00000000-0000-4000-8000-576f18824476'
    const projectId = '00000000-0000-4000-8000-95eb2692c90e'
    const context = fixture()
    const read = { action: 'project-reader' as const, companyId, projectId }

    expect(await handleMatrixCompanyCommand(read, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(context.request).not.toHaveBeenCalled()
    context.projectReaderEnabled = true
    await handleMatrixCompanyCommand(read, context)
    expect(context.request).toHaveBeenCalledWith(read)
  })

  it.each(['wrong-window', 'child-frame', 'navigated', 'absent'] as const)('rejects %s before testing authority or requesting data', async kind => {
    const context = fixture()

    if (kind === 'wrong-window') {context.event.sender = {}}

    if (kind === 'child-frame') {context.event.senderFrame = { url: context.uiUrl }}

    if (kind === 'navigated') {context.ui!.mainFrame.url = 'https://foreign.test'}

    if (kind === 'absent') {context.ui = undefined}
    await expect(handleMatrixCompanyCommand({ action: 'list' }, context)).rejects.toThrow('matrix_ipc_denied')
    expect(context.available).not.toHaveBeenCalled()
    expect(context.request).not.toHaveBeenCalled()
  })

  it('keeps a disabled or closing feature inert even with an authenticated UI', async () => {
    for (const change of [{ enabled: false }, { closing: true }]) {
      const context = { ...fixture(), ...change }
      expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: false, error: 'unavailable' })
      expect(context.request).not.toHaveBeenCalled()
      expect(context.available).not.toHaveBeenCalled()
    }
  })

  it('rejects forged fields before the account request and marks revoked scope as authentication', async () => {
    const context = fixture()
    expect(await handleMatrixCompanyCommand({ action: 'list', actor: 'forged' }, context)).toEqual({ ok: false, error: 'invalid' })
    expect(context.request).not.toHaveBeenCalled()
    context.available = () => false
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: false, error: 'authentication' })
    expect(context.request).not.toHaveBeenCalled()
  })

  it('projects known errors and redacts unexpected details', async () => {
    const context = fixture()
    const request = vi.mocked(context.request)
    request.mockRejectedValueOnce(new Error('matrix_domain_signed_out'))
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: false, error: 'authentication' })
    request.mockRejectedValueOnce(new MatrixCompanyError('limit', 60))
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: false, error: 'limit', retryAfterSeconds: 60 })
    request.mockRejectedValueOnce(new Error('private provider details'))
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: false, error: 'unavailable' })
    expect(await handleMatrixCompanyCommand({ action: 'list' }, context)).toEqual({ ok: true, value: directory })
  })

  it('guards pending intent recovery and never treats a corrupt journal as empty', async () => {
    const pending = vi.fn(() => null)
    const context = { ...fixture(), pending }
    expect(await handleMatrixCompanyPending(context)).toEqual({ ok: true, request: null })
    pending.mockImplementationOnce(() => { throw new Error('private vault detail') })
    expect(await handleMatrixCompanyPending(context)).toEqual({ ok: false, error: 'unavailable' })
    const calls = pending.mock.calls.length
    context.event.senderFrame = {}
    await expect(handleMatrixCompanyPending(context)).rejects.toThrow('matrix_ipc_denied')
    expect(pending).toHaveBeenCalledTimes(calls)
  })

})
