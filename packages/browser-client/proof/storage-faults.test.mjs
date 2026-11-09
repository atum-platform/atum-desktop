import assert from 'node:assert/strict'
import test from 'node:test'
import { faultRecords } from './storage-faults.mjs'
import { browserTools } from './browser-tools.mjs'

test('each storage fault changes only its explicit field; the original is untouched', () => {
  const active = { kind: 'session', phase: 'active', deviceId: 'fixture-device', issuer: 'https://localhost:22981/', storageKey: 'fixture-key', userId: 'fixture-user', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }
  const before = structuredClone(active)
  const cases = faultRecords(active)
  assert.equal(cases.length, 5)
  const changed = ['storageKey', 'issuer', 'deviceId', 'phase', null]
  for (let i = 0; i < cases.length; i++) {
    const record = cases[i][1]
    assert.notEqual(record, active)
    for (const key of Object.keys(active)) assert.equal(record[key] === active[key], key !== changed[i])
  }
  assert.deepEqual(active, before)
})

test('storage faults require an active fixture, never invent an account/device', () => {
  for (const value of [undefined, {}, { kind: 'login', phase: 'active' }, { kind: 'session', phase: 'blocked' }]) assert.throws(() => faultRecords(value), /active_fixture_required/)
})

test('browser tools refuse missing, relative and extra paths before loading a module', () => {
  for (const args of [[], ['relative', '/missing'], ['/missing', 'relative'], ['/missing', '/missing'], ['/missing', '/missing', 'extra']]) assert.throws(() => browserTools(args), /Supply absolute paths/)
})
