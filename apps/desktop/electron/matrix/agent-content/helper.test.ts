import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { MatrixAgentContentHelperError, runMatrixAgentContentHelper } from './helper'

const scratch = mkdtempSync(path.join(tmpdir(), 'atum-content-helper-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in interpreter: the real module's contract is covered by the Python tests. */
function interpreter(name: string, script: string) {
  const file = path.join(scratch, name)
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)

  return { python: file, source: scratch, profiles: scratch }
}

const home = path.join(scratch, 'agent-home')

describe('the content helper transport', () => {
  it('sends the request on stdin and passes only the operation and the home as arguments', async () => {
    const runtime = interpreter(
      'echo',
      `input=$(cat)\nprintf '{"ok":true,"args":"%s","home":"%s","input":%s}' "$*" "$HERMES_HOME" "$input"`
    )

    const request = { skills: [{ name: 'tiếng-việt/ghi-chú', sha256: 'a'.repeat(64) }] }

    await expect(
      runMatrixAgentContentHelper(runtime, home, 'skills-check', request, new AbortController().signal)
    ).resolves.toEqual({
      ok: true,
      args: `-B -m hermes_cli.atum_agent_content skills-check --home ${home}`,
      home,
      input: request
    })
  })

  it('carries only closed failure codes', async () => {
    const busy = interpreter('busy', `cat >/dev/null\necho '{"ok":false,"error":"agent_content_busy"}'\nexit 1`)
    await expect(
      runMatrixAgentContentHelper(busy, home, 'skills-install', {}, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'agent_content_busy'
    })

    const odd = interpreter('odd', `cat >/dev/null\necho '{"ok":false,"error":"/home/example/private path"}'\nexit 1`)
    await expect(
      runMatrixAgentContentHelper(odd, home, 'skills-check', {}, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'agent_content_failed'
    })

    const garbage = interpreter('garbage', `cat >/dev/null\necho 'Traceback (most recent call last)'`)
    await expect(
      runMatrixAgentContentHelper(garbage, home, 'skills-check', {}, new AbortController().signal)
    ).rejects.toBeInstanceOf(MatrixAgentContentHelperError)
  })

  it('bounds what it reads back', async () => {
    const flood = interpreter('flood', `cat >/dev/null\nyes x | head -c 2000000`)
    await expect(
      runMatrixAgentContentHelper(flood, home, 'skills-check', {}, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'agent_content_failed'
    })
  })

  it('stops the helper when the agent stops', async () => {
    const stuck = interpreter('stuck', `cat >/dev/null\nexec sleep 30`)
    const controller = new AbortController()
    const running = runMatrixAgentContentHelper(stuck, home, 'skills-check', {}, controller.signal)
    setTimeout(() => controller.abort(new Error('retired')), 50)

    await expect(running).rejects.toThrow('retired')
  })

  it('refuses a home that is not an absolute path before starting anything', async () => {
    const never = interpreter('never', 'exit 3')
    await expect(
      runMatrixAgentContentHelper(never, 'relative/home', 'skills-check', {}, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'agent_content_home'
    })
  })
})
