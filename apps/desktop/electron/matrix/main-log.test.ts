import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_LOG_LIMIT, mirrorTaggedConsole } from './main-log'

const dirs: string[] = []

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-main-log-'))
  dirs.push(dir)
  const seen: unknown[][] = []
  const target = { warn: (...args: unknown[]) => void seen.push(args), error: (...args: unknown[]) => void seen.push(args) }
  mirrorTaggedConsole(dir, target, () => new Date('2026-09-26T08:00:00.000Z'))

  return { dir, seen, target, read: () => fs.readFileSync(path.join(dir, 'main.log'), 'utf8') }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('mirrorTaggedConsole', () => {
  it('keeps the console output and appends tagged warnings and errors with a timestamp', () => {
    const { seen, target, read } = setup()
    target.warn('[Matrix] assistant setup did not finish:', 'model', 'matrix_setup_failed')
    target.error('[Matrix] Hermes runtime unavailable:', new Error('matrix_runtime_missing'))

    expect(seen).toHaveLength(2)
    expect(read()).toBe(
      '2026-09-26T08:00:00.000Z warn [Matrix] assistant setup did not finish: model matrix_setup_failed\n' +
        '2026-09-26T08:00:00.000Z error [Matrix] Hermes runtime unavailable: Error: matrix_runtime_missing\n'
    )
  })

  it('writes nothing for untagged library output', () => {
    const { dir, target } = setup()
    target.warn('room !abc:example sent an undecryptable event')
    target.error({ detail: 'x' })

    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(false)
  })

  it('rotates once past the size limit, keeping the previous file', () => {
    const { dir, target, read } = setup()
    fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(MAIN_LOG_LIMIT + 1))
    target.warn('[Matrix] after rotation')

    expect(fs.statSync(path.join(dir, 'main.old.log')).size).toBe(MAIN_LOG_LIMIT + 1)
    expect(read()).toBe('2026-09-26T08:00:00.000Z warn [Matrix] after rotation\n')
  })

  it('never throws when the log cannot be written', () => {
    const { dir, target } = setup()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.writeFileSync(dir, 'a file where the directory should be')
    dirs.push(dir)

    expect(() => target.warn('[Matrix] unwritable')).not.toThrow()
  })
})
