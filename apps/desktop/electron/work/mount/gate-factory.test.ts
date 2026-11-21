import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ACCOUNT, DEVICE } from '../gate/test-support'

import { createWorkGateService, workSocketPath } from './gate-factory'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const dir = () => {
  const made = mkdtempSync(join(tmpdir(), 'work-factory-'))

  dirs.push(made)

  return made
}

describe('the gate’s socket path', () => {
  it('is short, per account, and stable', () => {
    const a = workSocketPath({ key: 'account-a' }, '/base/dir/w')
    const b = workSocketPath({ key: 'account-b' }, '/base/dir/w')

    expect(a).not.toBe(b)
    expect(a).toBe(workSocketPath({ key: 'account-a' }, '/base/dir/w'))
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(100)
  })

  it('refuses a base that would make the path too long for the platform’s ingress, instead of binding somewhere else', () => {
    expect(() => workSocketPath({ key: 'a' }, `/${'x'.repeat(120)}`)).toThrow('socket_path_too_long')
  })
})

describe('createWorkGateService', () => {
  it('builds one account’s gate in its own directory, closed until the owner accepts the Work screen', async () => {
    const root = dir()

    const service = createWorkGateService({
      account: { key: 'acct', generation: 1, root, accountId: ACCOUNT },
      deviceServiceId: DEVICE,
      platform: { enroll: async () => ({ work: null }), pull: async () => { throw new Error('offline') }, ack: async () => undefined, macEvent: async () => undefined, carryGrant: async () => undefined },
      owner: { fetch: async () => ({ kind: 'unreachable' }) },
      incarnation: () => undefined,
      authTools: () => ({ executable: '/nonexistent/t3', environment: {} }),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString() },
      modelAccess: async () => 'allowed',
      held: () => false,
      socketBase: join(dir(), 'w')
    })

    try {
      expect(existsSync(join(root, 'work', 'gate', 'ledger.sqlite'))).toBe(true)
      expect(service.state()).toMatchObject({ phase: 'closed', workGrantAccepted: false, routeOpen: false, enrolled: false, socket: 'unbound', continuation: false })
    } finally {
      await service.close()
    }
  })
})
