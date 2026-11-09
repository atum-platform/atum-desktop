import type {
  MatrixStoreEntitlement,
  MatrixStoreGrantSource,
  MatrixStoreItem,
  MatrixStoreOwnership
} from '../../../shared/matrix-store'

const priority: Record<MatrixStoreGrantSource, number> = { purchase: 4, gift: 3, compensation: 2, promo: 1 }

/** Compatibility with an older Shell: derive ownership only from active, correctly scoped grants. */
export function legacyStoreOwnership(
  item: MatrixStoreItem,
  entitlements: MatrixStoreEntitlement[]
): MatrixStoreOwnership {
  const active = entitlements.filter(
    row =>
      row.itemId === item.itemId &&
      row.kind === item.kind &&
      row.state === 'active' &&
      (item.kind === 'pet'
        ? row.assistantId === null && row.subscription === null
        : Boolean(row.assistantId) &&
          (item.kind === 'agent'
            ? row.subscription?.state === 'active' || row.subscription?.state === 'cancelled'
            : row.subscription === null))
  )

  if (!active.length) {
    return { state: 'available', source: null, assistantIds: [], until: null }
  }

  const source = active.reduce<MatrixStoreGrantSource>((best, row) => {
    const next = row.source ?? 'purchase'

    return priority[next] > priority[best] ? next : best
  }, 'promo')

  return {
    state: 'owned',
    source,
    assistantIds: [...new Set(active.flatMap(row => (row.assistantId ? [row.assistantId] : [])))].sort(),
    until: null
  }
}

/** A validated server projection wins over the entitlement cache, including available/visiting. */
export function itemStoreOwnership(
  item: MatrixStoreItem,
  entitlements: MatrixStoreEntitlement[]
): MatrixStoreOwnership {
  return item.ownership ?? legacyStoreOwnership(item, entitlements)
}

export function itemOwnedForAssistant(
  item: MatrixStoreItem,
  entitlements: MatrixStoreEntitlement[],
  assistantId?: string
) {
  const ownership = itemStoreOwnership(item, entitlements)

  return (
    ownership.state === 'owned' &&
    (item.kind === 'pet' || Boolean(assistantId && ownership.assistantIds.includes(assistantId)))
  )
}
