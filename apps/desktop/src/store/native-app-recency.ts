import { Codecs, persistentAtom } from '@/lib/persisted'

/** Account-scoped presentation history on this machine, never sent to Hermes. */
interface NativeAppRecency {
  [accountId: string]: Record<string, number>
}

function sanitize(value: unknown): NativeAppRecency {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return {}}

  return Object.fromEntries(Object.entries(value).flatMap(([account, apps]) => {
    if (!apps || typeof apps !== 'object' || Array.isArray(apps)) {return []}

    return [[account, Object.fromEntries(Object.entries(apps).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
    ))]]
  }))
}

export const $nativeAppRecency = persistentAtom<NativeAppRecency>(
  'hermes.desktop.atum.nativeApps.lastUsedByAccount.v1', {}, Codecs.json(sanitize)
)

/** Call only after an accepted native open; a chooser or click is not usage. */
export function recordNativeAppUse(appKey: string, accountId: string | undefined): void {
  if (!accountId || !appKey) {return}
  const history = $nativeAppRecency.get()
  const previous = history[accountId] ?? {}
  // Preserve the order of back-to-back launches even within one clock tick.
  const lastUsed = Math.max(Date.now(), ...Object.values(previous).map(time => time + 1))

  $nativeAppRecency.set({ ...history, [accountId]: { ...previous, [appKey]: lastUsed } })
}
