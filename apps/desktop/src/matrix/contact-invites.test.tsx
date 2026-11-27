import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasRequest, MatrixAliasResult } from '../../shared/matrix-aliases'

import { acceptContactInvite, inviteContactByEmail, useContactInviteAccept } from './contact-invites'
import { parsePersonQuery } from './people'
import { PersonSearch } from './person-search'

const TOKEN = 'a'.repeat(43)
const SNAPSHOT = {
  state: 'ready',
  identity: { userId: '@me:test', deviceId: 'D' },
  rooms: [{ id: '!ana:test', name: 'Ana', membership: 'join', direct: true, participants: [
    { userId: '@me:test', membership: 'join' }, { userId: '@ana:test', membership: 'join' }] }],
  roomId: null,
  messages: [],
  error: null
} as unknown as MatrixSnapshot

function bridge(answer: (input: MatrixAliasRequest) => MatrixAliasResult): MatrixAliasBridge & { request: ReturnType<typeof vi.fn> } {
  return { pending: vi.fn(), request: vi.fn(async (input: MatrixAliasRequest) => answer(input)) }
}

describe('contact invitations', () => {
  it('reads an email as its own kind of query, never as a name or handle', () => {
    expect(parsePersonQuery(' Support@Example.com ')).toEqual({ kind: 'email', email: 'support@example.com' })
    expect(parsePersonQuery('@lan')).toMatchObject({ kind: 'handle', handle: 'lan' })
    expect(parsePersonQuery('@lan:test')).toEqual({ kind: 'matrixId', userId: '@lan:test' })
  })

  it('maps an invitation to invited, limited or failed', async () => {
    expect(await inviteContactByEmail(bridge(() => ({ ok: true, value: { kind: 'invite', state: 'invited', expiresAt: 1 } })), 'hello@example.com', 'vi'))
      .toBe('invited')
    expect(await inviteContactByEmail(bridge(() => ({ ok: true, value: { kind: 'invite', state: 'limited', retryAfterSeconds: 9 } })), 'hello@example.com', 'en'))
      .toBe('limited')
    expect(await inviteContactByEmail(bridge(() => ({ ok: false, error: 'limit' })), 'hello@example.com', 'en')).toBe('limited')
    expect(await inviteContactByEmail(bridge(() => ({ ok: false, error: 'unavailable' })), 'hello@example.com', 'en')).toBe('failed')
    expect(await inviteContactByEmail(undefined, 'hello@example.com', 'en')).toBe('failed')
  })

  it('treats anything but an accepted contact invitation as a link for Team Space', async () => {
    expect(await acceptContactInvite(bridge(() => ({ ok: true, value: { kind: 'accept', state: 'accepted', inviterMatrixUser: '@ana:test' } })), TOKEN))
      .toEqual({ state: 'accepted', inviterMatrixUser: '@ana:test' })
    for (const answer of [{ ok: true, value: { kind: 'accept', state: 'unavailable' } }, { ok: true, value: { kind: 'accept', state: 'self' } },
      { ok: false, error: 'missing' }] as MatrixAliasResult[]) {
      expect(await acceptContactInvite(bridge(() => answer), TOKEN)).toEqual({ state: 'other' })
    }
  })

  it('offers an opened link once, for a ready account, and opens the chat you already have with the inviter', async () => {
    const aliases = bridge(() => ({ ok: true, value: { kind: 'accept', state: 'accepted', inviterMatrixUser: '@ana:test' } }))
    const onAccepted = vi.fn()
    const request = { serial: 7, token: TOKEN, requestId: 'r' }
    const { rerender, result } = renderHook(props => useContactInviteAccept(props), {
      initialProps: { bridge: aliases, onAccepted, ready: false, request, snapshot: SNAPSHOT }
    })

    expect(result.current).toBe('checking')
    expect(aliases.request).not.toHaveBeenCalled()
    rerender({ bridge: aliases, onAccepted, ready: true, request, snapshot: SNAPSHOT })
    await waitFor(() => expect(result.current).toBe('settled'))
    expect(aliases.request).toHaveBeenCalledExactlyOnceWith({ action: 'accept', token: TOKEN })
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith('@ana:test', '!ana:test')
    rerender({ bridge: aliases, onAccepted, ready: true, request, snapshot: SNAPSHOT })
    expect(aliases.request).toHaveBeenCalledOnce()
  })

  it('lets a team invite through untouched, and never holds a paste flow', async () => {
    const aliases = bridge(() => ({ ok: true, value: { kind: 'accept', state: 'unavailable' } }))
    const onAccepted = vi.fn()
    const { result } = renderHook(() => useContactInviteAccept({
      bridge: aliases, onAccepted, ready: true, request: { serial: 1, token: TOKEN, requestId: 'r' }, snapshot: SNAPSHOT
    }))

    await waitFor(() => expect(result.current).toBe('settled'))
    expect(onAccepted).not.toHaveBeenCalled()
    const paste = renderHook(() => useContactInviteAccept({ bridge: aliases, onAccepted, ready: true, request: { serial: 2 }, snapshot: SNAPSHOT }))
    expect(paste.result.current).toBe('settled')
  })
})

describe('a Find answer and the live snapshot', () => {
  it('keeps the answer when the snapshot updates while it is in flight (the name search re-runs)', async () => {
    let answer!: (value: MatrixAliasResult) => void
    const aliases = bridge(() => ({ ok: true, value: { kind: 'search', matrixUser: null } }))
    aliases.request.mockImplementation(() => new Promise<MatrixAliasResult>(resolve => { answer = resolve }))
    window.atumMatrix = { people: { search: vi.fn(async () => ({ ok: true, value: { results: [], limited: false } })) } } as never
    const props = { bridge: aliases, label: 'Who', offer: () => ({ note: '' }), onQueryChange: () => {}, placeholder: '',
      query: '@lan', snapshot: SNAPSHOT }
    const view = render(<PersonSearch {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    view.rerender(<PersonSearch {...props} snapshot={{ ...SNAPSHOT }} />)
    answer({ ok: true, value: { kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: '@lan:test' } })
    await waitFor(() => expect(document.querySelector('[data-matrix-person-found]')).toBeTruthy(), { timeout: 10_000 })
    Reflect.deleteProperty(window, 'atumMatrix')
  })
})
