import { describe, expect, it, vi } from 'vitest'

import type { MatrixSdkCommand } from '../../shared/matrix'

import { ensureMatrixOwnerRecovery, type MatrixOwnerRecoveryPort } from './owner-recovery'

/** A sample, never a real key. */
const KEY = 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666'

function port(overrides: Partial<MatrixOwnerRecoveryPort> = {}) {
  const commands: MatrixSdkCommand[] = []
  const remembered: string[] = []

  const value: MatrixOwnerRecoveryPort = {
    remembered: () => undefined,
    storage: () => 'absent',
    command: vi.fn(async (command: MatrixSdkCommand) => {
      commands.push(command)

      if (command.kind === 'recoveryCreateKey') {
        return { id: 'staged', key: KEY }
      }

      if (command.kind === 'ownerRecovery') {
        return KEY
      }

      return null
    }),
    remember: key => void remembered.push(key),
    assertCurrent: () => {},
    ...overrides
  }

  return { port: value, commands, remembered }
}

describe("a first Mac's recovery key", () => {
  it('is made and kept on this Mac when the account has none, so nothing waits on the person', async () => {
    const { port: first, commands, remembered } = port()

    await expect(ensureMatrixOwnerRecovery(first)).resolves.toBe(KEY)
    expect(commands).toEqual([
      { kind: 'recoveryCreateKey' },
      { kind: 'ownerRecovery', command: { kind: 'recoverySetUp', id: 'staged' } }
    ])
    expect(remembered).toEqual([KEY])
  })

  it('is the one this Mac already keeps, without asking the SDK for anything', async () => {
    const { port: kept, commands, remembered } = port({ remembered: () => 'kept-key', storage: () => 'present' })

    await expect(ensureMatrixOwnerRecovery(kept)).resolves.toBe('kept-key')
    expect(commands).toEqual([])
    expect(remembered).toEqual([])
  })

  it('is never made when the account already has one: another Mac asks the person for it', async () => {
    const { port: second, commands } = port({ storage: () => 'present' })

    await expect(ensureMatrixOwnerRecovery(second)).resolves.toBeUndefined()
    expect(commands).toEqual([])
  })

  it('is never guessed before the account has synced', async () => {
    const { port: early, commands } = port({ storage: () => undefined })

    await expect(ensureMatrixOwnerRecovery(early)).rejects.toThrow('matrix_recovery_unknown')
    expect(commands).toEqual([])
  })

  it('is forgotten, not kept, when the SDK could not set it up (an identity appeared meanwhile)', async () => {
    const failing = port()

    failing.port.command = vi.fn(async (command: MatrixSdkCommand) => {
      failing.commands.push(command)

      if (command.kind === 'recoveryCreateKey') {
        return { id: 'staged', key: KEY }
      }

      if (command.kind === 'ownerRecovery') {
        throw new Error('matrix_recovery_exists')
      }

      return null
    })

    await expect(ensureMatrixOwnerRecovery(failing.port)).resolves.toBeUndefined()
    expect(failing.commands.at(-1)).toEqual({ kind: 'recoveryDiscard' })
    expect(failing.remembered).toEqual([])
  })

  it('leaves an identity it cannot see the key for to the person, and lets other failures retry', async () => {
    const existing = port()

    existing.port.command = vi.fn(async () => {
      throw new Error('matrix_recovery_exists')
    })

    // Undefined: the person is asked for their key (recovery_required), nothing is replaced.
    await expect(ensureMatrixOwnerRecovery(existing.port)).resolves.toBeUndefined()
    expect(existing.remembered).toEqual([])

    const offline = port()

    offline.port.command = vi.fn(async () => {
      throw new Error('network')
    })

    await expect(ensureMatrixOwnerRecovery(offline.port)).rejects.toThrow('network')
    expect(offline.remembered).toEqual([])
  })

  it('is not kept when the SDK confirms a different key', async () => {
    const mismatch = port()

    mismatch.port.command = vi.fn(async (command: MatrixSdkCommand) =>
      command.kind === 'recoveryCreateKey' ? { id: 'staged', key: KEY } : command.kind === 'ownerRecovery' ? 'other' : null
    )

    await expect(ensureMatrixOwnerRecovery(mismatch.port)).rejects.toThrow('matrix_recovery_incomplete')
    expect(mismatch.remembered).toEqual([])
  })

  it('stops, keeping nothing, once the account or device changed mid-way', async () => {
    let current = true

    const { port: stale, remembered } = port({
      assertCurrent: () => {
        if (!current) {
          throw new Error('matrix_agent_identity_stale')
        }
      }
    })

    stale.command = vi.fn(async (command: MatrixSdkCommand) => {
      if (command.kind === 'recoveryCreateKey') {
        current = false

        return { id: 'staged', key: KEY }
      }

      return KEY
    })

    await expect(ensureMatrixOwnerRecovery(stale)).rejects.toThrow('matrix_agent_identity_stale')
    expect(remembered).toEqual([])
  })

  it('refuses a malformed key from the SDK', async () => {
    const { port: odd, remembered } = port()

    odd.command = vi.fn(async () => ({ id: 'staged', key: 'x'.repeat(300) }))

    await expect(ensureMatrixOwnerRecovery(odd)).rejects.toThrow('matrix_recovery_invalid')
    expect(remembered).toEqual([])
  })

  it('never writes the key anywhere but the port, made, failed or refused', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = methods.map(method => vi.spyOn(console, method).mockImplementation(() => {}))

    try {
      await ensureMatrixOwnerRecovery(port().port)

      const mismatch = port()
      mismatch.port.command = vi.fn(async (command: MatrixSdkCommand) =>
        command.kind === 'recoveryCreateKey' ? { id: 'staged', key: KEY } : 'other'
      )
      await expect(ensureMatrixOwnerRecovery(mismatch.port)).rejects.toThrow()

      const keyInError = port()
      keyInError.port.command = vi.fn(async (command: MatrixSdkCommand) => {
        if (command.kind === 'recoveryCreateKey') {
          return { id: 'staged', key: KEY }
        }

        throw new Error('matrix_recovery_incomplete')
      })
      const failure = await ensureMatrixOwnerRecovery(keyInError.port).catch((error: unknown) => error)
      // What callers see on failure names the step, never the key.
      expect(String(failure)).not.toContain(KEY)

      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY)
      }
    } finally {
      spies.forEach(spy => spy.mockRestore())
    }
  })
})
