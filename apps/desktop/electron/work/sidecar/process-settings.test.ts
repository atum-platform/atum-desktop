import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { workSessionPaths } from '../session/paths'

import { WorkSidecar } from './process'

function systemPython() {
  try {
    return execFileSync('python3', ['-I', '-B', '-c', 'import sys, yaml; print(sys.executable)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return undefined
  }
}

const python = systemPython()

describe.skipIf(!python || process.platform === 'win32')('Work startup settings', () => {
  it('seeds native defaults and preserves account settings across Work restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-settings-'))
    const resources = join(root, 'resources')
    const paths = workSessionPaths({ root })
    const settingsPath = join(paths.userdata, 'settings.json')
    const observed = join(root, 'observed.json')
    const pythonBin = join(resources, 'runtime', 'python', 'bin')
    const workRuntime = join(resources, 'work-runtime')
    const profiles = join(resources, 'runtime', 'hermes-agent', 'acp_adapter', 'profiles')

    const sidecar = new WorkSidecar({
      resources,
      account: { key: 'fixture', generation: 1, root },
      current: () => true,
      gatewayEnvironment: () => ({ ATUM_MANAGED_MODEL_DEFAULT: 'old-default' }),
      revokeCredentials: () => undefined
    })

    vi.stubEnv('CODEX_HOME', join(root, 'fixture-codex'))

    try {
      await Promise.all([pythonBin, workRuntime, profiles, paths.userdata].map(directory => mkdir(directory, { recursive: true })))
      // A symlink relocates a venv interpreter away from pyvenv.cfg and loses
      // its site-packages (PyYAML in CI). Invoke the original path instead.
      const quotedPython = "'" + python!.replaceAll("'", "'\\''") + "'"
      await writeFile(join(pythonBin, 'python3.14'), `#!/bin/sh\nexec ${quotedPython} "$@"\n`, { mode: 0o700 })
      await copyFile(join(__dirname, 'supervisor.py'), join(workRuntime, 'actual_supervisor.py'))

      for (const profile of ['self-work.yaml', 'delegated.yaml']) {
        await copyFile(resolve(__dirname, '../../../../../acp_adapter/profiles', profile), join(profiles, profile))
      }

      await writeFile(join(paths.userdata, '.atum-theme-installed'), '')
      // Execute the real supervisor up to provider launch. The fixture only publishes
      // a loopback listener and inspects the gateway profiles in the temporary home.
      await writeFile(join(workRuntime, 'supervisor.py'), `
import http.server, importlib.util, json, os, sys, threading
from pathlib import Path
import yaml

module = importlib.util.spec_from_file_location("actual_supervisor", Path(__file__).with_name("actual_supervisor.py"))
actual = importlib.util.module_from_spec(module)
module.loader.exec_module(actual)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

def run(spec, children, channel):
    environments = spec["gateways"]
    Path(${JSON.stringify(observed)}).write_text(json.dumps([
        [env["ATUM_MANAGED_MODEL_DEFAULT"], yaml.safe_load((Path(env["HERMES_HOME"]) / "config.yaml").read_text())["model"], env["HOME"]]
        for env in environments
    ]))
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        origin = f"http://127.0.0.1:{server.server_port}"
        Path(spec["settingsPath"]).with_name("server-runtime.json").write_text(json.dumps({"pid": os.getpid(), "origin": origin}))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        actual.publish("spawned", pid=os.getpid())
        actual.publish("pairing", url=origin + "/pair#token=fixture")
        sys.stdin.buffer.read()

actual.run = run
actual.Children.stop = lambda self: None
actual.main()
`)
      const blocked = (driver: string) => ({ driver, enabled: false, config: { binaryPath: '/usr/bin/false' } })
      await writeFile(settingsPath, JSON.stringify({
        providerInstances: { codex: { driver: 'codex', enabled: true, config: { setupMode: 'managed' } }, claudeAgent: blocked('claudeAgent') }
      }))

      await sidecar.start({ continuation: false })
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(settings.defaultModelSelection).toEqual({ instanceId: 'atum-managed', model: 'atum-managed:nguyet-thuc' })
      expect(settings.textGenerationModelSelection).toEqual(settings.defaultModelSelection)
      const defaultProfile = ['nguyet-thuc', { provider: 'atum-managed', default: 'nguyet-thuc' }]
      expect(JSON.parse(await readFile(observed, 'utf8'))).toEqual([[...defaultProfile, homedir()], [...defaultProfile, join(root, 'work', 'delegated')]])
      expect(settings.providerInstances.codex).toEqual({ driver: 'codex', enabled: true, config: { setupMode: 'existing' } })
      expect(settings.providerInstances.claudeAgent).toEqual({ driver: 'claudeAgent', enabled: true })
      expect(settings.providerInstances.antigravity).toEqual({ driver: 'antigravity', enabled: true })
      expect(settings.providerInstances.opencode).toEqual({ driver: 'opencode', enabled: true })
      expect(settings.providerInstances['atum-managed-delegated']).toMatchObject({ enabled: true, showInPicker: false })
      expect(settings.providerInstances['atum-managed-delegated'].environment).toContainEqual({
        name: 'HOME', value: join(root, 'work', 'delegated'), sensitive: false
      })
      expect(settings.providerInstances['atum-managed'].environment.some((entry: { name: string }) => entry.name === 'HOME')).toBe(false)

      await sidecar.stop()

      const custom = {
        driver: 'opencode', displayName: 'Custom OpenCode', enabled: true, showInPicker: false,
        config: { binaryPath: '/opt/example/bin/opencode' }
      }

      const disabledOpenCode = { driver: 'opencode', enabled: false, config: { binaryPath: '/usr/bin/false' } }
      const disabledOptional = { driver: 'cursor', config: { enabled: false } }
      settings.providerInstances['custom-opencode'] = custom
      settings.providerInstances.cursor = disabledOptional
      settings.providerInstances.opencode = disabledOpenCode
      settings.providerInstances.claudeAgent.config = { binaryPath: '/opt/example/bin/claude' }
      settings.providerInstances.antigravity.enabled = false
      settings.providerInstances.codex = { driver: 'pi', displayName: 'Custom Pi', enabled: false }
      settings.providerInstances['atum-managed-delegated'].showInPicker = true
      settings.providerInstances['atum-relay-codex'] = { driver: 'opencode', enabled: true, showInPicker: true }
      await writeFile(settingsPath, JSON.stringify(settings))

      await sidecar.start({ continuation: false })
      const restarted = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(restarted.providerInstances['custom-opencode']).toEqual(custom)
      expect(restarted.providerInstances.cursor).toEqual(disabledOptional)
      expect(restarted.providerInstances.opencode).toEqual(disabledOpenCode)
      expect(restarted.providerInstances.codex).toEqual(settings.providerInstances.codex)
      expect(restarted.providerInstances.claudeAgent.config).toEqual(settings.providerInstances.claudeAgent.config)
      expect(restarted.providerInstances.antigravity.enabled).toBe(false)
      expect(restarted.providerInstances['atum-managed-delegated'].showInPicker).toBe(false)
      expect(restarted.providerInstances['atum-relay-codex']).toMatchObject({ driver: 'codex', showInPicker: false })
    } finally {
      await sidecar.stop()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
