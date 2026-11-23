import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { workSessionPaths } from '../session/paths'

import { ATUM_WORK_MODEL, ATUM_WORK_PROVIDER, workRuntimeEnvironment, WorkSidecar } from './process'

const resources = process.env.ATUM_WORK_TEST_RESOURCES
const exec = promisify(execFile)

describe.skipIf(!resources)('packaged Work sidecar', () => {
  it('waits for native commit before serving the owner and installs the theme once', async () => {
    const root = await mkdtemp('/tmp/atum-ws2-')
    const paths = workSessionPaths({ root })

    const sidecar = new WorkSidecar({
      resources: resources!,
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
      const trial = await sidecar.start({
        continuation: false,
        trial: {
          protocol: 4,
          childVersion: '0.1.11',
          update: { id: 'fixture', fromVersion: '0.1.10', targetVersion: '0.1.11', dbPath: paths.database, status: 'pending' }
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
      expect(settings.providerInstances.codex).toMatchObject({ enabled: true, config: { setupMode: 'managed' } })
      expect(settings.providerInstances.claudeAgent.enabled).toBe(true)
      expect(settings.providerInstances.antigravity.enabled).toBe(true)
      expect(settings.providerInstances['atum-managed-delegated']).toMatchObject({ enabled: true, showInPicker: false })
      await sidecar.stop()
      expect(sidecar.current()).toBeUndefined()
      await expect(fetch(trial.origin, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()

      await exec(join(resources!, 'work-runtime', 't3'), ['theme', 'clear'], {
        env: workRuntimeEnvironment(paths.work, resources!)
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
