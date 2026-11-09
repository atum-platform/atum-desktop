// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { atom } from 'nanostores'

import { captureAtumAssistantDirectoryScope, isAtumAssistantDirectoryScopeCurrent } from '@/app/atum/assistant-directory'
import { readKey, writeKey } from '@/lib/storage'

import { type AtumAgentHire, parseAgentHire } from '../../shared/atum-hiring'

import { $atumAccountScopeId } from './atum-messaging'
import { storeBridge } from './atum-store-catalog'

interface HiringView { accountId: string | null; state: 'idle' | 'loading' | 'ready' | 'error'; hires: AtumAgentHire[] }
export const $atumHiring = atom<HiringView>({ accountId: null, state: 'idle', hires: [] })
export interface HireIntent {
  accountId: string
  requestId: string
  profileId: string
  assistantId: string | null
  itemId: string
  offerId: string
  offerVersion: number
  priceProtons: number
  name: string
  avatar: string
  needsConsent?: boolean
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const key = (accountId: string) => `atum.desktop.hiringIntent.v1.${accountId}`
export const $atumHireIntent = atom<HireIntent | null>(null)

export function readHireIntent(accountId: string): HireIntent | null {
  try {
    const value = JSON.parse(readKey(key(accountId)) || 'null') as HireIntent | null

    if (!value || value.accountId !== accountId || ![value.requestId, value.offerId].every(id => UUID.test(id)) ||
      (value.assistantId !== null && !UUID.test(value.assistantId)) ||
      !/^employee-[a-f0-9-]{36}$/u.test(value.profileId) || typeof value.itemId !== 'string' ||
      !Number.isSafeInteger(value.offerVersion) || value.offerVersion < 1 ||
      !Number.isSafeInteger(value.priceProtons) || value.priceProtons < 0 ||
      (value.needsConsent !== undefined && typeof value.needsConsent !== 'boolean') ||
      typeof value.name !== 'string' || !value.name || value.name.length > 40 || typeof value.avatar !== 'string') { return null }

    return value
  } catch { return null }
}

/** Save the whole consented intent BEFORE creating an identity or charging.
 * Financial recovery requires durable storage, unlike ordinary UI preferences.
 */
export function saveHireIntent(intent: HireIntent): void {
  if ($atumAccountScopeId.get() !== intent.accountId) { throw new Error('hiring_account_changed') }
  const encoded = JSON.stringify(intent)
  writeKey(key(intent.accountId), encoded)

  if (readKey(key(intent.accountId)) !== encoded) { throw new Error('hiring_storage_unavailable') }
  $atumHireIntent.set(intent)
}

export function clearHireIntent(intent: HireIntent): void {
  if (readHireIntent(intent.accountId)?.requestId !== intent.requestId) { return }
  writeKey(key(intent.accountId), null)

  if (readKey(key(intent.accountId)) !== null) { throw new Error('hiring_storage_unavailable') }

  if ($atumAccountScopeId.get() === intent.accountId) { $atumHireIntent.set(null) }
}

let requestEpoch = 0
$atumAccountScopeId.listen(accountId => {
  requestEpoch += 1
  $atumHireIntent.set(accountId ? readHireIntent(accountId) : null)
  $atumHiring.set({ accountId, hires: [], state: 'idle' })

  if (accountId) { void refreshAtumHiring().catch(() => null) }
})

export async function refreshAtumHiring(): Promise<void> {
  const scope = captureAtumAssistantDirectoryScope()
  const epoch = ++requestEpoch

  if (!scope.accountId) { return }
  const current = $atumHiring.get()
  $atumHiring.set({ accountId: scope.accountId, hires: current.accountId === scope.accountId ? current.hires : [], state: 'loading' })

  try {
    const bridge = storeBridge()

    if (!bridge?.agentHires) { throw new Error('hiring_unavailable') }
    const hires = (await bridge.agentHires(scope.accountId)).map(parseAgentHire)

    if (!isAtumAssistantDirectoryScopeCurrent(scope) || epoch !== requestEpoch) { return }
    $atumHiring.set({ accountId: scope.accountId, hires, state: 'ready' })
    $atumHireIntent.set(readHireIntent(scope.accountId))
  } catch (error) {
    if (isAtumAssistantDirectoryScopeCurrent(scope) && epoch === requestEpoch) {
      $atumHiring.set({ ...$atumHiring.get(), state: 'error' })
    }

    throw error
  }
}

export async function cancelAtumHire(hireId: string): Promise<void> {
  const scope = captureAtumAssistantDirectoryScope()
  const bridge = storeBridge()

  if (!scope.accountId || !bridge?.cancelAgentHire) { throw new Error('hiring_unavailable') }
  const hire = parseAgentHire(await bridge.cancelAgentHire(hireId, scope.accountId))

  if (!isAtumAssistantDirectoryScopeCurrent(scope) || hire.id !== hireId) { throw new Error('hiring_account_changed') }
  requestEpoch += 1
  $atumHiring.set({ ...$atumHiring.get(), hires: $atumHiring.get().hires.map(row => row.id === hireId ? hire : row) })
}
