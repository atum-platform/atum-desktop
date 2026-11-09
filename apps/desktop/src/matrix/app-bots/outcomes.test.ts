import { describe, expect, it } from 'vitest'

import {
  APP_BOT_OUTCOME_DELAYS,
  appBotOutcomeText,
  appBotOutcomeUnreadableLine,
  parseAppBotOutcome,
  pollAppBotOutcome
} from './outcomes'

const linked = (app: string) => ({ app, guest: false })
const guest = (app: string) => ({ app, guest: true })

function outcome(code: string, action: Record<string, unknown>) {
  return {
    profile: 'atum.app-bot-outcome/1',
    state: 'notice',
    code,
    action,
    locale: 'en'
  }
}

it('keeps private outcome polling bounded and stops on a terminal private result', async () => {
  let attempts = 0
  const seen: string[] = []
  const result = await pollAppBotOutcome(
    async () => ({ profile: 'atum.app-bot-outcome/1' as const, state: ++attempts === 2 ? 'notice' as const : 'pending' as const, code: null, action: null, locale: 'en' }),
    async () => {},
    value => seen.push(value.state)
  )
  expect(result.state).toBe('notice')
  expect(seen).toEqual(['pending', 'notice'])
  expect(APP_BOT_OUTCOME_DELAYS.reduce((total, delay) => total + delay, 0)).toBe(130_000)
})

it('polls at the contract elapsed times and returns no_turn after 130 seconds', async () => {
  let elapsed = 0
  const polls: number[] = []
  const result = await pollAppBotOutcome(
    async () => { polls.push(elapsed); return { profile: 'atum.app-bot-outcome/1', state: 'none', code: null, action: null, locale: 'en' } },
    async delay => { elapsed += delay },
    () => {},
    () => elapsed
  )
  expect(polls).toEqual([2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 130_000])
  expect(result).toMatchObject({ state: 'notice', code: 'no_turn' })
})

it('keeps later polls on schedule when an earlier read takes time', async () => {
  let elapsed = 0
  const polls: number[] = []
  await pollAppBotOutcome(
    async () => { polls.push(elapsed); elapsed += 700; return { profile: 'atum.app-bot-outcome/1', state: 'none', code: null, action: null, locale: 'en' } },
    async delay => { elapsed += delay },
    () => {},
    () => elapsed
  )
  expect(polls).toEqual([2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 130_000])
})

it('accepts only the platform profile and action shape', () => {
  expect(parseAppBotOutcome({
    profile: 'atum.app-bot-outcome/1', state: 'undeliverable', code: 'undeliverable', locale: 'vi',
    action: { kind: 'open_bot_dm', app: 'moon' }
  }, linked('moon'))).toMatchObject({ state: 'undeliverable', action: { app: 'moon' } })
  expect(() => parseAppBotOutcome({ state: 'answered', code: null, action: null, locale: 'en' }, linked('moon'))).toThrow('app_bot_outcome_invalid')
})

describe('Demoza guest outcome contract', () => {
  it('maps the guest limit to Connect without treating quota outage as a login problem', () => {
    expect(parseAppBotOutcome(outcome('guest_limit_reached', { kind: 'connect_account', app: 'demoza' }), guest('demoza')).action)
      .toEqual({ kind: 'connect_account', app: 'demoza' })
    expect(parseAppBotOutcome(outcome('quota_unavailable', { kind: 'retry_later' }), guest('demoza')).action)
      .toEqual({ kind: 'retry_later' })

    expect(appBotOutcomeText('en', 'guest_limit_reached', 'demoza')).toMatch(/Connect your Demoza account/i)
    expect(appBotOutcomeText('en', 'quota_unavailable', 'demoza')).toMatch(/temporary problem/i)
    expect(appBotOutcomeText('en', 'quota_unavailable', 'demoza')).not.toMatch(/connect|sign[ -]?in|log[ -]?in/i)
  })

  it('accepts the no-app recovery actions, and refuses authority that names another app', () => {
    expect(parseAppBotOutcome(outcome('busy', { kind: 'wait' }), guest('demoza')).action).toEqual({ kind: 'wait' })
    expect(parseAppBotOutcome(outcome('outcome_unknown', { kind: 'acknowledge_unknown' }), guest('demoza')).action)
      .toEqual({ kind: 'acknowledge_unknown' })
    expect(() => parseAppBotOutcome(outcome('quota_unavailable', { kind: 'retry_later', app: 'moon' }), guest('demoza')))
      .toThrow('app_bot_outcome_invalid')
    expect(() => parseAppBotOutcome(outcome('guest_limit_reached', { kind: 'connect_account', app: 'moon', extra: true }), guest('demoza')))
      .toThrow('app_bot_outcome_invalid')
  })
})

describe('guest recovery belongs to the guest-enabled bot that sent it, not to a name', () => {
  const limit = (app: string) => outcome('guest_limit_reached', { kind: 'connect_account', app })

  it('offers Connect for any guest-enabled bot, naming that bot’s own app', () => {
    expect(parseAppBotOutcome(limit('acme'), guest('acme')).action).toEqual({ kind: 'connect_account', app: 'acme' })
    expect(parseAppBotOutcome(limit('demoza'), guest('demoza')).action).toEqual({ kind: 'connect_account', app: 'demoza' })
  })

  it('refuses Connect from a bot that is not guest-enabled, or one that names another app', () => {
    expect(() => parseAppBotOutcome(limit('acme'), linked('acme'))).toThrow('app_bot_outcome_invalid')
    expect(() => parseAppBotOutcome(limit('demoza'), guest('acme'))).toThrow('app_bot_outcome_invalid')
    expect(() => parseAppBotOutcome(limit('moon'), guest('acme'))).toThrow('app_bot_outcome_invalid')
  })

  it('keeps the other actions, and the recovery codes that have none, as they were for every bot', () => {
    expect(parseAppBotOutcome(outcome('needs_setup', { kind: 'open_setup', app: 'acme' }), linked('acme')).action)
      .toEqual({ kind: 'open_setup', app: 'acme' })
    expect(parseAppBotOutcome(outcome('busy', { kind: 'wait' }), linked('moon')).action).toEqual({ kind: 'wait' })
    // The code decides which recovery action goes with it.
    expect(() => parseAppBotOutcome(outcome('busy', { kind: 'retry_later' }), guest('acme'))).toThrow('app_bot_outcome_invalid')
    expect(() => parseAppBotOutcome(outcome('quota_unavailable', { kind: 'connect_account', app: 'acme' }), guest('acme')))
      .toThrow('app_bot_outcome_invalid')
  })

  it('says an app’s name from its slug without a list of known apps', () => {
    expect(appBotOutcomeText('en', 'guest_limit_reached', 'acme')).toMatch(/Connect your Acme account/u)
    expect(appBotOutcomeText('en', 'guest_limit_reached', 'the-space')).toMatch(/Connect your The Space account/u)
    // A display name the caller already has is kept as it is.
    expect(appBotOutcomeText('en', 'guest_limit_reached', 'Demoza Pro')).toMatch(/Connect your Demoza Pro account/u)
    expect(appBotOutcomeText('en', 'guest_limit_reached', 'demoza')).toMatch(/Connect your Demoza account/u)
    expect(appBotOutcomeText('vi', 'needs_setup', 'moon')).toContain('Moon')
  })
})

describe('a decoder reads what gives authority and ignores the rest', () => {
  const bot = linked('acme')
  const guestBot = guest('acme')

  it('accepts a field it does not know, at the outcome and in any action, and strips it', () => {
    const cases: Array<[string, Record<string, unknown>, ReturnType<typeof linked>, Record<string, unknown>]> = [
      ['needs_setup', { kind: 'open_setup', app: 'acme', hint: { a: 1 } }, bot, { kind: 'open_setup', app: 'acme' }],
      ['andy_group_declined', { kind: 'open_bot_dm', app: 'acme', style: 'quiet' }, bot, { kind: 'open_bot_dm', app: 'acme' }],
      [
        'needs_intake',
        { kind: 'open_app_route', app: 'acme', route_id: 'intake', badge: 3 },
        bot,
        { kind: 'open_app_route', app: 'acme', route_id: 'intake' }
      ],
      [
        'guest_limit_reached',
        { kind: 'connect_account', app: 'acme', cta: 'x' },
        guestBot,
        { kind: 'connect_account', app: 'acme' }
      ],
      ['quota_unavailable', { kind: 'retry_later', after_ms: 5000 }, guestBot, { kind: 'retry_later' }],
      ['busy', { kind: 'wait', app: 'acme', after_ms: 5000 }, guestBot, { kind: 'wait' }],
      ['outcome_unknown', { kind: 'acknowledge_unknown', ticket: 'abc' }, guestBot, { kind: 'acknowledge_unknown' }]
    ]

    for (const [code, action, who, expected] of cases) {
      const parsed = parseAppBotOutcome({ ...outcome(code, action), future_top_level: { x: 1 } }, who)

      expect(parsed).toEqual({
        profile: 'atum.app-bot-outcome/1',
        state: 'notice',
        code,
        action: expected,
        locale: 'en'
      })
      expect(JSON.stringify(parsed)).not.toMatch(/future|hint|style|badge|cta|after_ms|ticket/u)
    }
  })

  it('still refuses another app, an unknown kind and a route that is not one', () => {
    for (const kind of ['open_setup', 'open_bot_dm', 'connect_account'] as const) {
      expect(() => parseAppBotOutcome(outcome('guest_limit_reached', { kind, app: 'moon' }), guestBot)).toThrow(
        'app_bot_outcome_invalid'
      )
    }

    expect(() => parseAppBotOutcome(outcome('needs_intake', { kind: 'open_app_route', app: 'moon', route_id: 'intake' }), bot))
      .toThrow('app_bot_outcome_invalid')

    for (const kind of ['delete_everything', 'open_url', '', 7]) {
      expect(() => parseAppBotOutcome(outcome('needs_setup', { kind, app: 'acme' }), bot)).toThrow('app_bot_outcome_invalid')
    }

    for (const route_id of [undefined, null, 7, '', 'Bad Route!', '../escape', 'a'.repeat(65), '1route']) {
      expect(() =>
        parseAppBotOutcome(outcome('needs_intake', { kind: 'open_app_route', app: 'acme', route_id }), bot)
      ).toThrow('app_bot_outcome_invalid')
    }

    // An action with no app at all is not an app action.
    expect(() => parseAppBotOutcome(outcome('needs_setup', { kind: 'open_setup' }), bot)).toThrow('app_bot_outcome_invalid')
    // The code decides which recovery action goes with it, and only a guest-enabled bot has them.
    expect(() => parseAppBotOutcome(outcome('busy', { kind: 'retry_later', extra: true }), guestBot)).toThrow(
      'app_bot_outcome_invalid'
    )
    expect(() => parseAppBotOutcome(outcome('guest_limit_reached', { kind: 'connect_account', app: 'acme', extra: 1 }), bot)).toThrow(
      'app_bot_outcome_invalid'
    )
  })

  it('still refuses what is not an outcome of this profile', () => {
    for (const change of [{ profile: 'atum.app-bot-outcome/2' }, { state: 'done' }, { code: 7 }, { locale: 'ja' }]) {
      expect(() => parseAppBotOutcome({ ...outcome('needs_setup', { kind: 'open_setup', app: 'acme' }), ...change }, bot)).toThrow(
        'app_bot_outcome_invalid'
      )
    }
  })
})

describe('polling for a private outcome', () => {
  it('leaves a closed code in the console for an answer it could not read, never the answer', () => {
    expect(appBotOutcomeUnreadableLine(new Error('app_bot_outcome_invalid'))).toBe(
      '[Matrix] app bot outcome unreadable code=app_bot_outcome_invalid'
    )
    expect(appBotOutcomeUnreadableLine(new Error('GET https://x/y failed for a@b.c'))).toBe(
      '[Matrix] app bot outcome unreadable code=failed'
    )
    expect(appBotOutcomeUnreadableLine('boom')).toBe('[Matrix] app bot outcome unreadable code=failed')
  })

  const none = { profile: 'atum.app-bot-outcome/1' as const, state: 'none' as const, code: null, action: null, locale: 'en' }
  const notice = { ...none, state: 'notice' as const, code: 'needs_setup' }

  it('reports an answer it could not read and keeps polling until a terminal one', async () => {
    let attempts = 0
    const errors: unknown[] = []
    const seen: string[] = []

    const result = await pollAppBotOutcome(
      async () => {
        if (++attempts <= 2) {
          throw new Error('app_bot_outcome_invalid')
        }

        return attempts === 3 ? none : notice
      },
      async () => {},
      outcome => seen.push(outcome.state),
      () => 0,
      error => errors.push(error)
    )

    expect(result).toEqual(notice)
    expect(attempts).toBe(4)
    expect(errors.map(error => (error as Error).message)).toEqual(['app_bot_outcome_invalid', 'app_bot_outcome_invalid'])
    // Only answers that were read reach the window.
    expect(seen).toEqual(['none', 'notice'])
  })

  it('gives the "no answer" notice when nothing it asked could be read, after the whole schedule', async () => {
    let attempts = 0
    const errors: unknown[] = []
    let elapsed = 0
    const waits: number[] = []

    const result = await pollAppBotOutcome(
      async () => {
        attempts++
        throw new Error('app_bot_outcome_invalid')
      },
      async delay => {
        waits.push(delay)
        elapsed += delay
      },
      () => {},
      () => elapsed,
      error => errors.push(error)
    )

    expect(result).toMatchObject({ state: 'notice', code: 'no_turn' })
    expect(attempts).toBe(APP_BOT_OUTCOME_DELAYS.length)
    expect(errors).toHaveLength(APP_BOT_OUTCOME_DELAYS.length)
    expect(waits).toHaveLength(APP_BOT_OUTCOME_DELAYS.length)
  })
})
