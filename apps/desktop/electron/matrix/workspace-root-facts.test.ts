import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { readMatrixWorkspaceDriveRoots } from './workspace-root-facts'

let folder: string
let file: string
const emptyBindings = { keys: () => [], getItem: () => null, failureCode: () => null }

let store: EncryptedStore

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'atum-workspace-root-facts-'))
  file = path.join(folder, 'sealed-roots.json')
  store = new EncryptedStore(file, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })
})

afterEach(() => rmSync(folder, { recursive: true, force: true }))

test('a genuinely missing file has no failure and preserves current root facts without writing', () => {
  const live = path.join(folder, 'live-drive')
  expect(readMatrixWorkspaceDriveRoots(store, emptyBindings, [live])).toEqual([live])
  expect(store.failureCode()).toBeNull()
  expect(() => readFileSync(file)).toThrow()
})

test('disconnected roots and earlier account roots remain protected and inputs stay unchanged', () => {
  const historic = path.join(folder, 'historic-drive')
  const previous = [path.join(folder, 'previous-drive')]
  const live = [path.join(folder, 'live-drive'), historic]
  store.setItem('roots', JSON.stringify([historic]))
  const before = readFileSync(file)
  expect(readMatrixWorkspaceDriveRoots(store, emptyBindings, live, previous)).toEqual([previous[0], historic, live[0]])
  expect(readMatrixWorkspaceDriveRoots(store, emptyBindings, [], previous)).toEqual([previous[0], historic])
  expect(live).toEqual([path.join(folder, 'live-drive'), historic])
  expect(previous).toEqual([path.join(folder, 'previous-drive')])
  expect(readFileSync(file)).toEqual(before)
})

test('corrupt sealed storage is unavailable, rather than empty history, and its bytes are retained', () => {
  const bytes = '{synthetic-corrupt-record'
  writeFileSync(file, bytes)
  expect(() => readMatrixWorkspaceDriveRoots(store, emptyBindings)).toThrow('workspace_layout_deferred')
  expect(store.failureCode()).not.toBeNull()
  expect(readFileSync(file, 'utf8')).toBe(bytes)
})

test('decryption refusal cannot erase remembered protection', () => {
  store.setItem('roots', JSON.stringify([path.join(folder, 'historic-drive')]))
  const before = readFileSync(file)

  const unavailable = new EncryptedStore(file, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: () => {
      throw new Error('synthetic decryption refusal')
    }
  })

  expect(() =>
    readMatrixWorkspaceDriveRoots(unavailable, emptyBindings, [], [path.join(folder, 'prior-drive')])
  ).toThrow('workspace_layout_deferred')
  expect(readFileSync(file)).toEqual(before)
})

test.each(['{"privatePath":"/synthetic/private"', '{}', '["relative/path"]', '[null]', '["/root\\u0000bad"]'])(
  'malformed root history emits a closed code and leaves the sealed record intact',
  raw => {
    store.setItem('roots', raw)
    const before = readFileSync(file)
    expect(store.failureCode()).toBeNull()
    expect(() => readMatrixWorkspaceDriveRoots(store, emptyBindings)).toThrow(/^workspace_layout_deferred$/)
    expect(readFileSync(file)).toEqual(before)
  }
)

test('the binding port reads every account root and skips tombstones without decrypting other keys', () => {
  const drive = new EncryptedStore(path.join(folder, 'drive.json'), {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  })

  const old = path.join(folder, 'old-account-drive')
  const other = path.join(folder, 'other-account-drive')
  drive.setItems({
    'drive-root:old-account': JSON.stringify({ root: old, dev: 1, ino: 2 }),
    'drive-root:other-account': JSON.stringify({ root: other, dev: 3, ino: 4 }),
    'drive-root:disconnected': '',
    'drive-auth:old-account': 'synthetic-not-a-root'
  })
  const before = readFileSync(path.join(folder, 'drive.json'))
  const getItem = vi.fn((key: string) => drive.getItem(key))
  const keys = vi.fn(() => ['drive-root:old-account', 'drive-root:other-account', 'drive-root:disconnected'])

  expect(readMatrixWorkspaceDriveRoots(store, { keys, getItem, failureCode: () => drive.failureCode() })).toEqual([
    old,
    other
  ])
  expect(keys).toHaveBeenCalledWith('drive-root:')
  expect(getItem.mock.calls.map(([key]) => key)).toEqual(keys.mock.results[0].value)
  expect(readFileSync(path.join(folder, 'drive.json'))).toEqual(before)
})

test.each(['null', '{}', '{"root":"/drive","dev":1,"ino":"2"}', '{"root":"relative","dev":1,"ino":2}', '{'])(
  'a malformed legacy binding defers rather than treating a first upgrade as unbound',
  raw => {
    store.setItem('drive-root:inactive', raw)
    const before = readFileSync(file)

    const bindings = {
      keys: () => ['drive-root:inactive'],
      getItem: (key: string) => store.getItem(key),
      failureCode: () => store.failureCode()
    }

    expect(() => readMatrixWorkspaceDriveRoots(store, bindings)).toThrow(/^workspace_layout_deferred$/)
    expect(readFileSync(file)).toEqual(before)
  }
)

test('a disappeared binding or failed enumeration never authorizes an empty-root migration', () => {
  expect(() => readMatrixWorkspaceDriveRoots(store, { ...emptyBindings, keys: () => ['drive-root:missing'] })).toThrow(
    /^workspace_layout_deferred$/
  )
  expect(() =>
    readMatrixWorkspaceDriveRoots(store, {
      ...emptyBindings,
      keys: () => {
        throw new Error('synthetic private path must not escape')
      }
    })
  ).toThrow(/^workspace_layout_deferred$/)
})
