import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import type { MatrixSnapshot } from '../../shared/matrix'
import { isTeamSpaceRoom } from '../../shared/matrix-company-channel-room'
import { type MatrixRosterMessagePage, matrixRosterSearchRooms, type MatrixRosterSearchScope } from '../../shared/matrix-roster-search'

import { directRoomWith } from './people'
import { bindMatrixHandleOwner, rememberMatrixHandle } from './person-handles'
import { matrixRosterGlobalSearchPending, useMatrixRosterGlobalSearch } from './roster-global-search'
import { type MatrixRosterHit, useRosterSearchCopy } from './roster-message-results'
import { normalizeMatrixRosterQuery } from './roster-model'
import { $companyDirectories } from './team-space/directory-store'
import { teamSpaceAccountKey } from './team-space/keys'
import { runMatrixCommand } from './text-document-actions'

export function useRosterSearch(snapshot: MatrixSnapshot, query: string, searchScope: MatrixRosterSearchScope) {
  const searchCopy = useRosterSearchCopy()
  const searchRooms = useMemo(() => matrixRosterSearchRooms(snapshot.rooms), [snapshot.rooms])
  const searchableRooms = useMemo(() => new Map(searchRooms.map(room => [room.id, room])), [searchRooms])

  const globalCompanyIds = useMemo(() => [...new Set(searchRooms.flatMap(value => {
    const companyId = value.companyChannel?.companyId ?? value.companyConversation?.companyId

    return companyId && !value.encrypted ? [companyId] : []
  }))], [searchRooms])

  const roomIds = useMemo(() => searchRooms.filter(room => searchScope === 'device' ? room.encrypted :
    !room.encrypted && !isTeamSpaceRoom(room)).map(room => room.id), [searchRooms, searchScope])

  const privateRevision = searchScope === 'device'
    ? JSON.stringify([snapshot.rosterPrivateHistoryRevision, roomIds.toSorted(), snapshot.ignoredUsers])
    : undefined

  const { state: globalSearchState, reset: resetSearch } = useMatrixRosterGlobalSearch({
    people: window.atumMatrix.people,
    companies: window.atumMatrix.companies,
    messages: (scope, roomIds, query) =>
      runMatrixCommand({ kind: 'rosterMessageSearch', scope, roomIds, query }) as Promise<MatrixRosterMessagePage>
  }, { query, scope: searchScope, roomIds, privateRevision, ready: snapshot.state === 'ready', companyIds: globalCompanyIds })

  const activeSearch = [...query.trim()].length >= 2

  const currentGlobalSearch = snapshot.state === 'ready' && globalSearchState.scope === searchScope &&
    globalSearchState.query === query.trim() &&
    (searchScope !== 'device' || globalSearchState.privateRevision === privateRevision)

  useEffect(() => {
    const owner = snapshot.identity?.userId

    if (!owner) {
      return
    }

    bindMatrixHandleOwner(owner)

    if (currentGlobalSearch) {
      for (const person of globalSearchState.people.results) {
        if (person.handle) {
          rememberMatrixHandle(person.userId, person.handle)
        }
      }
    }
  }, [currentGlobalSearch, globalSearchState.people.results, snapshot.identity?.userId])

  const globalPeople = useMemo(() => {
    if (!currentGlobalSearch) {
      return []
    }

    const excluded = new Set([
      snapshot.identity?.userId,
      ...(snapshot.agents ?? []).map(agent => agent.userId)
    ].filter((id): id is string => Boolean(id)))

    return globalSearchState.people.results.filter(person =>
      !excluded.has(person.userId) && !directRoomWith(snapshot, person.userId))
  }, [currentGlobalSearch, globalSearchState.people.results, snapshot])

  const ignored = new Set(snapshot.ignoredUsers)

  const visibleHit = (hit: MatrixRosterHit) => {
    const room = searchableRooms.get(hit.roomId)

    return room && room.encrypted === (searchScope === 'device') && !ignored.has(hit.sender)
  }

  const hits = currentGlobalSearch ? (searchScope === 'device' ? globalSearchState.device.results :
    [...globalSearchState.personal.results, ...globalSearchState.messages.results]).filter(visibleHit) : []

  const files = currentGlobalSearch && searchScope === 'plain' ? globalSearchState.files.results.filter(visibleHit) : []

  const globalSearching = activeSearch && [...query.trim()].length <= 200 &&
    (!currentGlobalSearch || matrixRosterGlobalSearchPending(globalSearchState))

  const matchingChats = useMemo(() => {
    const text = normalizeMatrixRosterQuery(query)

    return text && searchScope === 'plain' ? searchRooms.filter(room => isTeamSpaceRoom(room) &&
      normalizeMatrixRosterQuery(room.title || room.name).includes(text)) : []
  }, [query, searchRooms, searchScope])

  const directories = useStore($companyDirectories)
  const companyDirectory = snapshot.identity ? directories[teamSpaceAccountKey(snapshot.identity)] : undefined
  const [companyNamesRead, setCompanyNamesRead] = useState<ReadonlyMap<string, string>>(() => new Map())

  const companyNames = companyDirectory
    ? new Map(companyDirectory.companies.map(company => [company.id, company.displayName]))
    : companyNamesRead

  const needsCompanyNames = searchScope === 'plain' && activeSearch && globalCompanyIds.length > 0 &&
    !companyDirectory && companyNamesRead.size === 0

  useEffect(() => {
    if (!needsCompanyNames) {return}

    let active = true
    void window.atumMatrix.companies?.request({ action: 'list' }).then(result => {
      if (active && result.ok && 'companies' in result.value) {
        setCompanyNamesRead(new Map(result.value.companies.map(company => [company.id, company.displayName])))
      }
    }).catch(() => {})

    return () => {active = false}
  }, [needsCompanyNames])

  const deviceCoverage = currentGlobalSearch ? globalSearchState.device.coverage : undefined

  const searched = (globalSearchState.personal.coverage?.searchedRooms ?? 0) +
    (globalSearchState.messages.coverage?.searchedRooms ?? 0)

  const privateCount = searchRooms.filter(room => room.encrypted).length

  const partial = globalSearchState.personal.coverage?.truncated || globalSearchState.messages.coverage?.truncated ||
    globalSearchState.messages.coverage?.source === 'loaded_history'

  const coverage = searchScope === 'device'
    ? [searchCopy.loaded(deviceCoverage?.loadedMessages ?? 0, deviceCoverage?.searchedRooms ?? 0, privateCount),
        deviceCoverage?.truncated && searchCopy.partial]
    : [searchCopy.searched(searched), privateCount > 0 && searchCopy.skipped(privateCount), partial && searchCopy.partial]

  return {
    activeSearch, companyNames, coverage, files, globalPeople, globalSearching, hits, matchingChats,
    resetSearch, searchableRooms, visibleHit
  }
}
