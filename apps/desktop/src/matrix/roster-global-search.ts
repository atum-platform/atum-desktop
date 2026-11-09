import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState } from 'react'

import type { MatrixCompanyMessageSearchBridge, MatrixCompanyMessageSearchResult } from '../../shared/matrix-company-search'
import type { MatrixPeopleSearchBridge, MatrixPeopleSearchPerson } from '../../shared/matrix-people-search'

import { searchPeopleDirectory } from './people'

export type MatrixRosterGlobalEvent = MatrixCompanyMessageSearchResult & { companyId: string }
export type MatrixRosterGlobalSearchStatus = 'idle' | 'pending' | 'complete'

interface MatrixRosterGlobalSearchSource<Result> {
  status: MatrixRosterGlobalSearchStatus
  results: readonly Result[]
}

export interface MatrixRosterGlobalSearchState {
  query: string
  people: MatrixRosterGlobalSearchSource<MatrixPeopleSearchPerson>
  messages: MatrixRosterGlobalSearchSource<MatrixRosterGlobalEvent>
  files: MatrixRosterGlobalSearchSource<MatrixRosterGlobalEvent>
}

export interface MatrixRosterGlobalSearchInput {
  query: string
  ready: boolean
  companyIds: readonly string[]
}

interface MatrixRosterGlobalSearchBridges {
  people?: MatrixPeopleSearchBridge
  companies?: MatrixCompanyMessageSearchBridge
}

type Source = 'people' | 'messages' | 'files'

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
  files: idle()
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
    files: { generation: 0, key: '' }
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

  const reset = () => {
    queryGeneration += 1
    cancel('people')
    cancel('messages')
    cancel('files')
    $state.set(initial())
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
    request: () => Promise<MatrixRosterGlobalSearchState[SourceName]['results']>
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
      void request().catch(() => []).then(results => {
        if (disposed || scheduledQueryGeneration !== queryGeneration ||
          sourceGeneration !== control.generation || key !== control.key) {
          return
        }

        setSource(source, { status: 'complete', results } as MatrixRosterGlobalSearchState[SourceName])
      })
    }, delay)
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
  ): Promise<readonly MatrixRosterGlobalEvent[]> => {
    const search = bridges.companies?.search

    if (!search) {
      return []
    }

    const pages = await Promise.all(companyIds.map(companyId =>
      search({
        companyId,
        query,
        limit: 10,
        tab,
        ...(tab === 'files' ? { fileType: 'all' as const } : {})
      }).then(result => result.ok
        ? result.value.results.map(value => ({ ...value, companyId }))
        : []).catch(() => [])
    ))

    return pages.flat()
  }

  const update = ({ query, ready, companyIds }: MatrixRosterGlobalSearchInput) => {
    if (disposed) {
      return
    }

    const text = query.trim()

    if (!ready || [...text].length < 2) {
      if ($state.get().query || Object.values(controls).some(control => control.key)) {
        reset()
      }

      return
    }

    if ($state.get().query !== text) {
      queryGeneration += 1
      cancel('people')
      cancel('messages')
      cancel('files')
      $state.set({ ...initial(), query: text })
    }

    const sortedCompanyIds = [...new Set(companyIds)].sort()
    schedule('people', text, () => searchPeopleDirectory(bridges.people, text))

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
    queryGeneration += 1
    cancel('people')
    cancel('messages')
    cancel('files')
  }

  /**
   * Back in use after `dispose` (React StrictMode unmounts and remounts the same roster once in
   * development). Late answers from before stay fenced by the bumped generations; the next `update`
   * asks again because `dispose` cleared every source's key.
   */
  const resume = () => {
    disposed = false
  }

  return { $state, dispose, resume, update }
}

export type MatrixRosterGlobalSearch = ReturnType<typeof createMatrixRosterGlobalSearch>

/**
 * The roster's one controller for its lifetime. It runs while mounted and stops on unmount, and a
 * remount of the same roster (StrictMode's double mount) starts it again instead of leaving a
 * shut-down controller behind a search that says "Searching…" for ever.
 */
export function useMatrixRosterGlobalSearch(
  bridges: MatrixRosterGlobalSearchBridges,
  { companyIds, query, ready }: MatrixRosterGlobalSearchInput,
  delay?: number
): MatrixRosterGlobalSearchState {
  const [search] = useState(() => createMatrixRosterGlobalSearch(bridges, delay))
  const state = useStore(search.$state)

  // Declared before the update effect so a remount resumes the controller before asking it again.
  useEffect(() => {
    search.resume()

    return () => search.dispose()
  }, [search])

  useEffect(() => {
    search.update({ query, ready, companyIds })
  }, [companyIds, query, ready, search])

  return state
}

export function matrixRosterGlobalSearchPending(state: MatrixRosterGlobalSearchState): boolean {
  return state.people.status === 'pending' || state.messages.status === 'pending' || state.files.status === 'pending'
}
