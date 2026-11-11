import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ChatGptRelayProcessError, runChatGptRelayProcess } from './chatgpt-relay-process'

const directories: string[] = []

function helper(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'atum-chatgpt-relay-'))
  directories.push(root)
  const pkg = join(root, 'hermes_cli')
  mkdirSync(pkg)
  writeFileSync(join(pkg, '__init__.py'), '', 'utf8')
  writeFileSync(join(pkg, 'chatgpt_relay.py'), source, 'utf8')
  return root
}

function input(source: string) {
  return {
    python: process.env.HERMES_PYTHON ?? 'python3',
    source,
    env: { ...process.env, PYTHONPATH: source },
    model: 'gpt-5.6-luna',
    effort: 'medium' as const,
    request: { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'fixture' }] },
    signal: new AbortController().signal
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ChatGPT relay child process', () => {
  it('carries only the helper’s closed stage, code and exit status', async () => {
    const source = helper(`
import sys
sys.stdin.buffer.read()
sys.stdout.write('{"error":{"stage":"response_encode","code":"response_not_serializable"}}')
raise SystemExit(4)
`)

    const error = await runChatGptRelayProcess(input(source)).catch(value => value)

    expect(error).toBeInstanceOf(ChatGptRelayProcessError)
    expect((error as ChatGptRelayProcessError).diagnostic).toEqual({
      stage: 'response_encode', code: 'response_not_serializable', exit: 4
    })
    expect((error as Error).message).toBe('chatgpt_relay_unavailable')
  })

  it('marks a valid child answer as successfully encoded', async () => {
    const source = helper(`
import json, sys
sys.stdin.buffer.read()
sys.stdout.write(json.dumps({"choices": [], "model": "gpt-5.6-luna"}))
`)

    await expect(runChatGptRelayProcess(input(source))).resolves.toEqual({
      status: 200,
      response: { choices: [], model: 'gpt-5.6-luna' },
      diagnostic: { stage: 'response_encode', code: 'ok', exit: 0 }
    })
  })
})
