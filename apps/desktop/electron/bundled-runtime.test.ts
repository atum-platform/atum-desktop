import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import RUNTIME_BASELINE from '../runtime-baseline.json' with { type: 'json' }

import {
  BUNDLED_RUNTIME_SCHEMA_VERSION,
  BundledRuntimeIdentityError,
  bundledRuntimeLayout,
  readBundledRuntimeManifest,
  requiresImmutableBundledRuntime,
  resolveBundledHermesRuntime
} from './bundled-runtime'

const COMMIT = '6c5a1009fd8ee0a92dfa08ee35b65ae1f4bdfd1b'
const TREE = '7c5a1009fd8ee0a92dfa08ee35b65ae1f4bdfd1c'

function manifest(overrides = {}) {
  return JSON.stringify({
    schemaVersion: BUNDLED_RUNTIME_SCHEMA_VERSION,
    target: { platform: 'darwin', arch: 'arm64' },
    python: { version: '3.14.7' },
    identity: {
      upstreamHermesCommit: RUNTIME_BASELINE.upstreamHermesCommit,
      atumOverlayCommit: RUNTIME_BASELINE.atumOverlayCommit,
      atumOverlayTree: RUNTIME_BASELINE.atumOverlayTree,
      runtimeCommit: COMMIT,
      runtimeTree: TREE
    },
    hermes: { dirtyCheckoutIgnored: false },
    browser: {
      schemaVersion: BROWSER_RUNTIME.schemaVersion,
      node: {
        version: BROWSER_RUNTIME.node.version,
        archiveSha256: BROWSER_RUNTIME.node.sha256,
        executable: `browser/node/${BROWSER_RUNTIME.node.executable}`,
        executableSha256: BROWSER_RUNTIME.node.executableSha256
      },
      agentBrowser: {
        version: BROWSER_RUNTIME.agentBrowser.version,
        packageIntegrity: BROWSER_RUNTIME.agentBrowser.packageIntegrity,
        executable: 'browser/bin/agent-browser',
        executableSha256: BROWSER_RUNTIME.agentBrowser.sha256
      },
      chromium: {
        name: BROWSER_RUNTIME.chromium.name,
        browserVersion: BROWSER_RUNTIME.chromium.browserVersion,
        playwrightVersion: BROWSER_RUNTIME.chromium.playwrightVersion,
        revision: BROWSER_RUNTIME.chromium.revision,
        archiveSha256: BROWSER_RUNTIME.chromium.sha256,
        executable: `browser/chromium/${BROWSER_RUNTIME.chromium.root}/${BROWSER_RUNTIME.chromium.executable}`,
        executableSha256: BROWSER_RUNTIME.chromium.executableSha256
      }
    },
    ...overrides
  })
}

test('bundled runtime is the packaged macOS backend when its real launch seam validates', () => {
  const resourcesPath = '/Applications/Atum.app/Contents/Resources'
  const layout = bundledRuntimeLayout(resourcesPath)
  const probes = []

  const backend = resolveBundledHermesRuntime({
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    resourcesPath,
    backendArgs: ['serve', '--isolated'],
    hermesHome: '/home/example/.hermes',
    currentEnv: {
      PATH: '/usr/bin:/bin',
      AGENT_BROWSER_PROVIDER: 'browserbase',
      AGENT_BROWSER_AUTO_CONNECT: '1',
      AGENT_BROWSER_ARGS: '--remote-debugging-port=9222',
      AGENT_BROWSER_CONFIG: '/tmp/hostile-agent-browser.json'
    },
    expectedProductCommit: COMMIT,
    expectedProductDirty: false,
    fileExists: candidate => candidate === layout.python,
    executableFile: candidate => [layout.node, layout.agentBrowser, layout.chromium].includes(candidate),
    directoryExists: candidate => candidate === layout.sourceRoot,
    readFile: candidate => {
      assert.equal(candidate, layout.manifestPath)

      return manifest()
    },
    probeRuntime: (python, options) => {
      probes.push({ python, env: options.env })

      return true
    }
  })

  assert.equal(backend?.command, layout.python)
  assert.deepEqual(backend?.args, ['-B', '-m', 'hermes_cli.main', 'serve', '--isolated'])
  assert.equal(backend?.root, layout.sourceRoot)
  assert.equal(backend?.bootstrap, false)
  assert.equal(backend?.bundled, true)
  assert.equal(backend?.runtimeManifest.identity.runtimeCommit, COMMIT)
  assert.equal(backend?.runtimeManifest.identity.upstreamHermesCommit, RUNTIME_BASELINE.upstreamHermesCommit)
  assert.equal(backend?.runtimeManifest.identity.atumOverlayCommit, RUNTIME_BASELINE.atumOverlayCommit)
  assert.equal(probes.length, 1)
  assert.equal(probes[0].python, layout.python)
  assert.equal(probes[0].env.PYTHONPATH, layout.sourceRoot)
  assert.ok(probes[0].env.PATH.split(':').includes(`${layout.pythonRoot}/bin`))
  assert.deepEqual(probes[0].env.PATH.split(':').slice(0, 2), [layout.browserBin, layout.nodeBin])
  assert.equal(probes[0].env.AGENT_BROWSER_EXECUTABLE_PATH, layout.chromium)
  assert.equal(probes[0].env.AGENT_BROWSER_HOME, '/home/example/.hermes/desktop-runtime/agent-browser')
  assert.equal(probes[0].env.PLAYWRIGHT_BROWSERS_PATH, '/home/example/.hermes/desktop-runtime/browser-cache')
  assert.equal(probes[0].env.AGENT_BROWSER_PROVIDER, undefined)
  assert.equal(probes[0].env.AGENT_BROWSER_AUTO_CONNECT, undefined)
  assert.equal(probes[0].env.AGENT_BROWSER_ARGS, undefined)
  assert.equal(probes[0].env.AGENT_BROWSER_CONFIG, undefined)
  assert.equal(Object.hasOwn(probes[0].env, 'AGENT_BROWSER_PROVIDER'), true)
  assert.equal(Object.hasOwn(probes[0].env, 'AGENT_BROWSER_AUTO_CONNECT'), true)
  assert.equal(Object.hasOwn(probes[0].env, 'AGENT_BROWSER_ARGS'), true)
  assert.equal(Object.hasOwn(probes[0].env, 'AGENT_BROWSER_CONFIG'), true)
  assert.equal(probes[0].env.HERMES_LAZY_INSTALL_TARGET, '/home/example/.hermes/desktop-runtime/lazy-packages')
})

test('development and excluded artifacts remain separate from the immutable packaged runtime', () => {
  const common = {
    resourcesPath: '/resources',
    hermesHome: '/home/user/.hermes',
    fileExists: () => true,
    executableFile: () => true,
    directoryExists: () => true,
    readFile: () => manifest(),
    probeRuntime: () => true
  }

  assert.equal(resolveBundledHermesRuntime({ ...common, isPackaged: false, platform: 'darwin' }), null)
  assert.equal(resolveBundledHermesRuntime({ ...common, isPackaged: true, platform: 'linux' }), null)
  assert.equal(requiresImmutableBundledRuntime({ isPackaged: false, platform: 'darwin', arch: 'arm64' }), false)
  assert.equal(requiresImmutableBundledRuntime({ isPackaged: true, platform: 'darwin', arch: 'arm64' }), true)
  assert.equal(requiresImmutableBundledRuntime({ isPackaged: true, platform: 'darwin', arch: 'x64' }), false)
})

test('packaged macOS x64 preserves its historical bundled-runtime preference without becoming fail-closed', () => {
  const resourcesPath = '/resources'
  const layout = bundledRuntimeLayout(resourcesPath)

  const backend = resolveBundledHermesRuntime({
    isPackaged: true,
    platform: 'darwin',
    arch: 'x64',
    resourcesPath,
    hermesHome: '/home/example/.hermes',
    currentEnv: { PATH: '/usr/bin:/bin' },
    fileExists: candidate => candidate === layout.python,
    directoryExists: candidate => candidate === layout.sourceRoot,
    executableFile: () => true,
    readFile: () => manifest({ target: { platform: 'darwin', arch: 'x64' }, browser: null }),
    probeRuntime: () => true
  })

  assert.equal(backend?.bundled, true)
  assert.equal(backend?.env.AGENT_BROWSER_EXECUTABLE_PATH, undefined)
  assert.equal(backend?.env.PLAYWRIGHT_BROWSERS_PATH, undefined)
  assert.notEqual(backend?.env.PATH?.split(':')[0], layout.browserBin)
  assert.equal(
    resolveBundledHermesRuntime({
      isPackaged: true,
      platform: 'darwin',
      arch: 'x64',
      resourcesPath,
      hermesHome: '/home/example/.hermes',
      fileExists: () => false,
      directoryExists: () => false,
      readFile: () => manifest({ target: { platform: 'darwin', arch: 'x64' }, browser: null }),
      probeRuntime: () => false
    }),
    null
  )
})

test('accepted packaged runtime rejects missing metadata and payloads instead of falling through', () => {
  const resourcesPath = '/resources'
  const layout = bundledRuntimeLayout(resourcesPath)

  const common = {
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    resourcesPath,
    hermesHome: '/home/example/.hermes',
    expectedProductCommit: COMMIT,
    expectedProductDirty: false,
    directoryExists: candidate => candidate === layout.sourceRoot,
    executableFile: () => true,
    probeRuntime: () => true
  }

  assert.throws(
    () => resolveBundledHermesRuntime({ ...common, fileExists: () => false, readFile: () => manifest() }),
    BundledRuntimeIdentityError
  )
  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        ...common,
        fileExists: candidate => candidate === layout.python,
        executableFile: () => false,
        readFile: () => manifest()
      }),
    /browser runtime payload is incomplete or not executable/
  )
  assert.throws(
    () => resolveBundledHermesRuntime({ ...common, fileExists: () => true, readFile: () => '{bad json' }),
    /manifest is missing or mismatched/
  )
  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        ...common,
        fileExists: () => true,
        readFile: () => manifest(),
        probeRuntime: () => false
      }),
    /launch probe failed/
  )
  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        ...common,
        expectedProductCommit: null,
        fileExists: () => true,
        readFile: () => manifest()
      }),
    /product build commit is missing/
  )
  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        ...common,
        expectedProductDirty: true,
        fileExists: () => true,
        readFile: () => manifest()
      }),
    /not attested clean/
  )
  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        ...common,
        expectedProductDirty: undefined,
        fileExists: () => true,
        readFile: () => manifest()
      }),
    /not attested clean/
  )
})

test('manifest contract rejects provenance mismatch and missing identity fields', () => {
  assert.equal(readBundledRuntimeManifest('/manifest', () => manifest())?.identity?.runtimeCommit, COMMIT)
  assert.equal(
    readBundledRuntimeManifest('/manifest', () => manifest({ python: { version: '3.12.1' } })),
    null
  )
  assert.equal(
    readBundledRuntimeManifest('/manifest', () =>
      manifest({
        identity: {
          upstreamHermesCommit: 'f'.repeat(40),
          atumOverlayCommit: RUNTIME_BASELINE.atumOverlayCommit,
          atumOverlayTree: RUNTIME_BASELINE.atumOverlayTree,
          runtimeCommit: COMMIT,
          runtimeTree: TREE
        }
      })
    ),
    null
  )
  assert.equal(
    readBundledRuntimeManifest('/manifest', () => manifest({ identity: undefined })),
    null
  )
  assert.equal(
    readBundledRuntimeManifest('/manifest', () => manifest({ browser: undefined })),
    null
  )
  assert.equal(
    readBundledRuntimeManifest('/manifest', () =>
      manifest({
        browser: {
          schemaVersion: BROWSER_RUNTIME.schemaVersion,
          node: { version: '99.0.0' },
          agentBrowser: { version: BROWSER_RUNTIME.agentBrowser.version },
          chromium: { revision: BROWSER_RUNTIME.chromium.revision }
        }
      })
    ),
    null
  )
  assert.equal(
    readBundledRuntimeManifest('/manifest', () => manifest({ target: { platform: 'darwin', arch: 'x64' } })),
    null
  )
  assert.equal(
    readBundledRuntimeManifest(
      '/manifest',
      () => manifest({ target: { platform: 'darwin', arch: 'x64' }, browser: null }),
      { platform: 'darwin', arch: 'x64' }
    )?.browser,
    null
  )
})

test('accepted packaged runtime rejects a renderer/backend commit mismatch', () => {
  const resourcesPath = '/resources'
  const layout = bundledRuntimeLayout(resourcesPath)

  assert.throws(
    () =>
      resolveBundledHermesRuntime({
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
        resourcesPath,
        hermesHome: '/home/example/.hermes',
        expectedProductCommit: '8'.repeat(40),
        expectedProductDirty: false,
        fileExists: candidate => candidate === layout.python,
        executableFile: () => true,
        directoryExists: candidate => candidate === layout.sourceRoot,
        readFile: () => manifest(),
        probeRuntime: () => true
      }),
    /product and bundled runtime commits differ/
  )
})

test('runtime layout remains relocatable under the Electron resources directory', () => {
  const resources = path.join('/Volumes', 'Atum Test', 'Atum.app', 'Contents', 'Resources')
  const layout = bundledRuntimeLayout(resources)

  assert.equal(layout.runtimeRoot, path.join(resources, 'runtime'))
  assert.equal(layout.python, path.join(resources, 'runtime', 'python', 'bin', 'python3.14'))
  assert.equal(layout.sourceRoot, path.join(resources, 'runtime', 'hermes-agent'))
  assert.equal(layout.node, path.join(resources, 'runtime', 'browser', 'node', 'bin', 'node'))
  assert.equal(layout.agentBrowser, path.join(resources, 'runtime', 'browser', 'bin', 'agent-browser'))
  assert.equal(
    layout.chromium,
    path.join(
      resources,
      'runtime',
      'browser',
      'chromium',
      BROWSER_RUNTIME.chromium.root,
      BROWSER_RUNTIME.chromium.executable
    )
  )
})
