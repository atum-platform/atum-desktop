import { useEffect, useState } from 'react'

import type { MatrixDriveBridge, MatrixDriveSearchResult, MatrixDriveView } from '../../shared/matrix-drive'

/** One debounced, cancellable lease. An old scope/query/owner's rows are never shown while the
 * next search is waiting. Native search results do not alter the current folder or its history. */
export function useDriveSearch(
  bridge: MatrixDriveBridge | undefined,
  view: MatrixDriveView,
  query: string,
  scope: 'drive' | 'folder'
) {
  const [answer, setAnswer] = useState<{
    bridge: MatrixDriveBridge
    key: string
    requestId: string
    result?: MatrixDriveSearchResult
    failed?: true
  }>()

  const key = JSON.stringify([view.revision, view.canGoBack, view.folderLabel, query, scope])
  const enabled = Boolean(bridge?.search && query.trim() && view.canBrowseLocally !== false)
  useEffect(() => {
    if (!enabled || !bridge?.search) {
      return
    }

    let active = true
    let started = false
    const requestId = crypto.randomUUID()

    const timer = setTimeout(() => {
      started = true
      void bridge.search!(query, scope, requestId)
        .then(result => {
          if (active && result.revision === view.revision) {
            setAnswer({ bridge, key, requestId, result })
          }
        })
        .catch(() => {
          if (active) {
            setAnswer({ bridge, key, requestId, failed: true })
          }
        })
    }, 180)

    return () => {
      active = false
      clearTimeout(timer)

      if (started) {
        void bridge.cancelSearch?.(requestId).catch(() => {})
      }
    }
  }, [bridge, enabled, key, query, scope, view.revision])
  const current = enabled && answer?.key === key && answer.bridge === bridge ? answer : undefined
  const result = current && view.searchResult?.requestId === current.requestId ? view.searchResult : current?.result

  return { enabled, result, loading: enabled && !current, failed: current?.failed === true }
}
