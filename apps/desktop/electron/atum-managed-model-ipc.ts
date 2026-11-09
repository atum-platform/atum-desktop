import {
  type ManagedModelAccessAlias,
  type ManagedModelAccessSnapshot,
  type ManagedModelUsageSnapshot,
  parseManagedModelAccessAlias
} from '../src/lib/atum-managed-model-access'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, argument?: unknown) => unknown): void
  removeHandler?(channel: string): void
}

interface ManagedModelAccessSource {
  accessState(accessAlias: ManagedModelAccessAlias): Promise<ManagedModelAccessSnapshot>
  usageHistory?(limit: number): Promise<ManagedModelUsageSnapshot>
}

export const ATUM_MANAGED_MODEL_ACCESS_CHANNEL = 'atum:managed-model:access'
export const ATUM_MANAGED_MODEL_USAGE_CHANNEL = 'atum:managed-model:usage'

const DEFAULT_USAGE_LIMIT = 20
const MAX_USAGE_LIMIT = 50

export function registerAtumManagedModelIpc(ipc: IpcMainLike, source: ManagedModelAccessSource | null): () => void {
  ipc.handle(ATUM_MANAGED_MODEL_ACCESS_CHANNEL, async (_event, requestedAlias) => {
    const accessAlias = parseManagedModelAccessAlias(requestedAlias)

    if (!source || !accessAlias) {
      return { state: 'unavailable' }
    }

    const snapshot = await source.accessState(accessAlias)

    return 'access_alias' in snapshot && snapshot.access_alias !== accessAlias ? { state: 'unavailable' } : snapshot
  })

  // Read-only: the renderer receives the caller's own recent turns, already
  // projected by the hosted route. No account authority or token crosses here.
  ipc.handle(ATUM_MANAGED_MODEL_USAGE_CHANNEL, async (_event, requestedLimit) => {
    if (!source?.usageHistory) {
      return { state: 'unavailable' }
    }

    const limit =
      typeof requestedLimit === 'number' && Number.isSafeInteger(requestedLimit)
        ? Math.min(MAX_USAGE_LIMIT, Math.max(1, requestedLimit))
        : DEFAULT_USAGE_LIMIT

    return source.usageHistory(limit)
  })

  return () => {
    ipc.removeHandler?.(ATUM_MANAGED_MODEL_ACCESS_CHANNEL)
    ipc.removeHandler?.(ATUM_MANAGED_MODEL_USAGE_CHANNEL)
  }
}
