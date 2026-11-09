// node --test scripts/s1-acceptance/prove-fences.test.mjs
// The fence prover against a stand-in platform and homeserver on loopback (real HTTP): it passes
// only when every path is refused, names an open path, refuses to probe before the switch, cleans up
// after an open begin, and never writes a token anywhere.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import { proveFences } from './prove-fences.mjs'

const AGENT = '00000000-0000-4000-8000-cf4c4732fd3b'
const EXECUTOR = '00000000-0000-4000-8000-ecbad70593ee'
const OWNER_TOKEN = 'owner-bearer-token-value-0123456789'
const DEVICE_TOKEN = 'agent-device-token-value-9876543210'
let server
let base
let behaviour
let requests
let dir

const fenced = {
  roster: [{ agentPrincipal: AGENT, answering: 'cloud', answeringChangedAt: 1 }],
  lease: [200, { held: false, reason: 'not_eligible' }],
  claim: [403, { error: 'matrix_403', details: { reason: 'cloud_answering' } }],
  begin: [403, { error: 'matrix_403', details: { reason: 'cloud_answering' } }],
  whoami: [401]
}

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
      const send = ([status, json]) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(json ? JSON.stringify(json) : '') }
      if (req.url === '/api/matrix/v1/agents') return send([200, behaviour.roster])
      if (req.url === '/api/matrix/v1/local-hermes/lease') return send(behaviour.lease)
      if (req.url === '/api/matrix/v1/local-hermes/invocations') return send(behaviour.claim)
      if (req.url === '/api/matrix/v1/local-hermes' && req.method === 'POST') return send(behaviour.begin)
      if (req.url === '/api/matrix/v1/local-hermes' && req.method === 'DELETE') return send([204])
      if (req.url === '/_matrix/client/v3/account/whoami') return send(behaviour.whoami.length > 1 ? behaviour.whoami.shift() : behaviour.whoami[0])
      send([404])
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

beforeEach(() => {
  behaviour = structuredClone(fenced)
  behaviour.whoami = [[401]]
  requests = []
  dir = mkdtempSync(path.join(os.tmpdir(), 'fences-'))
})

const run = (extra = {}) => proveFences({
  base, matrix: base, agent: AGENT, executor: EXECUTOR, hostDevice: 'OWNERMAC', senderDevice: 'OWNERMAC',
  room: '!room:atum', event: '$event', out: path.join(dir, 'evidence.json'), ownerToken: OWNER_TOKEN,
  agentDeviceToken: DEVICE_TOKEN, matrixWaitSeconds: 1, matrixIntervalMs: 1, liveAgentsConfirmed: true, ...extra
}, { sleep: async () => {} })
const evidence = () => JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8'))

test('every path refused: fenced, and the evidence says which refusal each got', async () => {
  assert.equal(await run(), 0)
  const value = evidence()
  assert.equal(value.passed, true)
  assert.equal(value.verdict, 'fenced')
  assert.deepEqual(value.checks.find(c => c.name === 'the local lease is refused'), { name: 'the local lease is refused', ok: true, status: 200, held: false, reason: 'not_eligible' })
  assert.equal(value.checks.find(c => c.name === 'the agent begin is refused').reason, 'cloud_answering')
  const posts = requests.filter(r => r.method === 'POST')
  assert.equal(posts.length, 6, 'lease, two claims, three begins')
  assert.ok(posts.every(r => r.auth === `Bearer ${OWNER_TOKEN}`))
  const begins = posts.filter(r => r.url === '/api/matrix/v1/local-hermes').map(r => r.body)
  assert.deepEqual(begins[0], { executorId: EXECUTOR })
  assert.equal(begins[1].agentPrincipal, AGENT)
  assert.equal(begins[2].hostDevice, 'OWNERMAC')
  const claims = posts.filter(r => r.url.endsWith('/invocations')).map(r => r.body.admission)
  assert.deepEqual(claims, ['interactive', 'automatic'])
})

test('nothing is probed before the switch', async () => {
  behaviour.roster = [{ agentPrincipal: AGENT, answering: 'local' }]
  assert.equal(await run(), 2)
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0)
  assert.equal(evidence().verdict, 'refused')
})

test('a granted lease is an open fence', async () => {
  behaviour.lease = [200, { held: true, leaseToken: 'x' }]
  assert.equal(await run(), 1)
  assert.deepEqual(evidence().open, ['the local lease is refused'])
})

test('a begin that succeeds is reported open and revoked at once', async () => {
  behaviour.begin = [200, { state: 'provisioning' }]
  assert.equal(await run(), 1)
  const deletes = requests.filter(r => r.method === 'DELETE')
  assert.equal(deletes.length, 2, 'both new executors revoked again')
  assert.ok(evidence().checks.some(c => c.name.startsWith('the executor an open begin created is revoked') && c.ok))
})

test("T's device token is polled until Synapse's cache lets go, and a live token is open", async () => {
  behaviour.whoami = [[200], [200], [401]]
  assert.equal(await run(), 0)
  behaviour.whoami = [[200]]
  assert.equal(await run(), 1)
  assert.ok(evidence().open.includes('T’s local agent device'))
})

test('a broken probe or platform is inconclusive, never fenced', async () => {
  behaviour.claim = [400, { error: 'matrix_400' }]
  assert.equal(await run(), 2)
  assert.equal(evidence().verdict, 'inconclusive')
  behaviour = structuredClone(fenced)
  behaviour.whoami = [[401]]
  behaviour.roster = []
  assert.equal(await run(), 2)
})

test('a refusal that is not the fence\'s own answer is inconclusive, never fenced', async () => {
  // The probes carry made-up request hashes and lease tokens: a bare 403, a 404 or a 409 can be the
  // probe failing on its own while the fence is open.
  for (const [status, json] of [[403, { error: 'matrix_403' }], [404, { error: 'matrix_404' }], [409, { error: 'matrix_409' }],
    [403, { error: 'matrix_403', details: { reason: 'something_else' } }]]) {
    for (const route of ['claim', 'begin']) {
      behaviour = structuredClone(fenced)
      behaviour.whoami = [[401]]
      behaviour[route] = [status, json]
      assert.equal(await run(), 2, `${route} ${status}`)
      const value = evidence()
      assert.equal(value.verdict, 'inconclusive', `${route} ${status}`)
      assert.deepEqual(value.open, [])
      assert.ok(value.inconclusive.length >= 1)
    }
  }
})

test('a lease answer other than the fenced not_eligible is inconclusive, and only a granted lease is open', async () => {
  for (const lease of [[200, { held: false, reason: 'held_elsewhere' }], [403, { error: 'matrix_403' }], [404, {}]]) {
    behaviour = structuredClone(fenced)
    behaviour.whoami = [[401]]
    behaviour.lease = lease
    assert.equal(await run(), 2)
    assert.deepEqual(evidence().inconclusive, ['the local lease is refused'])
  }
})

test('without the live-agent confirmation the run is not a pass', async () => {
  assert.equal(await run({ liveAgentsConfirmed: false }), 2)
  assert.equal(evidence().passed, false)
})

test('no token reaches the evidence', async () => {
  await run()
  const text = readFileSync(path.join(dir, 'evidence.json'), 'utf8')
  assert.ok(!text.includes(OWNER_TOKEN) && !text.includes(DEVICE_TOKEN))
  rmSync(dir, { recursive: true, force: true })
})
