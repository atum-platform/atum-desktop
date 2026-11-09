import { appBotDisclosureVersion, type AppDescriptor } from '../../../shared/app-catalog'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Intake is account-authorized by a fresh main-process status read, never by
 * renderer state or a catalog descriptor that may predate consent/linking. */
export function appBotIntakeAuthorized(value: unknown, disclosureVersion: number): boolean {
  const status = record(value)
  const consent = record(status?.consent)
  const link = record(status?.link)

  return (
    status?.profile === 'atum.app-bot-status/1' &&
    consent?.state === 'accepted' &&
    consent.disclosure_version === disclosureVersion &&
    link?.state === 'linked' &&
    link.ready === true &&
    link.available === true
  )
}

/** A link confirmed with no tap only carries a consent the person already gave (2026-10-10
 * security consult §10g). It stands only on a fresh main-process status read: consent
 * accepted to the disclosure this Atum shows. Never renderer state, and never the catalog,
 * which main does not refresh after a consent and which another device can make stale. */
export function appBotConsentStands(value: unknown, disclosureVersion: number): boolean {
  const status = record(value)
  const consent = record(status?.consent)

  return (
    status?.profile === 'atum.app-bot-status/1' &&
    consent?.state === 'accepted' &&
    consent.disclosure_version === disclosureVersion
  )
}

/** Signed catalog state required before main may ask the human SDK to address
 * an official bot. Room membership is rechecked by that SDK at send time. A guest
 * turn also needs a fresh `ready` status: the catalog alone never proves it. */
export function appBotSendConfigured(descriptor: AppDescriptor, guestReady = false): boolean {
  const bot = descriptor.bot

  if (
    !bot ||
    bot.state !== 'active' ||
    !bot.device ||
    bot.consent !== 'accepted' ||
    bot.disclosure_version !== appBotDisclosureVersion(descriptor)
  ) {
    return false
  }

  if (descriptor.link.state === 'linked') {
    return true
  }

  return Boolean(bot.guest_enabled && bot.direct_profile === 'atum.turn-memory/2' && guestReady)
}

/** Group support is signed catalog policy. A bot without it may be addressed
 * only in the canonical DM that the human SDK has independently validated. A
 * guest turn is direct-only, never a group grant. */
export function appBotSendAuthorized(descriptor: AppDescriptor, officialDm: boolean, guestReady = false): boolean {
  if (!appBotSendConfigured(descriptor, guestReady)) {
    return false
  }

  // Guest authority is a direct-chat capability. Even an inconsistent signed
  // catalog that advertises groups must not bypass the independently verified DM.
  return descriptor.link.state === 'linked'
    ? Boolean(descriptor.bot?.groups || officialDm)
    : officialDm
}

/** Whether main pins the bot's device before sharing a room with it: an encrypted room shares
 * its room keys with that device. A room without encryption (every chat 0.20 makes) shares none;
 * a room this Mac does not know yet keeps the pin. */
export function appBotPinRequired(room: { encrypted?: boolean } | undefined): boolean {
  return room?.encrypted !== false
}
