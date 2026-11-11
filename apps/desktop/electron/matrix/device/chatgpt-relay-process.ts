import { spawn } from 'node:child_process'

import { ownedBackgroundChildren } from '../../owned-background-children'

import type {
  ChatGptRelayCall,
  ChatGptRelayDiagnostic,
  ChatGptRelayProcessCode,
  ChatGptRelayStage
} from './chatgpt-relay'

const OUTPUT_MAX = 800_000
const STAGES = new Set<ChatGptRelayStage>(['provider_call', 'response_encode'])
const CODES = new Set<ChatGptRelayProcessCode>([
  'provider_call_failed', 'response_not_serializable', 'response_too_large'
])

export class ChatGptRelayProcessError extends Error {
  constructor(readonly diagnostic: ChatGptRelayDiagnostic) {
    super('chatgpt_relay_unavailable')
  }
}

function failureDiagnostic(exit: number, raw: Buffer): ChatGptRelayDiagnostic {
  try {
    const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    const error = payload.error as Record<string, unknown> | undefined
    const stage = error?.stage as ChatGptRelayStage
    const code = error?.code as ChatGptRelayProcessCode
    if (STAGES.has(stage) && CODES.has(code)) {
      return { stage, code, exit }
    }
  } catch {
    // Unknown child output is never surfaced or logged.
  }

  return exit === 3
    ? { stage: 'response_encode', code: 'response_too_large', exit }
    : exit === 4
      ? { stage: 'response_encode', code: 'response_not_serializable', exit }
      : exit === 5
        ? { stage: 'provider_call', code: 'provider_call_failed', exit }
        : { stage: 'provider_call', code: 'process_unavailable', exit }
}

/** Runs one Hermes openai-codex call. Stderr is drained, never logged; stdout is one bounded JSON
 * answer. The child receives only content/model/effort, while its environment points Hermes at the
 * account-scoped local auth store. */
export function runChatGptRelayProcess(input: {
  python: string
  source: string
  env: NodeJS.ProcessEnv
  model: string
  effort: 'low' | 'medium' | 'high'
  request: Record<string, unknown>
  signal: AbortSignal
}): Promise<ChatGptRelayCall> {
  return new Promise((resolve, reject) => {
    const child = ownedBackgroundChildren.track(spawn(input.python, ['-s', '-P', '-B', '-m', 'hermes_cli.chatgpt_relay'], {
      cwd: input.source,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe']
    }))

    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error, answer?: ChatGptRelayCall) => {
      if (settled) {
        return
      }
      settled = true
      input.signal.removeEventListener('abort', abort)
      if (error) {
        reject(error)
      } else {
        resolve(answer!)
      }
    }
    const abort = () => {
      child.kill('SIGTERM')
      finish(new ChatGptRelayProcessError({ stage: 'provider_call', code: 'stopped', exit: -1 }))
    }
    input.signal.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdout.on('data', chunk => {
      const value = Buffer.from(chunk)
      bytes += value.length
      if (bytes > OUTPUT_MAX) {
        child.kill('SIGTERM')
        finish(new ChatGptRelayProcessError({ stage: 'response_encode', code: 'response_too_large', exit: -1 }))
      } else {
        chunks.push(value)
      }
    })
    child.once('error', () => finish(new ChatGptRelayProcessError({
      stage: 'provider_call', code: 'process_unavailable', exit: -1
    })))
    child.once('exit', code => {
      if (settled) {
        return
      }
      if (code !== 0) {
        const exit = typeof code === 'number' && code >= 0 && code <= 255 ? code : -1
        return finish(new ChatGptRelayProcessError(failureDiagnostic(exit, Buffer.concat(chunks, bytes))))
      }
      try {
        const response: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          throw new Error()
        }
        finish(undefined, {
          status: 200,
          response: response as Record<string, unknown>,
          diagnostic: { stage: 'response_encode', code: 'ok', exit: 0 }
        })
      } catch {
        finish(new ChatGptRelayProcessError({ stage: 'response_encode', code: 'response_invalid', exit: 0 }))
      }
    })
    try {
      child.stdin.end(JSON.stringify({ model: input.model, effort: input.effort, request: input.request }))
    } catch {
      child.kill('SIGTERM')
      finish(new ChatGptRelayProcessError({ stage: 'provider_call', code: 'process_unavailable', exit: -1 }))
    }
  })
}
