import type { AppBotDescriptor } from './app-catalog'

export type AppBotGuestState = 'unsupported' | 'start_required' | 'ready' | 'linked' | 'unavailable'

export interface AppBotStatus {
  profile: 'atum.app-bot-status/1'
  consent: { state: 'accepted' | 'required' | 'revoked'; disclosure_version: number }
  link: { state: 'linked' | 'never_linked' | 'unlinked'; ready: boolean; available: boolean }
  /** Additive guest projection; absent on older platforms and for linked-only bots. */
  guest?: { enabled: boolean; state: AppBotGuestState }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Strict reading of the platform status. Unknown shape is no status, never a guessed ready. */
export function parseAppBotStatus(value: unknown): AppBotStatus | null {
  const raw = record(value)
  const consent = record(raw?.consent)
  const link = record(raw?.link)
  const guestValue = raw?.guest
  const guest = guestValue === undefined ? undefined : record(guestValue)

  if (
    raw?.profile !== 'atum.app-bot-status/1' ||
    (consent?.state !== 'accepted' && consent?.state !== 'required' && consent?.state !== 'revoked') ||
    !Number.isSafeInteger(consent.disclosure_version) || (consent.disclosure_version as number) < 1 ||
    (link?.state !== 'linked' && link?.state !== 'never_linked' && link?.state !== 'unlinked') ||
    typeof link.ready !== 'boolean' ||
    typeof link.available !== 'boolean' ||
    (guestValue !== undefined && guest === null)
  ) {
    return null
  }

  if (guest === null) {
    return null
  }

  if (
    guest !== undefined &&
    (typeof guest.enabled !== 'boolean' ||
      (guest.state !== 'unsupported' &&
        guest.state !== 'start_required' &&
        guest.state !== 'ready' &&
        guest.state !== 'linked' &&
        guest.state !== 'unavailable') ||
      guest.enabled === (guest.state === 'unsupported'))
  ) {
    return null
  }

  if (
    guest?.state === 'linked' &&
    (link.state !== 'linked' || link.ready !== true || link.available !== true)
  ) {
    return null
  }

  if (
    guest?.enabled === true &&
    link.state === 'linked' &&
    guest.state !== 'linked' &&
    guest.state !== 'unavailable'
  ) {
    return null
  }

  return {
    profile: 'atum.app-bot-status/1',
    consent: { state: consent.state as AppBotStatus['consent']['state'], disclosure_version: consent.disclosure_version as number },
    link: { state: link.state as AppBotStatus['link']['state'], ready: link.ready, available: link.available },
    ...(guest
      ? { guest: { enabled: guest.enabled as boolean, state: guest.state as AppBotGuestState } }
      : {})
  }
}

/** The guest state this client can trust. Guest-disabled bots are always unsupported, and a
 * guest-enabled bot with no guest projection (an older platform) is honestly unavailable. */
export function appBotGuestState(bot: AppBotDescriptor | null | undefined, status: AppBotStatus | null): AppBotGuestState {
  if (!bot?.guest_enabled) {
    return 'unsupported'
  }

  return status?.guest?.enabled === true ? status.guest.state : 'unavailable'
}

/** A send in guest mode stands only on current consent and a fresh `ready` status. */
export function appBotGuestReady(status: AppBotStatus | null, disclosureVersion: number): boolean {
  return Boolean(
    status?.guest?.enabled === true &&
    status.guest.state === 'ready' &&
    status.consent.state === 'accepted' &&
    status.consent.disclosure_version === disclosureVersion &&
    status.link.state !== 'linked'
  )
}
