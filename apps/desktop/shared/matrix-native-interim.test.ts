import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { MatrixInterimMessages } from './matrix-interim-messages'
import type { MatrixNoticeEdit } from './matrix-notice-edit'
import { matrixHermesProgressEvent } from './matrix-progress-line'

// Requires the repository's Python runtime dependencies, but no provider or network.
describe('native Hermes interim delivery', () => {
  it('publishes one safe native interim before the intact final answer', async () => {
    const fixture = fileURLToPath(new URL('../../../tests/gateway/fixtures/native_interim_frames.py', import.meta.url))
    const frames = JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', [fixture], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })) as Array<{ params: { type: string; session_id: string; payload: Record<string, unknown> } }>
    const published: MatrixNoticeEdit[] = []
    const interim = new MatrixInterimMessages({ roomId: '!room:test', eventId: '$question' }, {
      current: () => true,
      publish: async command => { published.push(command); return '$interim' },
      now: () => 0,
      after: () => () => undefined
    }, { privateChat: true, transactionFor: sequence => `interim-${sequence}` })

    expect(frames.map(frame => frame.params.type)).toEqual(['message.interim', 'message.complete'])
    for (const { params } of frames) {
      expect(params.session_id).toBe('offline-interim')
      const progress = matrixHermesProgressEvent(params.type, params.payload)
      if (progress?.kind === 'narration') interim.offer(progress.text)
      if (params.type === 'message.complete') {
        await interim.end(params.payload.text as string)
        published.push({ roomId: '!room:test', eventId: '$question', body: params.payload.text as string })
      }
    }
    expect(published).toHaveLength(2)
    expect(published[0]).toMatchObject({ interim: true })
    expect(published[0]!.body).toContain('I am checking')
    expect(published[1]!.body).toBe('Here is the answer.')
    expect(JSON.stringify(published)).not.toMatch(/PRIVATE|A{36}/)
  })
})
