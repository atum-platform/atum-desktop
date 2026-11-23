import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { type ConnectorPorts, ConnectorService } from './service'
const caller = { threadId: 'thread', providerInstanceId: 'codex', providerSessionId: 'native' }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'work-question-'))

  const ports: ConnectorPorts = {
    current: () => true,
    resolve: async () => ({ room: '!dm:test', agent: '@agent:test' }),
    send: vi.fn(async () => '$question'),
    read: async () => undefined,
    admit: async () => true
  }

  const file = join(directory, 'receipts.json')

  return {
    ports,
    file,
    service: new ConnectorService(file, ports),
    [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true })
  }
}

describe('Work connector receipts and release', () => {
  it('sends once across polls, restart and concurrent requests; rejects incompatible repeats', async () => {
    using f = fixture()
    const q = { agent: 'owned', question: 'Hello', request_id: randomUUID() }
    const results = await Promise.all([f.service.ask(caller, q, 0), f.service.ask(caller, q, 0)])
    expect(results.map(r => r.state)).toEqual(['waiting', 'waiting'])
    const restarted = new ConnectorService(f.file, f.ports)
    expect((await restarted.ask(caller, { agent: q.agent, request_id: q.request_id }, 0)).state).toBe('waiting')
    expect(f.ports.send).toHaveBeenCalledTimes(1)
    await expect(restarted.ask(caller, { ...q, question: 'Different' }, 0)).rejects.toThrow('work_request_conflict')
    await expect(restarted.ask({ ...caller, threadId: 'foreign' }, q, 0)).rejects.toThrow('work_request_conflict')
  })
  it('retries ambiguous acknowledgements with the same transaction without creating a new question', async () => {
    using f = fixture()
    const send = vi.fn().mockRejectedValueOnce(new Error('lost ack')).mockResolvedValue('$question')
    f.ports.send = send
    const q = { agent: 'owned', question: 'Hello', request_id: randomUUID() }
    expect((await f.service.ask(caller, q, 0)).state).toBe('unavailable')
    const restarted = new ConnectorService(f.file, f.ports)
    await Promise.all([restarted.ask(caller, q, 0), restarted.ask(caller, q, 0)])
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]![0].transaction).toBe(send.mock.calls[1]![0].transaction)
  })
  it.each(['google', 'unknown'] as const)('releases %s answers to the live plan session', async dataClass => {
    using f = fixture()
    f.ports.read = async () => ({ body: 'protected answer', dataClass })
    const result = await f.service.ask(caller, { agent: 'owned', question: 'Hello', request_id: randomUUID() }, 0)
    expect(result).toMatchObject({ state: 'answered', answer: 'protected answer', provenance: dataClass })
  })
  it('rechecks the live provider after reading and never releases after account change', async () => {
    using f = fixture()

    f.ports.read = async () => {
      f.ports.current = () => false

      return { body: 'private', dataClass: 'non_google' }
    }

    const result = await f.service.ask(caller, { agent: 'owned', question: 'Hello', request_id: randomUUID() }, 0)
    expect(result.state).toBe('cancelled')
    expect(result.answer).toBeUndefined()
  })
  it('releases clean answers, refuses foreign agents and cancels all future waits', async () => {
    using f = fixture()
    f.ports.read = async () => ({ body: 'clean', dataClass: 'non_google' })
    expect((await f.service.ask(caller, { agent: 'owned', question: 'Hi', request_id: randomUUID() }, 0)).answer).toBe(
      'clean'
    )
    f.ports.resolve = async () => undefined
    expect((await f.service.ask(caller, { agent: 'foreign', question: 'Hi', request_id: randomUUID() }, 0)).state).toBe(
      'unavailable'
    )
    f.service.cancel()
    expect((await f.service.ask(caller, { agent: 'owned', question: 'Hi', request_id: randomUUID() }, 0)).state).toBe(
      'cancelled'
    )
  })
  it('requires live caller admission even for answers with a clean marker', async () => {
    using f = fixture()
    const q = { agent: 'owned', question: 'Hi', request_id: randomUUID() }

    f.ports.read = async () => {
      f.ports.admit = async () => false

      return { body: 'clean', dataClass: 'non_google' }
    }

    expect(await f.service.ask(caller, q, 0)).toMatchObject({ state: 'unavailable' })
  })

  it('bounds the overall deadline, without another send', async () => {
    using f = fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)

    try {
      const q = { agent: 'owned', question: 'Hi', request_id: randomUUID() }
      await f.service.ask(caller, q, 0)
      clock.mockReturnValue(301001)
      const restarted = new ConnectorService(f.file, f.ports)
      expect((await restarted.ask(caller, q, 0)).state).toBe('timed_out')
      expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual([[q.request_id, null]])
      expect(f.ports.send).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
})
