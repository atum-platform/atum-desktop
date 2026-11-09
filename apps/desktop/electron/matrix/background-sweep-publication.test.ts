import { describe, expect, it, vi } from 'vitest'

import { MatrixBackgroundSweepPublication } from './background-sweep-publication'

const input = {
  agent: '00000000-0000-4000-8000-dec97132ebbf',
  occurrenceId: '00000000-0000-4000-8000-149a1ef8d82f',
  roomId: '!agent:atum.test',
  body: 'Lan needs an answer. Shall I draft a reply?',
  google: false
}

function harness() {
  const values = new Map<string, string>()
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    keys: (prefix = '') => [...values.keys()].filter(key => key.startsWith(prefix))
  }
  const prepare = vi.fn(async () => ({
    eventType: 'm.room.message' as const,
    content: { msgtype: 'm.text', body: input.body }
  }))
  const enqueue = vi.fn(async () => {})
  return {
    values,
    prepare,
    enqueue,
    publication: new MatrixBackgroundSweepPublication({ store: () => store, prepare, enqueue })
  }
}

describe('background sweep publication staging', () => {
  it('seals bytes before enqueue and reuses them exactly', async () => {
    const h = harness()
    const first = await h.publication.stage(input, new AbortController().signal)
    expect(first.outboxId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(first.bodySha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.enqueue).toHaveBeenCalledOnce()
    expect(h.values.size).toBe(1)

    await expect(h.publication.stage(input, new AbortController().signal)).resolves.toEqual(first)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(h.enqueue).toHaveBeenCalledTimes(2)
  })

  it('refuses changed wording under the same occurrence', async () => {
    const h = harness()
    await h.publication.stage(input, new AbortController().signal)
    await expect(h.publication.stage({ ...input, body: 'Changed' }, new AbortController().signal)).rejects.toThrow(
      'matrix_background_sweep_publication_conflict'
    )
    expect(h.prepare).toHaveBeenCalledOnce()
  })
})
