import { readFileSync } from 'node:fs'
import path from 'node:path'

import { MATRIX_IDENTITY_NAME } from './app-identity'
import { type MatrixConfig, parseMatrixConfig } from './config'

/** The production public configuration a packaged app carries in its Resources
 * (scripts/matrix-after-pack.mjs copies apps/desktop/matrix-public-config.json there).
 * A fresh install opens with it; an operator file in Application Support still wins. */
export const MATRIX_BUNDLED_CONFIG_NAME = 'matrix-public-config.json'

/** The startup refusal appears before the person's locale is available, so it stays
 * Vietnamese-first and English-second. It names only Atum; the stable custody folder name is an
 * internal compatibility detail, not product copy. */
export function matrixLaunchConfigurationErrorCopy(): { title: string; message: string } {
  return {
    title: 'Atum — Chưa có cấu hình dịch vụ / Service configuration required',
    message:
      'Cấu hình dịch vụ bị thiếu hoặc không hợp lệ. Hãy cài lại Atum.\n\n' +
      'Service configuration is missing or invalid. Reinstall Atum. If you set up ' +
      "public-config.json in Atum's Application Support data folder, check that file. No account data was changed."
  }
}

/** Operator-owned public endpoints. Never infer authority from cwd, environment,
 * the proof checkout or a previously signed-in account. The file sits in the app's
 * identity folder (app-identity.ts), where installed copies were set up. */
export function matrixLaunchConfigPath(appData: string, explicitFile?: string): string {
  const file = explicitFile ?? path.join(appData, MATRIX_IDENTITY_NAME, 'public-config.json')

  if (!path.isAbsolute(file)) {
    throw new Error('matrix_public_configuration_invalid')
  }

  return file
}

function readConfigFile(file: string): MatrixConfig {
  try {
    return parseMatrixConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    // Never expose raw file data.
    throw new Error(
      error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        ? 'matrix_public_configuration_missing'
        : 'matrix_public_configuration_invalid'
    )
  }
}

/**
 * Which public configuration this launch uses:
 * - an explicit `--matrix-config` file, which is authoritative: missing or broken, the app
 *   stops rather than switch accounts by falling back to another server;
 * - else the operator file in Application Support (`public-config.json`), when it exists.
 *   A present but broken operator file also stops the app, for the same reason;
 * - else the production default the signed app carries (`bundledFile`). A development
 *   build has none, so it still reports the missing configuration.
 */
export function readMatrixLaunchConfig(appData: string, explicitFile?: string, bundledFile?: string): MatrixConfig {
  const file = matrixLaunchConfigPath(appData, explicitFile)

  try {
    return readConfigFile(file)
  } catch (error) {
    if (
      explicitFile !== undefined ||
      bundledFile === undefined ||
      !(error instanceof Error) ||
      error.message !== 'matrix_public_configuration_missing'
    ) {
      throw error
    }
  }

  if (!path.isAbsolute(bundledFile)) {
    throw new Error('matrix_public_configuration_invalid')
  }

  return readConfigFile(bundledFile)
}
