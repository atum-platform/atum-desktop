import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  carryMatrixHermesHome,
  MATRIX_AUTOMATIC_REENROLLMENTS,
  MatrixAgentReenrollments,
  type MatrixAgentReenrollPort,
  matrixReenrollKey,
  reenrollMatrixAgent
} from './agent-reenroll'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function ledger(start = 0) {
  let saved: string | null = null
  let time = start

  const value = new MatrixAgentReenrollments(
    {
      read: () => saved,
      write: next => {
        saved = next
      }
    },
    () => time
  )

  return { ledger: value, advance: (ms: number) => (time += ms), saved: () => saved }
}

function port(device = { userId: '@agent-moon:test', deviceId: 'ATUM_AGENT_eedb46f9' }) {
  const steps: string[] = []
  const lines: string[] = []

  const value: MatrixAgentReenrollPort = {
    label: '3e4e6736',
    device: () => device,
    stop: vi.fn(async () => void steps.push('stop')),
    revoke: vi.fn(async () => void steps.push('revoke')),
    erase: vi.fn(async (erased: { deviceId: string }) => void steps.push(`erase:${erased.deviceId}`)),
    restart: vi.fn(() => void steps.push('restart')),
    log: line => lines.push(line)
  }

  return { port: value, steps, lines }
}

const MOON = matrixReenrollKey('owner-principal', 'agent-moon')

describe('replacing one agent’s executor on this Mac', () => {
  it('stops it, withdraws the old executor, erases the dead device’s store, then starts the gate again', async () => {
    const { port: agent, steps, lines } = port()

    expect(await reenrollMatrixAgent(agent, ledger().ledger, MOON, 'device_replaced')).toBe('started')
    expect(steps).toEqual(['stop', 'revoke', 'erase:ATUM_AGENT_eedb46f9', 'restart'])
    expect(lines).toEqual(['[Matrix] agent 3e4e6736 executor replaced reason=device_replaced'])
  })

  it(`replaces automatically at most ${MATRIX_AUTOMATIC_REENROLLMENTS} times a day, then leaves it to the person`, async () => {
    const { ledger: bound, advance } = ledger(1_000)

    for (let attempt = 0; attempt < MATRIX_AUTOMATIC_REENROLLMENTS; attempt++) {
      expect(await reenrollMatrixAgent(port().port, bound, MOON, 'device_replaced')).toBe('started')
    }

    const capped = port()
    expect(await reenrollMatrixAgent(capped.port, bound, MOON, 'device_replaced')).toBe('capped')
    expect(capped.steps).toEqual([])
    expect(capped.lines).toEqual(['[Matrix] agent 3e4e6736 executor replacement capped reason=device_replaced'])

    // Another agent has its own bound; the person's Reconnect is never capped here.
    expect(
      await reenrollMatrixAgent(
        port().port,
        bound,
        matrixReenrollKey('owner-principal', 'agent-other'),
        'device_replaced'
      )
    ).toBe('started')
    expect(await reenrollMatrixAgent(port().port, bound, MOON, 'person')).toBe('started')
    expect(await reenrollMatrixAgent(port().port, bound, MOON, 'policy')).toBe('started')

    // A day later, automatic replacement is allowed again.
    advance(24 * 60 * 60 * 1000)
    expect(await reenrollMatrixAgent(port().port, bound, MOON, 'device_replaced')).toBe('started')
  })

  it('keeps no principal in the clear', async () => {
    const { ledger: bound, saved } = ledger(5)
    await reenrollMatrixAgent(port().port, bound, MOON, 'device_replaced')
    expect(saved()).not.toContain('agent-moon')
    expect(Object.keys(JSON.parse(saved()!))).toEqual([MOON])
  })

  it('a ledger that cannot be read caps automatic replacements; the person’s Reconnect still works', async () => {
    for (const read of [
      () => {
        throw new Error('auth_storage_decrypt_failed')
      },
      () => '{not json',
      () => '[1, 2]'
    ]) {
      const broken = new MatrixAgentReenrollments({ read, write: () => {} })
      const capped = port()

      expect(broken.allowed(MOON)).toBe(false)
      expect(await reenrollMatrixAgent(capped.port, broken, MOON, 'device_replaced')).toBe('capped')
      expect(capped.steps).toEqual([])
      expect(await reenrollMatrixAgent(port().port, broken, MOON, 'person')).toBe('started')
    }
  })

  it('a write that fails (a full disk) never loosens the bound: this run keeps its own copy', async () => {
    const full = new MatrixAgentReenrollments({
      read: () => null,
      write: () => {
        throw new Error('auth_storage_write_failed')
      }
    })

    for (let attempt = 0; attempt < MATRIX_AUTOMATIC_REENROLLMENTS; attempt++) {
      expect(await reenrollMatrixAgent(port().port, full, MOON, 'device_replaced')).toBe('started')
    }

    expect(await reenrollMatrixAgent(port().port, full, MOON, 'device_replaced')).toBe('capped')
  })

  it('stops before restarting when the old executor cannot be withdrawn, and the person can finish it', async () => {
    const { port: agent, steps } = port()
    vi.mocked(agent.revoke).mockRejectedValueOnce(new Error('matrix_enrollment_unavailable'))

    await expect(reenrollMatrixAgent(agent, ledger().ledger, MOON, 'device_replaced')).rejects.toThrow(
      'matrix_enrollment_unavailable'
    )
    expect(steps).toEqual(['stop'])

    expect(await reenrollMatrixAgent(agent, ledger().ledger, MOON, 'person')).toBe('started')
    expect(steps).toEqual(['stop', 'stop', 'revoke', 'erase:ATUM_AGENT_eedb46f9', 'restart'])
  })

  it('still restarts when the dead device’s store cannot be erased', async () => {
    const { port: agent, steps, lines } = port()
    vi.mocked(agent.erase).mockRejectedValueOnce(new Error('busy'))

    expect(await reenrollMatrixAgent(agent, ledger().ledger, MOON, 'device_replaced')).toBe('started')
    expect(steps).toEqual(['stop', 'revoke', 'restart'])
    expect(lines[0]).toBe('[Matrix] agent 3e4e6736 old device store not erased')
  })
})

describe('the default agent’s home following it to a new executor', () => {
  function profiles() {
    const directory = mkdtempSync(path.join(tmpdir(), 'atum-profiles-'))
    directories.push(directory)

    return directory
  }

  it('moves the old home, with its memory, to the new executor’s name', () => {
    const root = profiles()
    const from = path.join(root, 'a'.repeat(64))
    const to = path.join(root, 'b'.repeat(64))
    mkdirSync(path.join(from, 'memories'), { recursive: true })
    writeFileSync(path.join(from, 'memories', 'MEMORY.md'), 'Minh prefers quiet cafés.')
    const lines: string[] = []

    expect(carryMatrixHermesHome(from, to, line => lines.push(line))).toBe(true)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(path.join(to, 'memories', 'MEMORY.md'), 'utf8')).toBe('Minh prefers quiet cafés.')
    expect(lines).toEqual(['[Matrix] assistant home moved to its new executor'])
  })

  it('never overwrites a home that exists, never leaves the profiles folder, and needs an old home', () => {
    const root = profiles()
    const from = path.join(root, 'a'.repeat(64))
    const to = path.join(root, 'b'.repeat(64))
    mkdirSync(from)
    mkdirSync(to)

    expect(carryMatrixHermesHome(from, to, () => {})).toBe(false)
    expect(existsSync(from)).toBe(true)

    const elsewhere = path.join(profiles(), 'c'.repeat(64))
    expect(carryMatrixHermesHome(from, elsewhere, () => {})).toBe(false)
    expect(carryMatrixHermesHome(path.join(root, 'd'.repeat(64)), path.join(root, 'e'.repeat(64)), () => {})).toBe(
      false
    )
    expect(carryMatrixHermesHome(from, from, () => {})).toBe(false)
  })
})
