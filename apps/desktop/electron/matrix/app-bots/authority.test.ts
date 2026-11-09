import { expect, it } from 'vitest'

import {
  APP_BOT_DISCLOSURE_VERSION,
  APP_BOT_HISTORY_DISCLOSURE_VERSION,
  type AppDescriptor
} from '../../../shared/app-catalog'
import { appBotTurnRefusal } from '../../../shared/matrix-app-bot-failure'

import {
  appBotConsentStands,
  appBotIntakeAuthorized,
  appBotPinRequired,
  appBotSendAuthorized,
  appBotSendConfigured
} from './authority'

const descriptor = {
  app: 'moon',
  link: { mode: 'external_account', state: 'linked' },
  bot: {
    state: 'active',
    consent: 'accepted',
    disclosure_version: APP_BOT_DISCLOSURE_VERSION,
    device: { device_id: 'MOON_1' },
    groups: true
  }
} as AppDescriptor

it('authorizes intake only from a fresh accepted and ready account status', () => {
  const ready = {
    profile: 'atum.app-bot-status/1',
    consent: { state: 'accepted', disclosure_version: 1 },
    link: { state: 'linked', ready: true, available: true }
  }

  expect(appBotIntakeAuthorized(ready, 1)).toBe(true)
  expect(appBotIntakeAuthorized(ready, 2)).toBe(false)
  expect(appBotIntakeAuthorized({ ...ready, consent: { ...ready.consent, state: 'required' } }, 1)).toBe(false)
  expect(appBotIntakeAuthorized({ ...ready, link: { ...ready.link, state: 'unlinked' } }, 1)).toBe(false)
  expect(appBotIntakeAuthorized({ ...ready, link: { ...ready.link, ready: false } }, 1)).toBe(false)
  expect(appBotIntakeAuthorized({ ...ready, profile: 'unknown' }, 1)).toBe(false)
})

// A link confirmed with no tap carries only the consent the person gave to the disclosure this
// Atum shows; link state does not matter (the link is what is being made).
it('lets a link confirm by itself only on accepted consent to the disclosure this Atum shows', () => {
  const accepted = {
    profile: 'atum.app-bot-status/1',
    consent: { state: 'accepted', disclosure_version: APP_BOT_DISCLOSURE_VERSION },
    link: { state: 'never_linked', ready: false, available: true }
  }

  expect(appBotConsentStands(accepted, APP_BOT_DISCLOSURE_VERSION)).toBe(true)
  expect(appBotConsentStands({ ...accepted, consent: { ...accepted.consent, state: 'revoked' } }, APP_BOT_DISCLOSURE_VERSION)).toBe(false)
  expect(appBotConsentStands({ ...accepted, consent: { ...accepted.consent, state: 'required' } }, APP_BOT_DISCLOSURE_VERSION)).toBe(false)
  expect(
    appBotConsentStands(
      { ...accepted, consent: { ...accepted.consent, disclosure_version: APP_BOT_DISCLOSURE_VERSION + 1 } },
      APP_BOT_DISCLOSURE_VERSION
    )
  ).toBe(false)
  expect(appBotConsentStands({ ...accepted, profile: 'unknown' }, APP_BOT_DISCLOSURE_VERSION)).toBe(false)
  expect(appBotConsentStands(undefined, APP_BOT_DISCLOSURE_VERSION)).toBe(false)
})

it('requires signed active, consented, linked bot configuration before send', () => {
  expect(appBotSendConfigured(descriptor)).toBe(true)
  expect(appBotSendConfigured({ ...descriptor, link: { ...descriptor.link, state: 'unlinked' } })).toBe(false)
  expect(
    appBotSendConfigured({
      ...descriptor,
      bot: { ...descriptor.bot!, consent: 'required' }
    })
  ).toBe(false)
  expect(
    appBotSendConfigured({
      ...descriptor,
      bot: { ...descriptor.bot!, device: null }
    })
  ).toBe(false)
  expect(appBotSendConfigured({ ...descriptor, has_history: true })).toBe(false)
  expect(appBotSendConfigured({
    ...descriptor,
    has_history: true,
    bot: { ...descriptor.bot!, disclosure_version: APP_BOT_HISTORY_DISCLOSURE_VERSION }
  })).toBe(true)
})

it('allows a one-to-one-only bot only in its independently verified canonical DM', () => {
  const directOnly = { ...descriptor, bot: { ...descriptor.bot!, groups: false } }

  expect(appBotSendAuthorized(directOnly, false)).toBe(false)
  expect(appBotSendAuthorized(directOnly, true)).toBe(true)
  expect(appBotSendAuthorized(descriptor, false)).toBe(true)
})

it('permits a guest send only with the explicit v2 capability and a fresh ready status', () => {
  const guest = {
    ...descriptor,
    link: { mode: 'external_account', state: 'never_linked' },
    bot: {
      ...descriptor.bot!,
      guest_enabled: true,
      direct_profile: 'atum.turn-memory/2',
      groups: false
    }
  } as AppDescriptor

  expect(appBotSendConfigured(guest, false)).toBe(false)
  expect(appBotSendConfigured(guest, true)).toBe(true)
  expect(appBotSendAuthorized(guest, true, true)).toBe(true)
  expect(appBotSendAuthorized(guest, false, true)).toBe(false)
  expect(appBotTurnRefusal(guest, false, false)).toBe('matrix_app_bot_unavailable')
  expect(appBotTurnRefusal(guest, false, true)).toBeNull()
  // Guest authority never reaches a group, even for an app that advertises groups.
  expect(appBotTurnRefusal({ ...guest, bot: { ...guest.bot!, groups: true } }, true, true)).toBe(
    'matrix_app_bot_unavailable'
  )
  expect(appBotSendAuthorized({ ...guest, bot: { ...guest.bot!, groups: true } }, false, true)).toBe(false)
  // A missing guest capability or a v1 profile stays linked-only.
  expect(appBotSendConfigured({ ...guest, bot: { ...guest.bot!, guest_enabled: false, direct_profile: 'atum.turn-memory/1' } }, true)).toBe(false)
})

it('pins the bot only for an encrypted room or one this Mac does not know', () => {
  expect(appBotPinRequired({ encrypted: false })).toBe(false)
  expect(appBotPinRequired({ encrypted: true })).toBe(true)
  expect(appBotPinRequired(undefined)).toBe(true)
  expect(appBotPinRequired({})).toBe(true)
})
