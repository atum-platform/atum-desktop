import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect } from 'react'

import { $appConnections, appConnectionKey, refreshAppConnection } from './app-connection-state'

export function useAppConnection(accountId: string, appId: string, enabled: boolean) {
  const connections = useStore($appConnections)
  useEffect(() => {
    if (enabled && accountId && appId) {
      void refreshAppConnection(accountId, appId)
    }
  }, [accountId, appId, enabled])
  useLayoutEffect(() => {
    if (!enabled || !accountId || !appId) {
      return
    }

    const recheck = () => {
      if (document.visibilityState !== 'hidden') {
        void refreshAppConnection(accountId, appId)
      }
    }

    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)

    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [accountId, appId, enabled])

  return enabled ? connections[appConnectionKey(accountId, appId)] : undefined
}
