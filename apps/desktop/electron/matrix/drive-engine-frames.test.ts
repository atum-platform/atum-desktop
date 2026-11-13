import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { type MatrixDriveFrameContext, MatrixDriveFrameReader, validateMatrixDriveFrame } from './drive-engine-frames'

interface Vector {
  id: string
  context: MatrixDriveFrameContext
  direction: 'engine_to_app' | 'app_to_engine'
  wire: string
  chunks?: number[]
  expected: { verdict: 'accept' | 'reject'; code: string }
}
const folder = fileURLToPath(new URL('./__fixtures__/drive-engine-1.1/', import.meta.url))

const vectors = readdirSync(folder)
  .filter(name => name.endsWith('.jsonl'))
  .flatMap(name =>
    readFileSync(path.join(folder, name), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Vector)
  )

it('requires negotiated file-status capability and validates every private path and closed state', () => {
  const context: MatrixDriveFrameContext = { phase: 'started', offered: ['file_status'], accepted: ['file_status'], issuer: 'https://auth.test/', origin: 'https://drive.test' }
  const frame = { kind: 'file_status', path: 'Docs/report.txt', state: 'conflict' }

  for (const state of ['conflict', 'error', 'uploading', 'clear']) {
    expect(() => validateMatrixDriveFrame({ ...frame, state }, context)).not.toThrow()
  }

  expect(() => validateMatrixDriveFrame(frame, { ...context, accepted: [] })).toThrow('feature_not_accepted')
  expect(() => validateMatrixDriveFrame(frame, context, 'app_to_engine')).toThrow('direction')

  for (const invalid of [
    { ...frame, state: 'synced' }, { ...frame, message: 'private error text' },
    ...['../secret', '/outside', 'Docs/../secret', 'Docs//file', 'Docs/.hidden', 'C:/file', 'Docs\\file', 'Docs/\nfile'].map(path => ({ ...frame, path }))
  ]) {expect(() => validateMatrixDriveFrame(invalid, context)).toThrow()}
})

it.each(vectors)('canonical wire $id', vector => {
  const reader = new MatrixDriveFrameReader()
  const bytes = Buffer.from(vector.wire)
  const context = structuredClone(vector.context)
  let offset = 0
  let code = 'ok'

  try {
    for (const length of vector.chunks ?? [bytes.length]) {
      for (const frame of reader.push(bytes.subarray(offset, offset + length))) {
        validateMatrixDriveFrame(frame, context, vector.direction)

        if (frame.kind === 'progress') {
          context.previousProgress = frame as unknown as MatrixDriveFrameContext['previousProgress']
        }

        if (frame.kind === 'sync') {
          context.lastSyncAt = frame.lastSyncAt as number
        }
      }

      offset += length
    }

    if (offset < bytes.length) {
      for (const frame of reader.push(bytes.subarray(offset))) {
        validateMatrixDriveFrame(frame, context, vector.direction)
      }
    }
  } catch (error) {
    code = (error as Error).message
  }

  expect(code).toBe(vector.expected.code)
})

it('decodes UTF-8 split at every byte without replacement characters', () => {
  const wire = Buffer.from(JSON.stringify({ kind: 'exclusions', patterns: ['báo-cáo'] }) + '\n')

  for (let cut = 0; cut < wire.length; cut++) {
    const reader = new MatrixDriveFrameReader()
    const frames = [...reader.push(wire.subarray(0, cut)), ...reader.push(wire.subarray(cut))]
    expect(frames).toEqual([{ kind: 'exclusions', patterns: ['báo-cáo'] }])
  }
})
it('rejects invalid UTF-8 without copying the payload to its exception', () => {
  const reader = new MatrixDriveFrameReader()
  expect(() => reader.push(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]))).toThrow('utf8')
  expect(() => reader.push(Buffer.from('{}\n'))).toThrow('protocol')
})

it('accepts the app credential on start only as accessToken[ and expiresAt]', () => {
  const context: MatrixDriveFrameContext = {
    phase: 'hello',
    offered: ['sync'],
    accepted: [],
    issuer: 'https://auth.test/',
    origin: 'https://drive.test'
  }

  expect(() =>
    validateMatrixDriveFrame(
      { kind: 'start', credential: { accessToken: 'opaque-token', expiresAt: 1_792_000_000_000 } },
      context,
      'app_to_engine'
    )
  ).not.toThrow()
  expect(() =>
    validateMatrixDriveFrame({ kind: 'start', credential: { accessToken: 'opaque-token' } }, context, 'app_to_engine')
  ).not.toThrow()

  for (const credential of [
    {},
    { accessToken: '' },
    { accessToken: 'a b' },
    { accessToken: 'a\nb' },
    { accessToken: 'opaque-token', refreshToken: 'never' },
    { accessToken: 'opaque-token', expiresAt: -1 },
    { accessToken: 'opaque-token', expiresAt: 1.5 }
  ]) {
    expect(() => validateMatrixDriveFrame({ kind: 'start', credential }, context, 'app_to_engine')).toThrow()
  }
})
