import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState } from 'react'

import type { MatrixCompanyMessageSearchBridge, MatrixCompanyMessageSearchResult } from '../../shared/matrix-company-search'
import type { MatrixPeopleSearchBridge, MatrixPeopleSearchPerson } from '../../shared/matrix-people-search'
import type { MatrixRosterMessageHit, MatrixRosterMessagePage, MatrixRosterSearchScope } from '../../shared/matrix-roster-search'

import { searchPeopleDirectory } from './people'

export type MatrixRosterGlobalEvent = MatrixCompanyMessageSearchResult & { companyId: string }
export type MatrixRosterGlobalSearchStatus = 'idle' | 'pending' | 'complete'

interface MatrixRosterGlobalSearchSource<Result> {
  status: MatrixRosterGlobalSearchStatus
  results: readonly Result[]
  coverage?: MatrixRosterMessagePage['coverage']
}

export interface MatrixRosterGlobalSearchState {
  query: string
  people: MatrixRosterGlobalSearchSource<MatrixPeopleSearchPerson>
  messages: MatrixRosterGlobalSearchSource<MatrixRosterGlobalEvent>
  files: MatrixRosterGlobalSearchSource<MatrixRosterGlobalEvent>
  personal: MatrixRosterGlobalSearchSource<MatrixRosterMessageHit>
  device: MatrixRosterGlobalSearchSource<MatrixRosterMessageHit>
  scope: MatrixRosterSearchScope
  privateRevision?: string
}

export interface MatrixRosterGlobalSearchInput {
  query: string
  ready: boolean
  companyIds: readonly string[]
  roomIds?: readonly string[]
  scope?: MatrixRosterSearchScope
  privateRevision?: string
}

interface MatrixRosterGlobalSearchBridges {
  people?: MatrixPeopleSearchBridge
  companies?: MatrixCompanyMessageSearchBridge
  messages?(scope: MatrixRosterSearchScope, roomIds: string[], query: string): Promise<MatrixRosterMessagePage>
}

type Source = 'people' | 'messages' | 'files' | 'personal' | 'device'
const NO_ROOMS: readonly string[] = []

interface SourceControl {
  generation: number
  key: string
  timer?: ReturnType<typeof setTimeout>
}

const idle = <Result>(): MatrixRosterGlobalSearchSource<Result> => ({ status: 'idle', results: [] })

const initial = (): MatrixRosterGlobalSearchState => ({
  query: '',
  people: idle(),
  messages: idle(),
  files: idle(),
  personal: idle(),
  device: idle(),
  scope: 'plain'
})

/**
 * One roster owns one controller. It reconciles independent server sources into a stable
 * per-query view: a source can replace only its own rows, and generations fence late work.
 * There is deliberately no automatic retry; a query/source scope is requested at most once.
 */
export function createMatrixRosterGlobalSearch(
  bridges: MatrixRosterGlobalSearchBridges,
  delay = 250
) {
  const $state = atom<MatrixRosterGlobalSearchState>(initial())

  const controls: Record<Source, SourceControl> = {
    people: { generation: 0, key: '' },
    messages: { generation: 0, key: '' },
    files: { generation: 0, key: '' },
    personal: { generation: 0, key: '' },
    device: { generation: 0, key: '' }
  }

  let queryGeneration = 0
  let disposed = false

  const cancel = (source: Source) => {
    const control = controls[source]
    clearTimeout(control.timer)
    control.timer = undefined
    control.generation += 1
    control.key = ''
  }

  const reset = (scope: MatrixRosterSearchScope = 'plain', query = '') => {
    queryGeneration += 1

    for (const source of Object.keys(controls) as Source[]) {cancel(source)}
    $state.set({ ...initial(), scope, query })
  }

  const setSource = <SourceName extends Source>(
    source: SourceName,
    value: MatrixRosterGlobalSearchState[SourceName]
  ) => {
    const state = $state.get()

    if (state[source] !== value) {
      $state.set({ ...state, [source]: value })
    }
  }

  const schedule = <SourceName extends Source>(
    source: SourceName,
    key: string,
    request: () => Promise<Omit<MatrixRosterGlobalSearchState[SourceName], 'status'>>,
    delayMs = delay
  ) => {
    const control = controls[source]

    if (control.key === key) {
      return
    }

    clearTimeout(control.timer)
    control.timer = undefined
    control.generation += 1
    control.key = key
    const sourceGeneration = control.generation
    const scheduledQueryGeneration = queryGeneration
    setSource(source, { status: 'pending', results: [] } as MatrixRosterGlobalSearchState[SourceName])

    control.timer = setTimeout(() => {
      control.timer = undefined
      void request().catch(() => ({ results: [] })).then(page => {
        if (disposed || scheduledQueryGeneration !== queryGeneration ||
          sourceGeneration !== control.generation || key !== control.key) {
          return
        }

        setSource(source, { status: 'complete', ...page,
          results: Array.isArray(page?.results) ? page.results : [] } as MatrixRosterGlobalSearchState[SourceName])
      })
    }, delayMs)
  }

  const completeWithoutRequest = (source: 'messages' | 'files', key: string) => {
    const control = controls[source]

    if (control.key === key) {
      return
    }

    clearTimeout(control.timer)
    control.timer = undefined
    control.generation += 1
    control.key = key
    setSource(source, { status: 'complete', results: [] })
  }

  const searchCompanies = async (
    companyIds: readonly string[],
    query: string,
    tab: 'messages' | 'files'
  ): Promise<Omit<MatrixRosterGlobalSearchSource<MatrixRosterGlobalEvent>, 'status'>> => {
    const search = bridges.companies?.search

    if (!search) {
      return { results: [] }
    }

    const pages = await Promise.all(companyIds.map(companyId =>
      search({
        companyId,
        query,
        limit: 10,
        tab,
        ...(tab === 'files' ? { fileType: 'all' as const } : {})
      }).then(result => result.ok ? {
        coverage: result.value.coverage,
        results: result.value.results.map(value => ({ ...value, companyId }))
      } : null).catch(() => null)
    ))

    const complete = pages.flatMap(page => page ?? [])

    return {
      results: complete.flatMap(page => page.results),
      coverage: {
        eligibleRooms: complete.reduce((total, page) => total + page.coverage.eligibleRooms, 0),
        searchedRooms: complete.reduce((total, page) => total + page.coverage.searchedRooms, 0),
        truncated: complete.length !== companyIds.length || complete.some(page => page.coverage.truncated),
        ...(complete.some(page => page.coverage.source === 'loaded_history') ? { source: 'loaded_history' } : {})
      }
    }
  }

  const update = ({ query, ready, companyIds, roomIds = NO_ROOMS, scope = 'plain', privateRevision }: MatrixRosterGlobalSearchInput) => {
    if (disposed) {
      return
    }

    const text = query.trim()
    const previous = $state.get()

    if (!ready || [...text].length < 2 || [...text].length > 200) {
      if (previous.scope !== scope || previous.query || Object.values(controls).some(control => control.key)) {
        reset(scope)
      }

      return
    }

    if (previous.scope !== scope || previous.query !== text) {
      reset(scope, text)
    }

    const ids = [...new Set(roomIds)].sort()
    const roomKey = JSON.stringify([text, ids])
    const search = bridges.messages

    if (scope === 'device') {
      if ($state.get().privateRevision !== privateRevision) {
        $state.set({ ...$state.get(), device: idle(), privateRevision })
      }

      if (search && ids.length > 0) {
        schedule('device', JSON.stringify([roomKey, privateRevision]),
          () => search('device', ids, text), previous.query === text ? 0 : delay)
      } else if (controls.device.key) {
        cancel('device')
        setSource('device', idle())
      }

      return
    }

    if (search && ids.length > 0) {
      schedule('personal', roomKey, () => search('plain', ids, text))
    } else if (controls.personal.key) {
      cancel('personal')
      setSource('personal', idle())
    }

    const sortedCompanyIds = [...new Set(companyIds)].sort()
    schedule('people', text, async () => ({ results: await searchPeopleDirectory(bridges.people, text) }))

    const companyKey = `${text}\u0000${sortedCompanyIds.join('\u0000')}`

    if (!bridges.companies?.search || sortedCompanyIds.length === 0) {
      completeWithoutRequest('messages', companyKey)
      completeWithoutRequest('files', companyKey)

      return
    }

    schedule('messages', companyKey, () => searchCompanies(sortedCompanyIds, text, 'messages'))
    schedule('files', companyKey, () => searchCompanies(sortedCompanyIds, text, 'files'))
  }

  const dispose = () => {
    disposed = true
    reset()
  }

  /**
   * Back in use after `dispose` (React StrictMode unmounts and remounts the same roster once in
   * development). Late answers from before stay fenced by the bumped generations; the next `update`
   * asks again because `dispose` cleared every source's key.
   */
  const resume = () => {
    disposed = false
  }

  return { $state, dispose, reset, resume, update }
}

export type MatrixRosterGlobalSearch = ReturnType<typeof createMatrixRosterGlobalSearch>

/**
 * The roster's one controller for its lifetime. It runs while mounted and stops on unmount, and a
 * remount of the same roster (StrictMode's double mount) starts it again instead of leaving a
 * shut-down controller behind a search that says "Searching…" for ever.
 */
export function useMatrixRosterGlobalSearch(
  bridges: MatrixRosterGlobalSearchBridges,
  { companyIds, privateRevision, query, ready, roomIds, scope }: MatrixRosterGlobalSearchInput,
  delay?: number
) {
  const [search] = useState(() => createMatrixRosterGlobalSearch(bridges, delay))
  const state = useStore(search.$state)

  // Declared before the update effect so a remount resumes the controller before asking it again.
  useEffect(() => {
    search.resume()

    return () => search.dispose()
  }, [search])

  useEffect(() => {
    search.update({ query, ready, companyIds, roomIds, scope, privateRevision })
  }, [companyIds, privateRevision, query, ready, roomIds, scope, search])

  return { state, reset: search.reset }
}

export function matrixRosterGlobalSearchPending(state: MatrixRosterGlobalSearchState): boolean {
  return state.people.status === 'pending' || state.messages.status === 'pending' || state.files.status === 'pending' ||
    state.personal.status === 'pending' || state.device.status === 'pending'
}
