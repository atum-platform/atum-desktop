import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ChatGptCarry } from './chatgpt-carry'

test('automatic carry uploads once and never reads credentials on the second run', async () => {
  let state = 'pending', reads = 0, uploads = 0
  const carry = new ChatGptCarry({ scope: () => ({ accountKey: 'one', generation: 1 }), home: () => '/synthetic',
    read: () => { reads++; return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } },
    call: async body => { if (body.access_token) { uploads++; state = 'migrated' }; return state } })
  await carry.sync(); await carry.sync()
  assert.equal(reads, 1); assert.equal(uploads, 1)
})

test('lost upload response retries server status without re-reading the credential', async () => {
  let state = 'pending', reads = 0, now = 0
  const carry = new ChatGptCarry({ scope: () => ({ accountKey: 'one', generation: 1 }), home: () => '/synthetic', now: () => now,
    read: () => { reads++; return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } },
    call: async body => { if (body.access_token) { state = 'migrated'; throw new Error('lost') }; return state } })
  await carry.sync(); now = 61000; await carry.sync()
  assert.equal(reads, 1)
})

test('account change during status never reads or uploads the previous account grant', async () => {
  let scope = { accountKey: 'one', generation: 1 }, reads = 0
  const carry = new ChatGptCarry({ scope: () => scope, home: () => '/synthetic',
    read: () => { reads++; return undefined },
    call: async () => { scope = { accountKey: 'two', generation: 2 }; return 'pending' } })
  await carry.sync(); assert.equal(reads, 0)
})

test('already migrated on another Mac skips credential reading', async () => {
  const carry = new ChatGptCarry({ scope: () => ({ accountKey: 'one', generation: 1 }), home: () => '/synthetic',
    read: () => { throw new Error('unexpected read') }, call: async () => 'migrated' })
  await carry.sync()
})
