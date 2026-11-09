import assert from 'node:assert/strict'

import { expect, test } from 'vitest'

import {
  ATUM_AUTH_CALLBACK_HOST,
  ATUM_AUTH_CALLBACK_TTL_MS,
  ATUM_AUTH_SCHEME,
  atumAuthBridgeRedirectUrl,
  AtumAuthCallbackBroker,
  atumAuthRedirectUrl,
  isAtumAuthScheme,
  parseAtumAuthCallback
} from './auth-deep-link'

const STATE = 'AbCd_1234-EfGh5678xyzQRS'
const OTHER_STATE = 'ZzZz_9999-AaAa0000lmnOPQ'

function callback(state = STATE, query = '?code=auth-code-123'): string {
  return `${ATUM_AUTH_SCHEME}://${ATUM_AUTH_CALLBACK_HOST}/${state}${query}`
}

// ---------------------------------------------------------------------------
// Redirect construction
// ---------------------------------------------------------------------------

test('the redirect_to is the exact shape the Supabase uri_allow_list authorizes', () => {
  // `atum://auth-callback/**` is what is allow-listed on the project. A
  // query-string state would match neither allow-list entry and GoTrue would
  // refuse the authorize request before showing a consent screen.
  assert.equal(atumAuthRedirectUrl(STATE), `atum://auth-callback/${STATE}`)

  const parsed = new URL(atumAuthRedirectUrl(STATE))

  assert.equal(parsed.protocol, 'atum:')
  assert.equal(parsed.hostname, 'auth-callback')
  assert.equal(parsed.search, '')
})

test('a redirect can only be built for a well-formed state', () => {
  for (const bogus of ['', 'short', 'has space here!!!!!!!', '../../escape/attempt', 'a'.repeat(129)]) {
    assert.throws(() => atumAuthRedirectUrl(bogus), /callback_state_invalid/)
  }
})

test('isAtumAuthScheme routes atum:// away from the hermes:// blueprint router', () => {
  assert.equal(isAtumAuthScheme('atum://auth-callback/x'), true)
  assert.equal(isAtumAuthScheme('ATUM://auth-callback/x'), true)
  assert.equal(isAtumAuthScheme('hermes://blueprint/morning-brief'), false)
  assert.equal(isAtumAuthScheme('atumx://auth-callback/x'), false)
  assert.equal(isAtumAuthScheme('https://atum.example/atum://'), false)
  assert.equal(isAtumAuthScheme(undefined), false)
  assert.equal(isAtumAuthScheme(42), false)
})

// ---------------------------------------------------------------------------
// Parsing — the deep link is untrusted input from anything on the machine
// ---------------------------------------------------------------------------

test('a well-formed success callback parses into state + code', () => {
  const parsed = parseAtumAuthCallback(callback())

  assert.deepEqual(parsed, { ok: true, state: STATE, code: 'auth-code-123', error: null })
})

test('an upstream denial parses as an error, and the free-text description is discarded', () => {
  const parsed = parseAtumAuthCallback(
    callback(STATE, '?error=access_denied&error_description=User%20said%20no%20%3Cscript%3E')
  )

  assert.deepEqual(parsed, { ok: true, state: STATE, code: null, error: 'access_denied' })
  // error_description is attacker-influenced; it must not survive into anything
  // we could later render or log.
  assert.doesNotMatch(JSON.stringify(parsed), /script|said no/i)
})

test('a junk error token is normalized rather than passed through', () => {
  const parsed = parseAtumAuthCallback(callback(STATE, '?error=%3Cimg%20src%3Dx%20onerror%3D1%3E'))

  assert.deepEqual(parsed, { ok: true, state: STATE, code: null, error: 'authorization_denied' })
})

test.each([
  ['not a url at all', 'callback_malformed'],
  ['', 'callback_malformed'],
  ['hermes://blueprint/morning-brief', 'callback_not_atum_scheme'],
  ['https://auth-callback/' + STATE + '?code=x', 'callback_not_atum_scheme'],
  // Host smuggling: userinfo makes the REAL host something else entirely.
  [`atum://${ATUM_AUTH_CALLBACK_HOST}@evil.example/${STATE}?code=x`, 'callback_host_unexpected'],
  [`atum://evil.example/${STATE}?code=x`, 'callback_host_unexpected'],
  [`atum://${ATUM_AUTH_CALLBACK_HOST}:8080/${STATE}?code=x`, 'callback_host_unexpected'],
  // No state segment, extra segments, or a state outside the base64url alphabet.
  ['atum://auth-callback?code=x', 'callback_state_invalid'],
  ['atum://auth-callback/?code=x', 'callback_state_invalid'],
  [`atum://auth-callback/${STATE}/extra?code=x`, 'callback_state_invalid'],
  ['atum://auth-callback/%2e%2e%2f%2e%2e?code=x', 'callback_state_invalid'],
  ['atum://auth-callback/short?code=x', 'callback_state_invalid'],
  [`atum://auth-callback/${'a'.repeat(200)}?code=x`, 'callback_state_invalid'],
  // Present but unusable payloads.
  [callback(STATE, ''), 'callback_missing_result'],
  [callback(STATE, '?state=' + STATE), 'callback_missing_result'],
  [callback(STATE, '?code=' + encodeURIComponent('<script>')), 'callback_code_invalid'],
  [callback(STATE, '?code='), 'callback_code_invalid'],
  // Parameter smuggling: which `code` would a downstream parser have read?
  [callback(STATE, '?code=good&code=evil'), 'callback_duplicate_parameter'],
  [callback(STATE, '?error=access_denied&error=other'), 'callback_duplicate_parameter']
])('rejects hostile input %# without throwing', (input, reason) => {
  assert.deepEqual(parseAtumAuthCallback(input), { ok: false, reason })
})

test('rejects a control-character URL rather than letting the parser normalize it away', () => {
  const injected = `atum://auth-callback/${STATE}?code=abc\r\nX-Injected: 1`

  assert.deepEqual(parseAtumAuthCallback(injected), { ok: false, reason: 'callback_malformed' })
  assert.deepEqual(parseAtumAuthCallback(`atum://auth-callback/${STATE}\u0000?code=abc`), {
    ok: false,
    reason: 'callback_malformed'
  })
  // A space is not a control character — WHATWG percent-encodes it into the
  // path, where the state charset rejects it.
  assert.deepEqual(parseAtumAuthCallback(`atum://auth-callback/${STATE} ?code=abc`), {
    ok: false,
    reason: 'callback_state_invalid'
  })
})

test('rejects an absurdly large URL before parsing it', () => {
  assert.deepEqual(parseAtumAuthCallback(callback(STATE, `?code=${'a'.repeat(100_000)}`)), {
    ok: false,
    reason: 'callback_too_large'
  })
})

test('non-string input is a rejection, never a throw', () => {
  for (const value of [undefined, null, 0, {}, [], Symbol('x'), () => undefined]) {
    assert.equal(parseAtumAuthCallback(value).ok, false)
  }
})

// ---------------------------------------------------------------------------
// Broker — pending-request lifecycle, replay, TTL
// ---------------------------------------------------------------------------

function brokerAt(clock: { now: number }) {
  return new AtumAuthCallbackBroker({ now: () => clock.now })
}

test('a matching callback resolves the pending request exactly once', async () => {
  const broker = new AtumAuthCallbackBroker()
  const controller = new AbortController()
  const waiting = broker.wait({ state: STATE, signal: controller.signal })

  assert.equal(broker.hasPendingRequest(), true)
  assert.deepEqual(broker.deliver(callback()), { accepted: true, outcome: 'accepted' })
  assert.equal(await waiting, 'auth-code-123')
  assert.equal(broker.hasPendingRequest(), false)
})

test('replaying the same callback is rejected — the state is single-use', async () => {
  const broker = new AtumAuthCallbackBroker()
  const controller = new AbortController()
  const waiting = broker.wait({ state: STATE, signal: controller.signal })

  broker.deliver(callback())
  await waiting

  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'state_replayed' })

  // And a replay cannot revive itself by racing a fresh, unrelated request.
  const second = broker.wait({ state: OTHER_STATE, signal: new AbortController().signal })

  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'state_mismatch' })
  assert.equal(broker.hasPendingRequest(), true)
  broker.deliver(callback(OTHER_STATE, '?code=second-code'))
  assert.equal(await second, 'second-code')
})

test('an unsolicited callback with no pending request is dropped', () => {
  const broker = new AtumAuthCallbackBroker()

  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'no_pending_request' })
  assert.deepEqual(broker.deliver('atum://auth-callback/nonsense'), {
    accepted: false,
    outcome: 'callback_state_invalid'
  })
})

test('a mismatched state is dropped WITHOUT cancelling the real in-flight request', async () => {
  // The deep link is a public channel. If a forged callback could abort the
  // pending request, any page on the machine could block sign-in forever.
  const broker = new AtumAuthCallbackBroker()
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(broker.deliver(callback(OTHER_STATE)), { accepted: false, outcome: 'state_mismatch' })
  }

  assert.equal(broker.hasPendingRequest(), true)
  broker.deliver(callback(STATE, '?code=real-code'))
  assert.equal(await waiting, 'real-code')
})

test('a state that merely shares a prefix does not match', async () => {
  const broker = new AtumAuthCallbackBroker()
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal })

  assert.deepEqual(broker.deliver(callback(`${STATE}xy`)), { accepted: false, outcome: 'state_mismatch' })
  assert.deepEqual(broker.deliver(callback(STATE.slice(0, -1) + 'Z')), {
    accepted: false,
    outcome: 'state_mismatch'
  })
  broker.deliver(callback(STATE, '?code=real-code'))
  assert.equal(await waiting, 'real-code')
})

test('a request that outlived its TTL is expired on arrival, not exchanged', async () => {
  const clock = { now: 1_000 }
  const broker = brokerAt(clock)
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal, ttlMs: 60_000 })

  // Machine slept: the callback lands after the deadline but before the timer
  // that would have fired during that sleep gets a chance to run.
  clock.now += 60_001
  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'request_expired' })
  await expect(waiting).rejects.toThrow('authorization_timeout')
  assert.equal(broker.hasPendingRequest(), false)

  // The expired state is spent too — a later replay never becomes valid.
  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'state_replayed' })
})

test('the TTL timer rejects a request that never gets a callback at all', async () => {
  const broker = new AtumAuthCallbackBroker()
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal, ttlMs: 15 })

  await expect(waiting).rejects.toThrow('authorization_timeout')
  assert.equal(broker.hasPendingRequest(), false)
})

test('the default TTL is the five-minute browser round trip, not an unbounded wait', () => {
  assert.equal(ATUM_AUTH_CALLBACK_TTL_MS, 5 * 60 * 1000)
})

test('an upstream denial rejects the waiter and still spends the state', async () => {
  const broker = new AtumAuthCallbackBroker()
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal })

  assert.deepEqual(broker.deliver(callback(STATE, '?error=access_denied')), {
    accepted: false,
    outcome: 'authorization_error'
  })
  await expect(waiting).rejects.toThrow('authorization_callback_error:access_denied')
  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'state_replayed' })
})

test('cancelling the attempt clears the pending request immediately', async () => {
  const broker = new AtumAuthCallbackBroker()
  const controller = new AbortController()
  const waiting = broker.wait({ state: STATE, signal: controller.signal })

  controller.abort()
  await expect(waiting).rejects.toThrow('authorization_cancelled')
  assert.equal(broker.hasPendingRequest(), false)
  assert.deepEqual(broker.deliver(callback()), { accepted: false, outcome: 'no_pending_request' })
})

test('an already-aborted signal never registers a pending request', async () => {
  const broker = new AtumAuthCallbackBroker()
  const controller = new AbortController()
  controller.abort()

  await expect(broker.wait({ state: STATE, signal: controller.signal })).rejects.toThrow('authorization_cancelled')
  assert.equal(broker.hasPendingRequest(), false)
})

test('a second attempt supersedes the first — only one request is ever live', async () => {
  const broker = new AtumAuthCallbackBroker()
  const first = broker.wait({ state: STATE, signal: new AbortController().signal })
  const second = broker.wait({ state: OTHER_STATE, signal: new AbortController().signal })

  await expect(first).rejects.toThrow('authorization_superseded')
  assert.deepEqual(broker.deliver(callback(STATE)), { accepted: false, outcome: 'state_mismatch' })
  broker.deliver(callback(OTHER_STATE, '?code=second-code'))
  assert.equal(await second, 'second-code')
})

test('wait refuses a malformed state instead of registering an unmatchable request', async () => {
  const broker = new AtumAuthCallbackBroker()

  await expect(broker.wait({ state: 'nope', signal: new AbortController().signal })).rejects.toThrow(
    'callback_state_invalid'
  )
  assert.equal(broker.hasPendingRequest(), false)
})

test('stop() closes an outstanding request and forgets every remembered state', async () => {
  const broker = new AtumAuthCallbackBroker()
  const waiting = broker.wait({ state: STATE, signal: new AbortController().signal })

  broker.stop()
  await expect(waiting).rejects.toThrow('authorization_cancelled')
  assert.equal(broker.hasPendingRequest(), false)
})

test('delivery outcomes never leak the code, the state, or the URL', () => {
  const broker = new AtumAuthCallbackBroker()
  const secretCode = 'zzsupersecretcodezz'
  void broker.wait({ state: STATE, signal: new AbortController().signal })

  const outcomes = [
    broker.deliver(callback(STATE, `?code=${secretCode}`)),
    broker.deliver(callback(OTHER_STATE, `?code=${secretCode}`)),
    broker.deliver(`atum://auth-callback/${STATE}?code=${'!'.repeat(10)}`)
  ]

  const serialized = JSON.stringify(outcomes)

  assert.doesNotMatch(serialized, new RegExp(secretCode))
  assert.doesNotMatch(serialized, new RegExp(STATE))
  assert.doesNotMatch(serialized, /atum:\/\//)
})

test('the browser is redirected to the platform bridge, not to the custom scheme', () => {
  const state = 'a'.repeat(32)

  // The bridge page is what ends the browser tab honestly; the deep link is
  // what it hands back to this app.
  expect(atumAuthBridgeRedirectUrl('https://deployment.example.invalid', state)).toBe(
    `https://deployment.example.invalid/auth/desktop/${state}`
  )
  expect(atumAuthRedirectUrl(state)).toBe(`atum://auth-callback/${state}`)
})

test('the bridge URL refuses a bad state, an insecure base, and a base carrying credentials or a query', () => {
  const state = 'a'.repeat(32)

  expect(() => atumAuthBridgeRedirectUrl('https://atum.example', 'short')).toThrow('callback_state_invalid')
  expect(() => atumAuthBridgeRedirectUrl('http://atum.example', state)).toThrow('callback_base_insecure')
  expect(() => atumAuthBridgeRedirectUrl('https://user:pw@atum.example', state)).toThrow('callback_base_invalid')
  expect(() => atumAuthBridgeRedirectUrl('https://atum.example/?next=/evil', state)).toThrow('callback_base_invalid')

  // Loopback stays usable for local platform development.
  expect(atumAuthBridgeRedirectUrl('http://localhost:3000', state)).toBe(`http://localhost:3000/auth/desktop/${state}`)
  // A hosted base with a path keeps it.
  expect(atumAuthBridgeRedirectUrl('https://atum.example/base', state)).toBe(`https://atum.example/base/auth/desktop/${state}`)
})
