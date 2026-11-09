import { afterEach, expect, it, vi } from 'vitest'

import { MatrixTerminals } from './terminals'

afterEach(() => vi.useRealTimers())

function fixture() {
  const changed = vi.fn(), streamed = vi.fn()
  const terminals = new MatrixTerminals(changed, streamed)
  let alive = true

  const receive = (chunk: string, processId = 'process-1', scope = 'room-one') =>
    terminals.receive(scope, { kind: 'output', processId, chunk }, () => alive)

  receive('first\r\n')
  const tab = terminals.view('room-one')[0]

  return { terminals, changed, streamed, receive, tab, retire: () => { alive = false } }
}

it('offers output without opening; closing retains the same bounded backlog and never kills a process', () => {
  const f = fixture()
  expect(f.tab.open).toBe(false)
  expect(f.terminals.view('room-two')).toEqual([])
  expect(() => f.terminals.read('room-two', f.tab.id)).toThrow('matrix_terminal_unavailable')
  f.terminals.open('room-one', f.tab.id)
  f.terminals.close('room-one', f.tab.id)
  f.receive('later\r\n')
  expect(f.terminals.read('room-one', f.tab.id)).toMatchObject({ output: 'first\r\nlater\r\n', sequence: 2 })
  expect(f.terminals.view('room-one')[0].open).toBe(false)
  f.terminals.open('room-one', f.tab.id)
  expect(f.terminals.view('room-one')[0]).toEqual({ ...f.tab, open: true })
  expect(f.streamed.mock.calls.at(-1)?.[0]).toMatchObject({ id: f.tab.id, scope: 'room-one', sequence: 2, chunk: 'later\r\n' })
  f.receive('x'.repeat(64_000))
  expect(f.terminals.read('room-one', f.tab.id).output).toHaveLength(64_000)
  f.retire()
  expect(f.terminals.view('room-one')).toEqual([])
  expect(() => f.terminals.open('room-one', f.tab.id)).toThrow('matrix_terminal_unavailable')
})

it('bounds view count, rejects unknown process IDs and retains an oversized chunk tail', () => {
  const f = fixture()
  f.receive('ignored', '../foreign')
  f.receive('x'.repeat(64_001))
  expect(f.terminals.read('room-one', f.tab.id)).toMatchObject({ sequence: 2, output: 'x'.repeat(64_000) })
  f.terminals.open('room-one', f.tab.id)

  for (let i = 2; i <= 8; i++) {
    f.receive('owned', `process-${i}`)
    const tab = f.terminals.view('room-one').find(tab => !tab.open)!
    f.terminals.open('room-one', tab.id)
  }

  f.receive('ninth', 'process-9')
  expect(f.terminals.view('room-one')).toHaveLength(8)
  f.terminals.close('room-one', f.tab.id)
  f.receive('ninth', 'process-9')
  expect(f.terminals.view('room-one')).toHaveLength(8)
  expect(() => f.terminals.read('room-one', f.tab.id)).toThrow('matrix_terminal_unavailable')
})

it('closes only the indicated original view and leaves output available for reopening', () => {
  const f = fixture()
  f.terminals.open('room-one', f.tab.id)
  f.terminals.receive('room-two', { kind: 'close', processId: 'process-1' }, () => true)
  expect(f.terminals.view('room-one')[0].open).toBe(true)
  f.terminals.receive('room-one', { kind: 'close', processId: 'process-1' }, () => true)
  expect(f.terminals.view('room-one')[0].open).toBe(false)
  expect(f.terminals.read('room-one', f.tab.id).output).toBe('first\r\n')
})

it('accepts only a bounded response to the current opaque foreground read', async () => {
  const f = fixture(), controller = new AbortController()
  expect(await f.terminals.readPane('room-one', {}, () => true, controller.signal)).toBeNull()
  f.terminals.open('room-one', f.tab.id)
  const pending = f.terminals.readPane('room-one', { start: -3, count: 9_000 }, () => true, controller.signal)
  const request = f.terminals.readRequest('room-one')!
  expect(request).toMatchObject({ start: 0, count: 1_000 })
  const result = { total_lines: 24, start: 0, end: 24, viewport_rows: 24, cursor_row: 1, text: 'actual cells' }
  expect(() => f.terminals.respond('room-two', request.id, result)).toThrow('matrix_terminal_unavailable')
  expect(() => f.terminals.respond('room-one', 'foreign', result)).toThrow('matrix_terminal_unavailable')
  expect(() => f.terminals.respond('room-one', request.id, { ...result, end: 99 })).toThrow('matrix_terminal_invalid')
  f.terminals.respond('room-one', request.id, { ...result, token: 'never-forward' })
  expect(await pending).toEqual(result)
  expect(() => f.terminals.respond('room-one', request.id, result)).toThrow('matrix_terminal_unavailable')
})

it.each(['timeout', 'abort', 'room', 'backend'] as const)('retires a pending foreground read on %s', async reason => {
  vi.useFakeTimers()
  const f = fixture(), controller = new AbortController()
  let alive = true
  f.terminals.open('room-one', f.tab.id)
  const pending = f.terminals.readPane('room-one', {}, () => alive, controller.signal)
  const id = f.terminals.readRequest('room-one')!.id

  if (reason === 'timeout') { await vi.advanceTimersByTimeAsync(2_000) }

  if (reason === 'abort') { controller.abort() }

  if (reason === 'room') { expect(f.terminals.readRequest('room-two')).toBeUndefined() }

  if (reason === 'backend') { alive = false; expect(f.terminals.readRequest('room-one')).toBeUndefined() }
  expect(await pending).toBeNull()
  expect(() => f.terminals.respond('room-one', id, null)).toThrow('matrix_terminal_unavailable')
})
