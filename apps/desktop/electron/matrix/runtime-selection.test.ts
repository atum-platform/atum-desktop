import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BundledRuntimeModule from '../bundled-runtime'

type BundledRuntime = typeof BundledRuntimeModule

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  stat: vi.fn(),
  resolve: vi.fn(),
  probe: vi.fn(),
  development: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawnSync: mocks.probe }))
vi.mock('node:fs', () => ({ readFileSync: mocks.read, statSync: mocks.stat }))
vi.mock('../bundled-runtime', async importOriginal => ({
  ...(await importOriginal<BundledRuntime>()),
  resolveBundledHermesRuntime: mocks.resolve
}))
vi.mock('./hermes-runtime', () => ({ readMatrixHermesRuntime: mocks.development }))

import { matrixRuntimeFailureCode, selectMatrixHermesRuntime, selectMatrixLocalBrainProcess } from './runtime-selection'

const options = {
  packaged: true,
  resources: '/moved/App.app/Contents/Resources',
  assets: '/moved/app.asar',
  userData: '/account/data'
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockReturnValue(JSON.stringify({ commit: '1'.repeat(40), dirty: false }))
  mocks.resolve.mockReturnValue({ command: '/moved/python', root: '/moved/source' })
  mocks.probe.mockReturnValue({ status: 0 })
})
describe('candidate runtime authority', () => {
  it('runs the packaged local brain on verified bundled Node and never falls back to Electron', () => {
    const runtime = selectMatrixHermesRuntime(options)
    expect(selectMatrixLocalBrainProcess(true, runtime)).toEqual({
      nodePath: `${options.resources}/runtime/browser/node/bin/node`, runAsNode: false
    })
    expect(selectMatrixLocalBrainProcess(true)).toBeUndefined()
    expect(selectMatrixLocalBrainProcess(false)).toEqual({ nodePath: process.execPath, runAsNode: true })
  })
  it('retains safe diagnostic codes without logging arbitrary error contents', () => {
    expect(matrixRuntimeFailureCode({ code: 'bundled_runtime_identity_invalid' })).toBe(
      'bundled_runtime_identity_invalid'
    )
    expect(matrixRuntimeFailureCode(new Error('matrix_packaged_runtime_override_denied'))).toBe(
      'matrix_packaged_runtime_override_denied'
    )
    expect(matrixRuntimeFailureCode(new Error('/private/credential-value'))).toBe(
      'matrix_runtime_configuration_invalid'
    )
  })
  it('uses bundle identity validation and isolates mutable profiles outside the moved bundle', () => {
    // Hermes gets the bundle's browser the way the old app's backend does.
    expect(selectMatrixHermesRuntime(options)).toEqual({
      python: '/moved/python',
      source: '/moved/source',
      profiles: '/account/data/hermes',
      bundled: {
        browserBin: `${options.resources}/runtime/browser/bin`,
        nodeBin: `${options.resources}/runtime/browser/node/bin`,
        chromium: expect.stringMatching(/^\/moved\/App\.app\/Contents\/Resources\/runtime\/browser\/chromium\//),
        // The assistant's pinned command-line tools (uv/uvx) from the same bundle.
        toolBins: [`${options.resources}/runtime/tools/uv/bin`],
        sharedAuthDir: expect.any(String)
      }
    })
    const request = mocks.resolve.mock.calls[0][0]
    expect(request).toMatchObject({
      isPackaged: true,
      resourcesPath: options.resources,
      currentEnv: {},
      expectedProductCommit: '1'.repeat(40),
      expectedProductDirty: false
    })
    expect(request.probeRuntime('/moved/python')).toBe(true)
    expect(mocks.probe).toHaveBeenCalledWith('/moved/python', expect.arrayContaining(['-I', '-B']), {
      env: { PYTHON_DOTENV_DISABLED: '1' },
      timeout: 5000,
      stdio: 'ignore'
    })
    expect(mocks.development).not.toHaveBeenCalled()
  })
  it('probes for the Python version the bundle declares, never a hard-coded one', async () => {
    // 0.20.38 shipped Python 3.14 while this probe still asserted 3.11, so no packaged local
    // agent could start. The probe now receives the bundle's own version as an argument.
    const { BUNDLED_PYTHON_VERSION } = await vi.importActual<BundledRuntime>('../bundled-runtime')
    selectMatrixHermesRuntime(options)
    mocks.resolve.mock.calls[0][0].probeRuntime('/moved/python')
    const args = mocks.probe.mock.calls.at(-1)![1] as string[]
    expect(args.at(-1)).toBe(BUNDLED_PYTHON_VERSION)
    expect(args.find(arg => arg.includes('version_info'))).not.toMatch(/\(3, ?\d+\)/)
  })
  it("pins Hermes's shared folder however Atum was launched, whatever the shell exports", () => {
    const pinned = selectMatrixHermesRuntime(options)!.bundled!.sharedAuthDir
    expect(pinned).toEqual(expect.any(String))

    // Launched from a shell with a stale export: an assistant's Hermes never inherits it
    // (hermes-runtime.ts), so the pin must still apply.
    vi.stubEnv('HERMES_SHARED_AUTH_DIR', '/stale/shared')
    vi.stubEnv('HERMES_CODEX_SHARED_AUTH_DIR', '/stale/codex')

    try {
      expect(selectMatrixHermesRuntime(options)!.bundled!.sharedAuthDir).toBe(pinned)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('refuses a packaged external override without even reading it', () => {
    expect(() => selectMatrixHermesRuntime({ ...options, developmentFile: '/hostile/runtime.json' })).toThrow(
      'override_denied'
    )
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.development).not.toHaveBeenCalled()
  })
  it('never falls back after missing, mismatched or unlaunchable bundles', () => {
    mocks.resolve.mockReturnValue(null)
    expect(() => selectMatrixHermesRuntime(options)).toThrow('unavailable')
    mocks.resolve.mockImplementation(() => {
      throw new Error('bundle mismatch')
    })
    expect(() => selectMatrixHermesRuntime(options)).toThrow('bundle mismatch')
    expect(mocks.development).not.toHaveBeenCalled()
  })
  it('treats a probe failure as failure, not an alternate Python candidate', () => {
    selectMatrixHermesRuntime(options)
    mocks.probe.mockReturnValue({ status: null, error: new Error('timeout') })
    expect(mocks.resolve.mock.calls[0][0].probeRuntime('/moved/python')).toBe(false)
  })
  it('keeps the explicit development setup without searching PATH or other profiles', () => {
    expect(selectMatrixHermesRuntime({ ...options, packaged: false })).toBeUndefined()
    mocks.development.mockReturnValue({ python: '/dev/python', source: '/dev/source', profiles: '/dev/profiles' })
    expect(selectMatrixHermesRuntime({ ...options, packaged: false, developmentFile: '/explicit.json' })).toEqual({
      python: '/dev/python',
      source: '/dev/source',
      profiles: '/dev/profiles'
    })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.development).toHaveBeenCalledWith('/explicit.json')
  })
})
