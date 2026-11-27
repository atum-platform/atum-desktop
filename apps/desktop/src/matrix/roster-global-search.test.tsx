import { cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixPeopleSearchBridge } from '../../shared/matrix-people-search'

import {
  createMatrixRosterGlobalSearch,
  matrixRosterGlobalSearchPending,
  useMatrixRosterGlobalSearch
} from './roster-global-search'

const NO_COMPANIES: readonly string[] = []

function peopleBridge(): MatrixPeopleSearchBridge {
  return {
    search: vi.fn(async () => ({
      ok: true as const,
      value: { results: [{ userId: '@linh:atum.example', name: 'Linh' }], limited: false }
    })),
    privacy: vi.fn(),
    setPrivacy: vi.fn()
  }
}

function Roster({ people, query }: { people: MatrixPeopleSearchBridge; query: string }) {
  const { state } = useMatrixRosterGlobalSearch({ people }, { query, ready: true, companyIds: NO_COMPANIES }, 0)
  const searching = state.query !== query.trim() || matrixRosterGlobalSearchPending(state)

  return (
    <p data-testid="search">
      {searching ? 'Searching…' : state.people.results.map(person => person.name).join(',') || 'none'}
    </p>
  )
}

afterEach(() => cleanup())

describe('roster global search lifecycle', () => {
  it('answers under React StrictMode instead of hanging on Searching…', async () => {
    const people = peopleBridge()
    const view = render(<StrictMode><Roster people={people} query="li" /></StrictMode>)

    await waitFor(() => expect(view.getByTestId('search').textContent).toBe('Linh'))
    expect(people.search).toHaveBeenCalled()
  })

  it('keeps answering new queries after the StrictMode remount', async () => {
    const people = peopleBridge()
    const view = render(<StrictMode><Roster people={people} query="li" /></StrictMode>)

    await waitFor(() => expect(view.getByTestId('search').textContent).toBe('Linh'))
    view.rerender(<StrictMode><Roster people={people} query="lin" /></StrictMode>)
    await waitFor(() => expect(view.getByTestId('search').textContent).toBe('Linh'))
    expect(people.search).toHaveBeenCalledWith({ query: 'lin', limit: 20 })
  })

  it('a disposed controller drops late answers, and asks again once resumed', async () => {
    const people = peopleBridge()
    const search = createMatrixRosterGlobalSearch({ people }, 0)

    search.update({ query: 'li', ready: true, companyIds: NO_COMPANIES })
    search.dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(search.$state.get().people.status).toBe('idle')

    search.resume()
    search.update({ query: 'li', ready: true, companyIds: NO_COMPANIES })
    await vi.waitFor(() => expect(search.$state.get().people.status).toBe('complete'))
    expect(search.$state.get().people.results.map(person => person.name)).toEqual(['Linh'])
  })

  it('cancels scheduled plain sources and never sends a device-only term to any remote source', async () => {
    const people = peopleBridge()
    const companies = { search: vi.fn() }

    const messages = vi.fn(async () => ({
      results: [], coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false }
    }))

    const controller = createMatrixRosterGlobalSearch({ people, companies, messages }, 10)
    const input = { ready: true, companyIds: ['company'], roomIds: ['!chat:example.test'] }

    controller.update({ ...input, scope: 'plain', query: 'scheduled' })
    controller.reset('device')
    controller.update({ ...input, scope: 'device', query: 'device-only-canary' })

    await vi.waitFor(() => expect(controller.$state.get().device.status).toBe('complete'))
    expect(people.search).not.toHaveBeenCalled()
    expect(companies.search).not.toHaveBeenCalled()
    expect(messages.mock.calls).toEqual([['device', input.roomIds, 'device-only-canary']])
  })

  it('drops an already in-flight remote answer after switching scope', async () => {
    const people = peopleBridge()
    let respond!: (value: Awaited<ReturnType<MatrixPeopleSearchBridge['search']>>) => void
    const pending = new Promise<Awaited<ReturnType<MatrixPeopleSearchBridge['search']>>>(resolve => {respond = resolve})
    vi.mocked(people.search).mockReturnValueOnce(pending)
    const controller = createMatrixRosterGlobalSearch({ people }, 0)
    const input = { ready: true, companyIds: NO_COMPANIES }

    controller.update({ ...input, query: 'plain' })
    await vi.waitFor(() => expect(people.search).toHaveBeenCalled())
    controller.update({ ...input, scope: 'device', query: 'private' })
    respond({ ok: true, value: { results: [{ userId: '@someone:example.test', name: 'Someone' }], limited: false } })
    await pending

    expect(controller.$state.get().scope).toBe('device')
    expect(controller.$state.get().people.results).toEqual([])
  })
})
