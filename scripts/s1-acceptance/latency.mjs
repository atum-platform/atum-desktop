#!/usr/bin/env node
// S1's latency re-measurement on the real path (S1 build plan §5 step 9; the S0 numbers in
//  §4), three ways, each numbers only:
//
//   node scripts/s1-acceptance/latency.mjs network [--samples 20] [--target name=https://…]… --out FILE
//       From this Mac to each production edge the S1 path crosses: a cold request (DNS, TCP, TLS and
//       the first byte) and N requests on one reused connection (time to the response's headers),
//       p50 and p95. Defaults: chat (Matrix), da (the platform API), gateway (models), devices (the
//       device hub's tunnel).
//
//   node scripts/s1-acceptance/latency.mjs turns --matrix https://chat.atumplatform.com \
//        --owner-token-file F --room ROOM --agent @t:… [--since ISO] [--idle-minutes 10] --out FILE
//       What the owner felt: in T's room, each owner message paired with T's next event (an answer
//       or a status), from the server's own timestamps. Event bodies stay encrypted and unread: only
//       senders and times. A message after more than --idle-minutes without a turn counts as cold
//       (the sandbox starts from nothing, S1 has no warm pool), the rest as warm.
//
//   node scripts/s1-acceptance/latency.mjs journal --file TIMINGS --out FILE
//       The controller's own [agent] lines (deploy/executor/ops.sh timings): outcomes counted, and
//       every `name=<n>ms`-style field percentiled (cold start, export, commit), when the controller
//       logs them.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { Evidence, parseArguments, percentiles, readSecretFile } from './lib/evidence.mjs'

export const DEFAULT_TARGETS = {
  chat: 'https://chat.atumplatform.com/_matrix/client/versions',
  da: 'https://api.atumplatform.com/api/matrix/v1/cloud/controller-keys',
  gateway: 'https://gateway.atumplatform.com/health/liveliness',
  devices: 'https://devices.atumplatform.com/v1'
}

/** One request; resolves with the time to headers and to the end, and the status. */
function timed(url, agent) {
  const client = url.startsWith('https:') ? https : http
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const request = client.get(url, { agent, headers: { 'user-agent': 'atum-s1-latency/1' }, timeout: 15_000 }, response => {
      const headers = performance.now() - started
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode, headersMs: headers, totalMs: performance.now() - started }))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

export async function network({ targets = DEFAULT_TARGETS, samples = 20, out }) {
  const evidence = new Evidence(out, { measure: 'S1 latency: network legs', samples })
  for (const [name, url] of Object.entries(targets)) {
    const cold = await timed(url, false).catch(error => ({ error: error.message }))
    const agent = new (url.startsWith('https:') ? https : http).Agent({ keepAlive: true, maxSockets: 1 })
    const warm = []
    let failures = 0
    for (let i = 0; i < samples; i += 1) {
      try { warm.push((await timed(url, agent)).headersMs) } catch { failures += 1 }
    }
    agent.destroy()
    const result = { url, coldMs: cold.error ? null : Math.round(cold.totalMs), coldStatus: cold.status ?? null,
      reused: percentiles(warm), failures }
    evidence.measure(name, result)
    evidence.check(`${name} answers`, !cold.error && failures < samples,
      { note: cold.error ? cold.error : `cold ${result.coldMs} ms, reused p50 ${result.reused.p50} ms p95 ${result.reused.p95} ms` })
  }
  return evidence.finish()
}

/** Pairs each owner message with the agent's next event. Events are oldest first. */
export function pairTurns(events, { owner, agent, idleMs = 10 * 60_000 }) {
  const turns = []
  let pending = null
  let lastAgent = null
  for (const event of events) {
    if (event.sender === owner && ['m.room.encrypted', 'm.room.message'].includes(event.type)) {
      if (!pending) pending = event
    } else if (event.sender === agent && ['m.room.encrypted', 'm.room.message'].includes(event.type)) {
      if (pending) {
        const cold = lastAgent === null || pending.origin_server_ts - lastAgent > idleMs
        turns.push({ ms: event.origin_server_ts - pending.origin_server_ts, cold })
        pending = null
      }
      lastAgent = event.origin_server_ts
    }
  }
  return { turns, unanswered: pending ? 1 : 0 }
}

export async function turns({ matrix, ownerToken, room, agent, since, idleMinutes = 10, out, fetchImpl = fetch }) {
  const evidence = new Evidence(out, { measure: 'S1 latency: owner-perceived turns', room, agent })
  evidence.secret(ownerToken)
  const headers = { authorization: `Bearer ${ownerToken}` }
  const whoami = await fetchImpl(new URL('/_matrix/client/v3/account/whoami', matrix), { headers })
  if (whoami.status !== 200) {
    evidence.check('the owner token is accepted', false, { status: whoami.status })
    return evidence.finish()
  }
  const owner = (await whoami.json()).user_id
  const sinceMs = since ? Date.parse(since) : Date.now() - 7 * 86_400_000
  const events = []
  let from = null
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`, matrix)
    url.searchParams.set('dir', 'b')
    url.searchParams.set('limit', '200')
    if (from) url.searchParams.set('from', from)
    const response = await fetchImpl(url, { headers })
    if (response.status !== 200) {
      evidence.check('the room history is readable', false, { status: response.status })
      return evidence.finish()
    }
    const body = await response.json()
    const chunk = (body.chunk ?? []).map(e => ({ type: e.type, sender: e.sender, origin_server_ts: e.origin_server_ts }))
    events.push(...chunk)
    if (!body.end || chunk.length === 0 || chunk.some(e => e.origin_server_ts < sinceMs)) break
    from = body.end
  }
  const ordered = events.filter(e => e.origin_server_ts >= sinceMs).sort((a, b) => a.origin_server_ts - b.origin_server_ts)
  const { turns: paired, unanswered } = pairTurns(ordered, { owner, agent, idleMs: idleMinutes * 60_000 })
  const cold = paired.filter(t => t.cold).map(t => t.ms)
  const warm = paired.filter(t => !t.cold).map(t => t.ms)
  evidence.measure('turns', { all: percentiles(paired.map(t => t.ms)), cold: percentiles(cold), warm: percentiles(warm), unanswered,
    idleMinutes, since: new Date(sinceMs).toISOString() })
  evidence.check('T answered every owner message in the window', unanswered === 0 && paired.length > 0,
    { note: `${paired.length} turns (${cold.length} cold), p50 ${percentiles(paired.map(t => t.ms)).p50} ms` })
  return evidence.finish()
}

/** The controller's [agent] lines: outcome counts and every numeric *Ms field. */
export function parseJournal(text) {
  const outcomes = {}
  const fields = {}
  for (const line of text.split('\n')) {
    if (!line.includes('[agent]')) continue
    const outcome = /\boutcome=([a-z_]+)/.exec(line)?.[1]
    if (outcome && /\bcommitted\b/.test(line)) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    for (const match of line.matchAll(/\b([a-zA-Z]+Ms)=([0-9]+)\b/g)) (fields[match[1]] ??= []).push(Number(match[2]))
  }
  return { outcomes, fields: Object.fromEntries(Object.entries(fields).map(([name, values]) => [name, percentiles(values)])) }
}

export function journal({ file, out }) {
  const evidence = new Evidence(out, { measure: 'S1 latency: the controller journal' })
  const parsed = parseJournal(readFileSync(file, 'utf8'))
  evidence.measure('journal', parsed)
  const committed = Object.values(parsed.outcomes).reduce((a, b) => a + b, 0)
  evidence.check('the journal holds committed turns', committed > 0, { note: `${committed} committed` })
  evidence.check('the controller logs per-turn timings', Object.keys(parsed.fields).length > 0,
    { note: Object.keys(parsed.fields).length ? Object.keys(parsed.fields).join(', ') : 'no *Ms fields: WS-2 to log TaskTimings on the committed line' })
  return evidence.finish()
}

async function main([command, ...argv]) {
  try {
    if (command === 'network') {
      const args = parseArguments(argv, { values: ['samples', 'out', 'target'] })
      const targets = { ...DEFAULT_TARGETS }
      if (args.target) {
        const [name, url] = args.target.split('=')
        targets[name] = url
      }
      return (await network({ targets, samples: Number(args.samples ?? 20), out: args.out })) ? 0 : 1
    }
    if (command === 'turns') {
      const args = parseArguments(argv, { values: ['matrix', 'owner-token-file', 'room', 'agent', 'since', 'idle-minutes', 'out'] })
      for (const name of ['matrix', 'owner-token-file', 'room', 'agent', 'out']) if (!args[name]) throw new Error(`--${name} is required`)
      return (await turns({ matrix: args.matrix, ownerToken: readSecretFile(args['owner-token-file']), room: args.room, agent: args.agent,
        since: args.since, idleMinutes: Number(args['idle-minutes'] ?? 10), out: args.out })) ? 0 : 1
    }
    if (command === 'journal') {
      const args = parseArguments(argv, { values: ['file', 'out'] })
      if (!args.file || !args.out) throw new Error('--file and --out are required')
      return journal({ file: args.file, out: args.out }) ? 0 : 1
    }
    throw new Error('usage: latency.mjs network|turns|journal …')
  } catch (error) {
    console.error(`latency: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
