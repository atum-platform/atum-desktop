import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import { createInitialDesktopUpdateState } from '../../../vendor/t3-updates/apps/desktop/src/updates/updateMachine'
import { workDesktopUpdateHandler } from '../../t3-updates/work-handoff'
import { workSessionPaths } from '../session/paths'

import { ATUM_WORK_MODEL, ATUM_WORK_PROVIDER, workRuntimeEnvironment, WorkSidecar } from './process'

const resources = process.env.ATUM_WORK_TEST_RESOURCES
const exec = promisify(execFile)

async function overlayResources(root: string) {
  const overlay = join(root, 'resources')
  const runtime = join(overlay, 'work-runtime')
  const installed = join(resources!, 'work-runtime')
  await mkdir(runtime, { recursive: true })
  await symlink(join(resources!, 'runtime'), join(overlay, 'runtime'))
  for (const name of ['t3', 'pin.json', 'atum.json', 'client', 'node_modules']) {
    await symlink(join(installed, name), join(runtime, name))
  }
  await copyFile(new URL('./supervisor.py', import.meta.url), join(runtime, 'supervisor.py'))

  return overlay
}

async function workRpc(origin: string, cookie: string, tag: string, payload: object) {
  const response = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, { method: 'POST', headers: { cookie } })
  expect(response.ok).toBe(true)
  const { ticket } = await response.json()
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`)

  try {
    return await new Promise<{ _tag: string; value?: { desktopUpdateToken?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Work RPC timeout (${tag})`)), 8_000)
      socket.addEventListener('close', () => {clearTimeout(timer); reject(new Error('Work RPC closed'))}, { once: true })
      socket.addEventListener('open', () => socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag, payload, headers: [] })))
      socket.addEventListener('message', event => {
        const frame = JSON.parse(event.data)
        if (frame._tag === 'Exit' && frame.requestId === '1') {clearTimeout(timer); resolve(frame.exit)}
      })
    })
  } finally {
    socket.close()
  }
}

describe.skipIf(!resources)('packaged Work sidecar', () => {
  it('authenticates the owner and performs prepare and commit over the real desktop descriptors after trial activation', async () => {
    const root = await mkdtemp('/tmp/atum-wctl-')
    const overlay = await overlayResources(root)
    const pin = JSON.parse(await readFile(join(overlay, 'work-runtime', 'pin.json'), 'utf8'))
    const restart = vi.fn(async () => false)
    const state = {
      ...createInitialDesktopUpdateState('1.0.0', { appArch: 'arm64', hostArch: 'arm64', runningUnderArm64Translation: false }, 'latest'),
      enabled: true, status: 'downloaded' as const, availableVersion: '1.1.0', downloadedVersion: '1.1.0'
    }
    const sidecar = new WorkSidecar({
      resources: overlay, account: { key: 'fixture', generation: 1, root }, current: () => true,
      gatewayEnvironment: () => ({}), revokeCredentials: () => undefined,
      desktopUpdate: workDesktopUpdateHandler({ state: () => state, checkNow: async () => false,
        download: async () => false, setChannel: async () => false, restart })
    })

    try {
      const trial = await sidecar.start({ continuation: false, trial: {
        protocol: 4, childVersion: pin.version, update: { id: 'desktop-fixture', fromVersion: '0.0.0', targetVersion: pin.version,
          dbPath: workSessionPaths({ root }).database, status: 'pending' }
      } })
      await trial.trial!.prepared
      expect(trial.takePairingUrl()).toBeUndefined()
      await trial.trial!.commit()
      const url = new URL(trial.takePairingUrl()!)
      expect(trial.takePairingUrl()).toBeUndefined()
      const endpoint = `${url.origin}/api/auth/websocket-ticket/rpc`
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
      const paired = await fetch(`${url.origin}/api/auth/browser-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: new URLSearchParams(url.hash.slice(1)).get('token') })
      })
      expect(paired.ok).toBe(true)
      const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('t3_session_'))!
      expect(cookie).toBeTruthy()
      const prepared = await workRpc(url.origin, cookie, 'server.updateServer', { targetVersion: '1.1.0' })
      expect(prepared._tag).toBe('Success')
      const requestId = prepared.value?.desktopUpdateToken
      expect(requestId).toBeTruthy()
      expect(restart).toHaveBeenCalledTimes(0)
      expect((await workRpc(url.origin, cookie, 'server.commitDesktopUpdate', { requestId: 'wrong' }))._tag).toBe('Failure')
      expect(restart).toHaveBeenCalledTimes(0)
      expect((await workRpc(url.origin, cookie, 'server.commitDesktopUpdate', { requestId }))._tag).toBe('Failure')
      expect((await workRpc(url.origin, cookie, 'server.commitDesktopUpdate', { requestId }))._tag).toBe('Failure')
      expect(restart).toHaveBeenCalledExactlyOnceWith('1.1.0')
    } finally {
      await sidecar.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('waits for native commit before serving the owner and installs the theme once', async () => {
    const root = await mkdtemp('/tmp/atum-ws2-')
    const overlay = await overlayResources(root)
    const paths = workSessionPaths({ root })

    const sidecar = new WorkSidecar({
      resources: overlay,
      account: { key: 'fixture', generation: 1, root },
      current: () => true,
      gatewayEnvironment: () => ({
        HTTPS_PROXY: 'http://127.0.0.1:1',
        HTTP_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1'
      }),
      revokeCredentials: () => undefined
    })

    try {
      const pin = JSON.parse(await readFile(join(overlay, 'work-runtime', 'pin.json'), 'utf8'))
      const targetVersion = pin.version
      expect(targetVersion).toMatch(/^\d+\.\d+\.\d+$/u)

      const trial = await sidecar.start({
        continuation: false,
        trial: {
          protocol: 4,
          childVersion: targetVersion,
          update: { id: 'fixture', fromVersion: '0.0.0', targetVersion, dbPath: paths.database, status: 'pending' }
        }
      })

      await trial.trial!.prepared
      expect(sidecar.current()).toBeUndefined()
      expect(trial.takePairingUrl()).toBeUndefined()
      await trial.trial!.commit()
      await trial.trial!.commit()
      expect(sidecar.current()).toBe(trial)
      expect(trial.takePairingUrl()?.startsWith(trial.origin + '/pair#token=')).toBe(true)

      const settingsPath = join(paths.userdata, 'settings.json')
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(settings.defaultTheme).toBe('atum')
      expect(settings.textGenerationModelSelection).toEqual({ instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL })
      expect(settings.providerInstances.codex).toMatchObject({ enabled: true, config: { setupMode: 'existing' } })
      expect(settings.providerInstances.claudeAgent.enabled).toBe(true)
      expect(settings.providerInstances.antigravity.enabled).toBe(true)
      expect(settings.providerInstances['atum-managed-delegated']).toBeUndefined()
      expect(settings.providerInstances['atum-relay-codex']).toBeUndefined()
      await sidecar.stop()
      expect(sidecar.current()).toBeUndefined()
      await expect(fetch(trial.origin, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()

      await exec(join(overlay, 'work-runtime', 't3'), ['theme', 'clear'], {
        env: workRuntimeEnvironment(paths.work, overlay)
      })
      const restarted = await sidecar.start({ continuation: false })
      expect(restarted.id).not.toBe(trial.id)
      expect(restarted.pid).not.toBe(trial.pid)
      expect(sidecar.current()).toBe(restarted)
      expect(restarted.takePairingUrl()?.startsWith(restarted.origin + '/pair#token=')).toBe(true)
      expect(JSON.parse(await readFile(settingsPath, 'utf8')).defaultTheme).toBeFalsy()
    } finally {
      await sidecar.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
