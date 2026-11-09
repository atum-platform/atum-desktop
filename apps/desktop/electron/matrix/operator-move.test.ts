import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { matrixUserDataPath } from './app-identity'
import { matrixLaunchConfigPath } from './launch-config'
import {
  nodeOperatorFiles,
  OPERATOR_MOVE_FILE,
  type OperatorMoveDeps,
  operatorMoveDirectory,
  operatorMoveTicker,
  runOperatorMove
} from './operator-move'

const P = '00000000-0000-4000-8000-6782f1709758'
const T = '00000000-0000-4000-8000-cf4c4732fd3b'
const DIR = '/u/operator'
const FILE = `${DIR}/${OPERATOR_MOVE_FILE}`

function rig(initial: string | null, over: Partial<OperatorMoveDeps> = {}) {
  const store = new Map<string, string>()

  if (initial !== null) {
    store.set(FILE, initial)
  }

  const move = vi.fn<OperatorMoveDeps['move']>(async () => ({
    state: 'failed',
    step: 'switch',
    code: 'matrix_migration_switch_failed'
  }))

  const deps: OperatorMoveDeps = {
    directory: DIR,
    allowed: [P],
    files: {
      read: file => store.get(file) ?? null,
      rename: (from, to) => {
        store.set(to, store.get(from)!)
        store.delete(from)
      },
      write: (file, text) => void store.set(file, text)
    },
    ready: () => true,
    move,
    now: () => 1_700_000_000_000,
    log: () => {},
    ...over
  }

  return { deps, store, move }
}

const trigger = JSON.stringify({ v: 1, principal: P, token: T })

describe('where the operator drops the trigger', () => {
  const appData = '/home/example/Library/Application Support'

  it('is the folder the operator already uses for public-config.json, not the per-configuration userData', () => {
    const directory = operatorMoveDirectory(appData)

    // Beside the operator's configuration file: one place an operator can name without a hash.
    expect(path.dirname(directory)).toBe(path.dirname(matrixLaunchConfigPath(appData)))
    expect(directory).toBe(path.join(appData, 'Atum Matrix Candidate', 'operator'))

    // Electron's userData is <identity folder>/<profile>/<configuration hash>: a file dropped in
    // the identity folder's operator/ is not under it, and the app must not look for it there.
    const userData = matrixUserDataPath(appData, 'candidate', 'a'.repeat(64))
    expect(path.relative(userData, directory).startsWith('..')).toBe(true)
    expect(path.join(userData, 'operator')).not.toBe(directory)
  })
})

describe('operator move trigger', () => {
  it('does nothing without a trigger file', async () => {
    const { deps, move } = rig(null)
    expect(await runOperatorMove(deps)).toBe('idle')
    expect(move).not.toHaveBeenCalled()
  })

  it('consumes the trigger before it moves, moves once, and writes a closed-code receipt', async () => {
    const { deps, store, move } = rig(trigger)
    const order: string[] = []
    move.mockImplementation(async () => {
      order.push(store.has(FILE) ? 'trigger-still-there' : 'trigger-consumed')

      return { state: 'failed', step: 'switch', code: 'matrix_migration_switch_failed' }
    })

    expect(await runOperatorMove(deps)).toBe('ran')
    expect(order).toEqual(['trigger-consumed'])
    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith(P)
    expect(store.has(FILE)).toBe(false)
    const receipt = JSON.parse(store.get(`${FILE}.consumed-${T}.receipt.json`)!)
    expect(receipt).toMatchObject({ v: 1, principal: P, token: T, state: 'failed', step: 'switch', code: 'matrix_migration_switch_failed' })
    // a second tick finds nothing: at most once
    expect(await runOperatorMove(deps)).toBe('idle')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('records a committed move as moved', async () => {
    const { deps, store, move } = rig(trigger)
    move.mockResolvedValue({ state: 'moved' })
    expect(await runOperatorMove(deps)).toBe('ran')
    expect(JSON.parse(store.get(`${FILE}.consumed-${T}.receipt.json`)!)).toMatchObject({ state: 'moved' })
  })

  it('refuses an agent that is not allow-listed and sets the file aside', async () => {
    const { deps, store, move } = rig(trigger, { allowed: [] })
    expect(await runOperatorMove(deps)).toBe('refused')
    expect(move).not.toHaveBeenCalled()
    expect(store.has(FILE)).toBe(false)
    expect([...store.keys()].some(key => key.includes('.refused-') && key.endsWith('not_allow_listed'))).toBe(true)
  })

  it('refuses another agent even when it is ready, so the trigger names exactly one allow-listed agent', async () => {
    const other = '00000000-0000-4000-8000-11e594f48195'
    const { deps, move } = rig(JSON.stringify({ v: 1, principal: other, token: T }))
    expect(await runOperatorMove(deps)).toBe('refused')
    expect(move).not.toHaveBeenCalled()
  })

  it.each(['not json', '{"v":2,"principal":"x","token":"y"}', JSON.stringify({ v: 1, principal: 'no', token: T })])(
    'refuses a malformed trigger (%s)',
    async text => {
      const { deps, move } = rig(text)
      expect(await runOperatorMove(deps)).toBe('refused')
      expect(move).not.toHaveBeenCalled()
    }
  )

  it('refuses a trigger the files layer reports as unsafe, without reading it as a request', async () => {
    const { deps, store, move } = rig(trigger, {
      files: {
        read: () => {
          throw new Error('operator_move_unsafe')
        },
        rename: (from, to) => {
          store.set(to, store.get(from) ?? '')
          store.delete(from)
        },
        write: () => {}
      }
    })

    expect(await runOperatorMove(deps)).toBe('refused')
    expect(move).not.toHaveBeenCalled()
    expect([...store.keys()].some(key => key.endsWith('-unsafe'))).toBe(true)
  })

  it('keeps the file and waits while the agent is not ready, then moves once when it is', async () => {
    let ready = false
    const { deps, store, move } = rig(trigger, { ready: () => ready })
    expect(await runOperatorMove(deps)).toBe('waiting')
    expect(await runOperatorMove(deps)).toBe('waiting')
    expect(store.get(FILE)).toBe(trigger)
    expect(move).not.toHaveBeenCalled()

    ready = true
    expect(await runOperatorMove(deps)).toBe('ran')
    expect(await runOperatorMove(deps)).toBe('idle')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('records a thrown move as a closed error and still never repeats it', async () => {
    const { deps, store, move } = rig(trigger)
    move.mockRejectedValue(new Error('matrix_migration_device_offline'))
    expect(await runOperatorMove(deps)).toBe('ran')
    expect(JSON.parse(store.get(`${FILE}.consumed-${T}.receipt.json`)!)).toMatchObject({ state: 'error', code: 'matrix_migration_device_offline' })
    move.mockRejectedValue(new Error('Some free text with /home/example/path'))
    expect(await runOperatorMove(deps)).toBe('idle')
  })

  it('never writes free text from an error into the receipt', async () => {
    const { deps, store, move } = rig(trigger)
    move.mockRejectedValue(new Error('/home/example/Library/secret path'))
    await runOperatorMove(deps)
    expect(store.get(`${FILE}.consumed-${T}.receipt.json`)).not.toContain('/Users')
    expect(JSON.parse(store.get(`${FILE}.consumed-${T}.receipt.json`)!).code).toBe('unexpected')
  })

  it('starts nothing when the trigger cannot be consumed', async () => {
    const { deps, move } = rig(trigger, {
      files: {
        read: () => trigger,
        rename: () => {
          throw new Error('EACCES')
        },
        write: () => {}
      }
    })

    expect(await runOperatorMove(deps)).toBe('failed')
    expect(move).not.toHaveBeenCalled()
  })

  it('does not throw when the receipt cannot be written, or a refused file cannot be set aside', async () => {
    const lines: string[] = []

    const receipt = rig(trigger, {
      log: line => lines.push(line),
      files: {
        read: () => trigger,
        rename: () => {},
        write: () => {
          throw new Error('ENOSPC')
        }
      }
    })

    expect(await runOperatorMove(receipt.deps)).toBe('ran')
    expect(lines.some(line => line.includes('receipt could not be written'))).toBe(true)

    const aside = rig('not json', {
      log: line => lines.push(line),
      files: {
        read: () => 'not json',
        rename: () => {
          throw new Error('EACCES')
        },
        write: () => {}
      }
    })

    expect(await runOperatorMove(aside.deps)).toBe('refused')
  })
})

describe('operator move poll', () => {
  it('answers busy while a move runs, and runs again once it has ended', async () => {
    const { deps, move } = rig(trigger)
    let finish!: () => void

    move.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ state: 'moved' })
        })
    )

    const tick = operatorMoveTicker(() => deps)
    const first = tick()
    expect(await tick()).toBe('busy')
    expect(await tick()).toBe('busy')
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1))
    finish()
    expect(await first).toBe('ran')
    expect(await tick()).toBe('idle')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('says once, not on every tick, that a trigger is waiting for its agent', async () => {
    const lines: string[] = []
    let ready = false
    const { deps } = rig(trigger, { ready: () => ready, log: line => lines.push(line) })
    const tick = operatorMoveTicker(() => deps)

    for (let index = 0; index < 4; index += 1) {
      expect(await tick()).toBe('waiting')
    }

    expect(lines.filter(line => line.includes('waiting'))).toHaveLength(1)
    ready = true
    expect(await tick()).toBe('ran')
  })

  it('does nothing while this Mac is not in a position to start a move', async () => {
    const { deps, move } = rig(trigger)
    let prepared = false
    const tick = operatorMoveTicker(() => (prepared ? deps : null))
    expect(await tick()).toBe('off')
    expect(move).not.toHaveBeenCalled()
    prepared = true
    expect(await tick()).toBe('ran')
  })

  it('survives a tick that throws and is not stuck busy afterwards', async () => {
    const { deps, move } = rig(trigger)
    let broken = true

    const tick = operatorMoveTicker(() => ({
      ...deps,
      ready: () => {
        if (broken) {
          throw new TypeError('boom')
        }

        return true
      }
    }))

    expect(await tick()).toBe('failed')
    expect(move).not.toHaveBeenCalled()
    broken = false
    expect(await tick()).toBe('ran')
    expect(move).toHaveBeenCalledTimes(1)
  })
})

describe('operator move files on disk', () => {
  let userData: string
  let directory: string

  beforeEach(() => {
    userData = mkdtempSync(path.join(os.tmpdir(), 'operator-move-'))
    directory = path.join(userData, 'operator')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  })

  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  const file = () => path.join(directory, OPERATOR_MOVE_FILE)

  const disk = (over: Partial<OperatorMoveDeps> = {}) => {
    const move = vi.fn<OperatorMoveDeps['move']>(async () => ({ state: 'moved' }))

    const deps: OperatorMoveDeps = {
      directory,
      allowed: [P],
      files: nodeOperatorFiles(),
      ready: () => true,
      move,
      now: () => 1_700_000_000_000,
      log: () => {},
      ...over
    }

    return { deps, move }
  }

  it('reads nothing when the folder or the file is absent', () => {
    expect(nodeOperatorFiles().read(path.join(userData, 'nowhere', OPERATOR_MOVE_FILE))).toBeNull()
    expect(nodeOperatorFiles().read(file())).toBeNull()
  })

  it('runs a private trigger end to end: consumed, moved once, receipt beside it', async () => {
    writeFileSync(file(), `${trigger}\n`, { mode: 0o600 })
    const { deps, move } = disk()

    expect(await runOperatorMove(deps)).toBe('ran')
    expect(move).toHaveBeenCalledTimes(1)
    expect(existsSync(file())).toBe(false)
    expect(readdirSync(directory).sort()).toEqual([`${OPERATOR_MOVE_FILE}.consumed-${T}`, `${OPERATOR_MOVE_FILE}.consumed-${T}.receipt.json`])
    const receipt = JSON.parse(readFileSync(path.join(directory, `${OPERATOR_MOVE_FILE}.consumed-${T}.receipt.json`), 'utf8'))
    expect(receipt).toMatchObject({ v: 1, principal: P, token: T, state: 'moved' })
    expect(await runOperatorMove(deps)).toBe('idle')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('picks up a trigger written where the operator is told to write it, next to public-config.json', async () => {
    // The operator writes beside the operator configuration file (documented path), nowhere else.
    const appData = path.join(userData, 'Application Support')
    const dropped = operatorMoveDirectory(appData)
    mkdirSync(dropped, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(dropped, OPERATOR_MOVE_FILE), `${trigger}\n`, { mode: 0o600 })

    const { deps, move } = disk({ directory: operatorMoveDirectory(appData) })

    expect(await runOperatorMove(deps)).toBe('ran')
    expect(move).toHaveBeenCalledWith(P)
    expect(existsSync(path.join(dropped, OPERATOR_MOVE_FILE))).toBe(false)
  })

  it('refuses a trigger that is a link, group-writable or too large, and never moves', async () => {
    const elsewhere = path.join(userData, 'elsewhere.json')
    writeFileSync(elsewhere, trigger, { mode: 0o600 })
    symlinkSync(elsewhere, file())
    const link = disk()
    expect(await runOperatorMove(link.deps)).toBe('refused')
    expect(link.move).not.toHaveBeenCalled()
    expect(readdirSync(directory).some(name => name.includes('.refused-') && name.endsWith('-unsafe'))).toBe(true)

    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file(), trigger, { mode: 0o600 })
    chmodSync(file(), 0o620)
    const writable = disk()
    expect(await runOperatorMove(writable.deps)).toBe('refused')
    expect(writable.move).not.toHaveBeenCalled()

    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file(), `${trigger}${' '.repeat(2048)}`, { mode: 0o600 })
    const large = disk()
    expect(await runOperatorMove(large.deps)).toBe('refused')
    expect(large.move).not.toHaveBeenCalled()
  })

  it('never replaces a receipt that exists', () => {
    const receipt = path.join(directory, 'receipt.json')
    nodeOperatorFiles().write(receipt, 'first')
    expect(() => nodeOperatorFiles().write(receipt, 'second')).toThrow()
    expect(readFileSync(receipt, 'utf8')).toBe('first')
  })
})
