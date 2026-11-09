/** The Hermes content helper (`hermes_cli/atum_agent_content.py`) for one agent's own home.
 * Main chooses the home; the request (references and downloaded bundles) goes over stdin,
 * so no name or byte from the account ever becomes a path argument or reaches a log. */
import { spawn } from 'node:child_process'
import path from 'node:path'

import { matrixHermesEnvironment, type MatrixHermesRuntimeConfig } from '../hermes-runtime'

export type MatrixAgentContentOperation = 'skills-check' | 'skills-install' | 'memory-read' | 'memory-apply'

export type MatrixAgentContentHelper = typeof runMatrixAgentContentHelper

/** The helper's closed failure codes; anything else is `matrix_agent_content_failed`. */
const HELPER_ERRORS = new Set([
  'agent_content_invalid',
  'agent_content_home',
  'agent_content_busy',
  'agent_content_receipt',
  'agent_content_failed'
])

const HELPER_TIMEOUT_MS = 120_000
// A report is one short row per declared skill (at most 512).
const MAXIMUM_OUTPUT_BYTES = 1024 * 1024

export class MatrixAgentContentHelperError extends Error {
  constructor(readonly code: string) {
    super(`matrix_${code}`)
    this.name = 'MatrixAgentContentHelperError'
  }
}

export function runMatrixAgentContentHelper(
  runtime: MatrixHermesRuntimeConfig,
  home: string,
  operation: MatrixAgentContentOperation,
  request: unknown,
  signal: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!path.isAbsolute(home)) {
      reject(new MatrixAgentContentHelperError('agent_content_home'))

      return
    }

    if (signal.aborted) {
      reject(signal.reason)

      return
    }

    let settled = false
    let size = 0
    let deadline: NodeJS.Timeout | undefined
    const chunks: Buffer[] = []

    const child = spawn(runtime.python, ['-B', '-m', 'hermes_cli.atum_agent_content', operation, '--home', home], {
      cwd: runtime.source,
      env: matrixHermesEnvironment(runtime, home, home),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })

    const abort = () => {
      child.kill('SIGKILL')
      finish(signal.reason ?? new Error('matrix_agent_content_cancelled'))
    }

    function finish(error: unknown, value?: unknown) {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)

      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }

    deadline = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new MatrixAgentContentHelperError('agent_content_failed'))
    }, HELPER_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength

      if (size > MAXIMUM_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(new MatrixAgentContentHelperError('agent_content_failed'))

        return
      }

      chunks.push(chunk)
    })

    child.on('error', () => finish(new MatrixAgentContentHelperError('agent_content_failed')))

    child.on('close', () => {
      let value: unknown

      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        finish(new MatrixAgentContentHelperError('agent_content_failed'))

        return
      }

      const row = value as Record<string, unknown> | null

      if (row && typeof row === 'object' && row.ok === false) {
        const code = typeof row.error === 'string' && HELPER_ERRORS.has(row.error) ? row.error : 'agent_content_failed'
        finish(new MatrixAgentContentHelperError(code))

        return
      }

      finish(undefined, value)
    })

    // The helper may exit before reading everything (a refused request): not our failure.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}
