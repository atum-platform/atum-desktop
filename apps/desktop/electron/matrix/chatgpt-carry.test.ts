import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ChatGptCarry, CarryRejected } from './chatgpt-carry'

function fixture(call: (body: Record<string, string>) => Promise<string>) {
  let state = 'local', now = 0, drains = 0, carried = 0, restored = 0
  const actions: string[] = []
  const carry = new ChatGptCarry({ scope: () => ({ accountKey: 'one', generation: 1 }), home: () => '/synthetic',
    now: () => now, call,
    custody: async (_home, action) => {
      actions.push(action)
      if (action === 'begin') { state = 'paused'; return { state, access_token: 'fake-access', refresh_token: 'fake-refresh' } }
      state = action === 'commit' ? 'carried' : 'local'; return { state }
    }, drain: async () => { drains++ }, carried: () => { carried++ }, restored: () => { restored++ } })
  return { carry, actions, state: () => state, restored: () => restored, carried: () => carried, drains: () => drains, retry: () => { now += 61_000 } }
}

test('drains before upload, commits once, and never uploads again', async () => {
  let f: ReturnType<typeof fixture>, uploads = 0
  f = fixture(async body => {
    if (!body.access_token) return 'pending'
    assert.equal(f.state(), 'paused'); assert.equal(f.drains(), 1)
    uploads++; return 'migrated'
  })
  await f.carry.sync(); await f.carry.sync()
  assert.equal(uploads, 1); assert.equal(f.carried(), 1)
  assert.deepEqual(f.actions, ['begin', 'commit'])
})

test('lost response keeps Mac paused and recovers from server marker', async () => {
  let state = 'pending'
  const f = fixture(async body => { if (body.access_token) { state = 'migrated'; throw Error('lost') }; return state })
  await f.carry.sync(); assert.equal(f.state(), 'paused')
  f.retry(); await f.carry.sync(); assert.equal(f.state(), 'carried')
  assert.deepEqual(f.actions, ['begin', 'commit'])
})

test('definite rejection returns refresh ownership to the Mac', async () => {
  const f = fixture(async body => { if (body.access_token) throw new CarryRejected(); return 'pending' })
  await f.carry.sync(); assert.equal(f.state(), 'local'); assert.equal(f.restored(), 1)
  assert.deepEqual(f.actions, ['begin', 'rollback'])
})

test('already migrated retires local credentials without reading them for upload', async () => {
  const f = fixture(async () => 'migrated')
  await f.carry.sync(); assert.deepEqual(f.actions, ['commit']); assert.equal(f.carried(), 1)
})

test('cloud outage before transfer leaves local ownership intact', async () => {
  const f = fixture(async () => { throw Error('offline') })
  await f.carry.sync(); assert.equal(f.state(), 'local'); assert.deepEqual(f.actions, [])
})

test('a busy import restores the Mac grant for a later retry', async () => {
  const f = fixture(async body => body.access_token ? 'busy' : 'pending')
  await f.carry.sync(); assert.equal(f.state(), 'local')
})

test('validation outage acknowledged before custody mutation restores local ownership', async () => {
  const f = fixture(async body => body.access_token ? 'not_imported' : 'pending')
  await f.carry.sync(); assert.equal(f.state(), 'local')
})

test('carried local relay cannot be re-enabled by an in-flight status response', async () => {
  const { MatrixChatGptRelay } = await import('./chatgpt-relay-client')
  let finish!: (answer: { status: number; value: unknown }) => void
  let calls = 0
  const relay = new MatrixChatGptRelay({ scope: () => ({ accountKey: 'one', generation: 1 }), changed: () => {},
    call: async () => { calls++; return new Promise(resolve => { finish = resolve }) } })
  const refreshing = relay.refresh()
  relay.markCarried()
  finish({ status: 200, value: { profile: 'atum.chatgpt-relay/1', state: 'disabled', revision: 1, models: [] } })
  await refreshing
  assert.equal(relay.view()?.state, 'carried')
  await relay.refresh(); assert.equal(calls, 1)
  assert.equal(await relay.enable('synthetic-device', []), false)
})
