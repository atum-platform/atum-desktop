import { atom } from 'nanostores'

import { $atumAccountScopeId } from '@/store/atum-messaging'
import { refreshProfiles } from '@/store/profile'

import type { AtumAgentSyncStatus } from '../../../shared/atum-agent-content'

import { refreshAtumAssistantDirectory } from './assistant-directory'

export const $atumAgentSync = atom<AtumAgentSyncStatus[]>([])

export async function refreshAgentSync(): Promise<void> {
  const account = $atumAccountScopeId.get()
  const rows = (await window.hermesDesktop?.agentSync?.status()) ?? []

  if ($atumAccountScopeId.get() === account) {$atumAgentSync.set(rows)}
}

/** One shell subscription, without switching the active profile or chat. */
export function observeAgentSync(): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (disposed) {return}
      void refreshAgentSync().catch(() => undefined)
      void refreshProfiles().catch(() => undefined)
      void refreshAtumAssistantDirectory().catch(() => undefined)
    }, 500)
  }

  const unsubscribe = window.hermesDesktop?.agentSync?.onChanged(refresh)

  const unsubscribeAccount = $atumAccountScopeId.subscribe(() => {
    $atumAgentSync.set([])
    refresh()
  })

  return () => {
    disposed = true
    clearTimeout(timer)
    unsubscribe?.()
    unsubscribeAccount()
  }
}
