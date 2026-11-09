import { $atumAccountScopeId, ensureAtumSpecialistConversation } from '@/store/atum-messaging'

import { $atumAppCatalog, appSupportsDirect, refreshAtumAppCatalog } from './atum-app-catalog'

interface AtumAppsGatewayEvent {
  payload?: unknown
  session_id?: string
  type?: string
}

interface AtumAppsNavigationOptions {
  activeSessionId: string | null
  getActiveSessionId?: () => string | null
  requestGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export async function handleAtumAppsNavigation(
  event: AtumAppsGatewayEvent,
  { activeSessionId, getActiveSessionId = () => activeSessionId, requestGateway }: AtumAppsNavigationOptions
): Promise<boolean> {
  if (event.type !== 'atum.apps.open.request' && event.type !== 'atum.apps.list.request') {
    return false
  }

  const payload = record(event.payload)
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''
  const appId = payload.app_id
  const senderIsActive = Boolean(activeSessionId && event.session_id === activeSessionId)
  const senderRemainsActive = () => Boolean(event.session_id && event.session_id === getActiveSessionId())

  if (!requestId) {
    return true
  }

  if (event.type === 'atum.apps.list.request') {
    let result: {
      apps?: Array<{ availability: 'available'; description: { vi: string; en: string }; id: string; name: string }>
      error?: string
    } = {}
    const accountId = $atumAccountScopeId.get()
    if (!senderIsActive) {
      result.error = 'Only the active local assistant can list apps.'
    } else if (!accountId) {
      result.error = 'No active Atum account is available.'
    } else {
      try {
        const apps = await refreshAtumAppCatalog(accountId, true)
        if (!senderRemainsActive()) {
          result.error = 'The active assistant changed.'
        } else if ($atumAccountScopeId.get() !== accountId || $atumAppCatalog.get().accountId !== accountId) {
          result.error = 'The active account changed.'
        } else {
          result.apps = apps.filter(appSupportsDirect).map(app => ({
            id: app.app,
            name: app.name.en,
            description: app.subtitle ?? { vi: '', en: '' },
            availability: 'available'
          }))
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Unable to load Atum apps.'
      }
    }
    await requestGateway('atum.apps.list.respond', {
      request_id: requestId,
      result: JSON.stringify(result),
      ...(typeof payload.turn_id === 'string' ? { session_id: event.session_id, turn_id: payload.turn_id } : {})
    })
    return true
  }

  let result: { error?: string; switched: boolean } = { switched: false }

  if (!senderIsActive) {
    result.error = 'Only the active local assistant can switch conversations.'
  } else if (typeof appId !== 'string') {
    result.error = 'Unknown Atum app id.'
  } else {
    try {
      const accountId = $atumAccountScopeId.get()
      if (!accountId) {
        result.error = 'No active Atum account is available.'
      } else {
        const apps = await refreshAtumAppCatalog(accountId, true)
        const current = apps.find(app => app.app === appId.trim().toLowerCase())
        if (!senderRemainsActive()) {
          result.error = 'The active assistant changed.'
        } else if ($atumAccountScopeId.get() !== accountId || $atumAppCatalog.get().accountId !== accountId) {
          result.error = 'The active account changed.'
        } else if (!appSupportsDirect(current)) {
          result.error = 'This Atum app is not available.'
        } else {
          const conversationId = await ensureAtumSpecialistConversation(appId)
          // The sender, account and main-backed catalog all have to remain the
          // same through the conversation authority before navigation spends
          // the foreground.
          if (!senderRemainsActive()) {
            result.error = 'The active assistant changed.'
          } else if ($atumAccountScopeId.get() !== accountId || $atumAppCatalog.get().accountId !== accountId) {
            result.error = 'The active account changed.'
          } else {
            window.history.pushState(null, '', `/dm/${conversationId}`)
            window.dispatchEvent(new PopStateEvent('popstate'))
            result = { switched: true }
          }
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unable to switch conversations.'
    }
  }

  await requestGateway('atum.apps.open.respond', {
    request_id: requestId,
    ...(typeof payload.turn_id === 'string' ? { session_id: event.session_id, turn_id: payload.turn_id } : {}),
    result: JSON.stringify(result)
  })

  return true
}
