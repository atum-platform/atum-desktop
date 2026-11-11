/**
 * `atum.owner-language/1`: the native roster read may report the owner's language, so the words a
 * headless sender puts in a message body (the fallback every other Matrix client shows) follow the
 * owner. It is a projection of the setting this app already owns (Matrix account data
 * `io.atum.desktop.language`), never a second setting. Same shape as the time-zone report
 * (`time-zone.ts`): one acknowledged value per account, no timer, the next roster read is the retry.
 */
import { type DesktopLocale, isDesktopLocale } from '../../shared/desktop-locale'

import type { OwnerTimeZoneScope, OwnerTimeZoneStore } from './time-zone'

export const LANGUAGE_REQUEST_HEADER = 'Atum-Language'
export const LANGUAGE_SOURCE_HEADER = 'Atum-Language-Source'
export const LANGUAGE_ACK_HEADER = 'Atum-Language-Ack'

/** `explicit`: the language the owner saved. `reported`: the supported system language of an
 * account that never chose one (never sent while a choice is saved). */
export type OwnerLanguageSource = 'explicit' | 'reported'

export interface OwnerLanguage {
  value: DesktopLocale
  source: OwnerLanguageSource
}

export interface OwnerLanguageReport {
  headers: Record<string, string>
  settle(ack: string | null | undefined): void
}

const storageKey = (accountKey: string) => `matrix-owner-language.${accountKey}`
const recorded = (language: OwnerLanguage) => `${language.source}:${language.value}`

/**
 * The header pair goes out while this account's current language (its saved choice, else its
 * supported system language) is not the one the platform last acknowledged for it. A value is
 * recorded only when the ack echoes it, for the same account and sign-in generation; a delayed
 * response after a switch or sign-out is discarded. A `reported` value the platform answers with
 * another language (an earlier report or a choice made elsewhere won) is not recorded, but it is not
 * sent again in this sign-in either: the server keeps the first report, so repeating it changes
 * nothing. Sign-out clears the record, so the next sign-in reports once more.
 *
 * An ack is evidence of what the server stored then, not now: when the observed choice changes (here,
 * or on another device and arriving by sync) the record is dropped, so returning to a language
 * acknowledged earlier still reports the new choice, and an ack for a report begun before that change
 * records nothing.
 */
export class OwnerLanguageReports {
  private readonly answered = new Set<string>()
  private observed?: { accountKey: string; generation: number; value?: string }
  /** Bumped whenever the observed choice moves from one known value to another. */
  private changes = 0

  constructor(
    private readonly options: {
      store: OwnerTimeZoneStore
      scope(): OwnerTimeZoneScope | null
      /** Undefined while it is not yet known whether the account saved a choice. */
      language(): OwnerLanguage | undefined
    }
  ) {}

  begin(): OwnerLanguageReport | undefined {
    const scope = this.options.scope()
    const language = this.options.language()

    if (!scope || !language || !this.due(scope, language)) {
      return undefined
    }

    const changes = this.changes

    return {
      headers: { [LANGUAGE_REQUEST_HEADER]: language.value, [LANGUAGE_SOURCE_HEADER]: language.source },
      settle: ack => {
        const live = this.options.scope()
        const now = this.options.language()

        if (
          live?.accountKey !== scope.accountKey ||
          live.generation !== scope.generation ||
          !isDesktopLocale(ack) ||
          // The choice changed while this read was out: its ack says nothing about the new one.
          changes !== this.changes ||
          !now ||
          recorded(now) !== recorded(language)
        ) {
          return
        }

        if (ack !== language.value) {
          if (language.source === 'reported') {
            this.answered.add(`${scope.accountKey}:${scope.generation}:${recorded(language)}`)
          }

          return
        }

        try {
          this.options.store.setItem(storageKey(scope.accountKey), recorded(language))
        } catch {
          // The roster read stands; the next read reports again.
        }
      }
    }
  }

  /**
   * Called after each published snapshot: true when the account's language just became known or
   * changed and a roster read should carry it now (the caller requests that read; there is no timer
   * here). A move from one known value to another drops the account's ack record (see the class note).
   */
  observe(): boolean {
    const scope = this.options.scope()
    const language = this.options.language()

    const current = scope
      ? { accountKey: scope.accountKey, generation: scope.generation, ...(language ? { value: recorded(language) } : {}) }
      : undefined

    const previous = this.observed

    this.observed = current

    if (
      !current ||
      (previous?.accountKey === current.accountKey &&
        previous.generation === current.generation &&
        previous.value === current.value)
    ) {
      return false
    }

    if (previous?.accountKey === current.accountKey && previous.value && current.value && previous.value !== current.value) {
      this.changes += 1
      this.clear(current.accountKey)
    }

    return Boolean(scope && language && this.due(scope, language))
  }

  /** Sign-out or account removal: this account reports afresh when it signs in again. */
  clear(accountKey: string): void {
    try {
      this.options.store.removeItem(storageKey(accountKey))
    } catch {
      // Nothing else depends on it; a later read reports again.
    }
  }

  private due(scope: OwnerTimeZoneScope, language: OwnerLanguage): boolean {
    return (
      isDesktopLocale(language.value) &&
      (language.source === 'explicit' || language.source === 'reported') &&
      this.lastAcked(scope.accountKey) !== recorded(language) &&
      !this.answered.has(`${scope.accountKey}:${scope.generation}:${recorded(language)}`)
    )
  }

  private lastAcked(accountKey: string): string | undefined {
    try {
      return this.options.store.getItem(storageKey(accountKey)) ?? undefined
    } catch {
      return undefined
    }
  }
}

/**
 * The language to report: the saved choice when the account has one; with none confirmed after
 * sync, the first supported system language; nothing while that is still unknown, or when no
 * system language is one Atum speaks (the sender then keeps its documented default).
 */
export function ownerLanguageToReport(
  row: { value: unknown; chosen?: boolean } | undefined,
  systemLanguage: DesktopLocale | undefined
): OwnerLanguage | undefined {
  if (row?.chosen === true) {
    return isDesktopLocale(row.value) ? { value: row.value, source: 'explicit' } : undefined
  }

  return row?.chosen === false && systemLanguage ? { value: systemLanguage, source: 'reported' } : undefined
}

/**
 * A language that became known or changed is reported by one roster read now, through the same
 * request-and-sync path a wake uses (no timer, no second read: one already running coalesces).
 */
export function refreshMatrixRosterOnLanguageChange(
  changed: () => boolean,
  roster: { request(): void },
  sync: () => void
): void {
  if (changed()) {
    roster.request()
    sync()
  }
}
