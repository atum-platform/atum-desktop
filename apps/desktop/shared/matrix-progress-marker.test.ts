import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { matrixProgressMarker, matrixProgressMarkerOf } from './matrix-progress-marker'

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
