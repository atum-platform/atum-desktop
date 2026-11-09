import { atom } from 'nanostores'

import type {
  ManagedModelAccessAlias,
  ManagedModelAccessSnapshot,
  ManagedModelUsageSnapshot
} from '@/lib/atum-managed-model-access'

export type ManagedModelAccessView =
  | { state: 'idle' }
  | { state: 'loading'; accessAlias: ManagedModelAccessAlias }
  | {
      state: 'resolved'
      accessAlias: ManagedModelAccessAlias
      access: ManagedModelAccessSnapshot
      /** Display freshness only; this snapshot never authorizes a task or a charge. */
      freshness?: { checkedAt: number | null; attemptedAt: number; consecutiveFailures: number }
    }

export const $managedModelAccess = atom<ManagedModelAccessView>({ state: 'idle' })

export function managedModelAccessAliasForView(view: ManagedModelAccessView): ManagedModelAccessAlias {
  return view.state === 'idle' ? 'binh-minh' : view.accessAlias
}

let generation = 0
let inFlight: { accessAlias: ManagedModelAccessAlias; request: Promise<void> } | null = null
let pollingConsumers = 0
let stopPolling: (() => void) | null = null

const REFRESH_MS = 60_000

export function resetManagedModelAccess(): void {
  generation += 1
  usageGeneration += 1
  inFlight = null
  usageInFlight = null
  $managedModelAccess.set({ state: 'idle' })
  $managedModelUsage.set({ state: 'idle' })
}

export type ManagedModelUsageView =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'resolved'; usage: ManagedModelUsageSnapshot }

/** Recent managed turns for the account surface. Loaded on demand, not polled. */
export const $managedModelUsage = atom<ManagedModelUsageView>({ state: 'idle' })

let usageGeneration = 0
let usageInFlight: Promise<void> | null = null

/** Every consumer reads the same page so the list length never depends on who refreshed last. */
export const MANAGED_MODEL_USAGE_LIMIT = 10

export function refreshManagedModelUsage(): Promise<void> {
  if (usageInFlight) {
    return usageInFlight
  }

  const requestGeneration = ++usageGeneration

  if ($managedModelUsage.get().state === 'idle') {
    $managedModelUsage.set({ state: 'loading' })
  }

  const request = (
    window.hermesDesktop?.managedModel?.usage?.(MANAGED_MODEL_USAGE_LIMIT) ??
    Promise.resolve({ state: 'unavailable' as const })
  )
    .then(usage => {
      if (requestGeneration === usageGeneration) {
        $managedModelUsage.set({ state: 'resolved', usage })
      }
    })
    .catch(() => {
      if (requestGeneration === usageGeneration) {
        $managedModelUsage.set({ state: 'resolved', usage: { state: 'unavailable' } })
      }
    })
    .finally(() => {
      if (usageInFlight === request) {
        usageInFlight = null
      }
    })

  usageInFlight = request

  return request
}

export function refreshManagedModelAccess(accessAlias: ManagedModelAccessAlias = 'binh-minh'): Promise<void> {
  if (inFlight?.accessAlias === accessAlias) {
    return inFlight.request
  }

  const requestGeneration = ++generation

  // Keep the last display during failed background reads. A known auth or
  // eligibility response replaces it immediately; only transport failures are stale.
  const current = $managedModelAccess.get()

  if (current.state === 'idle' || current.accessAlias !== accessAlias) {
    $managedModelAccess.set({ state: 'loading', accessAlias })
  }

  const publish = (access: ManagedModelAccessSnapshot) => {
    if (requestGeneration !== generation) { return }
    const previous = $managedModelAccess.get()
    const sameView = previous.state === 'resolved' && previous.accessAlias === accessAlias ? previous : null
    const failed = access.state === 'unavailable'
    $managedModelAccess.set({
      state: 'resolved', accessAlias,
      access: failed && sameView ? sameView.access : access,
      freshness: {
        checkedAt: failed ? (sameView?.freshness?.checkedAt ?? null) : Date.now(),
        attemptedAt: Date.now(),
        consecutiveFailures: failed ? (sameView?.freshness?.consecutiveFailures ?? 0) + 1 : 0
      }
    })
  }

  const read = async () => window.hermesDesktop?.managedModel?.access(accessAlias) ?? { state: 'unavailable' as const }

  const request = read().then(publish)
    .catch(() => publish({ state: 'unavailable' }))
    .finally(() => {
      if (inFlight?.request === request) {
        inFlight = null
      }
    })

  inFlight = { accessAlias, request }

  return request
}

export function retainManagedModelAccessPolling(accessAlias: ManagedModelAccessAlias = 'binh-minh'): () => void {
  pollingConsumers += 1

  if (pollingConsumers === 1) {
    void refreshManagedModelAccess(accessAlias)
    const timer = window.setInterval(() => void refreshManagedModelAccess(accessAlias), REFRESH_MS)
    const onFocus = () => void refreshManagedModelAccess(accessAlias)

    window.addEventListener('focus', onFocus)

    stopPolling = () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }

  let retained = true

  return () => {
    if (!retained) {
      return
    }

    retained = false
    pollingConsumers = Math.max(0, pollingConsumers - 1)

    if (pollingConsumers === 0) {
      stopPolling?.()
      stopPolling = null
      resetManagedModelAccess()
    }
  }
}
