import { describe, expect, it } from 'vitest'

import {
  appBotStatusLogLine,
  appCatalogLogLine,
  appCatalogPartialLogLine,
  appLinkLogLine,
  appMenuFailedLogLine,
  appReadFailureCode
} from './app-link-log'

describe('app link log lines', () => {
  it('names the app by its published slug and never echoes anything else', () => {
    expect(appLinkLogLine({ app: 'moon', step: 'request', action: 'begin', outcome: 'refused_busy' })).toBe(
      '[Matrix] app link app=moon step=request action=begin outcome=refused_busy'
    )
    expect(appLinkLogLine({ app: 'Not A Slug/../x', step: 'begin', outcome: 'opened' })).toBe(
      '[Matrix] app link app=unknown step=begin outcome=opened'
    )
    expect(appLinkLogLine({ app: 'andy', step: 'request', action: 'https://x', outcome: 'failed' })).toBe(
      '[Matrix] app link app=andy step=request outcome=failed'
    )
  })

  it('projects the bot status the setup card opened on, with unknown values closed', () => {
    expect(
      appBotStatusLogLine('moon', {
        profile: 'atum.app-bot-status/1',
        consent: { state: 'accepted', disclosure_version: 1 },
        link: { state: 'never_linked', ready: false, available: true }
      })
    ).toBe('[Matrix] app bot status app=moon consent=accepted link=never_linked ready=0 available=1')
    expect(appBotStatusLogLine('moon', { consent: { state: 'someone@example.com' }, link: null })).toBe(
      '[Matrix] app bot status app=moon consent=invalid link=invalid ready=0 available=0'
    )
    expect(appBotStatusLogLine('andy', undefined)).toBe('[Matrix] app bot status app=andy outcome=failed')
  })

  it('says whether the app catalog was read, with counts and a closed reason, never ids or raw text', () => {
    expect(
      appCatalogLogLine({
        ok: true,
        apps: [{ bot: {}, link: { state: 'linked' } }, { bot: {}, link: { state: 'never_linked' } }, { bot: null }]
      })
    ).toBe('[Matrix] apps catalog outcome=ready apps=3 bots=2 linked=1')

    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

    expect(appCatalogLogLine({ ok: false, error: timeout, retryInMs: 5_000 })).toBe(
      '[Matrix] apps catalog outcome=failed code=timeout retry=5'
    )
    expect(appCatalogLogLine({ ok: false, error: new Error('GET https://x/y failed for a@b.c'), retryInMs: null })).toBe(
      '[Matrix] apps catalog outcome=failed code=failed retry=none'
    )
  })

  it('names the apps a catalog held by slug, so a missing roster row is traceable from the log alone', () => {
    expect(
      appCatalogLogLine({
        ok: true,
        apps: [
          { app: 'moon', bot: { state: 'active' }, link: { state: 'linked' } },
          { app: 'andy', bot: {} },
          { app: 'demoza', bot: { state: 'unavailable' } },
          { app: 'vneid', bot: null },
          // Nothing but a well-formed slug and a known state is written: no free text, no ids.
          { app: 'acme', bot: { state: 'someone@example.com' } },
          { app: 'Someone <someone@example.com>', bot: null },
          { app: 7, bot: null }
        ]
      })
    ).toBe(
      '[Matrix] apps catalog outcome=ready apps=7 bots=4 linked=1 slugs=moon:active,andy,demoza:unavailable,vneid,acme'
    )
  })

  it('names, by slug only, the apps a look’s answer left out and the window kept', () => {
    expect(appCatalogPartialLogLine([{ app: 'demoza' }, { app: 'moon' }])).toBe(
      '[Matrix] apps catalog outcome=partial kept=demoza,moon'
    )
    expect(appCatalogPartialLogLine([{ app: 'Someone <someone@example.com>' }, { app: 7 }, { app: 'andy' }])).toBe(
      '[Matrix] apps catalog outcome=partial kept=andy'
    )
  })

  it('reduces any failure to a closed code', () => {
    expect(appReadFailureCode(Object.assign(new Error('x'), { code: 'temporarily_unavailable' }))).toBe(
      'temporarily_unavailable'
    )
    expect(appReadFailureCode(new Error('matrix_app_unavailable'))).toBe('matrix_app_unavailable')
    expect(appReadFailureCode(new Error('app_catalog_invalid'))).toBe('app_catalog_invalid')
    expect(appReadFailureCode('boom')).toBe('failed')
    expect(appReadFailureCode(new Error('Some free text with spaces'))).toBe('failed')
    // A lowercase word is not a code: only the known reasons survive.
    expect(appReadFailureCode(new Error('offline'))).toBe('failed')
    expect(appReadFailureCode(Object.assign(new Error('x'), { code: 'internal' }))).toBe('failed')
    expect(appMenuFailedLogLine('moon', new Error('app_unavailable'))).toBe(
      '[Matrix] apps menu app=moon outcome=failed code=app_unavailable'
    )
    expect(appMenuFailedLogLine('', new Error('x'))).toBe('[Matrix] apps menu app=unknown outcome=failed code=failed')
  })
})
