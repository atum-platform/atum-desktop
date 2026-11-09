#!/usr/bin/env node
// S1 acceptance test 10, the fence proof (S1 build plan §5; atum-platform
// docs/runbooks/cloud-launch-activation.md step F5). After T is switched to cloud answering, every
// way T's old local brain on THIS Mac could still write is refused:
//   - the local lease (acquire): 200 {held:false, reason:"not_eligible"} (0179's fenced answer)
//   - an interactive claim and an automatic claim of an owner message: 403 details.reason cloud_answering
//   - all three executor begins (default, agent, local host): 403 details.reason cloud_answering
// Only those exact answers count as fenced. The probes use made-up request hashes and lease tokens, so
// any other refusal (a bare 403, a 404, a 409) could come from the probe itself rather than the fence:
// those are inconclusive, never fenced.
//   - T's local agent Matrix device: its token answers 401 (the switch revoked its MAS session;
//     Synapse may cache the introspection for about two minutes, so this polls)
// The Mac's cron runs through that lease and that device, so it cannot post either.
//
// It refuses to probe at all unless the roster says T answers in the cloud: before the switch, the
// begins would really create executors. If a probe is NOT refused (the fence is open), it says so,
// and a begin that succeeded is revoked again at once.
//
//   node scripts/s1-acceptance/prove-fences.mjs \
//     --base https://api.atumplatform.com --matrix https://chat.atumplatform.com \
//     --owner-token-file <0600: the owner's bearer from this Mac's session> \
//     --agent <T's principal> --executor <T's local executor on this Mac> \
//     --host-device <this Mac's owner Matrix device> --sender-device <the owner device that sent EVENT> \
//     --agent-device-token-file <0600: T's local agent device token, captured before the switch> \
//     --room <T's room> --event <an owner message in it> --out evidence/fences-<mac>.json
//
// Exit 0: every path fenced. 1: a path is open. 2: refused to run or inconclusive (bad input, the
// owner token rejected, the platform unavailable). Never prints a token.
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { Evidence, parseArguments, readSecretFile, until } from './lib/evidence.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function proveFences(options, { fetchImpl = fetch, sleep } = {}) {
  const evidence = new Evidence(options.out, {
    test: 'S1 acceptance 10: fence proof',
    agent: options.agent,
    executor: options.executor,
    base: options.base
  })
  const ownerToken = evidence.secret(options.ownerToken)
  const agentDeviceToken = evidence.secret(options.agentDeviceToken)
  const api = new URL('/api/matrix/v1/', options.base)
  const call = async (method, route, body, token = ownerToken) => {
    const response = await fetchImpl(new URL(route, api), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    let json = null
    try { json = await response.json() } catch {}
    return { status: response.status, json }
  }
  const summary = result => ({
    status: result.status,
    ...(result.json && typeof result.json === 'object' && !Array.isArray(result.json)
      ? { error: result.json.error, reason: result.json.details?.reason ?? result.json.reason, held: result.json.held }
      : {})
  })

  // 0. Only after the switch.
  const roster = await call('GET', 'agents')
  if (roster.status === 401) {
    evidence.check('the owner token is accepted', false, { note: 'the platform rejected the owner token: capture it again' })
    evidence.finish({ verdict: 'inconclusive' })
    return 2
  }
  const entry = Array.isArray(roster.json) ? roster.json.find(item => item?.agentPrincipal === options.agent) : null
  if (!entry) {
    evidence.check('T is in the owner roster', false, { status: roster.status })
    evidence.finish({ verdict: 'inconclusive' })
    return 2
  }
  if (entry.answering !== 'cloud') {
    evidence.check('T answers in the cloud before probing', false,
      { note: `answering is ${entry.answering}: the proof runs only after the switch (F5); nothing was probed` })
    evidence.finish({ verdict: 'refused' })
    return 2
  }
  evidence.check('T answers in the cloud before probing', true, { answeringChangedAt: entry.answeringChangedAt ?? null })

  const open = []
  const inconclusive = []
  // A probe is fenced only on the fence's own answer, open only when the platform plainly accepted it
  // (2xx that is not the fenced answer), and inconclusive otherwise: every other 4xx or 5xx could be the
  // made-up probe failing for its own reasons while the fence is open.
  const accepted = result => result.status >= 200 && result.status < 300
  const judge = (name, result, fenced, opened = accepted) => {
    const outcome = summary(result)
    if (fenced(result)) return evidence.check(name, true, outcome)
    if (opened(result)) {
      open.push(name)
      return evidence.check(name, false, outcome)
    }
    inconclusive.push(name)
    return evidence.check(name, false,
      { ...outcome, note: 'inconclusive: refused, but not with the fence\'s answer (the probe or the platform, not the fence)' })
  }
  const cloudAnswering = result => result.status === 403 && result.json?.details?.reason === 'cloud_answering'
  const leaseNotEligible = result =>
    result.status === 200 && result.json?.held === false && result.json?.reason === 'not_eligible'
  const requestHash = createHash('sha256').update(`atum-fence-proof:${options.event}`).digest('hex')
  const claim = admission => ({
    operation: 'claim', executorId: options.executor, roomId: options.room, eventId: options.event, requestHash,
    senderDevice: options.senderDevice, protocol: 2, admission,
    ...(admission === 'automatic' ? { leaseToken: randomUUID() } : {})
  })

  // 1. The lease.
  judge('the local lease is refused', await call('POST', 'local-hermes/lease',
    { operation: 'acquire', executorId: options.executor, protocol: 2 }),
  leaseNotEligible, result => accepted(result) && result.json?.held === true)
  // 2–3. Claims, interactive and automatic.
  judge('an interactive claim is refused', await call('POST', 'local-hermes/invocations', claim('interactive')), cloudAnswering)
  judge('an automatic claim is refused', await call('POST', 'local-hermes/invocations', claim('automatic')), cloudAnswering)
  // 4–6. The three begins: T's own executor, a new agent executor, a new local host executor.
  judge('the default begin is refused', await call('POST', 'local-hermes', { executorId: options.executor }), cloudAnswering)
  for (const [name, body] of [
    ['the agent begin is refused', { executorId: randomUUID(), agentPrincipal: options.agent }],
    ['the local host begin is refused', { executorId: randomUUID(), agentPrincipal: options.agent, hostDevice: options.hostDevice }]
  ]) {
    const result = await call('POST', 'local-hermes', body)
    judge(name, result, cloudAnswering)
    if (accepted(result)) {
      // The fence is open and an executor now exists for T: revoke it at once.
      const revoked = await call('DELETE', 'local-hermes', { executorId: body.executorId })
      evidence.check(`the executor an open begin created is revoked (${body.executorId})`, revoked.status === 204, summary(revoked))
    }
  }

  // 7. T's local agent device: its token dies (the switch revoked the MAS session).
  const started = Date.now()
  const whoami = async () => {
    try {
      const response = await fetchImpl(new URL('/_matrix/client/v3/account/whoami', options.matrix), {
        headers: { authorization: `Bearer ${agentDeviceToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000)
      })
      await response.body?.cancel?.()
      return response.status
    } catch {
      return 0 // unreachable: inconclusive, never "fenced"
    }
  }
  let last = null
  const dead = await until(async () => (last = await whoami()) === 401,
    { timeoutMs: (options.matrixWaitSeconds ?? 150) * 1000, intervalMs: options.matrixIntervalMs ?? 5_000, sleep })
  if (last !== 401 && last !== 200) inconclusive.push('T’s local agent device')
  else if (!dead) open.push('T’s local agent device')
  evidence.check("T's local agent device token answers 401", Boolean(dead),
    { status: last, afterMs: Date.now() - started, note: dead ? undefined : 'still accepted: the device can post' })

  evidence.check('the six live agents still answer (owner confirms)', options.liveAgentsConfirmed === true,
    { note: options.liveAgentsConfirmed ? 'confirmed by the operator' : 'not confirmed: pass --live-agents-confirmed after the smoke' })
  const verdict = open.length ? 'open' : inconclusive.length ? 'inconclusive' : 'fenced'
  evidence.finish({ verdict, open, inconclusive })
  console.log(`FENCES_${verdict.toUpperCase()}${open.length ? ` open: ${open.join(', ')}` : ''}`)
  return open.length ? 1 : verdict === 'fenced' && options.liveAgentsConfirmed ? 0 : 2
}

async function main(argv) {
  let args
  try {
    args = parseArguments(argv, {
      values: ['base', 'matrix', 'owner-token-file', 'agent', 'executor', 'host-device', 'sender-device',
        'agent-device-token-file', 'room', 'event', 'out', 'matrix-wait-seconds'],
      flags: ['live-agents-confirmed']
    })
    for (const name of ['base', 'matrix', 'owner-token-file', 'agent', 'executor', 'host-device', 'sender-device',
      'agent-device-token-file', 'room', 'event', 'out']) {
      if (!args[name]) throw new Error(`--${name} is required`)
    }
    if (!UUID.test(args.agent) || !UUID.test(args.executor)) throw new Error('--agent and --executor are UUIDs')
    if (!/^!.+/.test(args.room) || !/^\$.+/.test(args.event)) throw new Error('--room is !… and --event is $…')
    for (const name of ['base', 'matrix']) {
      if (new URL(args[name]).protocol !== 'https:') throw new Error(`--${name} must be https`)
    }
  } catch (error) {
    console.error(`prove-fences: ${error.message}`)
    return 2
  }
  return proveFences({
    base: args.base, matrix: args.matrix, agent: args.agent, executor: args.executor, hostDevice: args['host-device'],
    senderDevice: args['sender-device'], room: args.room, event: args.event, out: args.out,
    ownerToken: readSecretFile(args['owner-token-file']), agentDeviceToken: readSecretFile(args['agent-device-token-file']),
    matrixWaitSeconds: args['matrix-wait-seconds'] ? Number(args['matrix-wait-seconds']) : undefined,
    liveAgentsConfirmed: args['live-agents-confirmed'] === true
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
