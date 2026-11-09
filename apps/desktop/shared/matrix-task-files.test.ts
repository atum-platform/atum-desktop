import { describe, expect, it } from 'vitest'

import { parseMatrixTaskFilesPromise } from './matrix-task-files'

const first = '00000000-0000-4000-8000-6e1357ad4c59'
const second = '00000000-0000-4000-8000-914ef7a13b20'

describe('parseMatrixTaskFilesPromise', () => {
  it('returns a copied exact owner grant rendezvous', () => {
    const input = { version: 1, requestIds: [first, second] }
    const result = parseMatrixTaskFilesPromise(input)

    expect(result).toEqual(input)
    expect(result?.requestIds).not.toBe(input.requestIds)
  })

  it.each([
    null,
    0,
    [],
    {},
    { version: 1, requestIds: [] },
    { version: 0, requestIds: [first] },
    { version: 1, requestIds: [first, first] },
    { version: 1, requestIds: [first.toUpperCase()] },
    { version: 1, requestIds: [first], extra: true }
  ])('rejects malformed task-file promises (%j)', value => {
    expect(parseMatrixTaskFilesPromise(value)).toBeNull()
  })
})
