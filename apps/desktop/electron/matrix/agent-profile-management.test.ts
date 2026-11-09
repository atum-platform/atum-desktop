import { describe, expect, it, vi } from 'vitest'

import type { AgentProfileRequest } from '../../shared/agent-profile-management'

import { MatrixAgentDefinitionError } from './agent-definition'
import { manageMatrixAgentProfile } from './agent-profile-management'

const MAIN = '00000000-0000-4000-8000-11e594f48195'
const OTHER = '00000000-0000-4000-8000-e79acd97ac88'

function detail(principal = OTHER) {
  return {
    principal,
    displayName: principal === MAIN ? 'Atum' : 'Scout',
    isMain: principal === MAIN,
    definitionRevision: 3,
    identityRevision: 2,
    avatarUrl: null,
    soul: principal === MAIN ? '# Atum' : '# Scout'
  }
}

function fixture(originPrincipal = MAIN) {
  const request = vi.fn(async (input: AgentProfileRequest, _signal?: AbortSignal) => {
    if (input.operation === 'list') {
      return {
        originPrincipal,
        originIsMain: originPrincipal === MAIN,
        agents: [
          { ...detail(MAIN), soul: undefined },
          { ...detail(OTHER), soul: undefined }
        ].map(({ soul: _soul, ...entry }) => entry)
      }
    }
    return {
      originPrincipal,
      originIsMain: originPrincipal === MAIN,
      profile: detail(input.target ?? originPrincipal)
    }
  })
  const saved = vi.fn()
  return {
    request,
    saved,
    options: { originPrincipal, request, current: () => true, saved }
  }
}

it('forwards valid requests to the server boundary and never accepts caller-selected authority', async () => {
  const f = fixture(OTHER)
  const signal = new AbortController().signal

  await expect(
    manageMatrixAgentProfile(f.options, { operation: 'read', target: MAIN, role: 'main' }, signal)
  ).resolves.toEqual({ error: 'invalid' })
  expect(f.request).not.toHaveBeenCalled()

  await expect(manageMatrixAgentProfile(f.options, { operation: 'read', target: MAIN }, signal)).resolves.toMatchObject({
    originPrincipal: OTHER,
    originIsMain: false,
    profile: { principal: MAIN }
  })
  expect(f.request).toHaveBeenCalledExactlyOnceWith(
    { operation: 'read', target: MAIN },
    expect.any(AbortSignal)
  )
})

it('keeps transport identities out and invokes the saved hook only for a validated profile', async () => {
  const f = fixture()
  const list = await manageMatrixAgentProfile(f.options, { operation: 'list' }, new AbortController().signal)
  expect(list).toMatchObject({ agents: [{ principal: MAIN }, { principal: OTHER }] })
  expect(JSON.stringify(list)).not.toContain('matrixUser')
  expect(f.saved).not.toHaveBeenCalled()

  const update = {
    operation: 'update',
    target: OTHER,
    expectedDefinitionRevision: 3,
    expectedIdentityRevision: 2,
    displayName: 'Researcher'
  }
  await expect(manageMatrixAgentProfile(f.options, update, new AbortController().signal)).resolves.toMatchObject({
    profile: { principal: OTHER }
  })
  expect(f.request).toHaveBeenLastCalledWith(update, expect.any(AbortSignal))
  expect(f.saved).toHaveBeenCalledExactlyOnceWith(detail(OTHER))
})

it('forwards prepared avatar bytes without translating them into Matrix profile media', async () => {
  const f = fixture()
  await manageMatrixAgentProfile(
    f.options,
    { operation: 'avatar', target: OTHER, avatar: { type: 'image/png', base64: 'iVBORw0KGgo=' } },
    new AbortController().signal
  )
  expect(f.request).toHaveBeenCalledWith(
    { operation: 'avatar', target: OTHER, avatar: { type: 'image/png', bytes: expect.any(Uint8Array) } },
    expect.any(AbortSignal)
  )
})

it('rejects stale or mismatched server output instead of trusting the transport', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce({ originPrincipal: OTHER, originIsMain: true, profile: detail(OTHER) })
  await expect(
    manageMatrixAgentProfile(f.options, { operation: 'read', target: OTHER }, new AbortController().signal)
  ).resolves.toEqual({ error: 'unavailable' })
  expect(f.saved).not.toHaveBeenCalled()

  const stale = fixture()
  stale.options.current = () => false
  await expect(
    manageMatrixAgentProfile(stale.options, { operation: 'list' }, new AbortController().signal)
  ).resolves.toEqual({ error: 'unavailable' })
  expect(stale.request).not.toHaveBeenCalled()
})

it('propagates an abort while the canonical request is in flight', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.request.mockImplementationOnce(async (_input, signal) => {
    controller.abort()
    signal.throwIfAborted()
    throw new Error('unreachable')
  })
  await expect(
    manageMatrixAgentProfile(f.options, { operation: 'read' }, controller.signal)
  ).rejects.toThrow()
})

// Conversational rename: the person says what to call the assistant and the assistant renames itself
// with its own atum_agents tool. On a Mac that is this same adapter, so these are the cases the
// person's sentence can end in. The platform decides (revision fence, name rules); the adapter only
// carries its closed answer back, and tells main to show the new name once it is a validated profile.
describe('a Mac assistant renames itself', () => {
  const rename = {
    operation: 'update',
    expectedDefinitionRevision: 3,
    expectedIdentityRevision: 2,
    displayName: 'Bông'
  }

  const signal = () => new AbortController().signal

  it('writes only the name, for itself, and hands the validated profile to main', async () => {
    const f = fixture(MAIN)
    f.request.mockResolvedValueOnce({
      originPrincipal: MAIN,
      originIsMain: true,
      profile: { ...detail(MAIN), displayName: 'Bông', definitionRevision: 4, identityRevision: 3 }
    })

    await expect(manageMatrixAgentProfile(f.options, rename, signal())).resolves.toMatchObject({
      profile: { principal: MAIN, displayName: 'Bông', definitionRevision: 4, identityRevision: 3 }
    })
    // No target (itself), no soul, no photo: the request is exactly the name and both revisions.
    expect(f.request).toHaveBeenCalledExactlyOnceWith(rename, expect.any(AbortSignal))
    expect(f.saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ principal: MAIN, displayName: 'Bông' }))
  })

  it.each(['reserved', 'duplicate', 'invalid', 'conflict', 'locked', 'denied', 'missing', 'offline', 'unavailable'])(
    'carries the platform’s closed refusal “%s” back and shows no new name',
    async code => {
      const f = fixture(MAIN)
      f.request.mockResolvedValueOnce({ error: code } as never)

      await expect(manageMatrixAgentProfile(f.options, rename, signal())).resolves.toEqual({ error: code })
      expect(f.saved).not.toHaveBeenCalled()
    }
  )

  it('turns a rejected call into the platform’s own vocabulary, and anything else into unavailable', async () => {
    for (const [thrown, expected] of [
      [new MatrixAgentDefinitionError('conflict'), 'conflict'],
      [new MatrixAgentDefinitionError('denied'), 'denied'],
      [new MatrixAgentDefinitionError('invalid'), 'invalid'],
      [new Error('socket hang up'), 'unavailable'],
      [new TypeError('fetch failed'), 'unavailable']
    ] as const) {
      const f = fixture(MAIN)
      f.request.mockRejectedValueOnce(thrown)

      await expect(manageMatrixAgentProfile(f.options, rename, signal())).resolves.toEqual({ error: expected })
      expect(f.saved).not.toHaveBeenCalled()
    }
  })

  it('refuses a rename that carries anything else, before the platform is asked', async () => {
    const f = fixture(MAIN)

    for (const extra of [{ role: 'main' }, { owner: 'someone' }, { model: 'gpt' }, { avatar: null }, { target: 'x' }]) {
      await expect(manageMatrixAgentProfile(f.options, { ...rename, ...extra }, signal())).resolves.toEqual({
        error: 'invalid'
      })
    }

    // And not without both revisions, or with a name that is not text.
    for (const broken of [
      { ...rename, expectedDefinitionRevision: undefined },
      { ...rename, expectedIdentityRevision: 0 },
      { ...rename, displayName: 12 },
      { ...rename, displayName: 'x'.repeat(4097) }
    ]) {
      await expect(manageMatrixAgentProfile(f.options, broken, signal())).resolves.toEqual({ error: 'invalid' })
    }

    expect(f.request).not.toHaveBeenCalled()
  })

  it('never answers for another turn: a rename after its turn ended is not sent, one answered late is dropped', async () => {
    const ended = fixture(MAIN)
    ended.options.current = () => false
    await expect(manageMatrixAgentProfile(ended.options, rename, signal())).resolves.toEqual({ error: 'unavailable' })
    expect(ended.request).not.toHaveBeenCalled()

    const late = fixture(MAIN)
    let live = true
    late.options.current = () => live
    late.request.mockImplementationOnce(async () => {
      live = false

      return { originPrincipal: MAIN, originIsMain: true, profile: { ...detail(MAIN), displayName: 'Bông' } }
    })
    await expect(manageMatrixAgentProfile(late.options, rename, signal())).resolves.toEqual({ error: 'unavailable' })
    expect(late.saved).not.toHaveBeenCalled()
  })
})
