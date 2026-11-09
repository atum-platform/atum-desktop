import { describe, expect, it, vi } from 'vitest'

import { handleMatrixPeoplePrivacy, handleMatrixPeopleSearch } from './main-people-search'

function fixture() {
  const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }
  return {
    event: { sender: ui, senderFrame: ui.mainFrame }, ui, uiUrl: ui.mainFrame.url,
    closing: false, available: () => true,
    alias: vi.fn(async () => ({ kind: 'search' as const, matrixUser: '@nguyen:test' })),
    sdk: vi.fn(async command => command.kind === 'peopleSearch'
      ? { limited: false, results: [{ userId: '@nguyen:test', name: 'Nguyễn' }] }
      : command.kind === 'peoplePrivacyWrite' ? command.enabled : true)
  }
}

describe('people search IPC', () => {
  it('uses Synapse directly for names and requires two characters', async () => {
    const context = fixture()
    await expect(handleMatrixPeopleSearch({ query: 'ng', limit: 20 }, context)).resolves.toMatchObject({ ok: true })
    expect(context.alias).not.toHaveBeenCalled()
    expect(context.sdk).toHaveBeenCalledWith({ kind: 'peopleSearch', query: 'ng', limit: 20 })
    await expect(handleMatrixPeopleSearch({ query: 'n', limit: 20 }, context)).resolves.toEqual({ ok: false, error: 'invalid' })
  })

  it('sends only a complete lower-case email to the MAS seam, then verifies the exact user in Synapse', async () => {
    const context = fixture()
    await expect(handleMatrixPeopleSearch({ query: 'NGUYEN@example.com', limit: 20 }, context)).resolves.toMatchObject({ ok: true })
    expect(context.alias).toHaveBeenCalledWith({ action: 'search', email: 'nguyen@example.com' })
    expect(context.sdk).toHaveBeenCalledWith({ kind: 'peopleSearch', query: '@nguyen:test', limit: 20,
      exactUserId: '@nguyen:test' })
  })

  it.each(['@poon', 'poon'])('combines the exact public handle with native name search for %s', async query => {
    const context = fixture()
    context.alias.mockResolvedValue({
      kind: 'lookup', handle: 'poon', state: 'assigned', principalKind: 'human', matrixUser: '@user-opaque:test'
    } as never)
    context.sdk.mockResolvedValue({ limited: false, results: [] })

    await expect(handleMatrixPeopleSearch({ query, limit: 20 }, context)).resolves.toEqual({
      ok: true,
      value: { limited: false, results: [{ userId: '@user-opaque:test', name: '@poon', handle: 'poon' }] }
    })
    expect(context.alias).toHaveBeenCalledWith({ action: 'lookup', handle: 'poon' })
    expect(context.sdk).toHaveBeenCalledWith({ kind: 'peopleSearch', query: 'poon', limit: 20 })
  })

  it('keeps exact public handles usable when the native directory is unavailable', async () => {
    const context = fixture()
    context.alias.mockResolvedValue({
      kind: 'lookup', handle: 'poon', state: 'assigned', principalKind: 'human', matrixUser: '@user-opaque:test'
    } as never)
    context.sdk.mockRejectedValue(new Error('directory unavailable'))

    await expect(handleMatrixPeopleSearch({ query: 'poon', limit: 20 }, context)).resolves.toMatchObject({
      ok: true,
      value: { results: [{ userId: '@user-opaque:test', name: '@poon', handle: 'poon' }] }
    })
  })

  it('keeps the native display name while attaching an exact public handle', async () => {
    const context = fixture()
    context.alias.mockResolvedValue({
      kind: 'lookup', handle: 'poon', state: 'assigned', principalKind: 'human', matrixUser: '@nguyen:test'
    } as never)

    await expect(handleMatrixPeopleSearch({ query: '@poon', limit: 20 }, context)).resolves.toEqual({
      ok: true,
      value: { limited: false, results: [{ userId: '@nguyen:test', name: 'Nguyễn', handle: 'poon' }] }
    })
  })

  it('reads and writes the default-on privacy switch', async () => {
    const context = fixture()
    await expect(handleMatrixPeoplePrivacy({}, context)).resolves.toEqual({ ok: true, enabled: true })
    await expect(handleMatrixPeoplePrivacy({ enabled: false }, context)).resolves.toEqual({ ok: true, enabled: false })
  })
})
