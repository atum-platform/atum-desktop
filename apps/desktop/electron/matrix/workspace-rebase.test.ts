import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'

import { rebaseLegacyCwd, rebaseLegacySessionCwd } from './workspace-rebase'

interface RpcFrame {
  id?: number | string
  method: string
  params: Record<string, unknown>
}

class ResumeSocket extends EventTarget {
  readyState = 0
  readonly sent: RpcFrame[] = []
  error?: number

  send(text: string): void {
    const frame = JSON.parse(text) as RpcFrame
    this.sent.push(frame)

    if (frame.id === undefined) {
      return
    }

    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            ...(this.error ? { error: { code: this.error, message: 'synthetic refusal' } } : { result: {} })
          })
        })
      )
    })
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

describe('legacy session cwd rebase', () => {
  let home: string
  let legacy: string
  let workspace: string
  let socket: ResumeSocket
  let gateway: JsonRpcGatewayClient

  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'atum-workspace-rebase-'))
    legacy = path.join(home, 'Atum')
    workspace = path.join(legacy, 'Workspace')
    mkdirSync(workspace, { recursive: true })
    socket = new ResumeSocket()
    gateway = new JsonRpcGatewayClient({ socketFactory: () => socket as unknown as WebSocket })
    const connected = gateway.connect('ws://127.0.0.1:1234')
    socket.open()
    await connected
  })

  afterEach(() => {
    gateway.close()
    rmSync(home, { recursive: true, force: true })
  })

  const input = () => ({ cwd: legacy, legacy, workspace, sessionId: 'runtime-session', gateway })
  const capabilityNotifications = () => socket.sent.filter(frame => frame.method === 'client.capabilities')
  const businessRequests = () => socket.sent.filter(frame => frame.method !== 'client.capabilities')

  test('uses the resumed runtime session id through the actual JSON-RPC client', async () => {
    await expect(rebaseLegacySessionCwd(input())).resolves.toBe('rebased')
    expect(capabilityNotifications()).toEqual([])
    expect(businessRequests()).toHaveLength(1)
    expect(businessRequests()[0].method).toBe('session.cwd.set')
    expect(businessRequests()[0].params).toEqual({ session_id: 'runtime-session', cwd: workspace })
  })

  test('a different existing project remains the explicit choice', async () => {
    const project = path.join(home, 'Project')
    mkdirSync(project)
    await expect(rebaseLegacySessionCwd({ ...input(), cwd: project })).resolves.toBe('unchanged')
    expect(businessRequests()).toEqual([])
  })

  test('an alias of the legacy directory is compared after realpath', async () => {
    const alias = path.join(home, 'legacy-alias')
    symlinkSync(legacy, alias, 'dir')
    await expect(rebaseLegacySessionCwd({ ...input(), cwd: alias })).resolves.toBe('rebased')
  })

  test.each([4009, 4017, -32603])('refusal %s is nonfatal, with no immediate retry', async code => {
    socket.error = code
    await expect(rebaseLegacySessionCwd(input())).resolves.toBe('deferred')
    expect(businessRequests()).toHaveLength(1)
    socket.error = undefined
    await expect(rebaseLegacySessionCwd(input())).resolves.toBe('rebased')
    expect(businessRequests()).toHaveLength(2)
    expect(businessRequests().every(frame => frame.method === 'session.cwd.set')).toBe(true)
  })

  test('cancellation before dispatch does not write session state', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(rebaseLegacySessionCwd({ ...input(), signal: abort.signal })).resolves.toBe('deferred')
    expect(businessRequests()).toEqual([])
  })

  test('a closed executor defers without a connection or session fallback', async () => {
    gateway.close()
    await expect(rebaseLegacySessionCwd(input())).resolves.toBe('deferred')
    expect(businessRequests()).toEqual([])
  })

  test('already rebased, missing and malformed cwd do not issue a write', async () => {
    for (const cwd of [workspace, path.join(home, 'missing'), 'relative', null, {}]) {
      await expect(rebaseLegacySessionCwd({ ...input(), cwd })).resolves.toBe('unchanged')
    }

    expect(businessRequests()).toEqual([])
  })

  test('a blocked workspace, legacy target and Drive target cannot become the session cwd', () => {
    const file = path.join(home, 'file')
    writeFileSync(file, 'synthetic')
    const drive = path.join(legacy, 'Drive')
    mkdirSync(drive)

    for (const target of [file, legacy, drive]) {
      expect(rebaseLegacyCwd(legacy, legacy, target)).toBeUndefined()
    }
  })

  test('a target alias inside the real default Drive is also refused', () => {
    const actualDrive = path.join(home, 'actual-drive')
    const child = path.join(actualDrive, 'child')
    mkdirSync(child, { recursive: true })
    symlinkSync(actualDrive, path.join(legacy, 'Drive'), 'dir')
    const alias = path.join(home, 'drive-alias')
    symlinkSync(child, alias, 'dir')
    expect(rebaseLegacyCwd(legacy, legacy, alias)).toBeUndefined()
  })
})
