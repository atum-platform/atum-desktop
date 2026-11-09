// @vitest-environment node
import { expect, it, vi } from 'vitest'

import type { MatrixNoticeEdit } from '../../shared/matrix-notice-edit'
import { MatrixStatusLine } from '../../shared/matrix-status-line'

import { matrixNoticeEditTransaction, matrixStatusNoticeTransaction } from './notice-edit'
const target = { roomId: '!room:test', eventId: '$question', statusLine: true as const }

function fixture() {
  let current = true
  const commands: MatrixNoticeEdit[] = []

  const publish = vi.fn(async (command: MatrixNoticeEdit) => {
    commands.push({ ...command })

    return `$notice-${commands.length}`
  })

  const line = new MatrixStatusLine(target, { current: () => current, publish })

  return {
    line,
    commands,
    publish,
    expire: () => {
      current = false
    }
  }
}

it('keeps one original notice, monotone edits, and no duplicate for unchanged copy', async () => {
  const f = fixture()
  await f.line.update('Queued')
  await f.line.update('Needs approval')
  await f.line.update('Needs approval')
  await f.line.update('Queued')
  expect(f.commands).toEqual([
    { ...target, body: 'Queued' },
    { ...target, body: 'Needs approval', replaces: '$notice-1', revision: 1 },
    { ...target, body: 'Queued', replaces: '$notice-1', revision: 2 }
  ])
  expect(matrixStatusNoticeTransaction('$question')).toBe('atum-sn-question')
  expect(matrixNoticeEditTransaction('$notice-1', 1)).not.toBe(matrixNoticeEditTransaction('$notice-1', 2))
  expect(matrixNoticeEditTransaction('$a+b', 1)).not.toBe(matrixNoticeEditTransaction('$a/b', 1))
  expect(matrixNoticeEditTransaction('$a.2b', 1)).not.toBe(matrixNoticeEditTransaction('$a+b', 1))
})
it('serializes concurrent state changes under the same original notice', async () => {
  const f = fixture()
  let resolve!: (value: string) => void
  f.publish.mockImplementationOnce(command => {
    f.commands.push({ ...command })

    return new Promise<string>(done => {
      resolve = done
    })
  })
  const first = f.line.update('Queued')
  const second = f.line.update('Waiting')
  await vi.waitFor(() => expect(f.commands).toHaveLength(1))
  resolve('$original')
  await Promise.all([first, second])
  expect(f.commands[1]).toMatchObject({ replaces: '$original', revision: 1, body: 'Waiting' })
})
it('settles an ambiguous failed edit with identical content/revision before the next state', async () => {
  const f = fixture()
  await f.line.update('Queued')
  f.publish.mockImplementationOnce(async command => {
    f.commands.push({ ...command })
    throw new Error('network_fixture')
  })
  await expect(f.line.update('Waiting')).rejects.toThrow('network_fixture')
  await f.line.update('Working')
  expect(f.commands[1]).toEqual(f.commands[2])
  expect(f.commands[3]).toMatchObject({ replaces: '$notice-1', revision: 2, body: 'Working' })
})
it('drains the in-flight publication and drops queued/later edits before the outcome', async () => {
  const f = fixture()
  let resolve!: (value: string) => void
  const order: string[] = []
  f.publish.mockImplementationOnce(command => {
    f.commands.push({ ...command })

    return new Promise<string>(done => {
      resolve = done
    })
  })
  const first = f.line.update('Waiting')
  await vi.waitFor(() => expect(f.commands).toHaveLength(1))
  const queued = f.line.update('Working')

  const ended = f.line.end().then(() => {
    order.push('outcome')
  })

  await Promise.resolve()
  expect(order).toEqual([])
  resolve('$original')
  await Promise.all([first, queued, ended])
  await f.line.update('Too late')
  expect(f.commands).toHaveLength(1)
  expect(order).toEqual(['outcome'])
})
it('never publishes after the real native fence expires, including queued work', async () => {
  const f = fixture()
  const update = f.line.update('Waiting')
  f.expire()
  await update
  await f.line.update('Working')
  expect(f.commands).toEqual([])
})
it('closes after a publication failure without retrying after the outcome', async () => {
  const f = fixture()
  f.publish.mockRejectedValueOnce(new Error('network_fixture'))
  await expect(f.line.update('Waiting')).rejects.toThrow('network_fixture')
  await f.line.end()
  await f.line.update('Working')
  expect(f.publish).toHaveBeenCalledTimes(1)
})

it('retains an ambiguous revision when the native fence becomes unavailable during its retry', async () => {
  const current = vi.fn(() => true)
  const commands: MatrixNoticeEdit[] = []

  const publish = vi.fn(async (command: MatrixNoticeEdit) => {
    commands.push({ ...command })

    return `$notice-${commands.length}`
  })

  const line = new MatrixStatusLine(target, { current, publish })
  await line.update('Queued')
  publish.mockImplementationOnce(async command => {
    commands.push({ ...command })
    throw new Error('network_fixture')
  })
  await expect(line.update('Waiting')).rejects.toThrow('network_fixture')
  current.mockReturnValueOnce(true).mockReturnValueOnce(false)
  await line.update('Working')
  expect(commands).toHaveLength(2)
  await line.update('Working')
  expect(commands[2]).toEqual(commands[1])
  expect(commands[3]).toMatchObject({ body: 'Working', revision: 2, replaces: '$notice-1' })
})
