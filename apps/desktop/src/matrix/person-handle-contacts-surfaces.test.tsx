import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAliasRequest, MatrixAliasResult } from '../../shared/matrix-aliases'
import type { MatrixPeopleSearchBridge } from '../../shared/matrix-people-search'

import { MatrixMembers } from './conversation-controls'
import { searchPeopleDirectory } from './people'
import { resetMatrixHandleContactsForTest, setMatrixHandleContactsBridgeForTest } from './person-handle-contacts'
import { $matrixHandles, bindMatrixHandleOwner, resetMatrixHandlesForTest } from './person-handles'
import { MatrixRosterConversations } from './roster-conversations'

const OWNER = '@synthetic-user-0013:example.invalid'
const POON = '@synthetic-user-0021:example.invalid'
const LAN = '@synthetic-user-0019:example.invalid'
const RAW_ID = /user-[0-9a-f]{8}/u

/** The platform's answer: Poon has a handle, everyone else is null (stranger or none, alike). */
function contactsDirectory(byUser: Record<string, string> = { [POON]: 'poon' }) {
  const request = vi.fn(async (input: MatrixAliasRequest): Promise<MatrixAliasResult> =>
    input.action === 'contacts'
      ? {
          ok: true,
          value: { kind: 'contacts', contacts: input.matrixUsers.map(matrixUser => ({ matrixUser, handle: byUser[matrixUser] ?? null })) }
        }
      : { ok: false, error: 'unavailable' })

  setMatrixHandleContactsBridgeForTest({ pending: vi.fn(), request })

  return request
}

const contactReads = (request: ReturnType<typeof contactsDirectory>) =>
  request.mock.calls.flatMap(([input]) => (input.action === 'contacts' ? [[...input.matrixUsers].sort()] : []))

const direct = (id: string, name: string, userId: string): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: false,
  direct: true,
  preview: { kind: 'text', text: 'See you tomorrow', own: false, sender: name, at: 1 },
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId, membership: 'join' }
  ]
})

function snapshot(extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    domainEnabled: true,
    identity: { userId: OWNER, deviceId: 'OWNER' },
    rooms: [direct('!poon:example.invalid', 'Poon Nguyen', POON), direct('!lan:example.invalid', 'Lan', LAN)],
    roomId: null,
    messages: [],
    error: null,
    ...extra
  }
}

const wrap = (child: React.ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {child}
  </I18nProvider>
)

function roster(value: MatrixSnapshot) {
  window.atumMatrix = { command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge

  return render(
    wrap(
      <MatrixRosterConversations
        agentActions={null}
        assistantOpening={false}
        fail={vi.fn()}
        onEditAgent={vi.fn()}
        onOpen={vi.fn()}
        openAgentChat={vi.fn()}
        openAssistant={vi.fn()}
        snapshot={value}
      />
    )
  )
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  cleanup()
  resetMatrixHandleContactsForTest()
  resetMatrixHandlesForTest()
  Reflect.deleteProperty(window, 'atumMatrix')
  vi.useRealTimers()
})

describe('handles of people nobody looked up', () => {
  it('fills the roster from one read for every direct chat, under an empty chat\'s name, never an ID', async () => {
    const request = contactsDirectory()
    // Chats nobody has written in yet: their second line is who they are, by handle.
    roster(snapshot({ rooms: snapshot().rooms.map(room => ({ ...room, preview: undefined })) }))

    await act(() => vi.advanceTimersByTimeAsync(300))

    expect(contactReads(request)).toEqual([[LAN, POON].sort()])
    const poon = screen.getByRole('button', { name: 'Poon Nguyen' })
    expect(poon.querySelector('[data-roster-preview][data-person-handle]')?.textContent).toBe('@poon')
    // Lan had no handle to give: no second name, and never the Matrix ID.
    const lan = screen.getByRole('button', { name: 'Lan' })
    expect(lan.querySelector('[data-person-handle]')).toBeNull()
    expect(lan.textContent).not.toMatch(RAW_ID)
  })

  it('asks nothing where there is no directory (the domain is off)', async () => {
    const request = contactsDirectory()
    roster(snapshot({ domainEnabled: false }))

    await act(() => vi.advanceTimersByTimeAsync(300))

    expect(request).not.toHaveBeenCalled()
  })

  it('does not ask again when the roster re-renders with the same people', async () => {
    const request = contactsDirectory()
    const view = roster(snapshot())
    await act(() => vi.advanceTimersByTimeAsync(300))

    for (let index = 0; index < 5; index += 1) {
      view.rerender(
        wrap(
          <MatrixRosterConversations
            agentActions={null}
            assistantOpening={false}
            fail={vi.fn()}
            onEditAgent={vi.fn()}
            onOpen={vi.fn()}
            openAgentChat={vi.fn()}
            openAssistant={vi.fn()}
            snapshot={snapshot()}
          />
        )
      )
      await act(() => vi.advanceTimersByTimeAsync(300))
    }

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks for people found by name whose handle the search did not carry', async () => {
    const request = contactsDirectory()
    bindMatrixHandleOwner(OWNER)

    const people: MatrixPeopleSearchBridge = {
      search: vi.fn(async () => ({
        ok: true as const,
        value: { results: [{ userId: POON, name: 'Poon Nguyen' }, { userId: LAN, name: 'Lan', handle: 'lan' }] }
      }))
    } as unknown as MatrixPeopleSearchBridge

    await searchPeopleDirectory(people, 'nguyen')
    await vi.advanceTimersByTimeAsync(300)

    expect(contactReads(request)).toEqual([[POON]])
    expect($matrixHandles.get().byUser).toMatchObject({ [POON]: 'poon', [LAN]: 'lan' })
  })

  it.each([
    ['switching to another account', () => bindMatrixHandleOwner('@synthetic-user-0023:example.invalid')],
    ['signing out and back in as the same person', () => {
      bindMatrixHandleOwner('')
      bindMatrixHandleOwner(OWNER)
    }]
  ])('drops a directory answer that lands after %s: nothing learned, nothing asked', async (_, change) => {
    const request = contactsDirectory()
    bindMatrixHandleOwner(OWNER)
    let answer: (value: Awaited<ReturnType<MatrixPeopleSearchBridge['search']>>) => void = () => {}
    const people = { search: vi.fn(() => new Promise(resolve => (answer = resolve))) } as unknown as MatrixPeopleSearchBridge

    const searching = searchPeopleDirectory(people, 'nguyen')
    change()
    answer({ ok: true, value: { results: [{ userId: POON, name: 'Poon Nguyen' }, { userId: LAN, name: 'Lan', handle: 'lan' }], limited: false } })
    await searching
    await vi.advanceTimersByTimeAsync(300)

    expect(request).not.toHaveBeenCalled()
    expect($matrixHandles.get().byUser).toEqual({})
  })

  it('asks for a chat\'s members only while its members sheet is open', async () => {
    const request = contactsDirectory()
    window.atumMatrix = { command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge
    const room: MatrixRoom = { id: '!group:example.invalid', name: 'Friends', encrypted: true, membership: 'join' }

    const members = [
      { userId: POON, name: 'Poon Nguyen', membership: 'join', canRemove: false },
      { userId: LAN, name: 'Lan', membership: 'join', canRemove: false }
    ]

    const value = snapshot({ members, rooms: [room], roomId: room.id })
    const view = render(wrap(<MatrixMembers onOpenChange={vi.fn()} open={false} room={room} snapshot={value} />))
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(request).not.toHaveBeenCalled()

    view.rerender(wrap(<MatrixMembers onOpenChange={vi.fn()} open room={room} snapshot={value} />))
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(contactReads(request)).toEqual([[LAN, POON].sort()])
    expect(screen.getByText('@poon')).toBeTruthy()
  })
})
