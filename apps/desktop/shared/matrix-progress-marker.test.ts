import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { matrixProgressMarker, matrixProgressMarkerOf, matrixProgressPresentation } from './matrix-progress-marker'

const fixtures = join(__dirname, '../../../packages/device-protocol/fixtures/agent-turns/fixtures')
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as Record<string, unknown>

describe('the io.atum.progress marker against the vendored agent-turns/1.3 pack', () => {
  it('reads the marker of every accepted fixture, on the edit and inside m.new_content', () => {
    for (const name of ['progress-original', 'progress-edit', 'progress-heartbeat', 'progress-settled']) {
      const content = fixture(`${name}.content.json`)
      const marker = matrixProgressMarker(content)

      expect(marker, name).toBeDefined()
      expect(marker).toEqual(content['io.atum.progress'])

      if (content['m.new_content']) {
        expect(matrixProgressMarker(content['m.new_content']), name).toEqual(marker)
      }
    }
  })

  it('refuses the fixtures the contract rejects (a group scope)', () => {
    expect(matrixProgressMarker(fixture('progress-group-rejected.content.json'))).toBeUndefined()
  })

  it('keeps nothing but the contract’s fields, and rejects out-of-range or malformed ones', () => {
    const base = fixture('progress-edit.content.json')['io.atum.progress'] as Record<string, unknown>

    expect(matrixProgressMarker({ 'io.atum.progress': { ...base, extra: 'x', token: 'secret' } })).toEqual(base)

    for (const bad of [
      { revision: 49 },
      { revision: -1 },
      { revision: 1.5 },
      { kind: 'tool' },
      { phase: 'done' },
      { profile: 'atum.agent-turns/1.2' },
      { device: '' },
      { device: 'x'.repeat(81) },
      { heartbeat: false }
    ]) {
      expect(matrixProgressMarker({ 'io.atum.progress': { ...base, ...bad } }), JSON.stringify(bad)).toBeUndefined()
    }

    expect(matrixProgressMarker({})).toBeUndefined()
    expect(matrixProgressMarker(null)).toBeUndefined()
  })

  it('builds the marker a kernel frame publishes under', () => {
    expect(
      matrixProgressMarkerOf({
        profile: 'atum.agent-turns/1.3',
        scope: 'owner_private',
        body: 'Vẫn đang làm · 3 phút',
        kind: 'heartbeat',
        phase: 'working',
        revision: 2,
        heartbeat: true
      })
    ).toEqual(fixture('progress-heartbeat.content.json')['io.atum.progress'])
  })
})

// New-runtime cron turns have no owner source event. Absence alone cannot identify one.
it('preserves the explicit cron trigger for native Stop', () => {
  const base = fixture('progress-original.content.json')['io.atum.progress'] as Record<string, unknown>
  expect(matrixProgressMarker({ 'io.atum.progress': { ...base, trigger: 'cron' } })).toEqual({ ...base, trigger: 'cron' })
})

describe('the io.atum.presentation descriptor against the vendored agent-turns/1.6 pack', () => {
  const pack = join(__dirname, '../contracts/atum-agent-turns-v1.6/fixtures')

  const vectors = (
    JSON.parse(readFileSync(join(pack, 'presentation-descriptor.vectors.json'), 'utf8')) as {
      vectors: { name: string; kind: string; phase: string; descriptor: unknown; decision: 'render' | 'fallback' }[]
    }
  ).vectors

  // The codes this build words. A code it does not word is "show body" (A12), never an error.
  const worded = new Set(['tool_activity', 'heartbeat'])

  it('renders exactly the vectors the contract renders, for every code it words, and falls back otherwise', () => {
    for (const vector of vectors) {
      const code = (vector.descriptor as { code?: string }).code ?? ''
      const read = matrixProgressPresentation({ 'io.atum.presentation': vector.descriptor }, vector)

      expect(Boolean(read), vector.name).toBe(vector.decision === 'render' && worded.has(code))
    }
  })

  it('reads the descriptor of the pack’s tool-activity and heartbeat lines', () => {
    for (const name of ['progress-presentation-tool-activity', 'progress-presentation-heartbeat']) {
      const content = JSON.parse(readFileSync(join(pack, `${name}.content.json`), 'utf8')) as Record<string, unknown>

      expect(matrixProgressPresentation(content, matrixProgressMarker(content)!), name).toEqual(content['io.atum.presentation'])
    }
  })

  it('pairs the approval wait only with a waiting device line', () => {
    const wait = { 'io.atum.presentation': { version: 1, code: 'approval_wait', args: {} } }

    expect(matrixProgressPresentation(wait, { kind: 'device', phase: 'waiting' })).toEqual(wait['io.atum.presentation'])
    expect(matrixProgressPresentation(wait, { kind: 'todo', phase: 'working' })).toBeUndefined()
    expect(matrixProgressPresentation({ 'io.atum.presentation': { version: 1, code: 'approval_wait', args: { prompt: 'x' } } },
      { kind: 'device', phase: 'waiting' })).toBeUndefined()
  })
})
