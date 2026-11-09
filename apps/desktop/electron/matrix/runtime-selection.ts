import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BUNDLED_PYTHON_VERSION, bundledRuntimeLayout, resolveBundledHermesRuntime } from '../bundled-runtime'
import { resolveSharedAuthDirEnv } from '../hermes-home'

import { type MatrixHermesRuntimeConfig, readMatrixHermesRuntime } from './hermes-runtime'

/** Reuse the verified bundle's existing Node payload; no second runtime or Electron Node mode. */
export function selectMatrixLocalBrainProcess(packaged: boolean, runtime?: MatrixHermesRuntimeConfig):
  { nodePath: string; runAsNode: boolean } | undefined {
  if (!packaged) {return { nodePath: process.execPath, runAsNode: true }}

  return runtime?.bundled ? { nodePath: path.join(runtime.bundled.nodeBin, 'node'), runAsNode: false } : undefined
}

/** Diagnostics are closed codes, never raw filesystem/JSON/provider errors. */
export function matrixRuntimeFailureCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'bundled_runtime_identity_invalid') {
    return 'bundled_runtime_identity_invalid'
  }

  return error instanceof Error && error.message === 'matrix_packaged_runtime_override_denied'
    ? 'matrix_packaged_runtime_override_denied'
    : 'matrix_runtime_configuration_invalid'
}

/** Packaging, not PATH or a renderer, owns the executable in a distributed app. */
export function selectMatrixHermesRuntime(options: {
  packaged: boolean
  resources: string
  assets: string
  userData: string
  developmentFile?: string
}): MatrixHermesRuntimeConfig | undefined {
  if (!options.packaged) {
    return options.developmentFile ? readMatrixHermesRuntime(options.developmentFile) : undefined
  }

  if (options.developmentFile) {
    throw new Error('matrix_packaged_runtime_override_denied')
  }

  const stamp = JSON.parse(readFileSync(path.join(options.assets, 'matrix-build-stamp.json'), 'utf8'))
  const profiles = path.join(options.userData, 'hermes')

  const resolved = resolveBundledHermesRuntime({
    isPackaged: true,
    resourcesPath: options.resources,
    hermesHome: profiles,
    currentEnv: {},
    expectedProductCommit: stamp.commit,
    expectedProductDirty: stamp.dirty,
    // Isolated import probe: only this bundle is added, with no user-site,
    // working-directory, dotenv or provider configuration fallback.
    probeRuntime: python =>
      spawnSync(
        python,
        [
          '-I',
          '-B',
          '-c',
          // The expected version comes from the bundle's own constant: a hard-coded 3.11 here refused
          // every packaged 0.20.38 runtime after the Python 3.14 upgrade (no local agent could start).
          "import sys; assert '%d.%d' % sys.version_info[:2] == sys.argv[2]; sys.path.insert(0, sys.argv[1]); import hermes_cli.config, yaml",
          path.join(options.resources, 'runtime', 'hermes-agent'),
          BUNDLED_PYTHON_VERSION
        ],
        {
          env: { PYTHON_DOTENV_DISABLED: '1' },
          timeout: 5_000,
          stdio: 'ignore'
        }
      ).status === 0
  })

  if (!resolved) {
    throw new Error('matrix_packaged_runtime_unavailable')
  }

  // The identity check above requires the browser payload in a packaged build; Hermes gets
  // it the way the old app's backend does, plus the shared subscription credentials.
  const layout = bundledRuntimeLayout(options.resources)

  // The pin applies however Atum was launched: an assistant's Hermes never inherits the
  // shell's shared-folder settings (hermes-runtime.ts WITHHELD_ENV), so the resolver must not
  // step aside for them as it does for the old app, where they pass through.
  const launchEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['HERMES_SHARED_AUTH_DIR', 'HERMES_CODEX_SHARED_AUTH_DIR'].includes(key)
    )
  )

  const shared = resolveSharedAuthDirEnv({
    isPackaged: true,
    platform: process.platform,
    env: launchEnv,
    homeDir: os.homedir(),
    directoryExists: (candidate: string) => {
      try {
        return statSync(candidate).isDirectory()
      } catch {
        return false
      }
    }
  }) as { HERMES_SHARED_AUTH_DIR?: string }

  return {
    python: resolved.command,
    source: resolved.root,
    profiles,
    bundled: {
      browserBin: layout.browserBin,
      nodeBin: layout.nodeBin,
      chromium: layout.chromium,
      toolBins: layout.toolBins,
      ...(shared.HERMES_SHARED_AUTH_DIR ? { sharedAuthDir: shared.HERMES_SHARED_AUTH_DIR } : {})
    }
  }
}
