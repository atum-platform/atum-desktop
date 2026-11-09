import { atom, computed, onMount } from 'nanostores'

import { $atumAccountStatus } from '@/store/atum-messaging'

import type { UtilityConnectInput, UtilityDisconnectInput, UtilityError, UtilitySourcePreference, UtilityStatus } from '../../../../shared/atum-utilities'

interface UtilityView {
  status: UtilityStatus | null
  loading: boolean
  busy: boolean
  operation?: 'connect' | 'disconnect' | 'setEnabled'
  error: UtilityError | null
}

export const $utilities = atom<UtilityView>({ status: null, loading: true, busy: false, error: null })
export const $workspaceProtected = computed($utilities, value => value.status?.workspaceProtected === true)
let requestId = 0
let accountKey = ''

function currentAccountKey(): string {
  const account = $atumAccountStatus.get()

  return account.account && ['signed_in', 'refreshing'].includes(account.state)
    ? `${account.account.id}:${account.current?.sessionGeneration ?? 0}` : ''
}

function reconcileAccount(): void {
  const key = currentAccountKey()

  if (key !== accountKey) {
    accountKey = key
    requestId++
    $utilities.set({ status: null, loading: Boolean(key), busy: false, error: null })
  }
}

async function request(action: 'status' | 'connect' | 'disconnect' | 'setEnabled', input?: UtilityConnectInput | UtilityDisconnectInput | UtilitySourcePreference[]): Promise<void> {
  reconcileAccount()

  if (!accountKey || (action === 'status' && $utilities.get().busy)) { return }
  const bridge = window.hermesDesktop?.utilities

  if (!bridge) {
    $utilities.set({ status: null, loading: false, busy: false, error: 'unavailable' })

    return
  }

  const owner = accountKey
  const id = ++requestId
  $utilities.set({ ...$utilities.get(), busy: action !== 'status', operation: action === 'status' ? undefined : action, error: null })

  try {
    const result = await (action === 'connect' ? bridge.connect(input as UtilityConnectInput) : action === 'disconnect' ? bridge.disconnect(input as UtilityDisconnectInput) : action === 'setEnabled' ? bridge.setEnabled(input as UtilitySourcePreference[]) : bridge.status())

    if (owner !== currentAccountKey() || id !== requestId) { return }
    const status = result.status?.accountId === $atumAccountStatus.get().account?.id ? result.status : null
    $utilities.set({ status, loading: false, busy: false, error: result.error ?? null })
  } catch {
    if (owner === currentAccountKey() && id === requestId) {
      $utilities.set({ ...$utilities.get(), loading: false, busy: false, error: 'network' })
    }
  }
}

export const refreshUtilities = (): Promise<void> => request('status')
export const connectUtility = (input: UtilityConnectInput): Promise<void> => request('connect', input)
export const disconnectUtility = (input: UtilityDisconnectInput): Promise<void> => request('disconnect', input)
export const setUtilityEnabled = (preferences: UtilitySourcePreference[]): Promise<void> => request('setEnabled', preferences)

export async function cancelUtilityConnection(): Promise<void> {
  const id = ++requestId
  const owner = currentAccountKey()
  let error: UtilityError | null = null

  try { await window.hermesDesktop?.utilities?.cancel() } catch { error = 'network' }

  if (owner === currentAccountKey() && id === requestId) {
    $utilities.set({ ...$utilities.get(), busy: false, error })
    void refreshUtilities()
  }
}

onMount($utilities, () => {
  const unlisten = $atumAccountStatus.listen(() => {
    const previous = accountKey
    reconcileAccount()

    if (accountKey !== previous) { void refreshUtilities() }
  })

  const refresh = () => { if (document.visibilityState === 'visible') { void refreshUtilities() } }
  void refreshUtilities()
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)

  return () => {
    unlisten()
    // nanostores unmounts on a timer, which can fire after a test environment is gone.
    if (typeof window === 'undefined') { return }
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
})
