// node --test scripts/s1-acceptance/latency.test.mjs
// The latency drivers on loopback (real HTTP): legs measured cold and reused, turns paired from
// server timestamps only, journal fields percentiled, and no token in the evidence.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { journal, network, pairTurns, parseJournal, turns } from './latency.mjs'

const TOKEN = 'owner-token-for-latency-0123456789'
const OWNER = '@owner:atum'
const AGENT = '@t:atum'
let server
let base
const dir = mkdtempSync(path.join(os.tmpdir(), 'latency-'))
const timeline = [
  { type: 'm.room.encrypted', sender: OWNER, origin_server_ts: 1_000 },
  { type: 'm.room.encrypted', sender: AGENT, origin_server_ts: 9_000 },
  { type: 'm.reaction', sender: OWNER, origin_server_ts: 9_500 },
  { type: 'm.room.encrypted', sender: OWNER, origin_server_ts: 20_000 },
  { type: 'm.room.encrypted', sender: OWNER, origin_server_ts: 20_500 },
  { type: 'm.room.encrypted', sender: AGENT, origin_server_ts: 24_000 }
]

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); return res.end('ok') }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{}') }
    if (req.url.startsWith('/_matrix/client/v3/account/whoami')) { res.writeHead(200); return res.end(JSON.stringify({ user_id: OWNER })) }
    if (req.url.includes('/messages')) {
      res.writeHead(200)
      return res.end(JSON.stringify({ chunk: [...timeline].reverse().map(e => ({ ...e, content: { ciphertext: 'secret' } })) }))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test('each leg is measured cold and on one reused connection', async () => {
  const out = path.join(dir, 'network.json')
  assert.equal(await network({ targets: { local: `${base}/health` }, samples: 5, out }), true)
  const value = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(value.measurements.local.reused.n, 5)
  assert.equal(typeof value.measurements.local.coldMs, 'number')
  assert.equal(value.measurements.local.coldStatus, 200)
})

test('an unreachable leg fails its check', async () => {
  const out = path.join(dir, 'network-down.json')
  assert.equal(await network({ targets: { down: 'http://127.0.0.1:9/x' }, samples: 2, out }), false)
})

test('owner messages pair with the next agent event; a burst counts once; idle means cold', () => {
  const { turns: paired, unanswered } = pairTurns(timeline, { owner: OWNER, agent: AGENT, idleMs: 5_000 })
  assert.deepEqual(paired, [{ ms: 8_000, cold: true }, { ms: 4_000, cold: true }])
  assert.equal(unanswered, 0)
  assert.equal(pairTurns(timeline, { owner: OWNER, agent: AGENT, idleMs: 60_000 }).turns[1].cold, false)
  assert.equal(pairTurns([...timeline, { type: 'm.room.encrypted', sender: OWNER, origin_server_ts: 30_000 }],
    { owner: OWNER, agent: AGENT }).unanswered, 1)
})

test('turns read only senders and times, and keep the token out of the evidence', async () => {
  const out = path.join(dir, 'turns.json')
  assert.equal(await turns({ matrix: base, ownerToken: TOKEN, room: '!r:atum', agent: AGENT, since: new Date(0).toISOString(), out }), true)
  const text = readFileSync(out, 'utf8')
  assert.ok(!text.includes(TOKEN) && !text.includes('secret'))
  assert.equal(JSON.parse(text).measurements.turns.all.n, 2)
  assert.equal(await turns({ matrix: base, ownerToken: 'wrong-token-value', room: '!r:atum', agent: AGENT, out }), false)
})

test('the journal parser counts outcomes and percentiles every timing field', () => {
  const text = [
    '1790000000.1 h node[1]: [agent] executor=e committed invocation=a outcome=answered home=3 readyMs=6100 commitMs=900',
    '1790000100.1 h node[1]: [agent] executor=e committed invocation=b outcome=stopped home=4 readyMs=5900 commitMs=1100',
    '1790000200.1 h node[1]: [agent] executor=e release seq=4 code=quote_pending attempt=1',
    '1790000300.1 h node[1]: unrelated readyMs=1'
  ].join('\n')
  const parsed = parseJournal(text)
  assert.deepEqual(parsed.outcomes, { answered: 1, stopped: 1 })
  assert.deepEqual(parsed.fields.readyMs, { n: 2, p50: 5900, p95: 6100 })
  const file = path.join(dir, 'timings.txt')
  writeFileSync(file, text)
  assert.equal(journal({ file, out: path.join(dir, 'journal.json') }), true)
  writeFileSync(file, '1 h node[1]: [agent] executor=e committed invocation=a outcome=answered home=1\n')
  assert.equal(journal({ file, out: path.join(dir, 'journal2.json') }), false, 'no timing fields yet: says so')
})
