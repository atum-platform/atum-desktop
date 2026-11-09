import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { MatrixDriveImportPlan } from '../../shared/matrix-drive'

import type { MatrixDrive } from './drive'
import { ASSISTANT_OUTPUT_BUDGET_BYTES, DRIVE_QUOTA_DEFAULT_BYTES, MatrixDriveImport } from './drive-import'
import type { MatrixDriveImportOptions } from './drive-import'
import type { NativeDriveImportTarget } from './drive-import-native'
import { registerMatrixDriveIpc } from './drive-ipc'

const native = process.platform === 'darwin' || process.platform === 'linux'

const python = native
  ? execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  : ''

let home: string
let drive: string
let source: string
let target: NativeDriveImportTarget
let options: MatrixDriveImportOptions

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-drive-import-plan-')))
  drive = path.join(home, 'Atum', 'Drive')
  source = path.join(home, 'work.txt')
  mkdirSync(drive, { recursive: true })
  writeFileSync(source, 'work')
  const root = statSync(drive)
  target = { root: drive, dev: root.dev, ino: root.ino, ownerKey: 'synthetic-owner:1' }
  options = { home, python, target: () => target, choose: async () => [source], protectedRoots: () => [] }
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

test('the warning reserve equals the actual vendored output budget', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../../../../packages/device-protocol/fixtures/workspace-transactions/contract.json', import.meta.url),
      'utf8'
    )
  )

  expect(ASSISTANT_OUTPUT_BUDGET_BYTES).toBe(contract.parameters.total_max_bytes)
  expect(DRIVE_QUOTA_DEFAULT_BYTES).toBe(1024 ** 3)
})

test.skipIf(!native).each(['ready', 'warning', 'blocked'] as const)(
  'real read-only planning returns a path-free %s sheet and negotiated quota',
  async state => {
    const remaining = state === 'ready' ? ASSISTANT_OUTPUT_BUDGET_BYTES + 4 : state === 'warning' ? 4 : 3

    const operations = new MatrixDriveImport({
      ...options,
      quota: () => ({ total: 100_000_000, used: 100_000_000 - remaining, remaining })
    })

    const plan = await operations.importPlan()
    expect(plan).toMatchObject({
      state,
      files: 1,
      bytes: 4,
      space: { remainingAfter: remaining - 4, estimated: false }
    })
    expect(JSON.stringify(plan)).not.toContain(home)
    expect(JSON.stringify(plan)).not.toContain('work.txt')
    expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
  }
)

test.skipIf(!native)('old engines use a labelled local estimate and actual native run keeps originals', async () => {
  writeFileSync(path.join(drive, 'existing.txt'), 'existing')
  const operations = new MatrixDriveImport(options)
  const plan = await operations.importPlan()
  expect(plan).toMatchObject({
    state: 'ready',
    space: {
      total: DRIVE_QUOTA_DEFAULT_BYTES,
      used: 8,
      remainingAfter: DRIVE_QUOTA_DEFAULT_BYTES - 12,
      estimated: true
    }
  })

  if ('planId' in plan) {
    expect(await operations.importRun(plan.planId)).toEqual({ state: 'completed', added: 1 })
    expect(readFileSync(source, 'utf8')).toBe('work')
    expect(readFileSync(path.join(drive, 'work.txt'), 'utf8')).toBe('work')
    expect(await operations.importRun(plan.planId)).toEqual({ state: 'expired', added: 0 })
  }
})

test.skipIf(!native)('the actual IPC handler runs native copy only from an admitted cached intent', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  const requireUi = vi.fn()
  const operations = new MatrixDriveImport(options)
  registerMatrixDriveIpc(
    {
      handle: vi.fn((_channel, callback) => {
        handler = callback
      })
    },
    {} as MatrixDrive,
    requireUi,
    undefined,
    operations
  )
  const event = {} as IpcMainInvokeEvent
  const plan = (await handler(event, { kind: 'importPlan' })) as MatrixDriveImportPlan
  expect(plan.state).toBe('ready')
  expect(JSON.stringify(plan)).not.toContain(home)

  if (!('planId' in plan)) {
    throw new Error('expected native plan')
  }

  await expect(handler(event, { kind: 'importRun', planId: plan.planId, path: source })).rejects.toThrow('invalid')
  requireUi.mockImplementationOnce(() => {
    throw new Error('caller denied')
  })
  await expect(handler(event, { kind: 'importRun', planId: plan.planId })).rejects.toThrow('caller denied')
  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  expect(await handler(event, { kind: 'importRun', planId: plan.planId })).toEqual({ state: 'completed', added: 1 })
  expect(readFileSync(source, 'utf8')).toBe('work')
  expect(readFileSync(path.join(drive, 'work.txt'), 'utf8')).toBe('work')
  expect(await handler(event, { kind: 'importRun', planId: plan.planId })).toEqual({ state: 'expired', added: 0 })
})

test.skipIf(!native)('protected roots are refreshed before copying and before placement', async () => {
  let protectedRoots: string[] = []
  const beforeCopy = new MatrixDriveImport({ ...options, protectedRoots: () => protectedRoots })
  const first = await beforeCopy.importPlan()

  if (!('planId' in first)) {
    throw new Error('expected native plan')
  }

  protectedRoots = [source]
  expect((await beforeCopy.importRun(first.planId)).state).toBe('unavailable')
  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)

  let reads = 0

  const beforePlacement = new MatrixDriveImport({
    ...options,
    protectedRoots: () => (++reads < 3 ? [] : [source])
  })

  const second = await beforePlacement.importPlan()

  if (!('planId' in second)) {
    throw new Error('expected native plan')
  }

  expect(await beforePlacement.importRun(second.planId)).toEqual({ state: 'cancelled', added: 0 })
  expect(readFileSync(source, 'utf8')).toBe('work')
  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  expect(existsSync(path.join(home, 'Atum', '.import', second.planId))).toBe(false)
})

test.skipIf(!native)('expired, cancelled and wrong-account intents cannot place or reuse a plan', async () => {
  let now = 1000
  const operations = new MatrixDriveImport({ ...options, now: () => now })
  const first = await operations.importPlan()
  expect(first.state).toBe('ready')

  if ('planId' in first) {
    now += 10 * 60_000
    expect(await operations.importRun(first.planId)).toEqual({ state: 'expired', added: 0 })
  }

  const second = await operations.importPlan()

  if ('planId' in second) {
    await operations.importCancel(second.planId)
    expect(await operations.importRun(second.planId)).toEqual({ state: 'expired', added: 0 })
  }

  const third = await operations.importPlan()

  if ('planId' in third) {
    target = { ...target, ownerKey: 'synthetic-owner:2' }
    expect(await operations.importRun(third.planId)).toEqual({ state: 'changed', added: 0 })
  }

  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
})

test.skipIf(!native)('a cancelled picker and a second concurrent picker never write or invoke a copy', async () => {
  let release!: () => void

  const chooser = vi.fn(
    () =>
      new Promise<undefined>(resolve => {
        release = () => resolve(undefined)
      })
  )

  const operations = new MatrixDriveImport({ ...options, choose: chooser })
  const pending = operations.importPlan()
  expect(await operations.importPlan()).toEqual({ state: 'refused', reason: 'busy' })
  release()
  expect(await pending).toEqual({ state: 'cancelled' })
  expect(chooser).toHaveBeenCalledOnce()
  expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
})

test.skipIf(!native)(
  'a blocked plan and malformed negotiated quota cannot fall back to an optimistic estimate',
  async () => {
    const operations = new MatrixDriveImport({ ...options, quota: () => ({ total: 3, used: 0, remaining: 3 }) })
    const plan = await operations.importPlan()
    expect(plan.state).toBe('blocked')

    if ('planId' in plan) {
      expect(await operations.importRun(plan.planId)).toEqual({ state: 'no_room', added: 0 })
    }

    const invalid = new MatrixDriveImport({ ...options, quota: () => ({ total: 100, used: 99, remaining: 100 }) })
    expect((await invalid.importPlan()).state).toBe('refused')
    expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  }
)

test.skipIf(!native)('a changed negotiated exclusion list invalidates a cached import before native copy', async () => {
  let patterns = ['token', '.env', '.git', 'node_modules']
  const operations = new MatrixDriveImport({ ...options, exclusions: () => patterns })
  const plan = await operations.importPlan()
  expect(plan.state).toBe('ready')

  if (!('planId' in plan)) {
    throw new Error('expected native plan')
  }

  patterns = [...patterns, 'work.txt']
  expect(await operations.importRun(plan.planId)).toEqual({ state: 'changed', added: 0 })
  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  expect(readFileSync(source, 'utf8')).toBe('work')
})

test.skipIf(!native)('an exclusion change during native staging refuses placement', async () => {
  let reads = 0
  const patterns = ['token', '.env', '.git', 'node_modules']

  const operations = new MatrixDriveImport({
    ...options,
    exclusions: () => (++reads < 3 ? patterns : [...patterns, 'work.txt'])
  })

  const plan = await operations.importPlan()

  if (!('planId' in plan)) {
    throw new Error('expected native plan')
  }

  expect(await operations.importRun(plan.planId)).toEqual({ state: 'cancelled', added: 0 })
  expect(existsSync(path.join(drive, 'work.txt'))).toBe(false)
  expect(readFileSync(source, 'utf8')).toBe('work')
})
