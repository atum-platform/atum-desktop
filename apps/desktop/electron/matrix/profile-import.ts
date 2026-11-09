/** The existing offline importer is the file boundary. Account/lifecycle owns identity;
 * no renderer path, credential, grant or arbitrary command crosses this seam. */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { type AtumSkillBundle, parseSkillBundle } from '../../shared/atum-agent-content'
import { type AtumPortableAssistantDefinition, parseAtumPortableDefinition } from '../../shared/atum-agent-portability'

import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from './agent-definition'
import { matrixHermesEnvironment, type MatrixHermesRuntimeConfig } from './hermes-runtime'

/** Native-selected path plus the exact revision selected, journaled before account writes. */
export interface MatrixProfileImport {
  prepared: string
  sha256: string
}

export interface MatrixProfilePayload {
  sha256: string
  definition: AtumPortableAssistantDefinition
  bundles: AtumSkillBundle[]
}

export function parseMatrixProfilePayload(value: unknown): MatrixProfilePayload {
  const row = value as Record<string, unknown>

  if (!row || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Array.isArray(row.bundles)) {
    throw new Error('matrix_profile_import_invalid')
  }

  const definition = parseAtumPortableDefinition(row.definition)
  const bundles = row.bundles.map(parseSkillBundle)

  if (bundles.length !== definition.skills.length || bundles.some((bundle, i) => bundle.sha256 !== definition.skills[i].sha256)) {
    throw new Error('matrix_profile_import_invalid')
  }

  return { sha256: row.sha256, definition, bundles }
}

function helper(runtime: MatrixHermesRuntimeConfig, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(runtime.python, ['-B', '-m', 'hermes_cli.atum_profile_install', ...args], {
      cwd: runtime.source,
      // Do not initialize the real user's Hermes home or any destination during a read.
      env: matrixHermesEnvironment(runtime, runtime.profiles, runtime.source),
      timeout: 120_000,
      maxBuffer: 192 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        reject(new Error('matrix_profile_import_invalid'))

        return
      }

      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('matrix_profile_import_invalid'))
      }
    })
  })
}

export async function readMatrixProfileImport(
  runtime: MatrixHermesRuntimeConfig, prepared: string, expected?: string
): Promise<MatrixProfilePayload> {
  if (!path.isAbsolute(prepared)) {
    throw new Error('matrix_profile_import_invalid')
  }

  return parseMatrixProfilePayload(await helper(runtime, [
    'payload', '--prepared', prepared, ...(expected ? ['--expected-sha256', expected] : [])
  ]))
}

/** The caller enrolls a new executor and holds its runtime stopped until this succeeds. */
export async function installMatrixProfileImport(
  runtime: MatrixHermesRuntimeConfig, profile: MatrixProfileImport, home: string, roomId: string
): Promise<void> {
  mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 })

  const result = await helper(runtime, [
    'install', '--prepared', profile.prepared, '--expected-sha256', profile.sha256,
    '--destination', home, '--room', roomId
  ]) as Record<string, unknown>

  if (result?.status !== 'installed' || result.sha256 !== profile.sha256 || result.room !== roomId) {
    throw new Error('matrix_profile_import_invalid')
  }
}

/** Upload immutable skill content before referencing it. Resume acknowledges an exact
 * prior write but never replaces a different definition somebody edited meanwhile. */
export async function publishMatrixProfileImport(payload: MatrixProfilePayload, deps: {
  read(): Promise<MatrixAgentDefinitionSnapshot>
  skill(bundle: AtumSkillBundle): Promise<unknown>
  write(snapshot: MatrixAgentDefinitionSnapshot, definition: AtumPortableAssistantDefinition): Promise<unknown>
}): Promise<void> {
  const snapshot = await deps.read()

  if (snapshot.definition) {
    if (JSON.stringify(snapshot.definition) === JSON.stringify(payload.definition)) {return}
    throw new Error('matrix_profile_import_conflict')
  }

  for (const bundle of payload.bundles) {
    try {
      await deps.skill(bundle)
    } catch (error) {
      // Immutable, content-addressed PUTs are safe to repeat after an ambiguous
      // network/503 acknowledgement. Never retry permission or content failures,
      // and leave the existing lifecycle journal intact if the second try fails.
      if (!(error instanceof MatrixAgentDefinitionError) || error.code !== 'unavailable') {throw error}
      await delay(750)
      await deps.skill(bundle)
    }
  }

  await deps.write(snapshot, payload.definition)
}
