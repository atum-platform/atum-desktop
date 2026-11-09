/**
 * A38, `spec/owner-time-zone/v1`: the native roster read may report this Mac's time zone, and
 * the platform acknowledges the value it stored.
 *
 * The rule below is the controller's `isIanaTimeZone`
 * (`packages/cloud-controller/src/controller/time-zone.ts`), copied because this app does not
 * depend on that package; the platform contract states the same pattern. One IANA name, never
 * a numeric offset, so daylight saving and future tzdata rules still apply.
 */
const IANA_TIME_ZONE = /^[A-Z][A-Za-z0-9_+-]{0,63}(\/[A-Z][A-Za-z0-9_+-]{0,63}){0,2}$/u

export const TIME_ZONE_REQUEST_HEADER = 'Atum-Time-Zone'
export const TIME_ZONE_ACK_HEADER = 'Atum-Time-Zone-Ack'

/**
 * The contract's lexical rule only, exactly like the phone: the platform validates the name against
 * its tz database and is the authority, so a legacy alias this Electron build's ICU happens not to
 * know is still reported (and both clients behave the same).
 */
export function isIanaTimeZone(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && IANA_TIME_ZONE.test(value)
}

/** The Mac's zone as ICU names it (never an offset); undefined when it is missing or not an IANA name. */
export function currentIanaTimeZone(): string | undefined {
  let zone: unknown

  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }

  return isIanaTimeZone(zone) ? zone : undefined
}

export interface OwnerTimeZoneScope {
  accountKey: string
  generation: number
}

export interface OwnerTimeZoneStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** What one roster read carries, and how its response settles against the read's own scope. */
export interface OwnerTimeZoneReport {
  headers: Record<string, string>
  settle(ack: string | null | undefined): void
}

const storageKey = (accountKey: string) => `matrix-owner-time-zone.${accountKey}`

/**
 * One acknowledged zone per signed-in account. The header goes out only when the Mac's zone
 * differs from that account's last acknowledged one (or none was ever acknowledged for it).
 * A zone is recorded only when the response echoes the zone sent AND belongs to the same
 * account and sign-in generation: a delayed response after a switch or sign-out is discarded.
 * Each account keeps its value across switches; only an explicit sign-out clears it. There is
 * no timer and no retry: the next roster read is the retry.
 */
export class OwnerTimeZoneReports {
  constructor(
    private readonly options: {
      store: OwnerTimeZoneStore
      scope(): OwnerTimeZoneScope | null
      zone(): string | undefined
    }
  ) {}

  begin(): OwnerTimeZoneReport | undefined {
    const scope = this.options.scope()
    const zone = this.options.zone()

    if (!scope || !isIanaTimeZone(zone) || this.lastAcked(scope.accountKey) === zone) {
      return undefined
    }

    return {
      headers: { [TIME_ZONE_REQUEST_HEADER]: zone },
      settle: ack => {
        // The ack echoes this caller's own value; anything else stored nothing to record.
        if (ack !== zone) {
          return
        }

        const live = this.options.scope()

        if (live?.accountKey !== scope.accountKey || live.generation !== scope.generation) {
          return
        }

        try {
          this.options.store.setItem(storageKey(scope.accountKey), zone)
        } catch {
          // The roster read stands; the next read reports again.
        }
      }
    }
  }

  /** The zone this account's platform acknowledged last, or undefined when it never did. It is
   * the owner's zone as far as this Mac knows: a new routine defaults to it (A38). */
  ownerZone(): string | undefined {
    const scope = this.options.scope()

    return scope ? this.lastAcked(scope.accountKey) : undefined
  }

  /** Sign-out or account removal: this account reports afresh when it signs in again. */
  clear(accountKey: string): void {
    try {
      this.options.store.removeItem(storageKey(accountKey))
    } catch {
      // Nothing else depends on it; a later read reports again.
    }
  }

  private lastAcked(accountKey: string): string | undefined {
    try {
      const value = this.options.store.getItem(storageKey(accountKey))

      return isIanaTimeZone(value) ? value : undefined
    } catch {
      return undefined
    }
  }
}
