import type { MatrixRoom } from '../../../shared/matrix'

/** What the switcher needs of a company; the directory's rows carry more. */
export interface SwitcherCompany {
  id: string
  displayName: string
}

/** Companies one to nine have a shortcut (⌘⌥1…⌘⌥9). */
export const COMPANY_SHORTCUT_SLOTS = 9

/**
 * Every switcher surface (the rail, the company menu, the shortcuts) lists companies in this one order:
 * by name, then id so a tie never reorders. "Company 2" is therefore the same tile everywhere.
 */
export function orderCompanies<T extends SwitcherCompany>(companies: readonly T[], locale: string): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })

  return [...companies].sort(
    (left, right) => collator.compare(left.displayName, right.displayName) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

/**
 * The two letters on a company's tile: the first letters of its first two words, or the first two letters of
 * a single word. Counted in whole characters, so an accent or an emoji is never cut in half.
 */
export function companyInitials(displayName: string, locale: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean)
  const letters = (word: string) => [...word]

  const initials =
    words.length >= 2 ? [letters(words[0]!)[0], letters(words[1]!)[0]] : letters(words[0] ?? '').slice(0, 2)

  const text = initials.filter(Boolean).join('')

  return text ? text.toLocaleUpperCase(locale) : '?'
}

/** Company `slot` (1-based) in the shown order, if there is one. */
export function companyAtSlot<T extends SwitcherCompany>(ordered: readonly T[], slot: number): T | undefined {
  return slot >= 1 && slot <= COMPANY_SHORTCUT_SLOTS ? ordered[slot - 1] : undefined
}

/**
 * The company one step before or after `currentId`, wrapping round. With none selected a step forward is the
 * first and a step back the last; with nowhere else to go there is no answer.
 */
export function steppedCompany<T extends SwitcherCompany>(
  ordered: readonly T[],
  currentId: string | undefined,
  step: 1 | -1
): T | undefined {
  if (ordered.length === 0 || (ordered.length === 1 && ordered[0]!.id === currentId)) {
    return undefined
  }

  const index = ordered.findIndex(company => company.id === currentId)

  if (index < 0) {
    return step === 1 ? ordered[0] : ordered[ordered.length - 1]
  }

  return ordered[(index + step + ordered.length) % ordered.length]
}

/** The newest activity in each company, from the channel rooms this window holds. */
export function companyActivity(rooms: readonly MatrixRoom[]): ReadonlyMap<string, number> {
  const newest = new Map<string, number>()

  for (const room of rooms) {
    const companyId = room.companyChannel?.companyId

    if (room.membership === 'join' && companyId && (room.lastActiveAt ?? 0) > (newest.get(companyId) ?? 0)) {
      newest.set(companyId, room.lastActiveAt!)
    }
  }

  return newest
}

export interface InitialCompanyChoice {
  /** The company this device last had open for this account. */
  lastUsedId?: string | undefined
  /** Newest activity per company. */
  activity: ReadonlyMap<string, number>
  /** Companies that must not be picked, such as one the person has just left. */
  excluded?: ReadonlySet<string>
}

/**
 * Which company opens when nothing names one: the one last used (by id) if it is still there, else the one with
 * the newest activity, else the first. A remembered company that was left or removed is simply not found.
 */
export function initialCompany<T extends SwitcherCompany>(
  ordered: readonly T[],
  { activity, excluded, lastUsedId }: InitialCompanyChoice
): T | undefined {
  const candidates = ordered.filter(company => !excluded?.has(company.id))
  const remembered = lastUsedId ? candidates.find(company => company.id === lastUsedId) : undefined

  if (remembered) {
    return remembered
  }

  let newest: T | undefined

  for (const company of candidates) {
    if ((activity.get(company.id) ?? 0) > (newest ? (activity.get(newest.id) ?? 0) : 0)) {
      newest = company
    }
  }

  return newest ?? candidates[0]
}

const lastCompanyKey = (accountKey: string) => `atum.team-space.last-company:${accountKey}`

const lastChannelKey = (accountKey: string, companyId: string) =>
  `atum.team-space.last-channel:${accountKey}:${companyId}`

/** The company last open on this device for this account; device-local, like the sidebar's width. */
export function readLastCompanyId(accountKey: string): string | undefined {
  try {
    return window.localStorage.getItem(lastCompanyKey(accountKey)) || undefined
  } catch {
    return undefined
  }
}

export function writeLastCompanyId(accountKey: string, companyId: string): void {
  try {
    window.localStorage.setItem(lastCompanyKey(accountKey), companyId)
  } catch {
    // Remembering is a convenience; the window works without it.
  }
}

/** The last company channel this device showed for this account and company. */
export function readLastChannelId(accountKey: string, companyId: string): string | undefined {
  try {
    return window.localStorage.getItem(lastChannelKey(accountKey, companyId)) || undefined
  } catch {
    return undefined
  }
}

export function writeLastChannelId(accountKey: string, companyId: string, channelId: string): void {
  try {
    window.localStorage.setItem(lastChannelKey(accountKey, companyId), channelId)
  } catch {
    // Remembering is a convenience; #general remains the authoritative fallback.
  }
}
