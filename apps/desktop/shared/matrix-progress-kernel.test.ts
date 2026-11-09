import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PROGRESS_LIMITS, MatrixProgressKernel } from './matrix-progress-kernel'

const options = (privateChat = true) => ({
  privateChat,
  redact: vi.fn((text: string) => text.replaceAll('secret', '[redacted]')),
  heartbeatText: (minutes: number) => `Still working · ${minutes} minutes`,
  settledFallback: 'Finished this step'
})

const contract = JSON.parse(
  readFileSync(new URL('../../../packages/device-protocol/fixtures/agent-turns/contract.json', import.meta.url), 'utf8')
) as {
  parameters: {
    progress_min_edit_ms: number
    progress_heartbeat_ms: number
    progress_max_edits_per_turn: number
    progress_body_max_chars: number
  }
}

describe('agent-turns/1.3 progress kernel', () => {
  it('uses the exact vendored contract bounds', () => {
    expect(MATRIX_PROGRESS_LIMITS).toEqual({
      minEditMs: contract.parameters.progress_min_edit_ms,
      heartbeatMs: contract.parameters.progress_heartbeat_ms,
      maxEdits: contract.parameters.progress_max_edits_per_turn,
      bodyMaxChars: contract.parameters.progress_body_max_chars
    })
  })

  it('publishes once, coalesces throttled updates, and edits the same logical line', () => {
    const kernel = new MatrixProgressKernel(options())
    expect(kernel.offer({ kind: 'interim', text: 'Checking' }, 0)).toMatchObject({
      action: 'publish', frame: { revision: 0, body: 'Checking' }
    })
    expect(kernel.offer({ kind: 'interim', text: 'Reading' }, 1_000)).toEqual({ action: 'hold' })
    expect(kernel.offer({ kind: 'interim', text: 'Summarising' }, 2_000)).toEqual({ action: 'hold' })
    expect(kernel.flush(2_999)).toEqual({ action: 'hold' })
    expect(kernel.flush(3_000)).toMatchObject({
      action: 'edit', frame: { revision: 1, body: 'Summarising' }
    })
  })

  it('cancels an obsolete queued edit when the visible body becomes current again', () => {
    const kernel = new MatrixProgressKernel(options())
    expect(kernel.offer({ kind: 'interim', text: 'A' }, 0).action).toBe('publish')
    expect(kernel.offer({ kind: 'interim', text: 'B' }, 1_000)).toEqual({ action: 'hold' })
    expect(kernel.offer({ kind: 'interim', text: 'A' }, 2_000)).toEqual({ action: 'drop' })
    expect(kernel.flush(3_000)).toEqual({ action: 'drop' })
  })

  it('redacts, renders todo state and bounds Unicode content', () => {
    const o = options()
    const kernel = new MatrixProgressKernel(o)
    const decision = kernel.offer({
      kind: 'todo',
      text: `secret ${'😀'.repeat(MATRIX_PROGRESS_LIMITS.bodyMaxChars)}`,
      todo: [
        { text: 'Read', state: 'done' },
        { text: 'Write', state: 'active' }
      ]
    }, 0)

    expect(o.redact).toHaveBeenCalledOnce()
    expect(decision).toMatchObject({ action: 'publish', frame: { kind: 'todo' } })
    if (decision.action === 'publish') {
      expect([...decision.frame.body]).toHaveLength(MATRIX_PROGRESS_LIMITS.bodyMaxChars)
      expect(decision.frame.body.startsWith('[redacted]')).toBe(true)
    }
  })

  it('never publishes progress in a group', () => {
    const o = options(false)
    const kernel = new MatrixProgressKernel(o)
    expect(kernel.offer({ kind: 'interim', text: 'No' }, 0)).toEqual({ action: 'drop' })
    expect(o.redact).not.toHaveBeenCalled()
  })

  it('emits a quiet heartbeat only after three silent minutes', () => {
    const kernel = new MatrixProgressKernel(options())
    kernel.offer({ kind: 'interim', text: 'Checking' }, 0)
    expect(kernel.heartbeat(MATRIX_PROGRESS_LIMITS.heartbeatMs - 1)).toEqual({ action: 'hold' })
    expect(kernel.heartbeat(MATRIX_PROGRESS_LIMITS.heartbeatMs)).toMatchObject({
      action: 'edit',
      frame: { kind: 'heartbeat', heartbeat: true, body: 'Still working · 3 minutes' }
    })
  })

  it('does not reset heartbeat silence for a duplicate of the visible body', () => {
    const kernel = new MatrixProgressKernel(options())
    kernel.offer({ kind: 'interim', text: 'Checking' }, 0)
    expect(kernel.offer({ kind: 'interim', text: 'Checking' }, 1_000)).toEqual({ action: 'drop' })
    expect(kernel.heartbeat(MATRIX_PROGRESS_LIMITS.heartbeatMs)).toMatchObject({
      action: 'edit', frame: { kind: 'heartbeat', heartbeat: true, body: 'Still working · 3 minutes' }
    })
  })

  it('reserves the last edit for settlement and never duplicates the final answer', () => {
    const kernel = new MatrixProgressKernel(options())
    kernel.offer({ kind: 'interim', text: 'Start' }, 0)

    for (let revision = 1; revision < MATRIX_PROGRESS_LIMITS.maxEdits; revision++) {
      expect(kernel.offer({ kind: 'interim', text: `Step ${revision}` }, revision * 3_000).action).toBe('edit')
    }

    expect(kernel.offer({ kind: 'interim', text: 'Held final detail' }, 200_000)).toEqual({ action: 'hold' })
    expect(kernel.settle(201_000, 'Held final detail')).toMatchObject({
      action: 'edit', frame: { revision: MATRIX_PROGRESS_LIMITS.maxEdits, kind: 'settled', body: 'Finished this step' }
    })
    expect(kernel.offer({ kind: 'interim', text: 'Too late' }, 204_000)).toEqual({ action: 'drop' })
  })
})
