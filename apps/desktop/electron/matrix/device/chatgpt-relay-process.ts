import { spawn } from 'node:child_process'

import { ownedBackgroundChildren } from '../../owned-background-children'

import type { ChatGptRelayCall } from './chatgpt-relay'

const OUTPUT_MAX = 800_000

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
      finish(new Error('chatgpt_relay_stopped'))
    }
    input.signal.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdout.on('data', chunk => {
      const value = Buffer.from(chunk)
      bytes += value.length
      if (bytes > OUTPUT_MAX) {
        child.kill('SIGTERM')
        finish(new Error('chatgpt_relay_response_too_large'))
      } else {
        chunks.push(value)
      }
    })
    child.once('error', () => finish(new Error('chatgpt_relay_unavailable')))
    child.once('exit', code => {
      if (settled) {
        return
      }
      if (code !== 0) {
        return finish(new Error('chatgpt_relay_unavailable'))
      }
      try {
        const response: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          throw new Error()
        }
        finish(undefined, { status: 200, response: response as Record<string, unknown> })
      } catch {
        finish(new Error('chatgpt_relay_response_invalid'))
      }
    })
    try {
      child.stdin.end(JSON.stringify({ model: input.model, effort: input.effort, request: input.request }))
    } catch {
      child.kill('SIGTERM')
      finish(new Error('chatgpt_relay_unavailable'))
    }
  })
}
