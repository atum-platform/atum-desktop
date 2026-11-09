import { generateKeyPairSync, sign as nodeSign, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { argsHash, keyId } from './canonical'
import { createDeviceRuntime, type DeviceRuntimeEnvironment, GRANTABLE } from './runtime'

const OWNER = '@owner:atumplatform.com'
const AGENT = '@agent-t:atumplatform.com'

function approvalKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer

  return {
    ref: { kid: keyId(spki), spki: spki.toString('base64url') },
    signer: {
      approve: vi.fn(async (bytes: Uint8Array, _reason: string) => ({
        kid: keyId(spki),
        sig: nodeSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
      }))
    }
  }
}

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }

  dirs = []
})

function environment(over: Partial<DeviceRuntimeEnvironment> = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'atum-device-runtime-'))
  dirs.push(userData)
  const data = new Map<string, string>()
  const key = approvalKeyPair()
  const sent: { type: string; body: Record<string, unknown> }[] = []

  const env: DeviceRuntimeEnvironment = {
    platform: 'linux',
    userData,
    home: '/home/example',
    appExecutable: '/Applications/Atum.app/Contents/MacOS/Atum',
    launcherPath: null,
    hermes: null,
    cuaDriverSocket: '/home/example/Library/Caches/cua-driver/cua-driver.sock',
    cuaDriverAvailable: () => true,
    store: { getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) },
    locale: () => 'vi',
    sshAuthSock: () => undefined,
    identity: () => ({ ownerUserId: OWNER, signedIn: true, localScopes: ['terminal', 'files'], cloudAgents: [AGENT] }),
    originLog: () => [],
    send: async (type, body) => {
      sent.push({ type, body })

      return true
    },
    accountEpoch: () => 7,
    signer: () => key.signer,
    approvalKey: () => key.ref,
    deviceServiceId: () => '00000000-0000-4000-8000-b86a6ca39e23',
    agentName: userId => (userId === AGENT ? 'T' : userId),
    deviceName: () => 'MacBook Pro',
    tray: { createTray: () => ({ setToolTip() {}, setContextMenu() {}, destroy() {} }), buildStopMenu: () => ({}), notify: () => {} },
    promptPassword: async () => null,
    ownApp: () => ({ bundlePath: '/Applications/Atum.app' }),
    log: () => {},
    ...over
  }

  return { env, key, sent, data }
}

describe('the device runtime', () => {
  it('says plainly when this Mac cannot run device commands, and offers nothing in its Hello', async () => {
    const { env } = environment()
    const runtime = createDeviceRuntime(env)
    await runtime.start()

    expect(runtime.hello()).toEqual({ terminal: false, files: false, computer: { available: false, reason: 'not_macos' } })
    expect(await runtime.request({ action: 'status' })).toMatchObject({ available: false, reason: 'not_macos', enrolled: true })

    const missing = createDeviceRuntime(environment({ platform: 'darwin' }).env)
    expect(missing.hello().computer).toEqual({ available: false, reason: 'launcher_missing' })
    await runtime.stop()
  })

  it('a command admitted while the runtime cannot run reports no effect, never silence', async () => {
    const { env, sent } = environment()
    const runtime = createDeviceRuntime(env)
    await runtime.start()

    const session = {
      connectionId: randomUUID(),
      connectionEpoch: 1,
      localGeneration: 1,
      deviceServiceId: env.deviceServiceId()!,
      enrollmentEpoch: 1,
      accountEpoch: 7
    }

    const now = Date.now()
    const grantId = randomUUID()

    const [ack] = await runtime.service.frame(
      {
        type: 'TurnGrant',
        verdict: 'ok',
        kid: 'k',
        receivedAt: performance.now(),
        body: {
          grantId,
          ownerUserId: OWNER,
          agentPrincipal: randomUUID(),
          agentUserId: AGENT,
          originKind: 'other',
          originAssertionHash: null,
          writerEpoch: { leaseGeneration: 1, leaseTokenHash: 'gDY09Edy88FdgWR6miyz0BiM2JsbZurUySyPwVe3Mt4' },
          targetDeviceServiceId: session.deviceServiceId,
          enrollmentEpoch: 1,
          accountEpoch: 7,
          scopes: ['terminal'],
          connectionId: session.connectionId,
          issuedAt: now,
          expiresAt: now + 60_000
        }
      },
      session
    )

    expect(ack.body.accepted).toBe(true)

    const args = { command: 'echo hi' }
    await runtime.service.frame(
      {
        type: 'Execute',
        verdict: 'ok',
        kid: 'k',
        receivedAt: performance.now(),
        body: {
          commandId: randomUUID(),
          grantId,
          seq: 1,
          connectionId: session.connectionId,
          connectionEpoch: 1,
          deviceServiceId: session.deviceServiceId,
          enrollmentEpoch: 1,
          accountEpoch: 7,
          tool: 'terminal',
          toolVersion: 1,
          args,
          argsHash: argsHash(args),
          inputManifestHash: null,
          needs: [],
          proposedEffect: 'ordinary',
          admitBy: now + 15_000,
          timeoutMs: 60_000,
          issuedAt: now
        }
      },
      session
    )

    await vi.waitFor(() => expect(sent.some(each => each.type === 'Receipt')).toBe(true))
    expect(sent.find(each => each.type === 'Receipt')!.body).toMatchObject({ state: 'failed_no_effect' })
    await runtime.stop()
  })

  it('Settings: a standing grant takes Touch ID, is per agent, lists with its agent and revokes', async () => {
    const lines: string[] = []
    const { env, key } = environment({ log: line => void lines.push(line) })
    const runtime = createDeviceRuntime(env)

    const created = (await runtime.request({ action: 'addGrant', capability: 'keychain', agentUserId: AGENT })) as { id: string }
    expect(key.signer.approve).toHaveBeenCalledTimes(1)
    // The sheet names the agent and the capability, in Vietnamese.
    expect(key.signer.approve.mock.calls[0][1]).toBe('Luôn cho phép T dùng Chuỗi khóa của bạn trên máy Mac này')

    const status = (await runtime.request({ action: 'status' })) as { grants: { id: string; agent: string; agentName: string }[]; grantable: string[] }
    expect(status.grants).toEqual([expect.objectContaining({ id: created.id, capability: 'keychain', agent: AGENT, agentName: 'T' })])
    expect(status.grantable).toEqual([...GRANTABLE])

    await runtime.request({ action: 'revokeGrant', id: created.id })
    expect(((await runtime.request({ action: 'status' })) as { grants: unknown[] }).grants).toEqual([])
    // Each outcome is one closed-code line: no agent, name or grant id.
    expect(lines.filter(line => line.includes('standing permission'))).toEqual([
      '[Device] standing permission added capability=keychain',
      '[Device] standing permission revoked'
    ])
  })

  it('Settings refuses a grant that is not grantable, for an agent that is not a cloud agent, or without enrollment', async () => {
    const { env } = environment()
    const runtime = createDeviceRuntime(env)

    await expect(runtime.request({ action: 'addGrant', capability: 'sudo', agentUserId: AGENT })).rejects.toThrow('device_grant_invalid')
    await expect(runtime.request({ action: 'addGrant', capability: 'keychain', agentUserId: '@stranger:x' })).rejects.toThrow('device_grant_invalid')

    const unenrolled = createDeviceRuntime(environment({ approvalKey: () => null }).env)
    await expect(unenrolled.request({ action: 'addGrant', capability: 'keychain', agentUserId: AGENT })).rejects.toThrow('device_not_enrolled')
    await expect(runtime.request({ action: 'nope' })).rejects.toThrow('device_request_invalid')
  })

  it('starts again after a stop: sign-out then sign-in in the same process runs a fresh start', async () => {
    const lines: string[] = []
    const { env } = environment({ log: line => void lines.push(line) })
    const runtime = createDeviceRuntime(env)

    await runtime.start()
    await runtime.start()
    expect(lines.filter(line => line.includes('runtime unavailable'))).toHaveLength(1)

    await runtime.stop()
    await runtime.start()
    expect(lines.filter(line => line.includes('runtime unavailable'))).toHaveLength(2)
    await runtime.stop()
  })

  it('a start racing a stop runs afresh after the teardown, never returning the memo being torn down', async () => {
    const lines: string[] = []
    const { env } = environment({ log: line => void lines.push(line) })
    const runtime = createDeviceRuntime(env)
    const unavailable = () => lines.filter(line => line.includes('runtime unavailable')).length

    await runtime.start()
    expect(unavailable()).toBe(1)

    // Sign-out, then an immediate sign-in before the stop's teardown has finished.
    const stopped = runtime.stop()
    const restarted = runtime.start()
    await Promise.all([stopped, restarted])
    expect(unavailable()).toBe(2)

    // The fresh start is the live one: another start is the memo, not a third start.
    await runtime.start()
    expect(unavailable()).toBe(2)
    await runtime.stop()
  })

  it('a cancelled Touch ID adds nothing', async () => {
    const lines: string[] = []

    const { env } = environment({
      log: line => void lines.push(line),
      signer: () => ({
        approve: async () => {
          throw Object.assign(new Error('device_key_approval_denied'), { code: 'approval_denied' })
        }
      })
    })

    const runtime = createDeviceRuntime(env)

    await expect(runtime.request({ action: 'addGrant', capability: 'keychain', agentUserId: AGENT })).rejects.toThrow('approval_denied')
    expect(((await runtime.request({ action: 'status' })) as { grants: unknown[] }).grants).toEqual([])
    expect(lines).toContain('[Device] standing permission not added: approval_denied')
  })
})
