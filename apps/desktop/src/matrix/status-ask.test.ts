// @vitest-environment node
import { expect, it, vi } from 'vitest'

import { matrixWorkingAsk } from '../../electron/matrix/agent-signals'
import { MatrixHermesPrompts } from '../../electron/matrix/hermes-prompts'
import type { MatrixNoticeEdit } from '../../shared/matrix-notice-edit'
import { type MatrixPresentationCommand, MatrixPresentationSignals } from '../../shared/matrix-presentation-signals'
import { MatrixProgressLine } from '../../shared/matrix-progress-line'
import { matrixStatusAsk } from '../../shared/matrix-status-ask'
import { MatrixStatusLine } from '../../shared/matrix-status-line'
import { matrixStatusLineCopy } from '../../shared/matrix-status-line-copy'

it('wraps real native prompts and shared typing: wait, resume typing, say the wait is over, then close', async () => {
  const notices: MatrixNoticeEdit[] = []
  const signals = vi.fn(async (_command: MatrixPresentationCommand) => {})

  const presentation = new MatrixPresentationSignals({
    send: signals,
    owner: () => '@owner:test',
    leaseHeld: () => true,
    every: () => () => {}
  })

  const line = new MatrixStatusLine(
    { roomId: '!room:test', eventId: '$question' },
    {
      current: () => true,
      publish: async command => {
        notices.push(command)

        return `$notice-${notices.length}`
      }
    }
  )

  const prompts = new MatrixHermesPrompts(() => {})
  const work = presentation.work('!room:test')
  const log = vi.fn()
  const ask = matrixStatusAsk(matrixWorkingAsk(prompts.ask, work), line, matrixStatusLineCopy.en, log)
  const abort = new AbortController()
  const pending = ask({ kind: 'clarify', question: 'Private question', choices: [] }, abort.signal, Date.now() + 60000)
  expect(prompts.snapshot()).toHaveLength(1)
  expect(signals.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'agentTyping', typing: false })
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  expect(notices[0]!.body).toBe(matrixStatusLineCopy.en.waiting)
  expect(JSON.stringify(notices)).not.toContain('Private question')
  prompts.respond({ id: prompts.snapshot()[0]!.id, kind: 'clarify', answer: 'Private answer' })
  await expect(pending).resolves.toEqual({ kind: 'clarify', answer: 'Private answer' })
  await vi.waitFor(() => expect(signals.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'agentTyping', typing: true }))
  // Typing says the agent is working again; the line is edited in place to the past tense, never
  // to a working word, so no stale "waiting" stays above the answer.
  await vi.waitFor(() => expect(notices).toHaveLength(2))
  await line.end()
  work.stop()
  await line.update('Too late')
  expect(notices).toEqual([
    { roomId: '!room:test', eventId: '$question', body: matrixStatusLineCopy.en.waiting, statusLine: true },
    {
      roomId: '!room:test',
      eventId: '$question',
      body: matrixStatusLineCopy.en.waited,
      statusLine: true,
      replaces: '$notice-1',
      revision: 1
    }
  ])
  expect(log).not.toHaveBeenCalled()
})

it('a later wait in the same turn edits the one line, which ends in the past tense', async () => {
  const notices: MatrixNoticeEdit[] = []

  const line = new MatrixStatusLine(
    { roomId: '!room:test', eventId: '$question' },
    {
      current: () => true,
      publish: async command => {
        notices.push(command)

        return `$notice-${notices.length}`
      }
    }
  )

  const ask = matrixStatusAsk(async (answer: string) => answer, line, matrixStatusLineCopy.vi, vi.fn())
  await expect(ask('one')).resolves.toBe('one')
  await vi.waitFor(() => expect(notices).toHaveLength(2))
  await expect(ask('two')).resolves.toBe('two')
  await vi.waitFor(() => expect(notices).toHaveLength(4))
  await line.end()
  const target = { roomId: '!room:test', eventId: '$question', statusLine: true }
  const { waiting, waited } = matrixStatusLineCopy.vi
  expect(notices).toEqual([
    { ...target, body: waiting },
    { ...target, body: waited, replaces: '$notice-1', revision: 1 },
    { ...target, body: waiting, replaces: '$notice-1', revision: 2 },
    { ...target, body: waited, replaces: '$notice-1', revision: 3 }
  ])
})

it('retries an ambiguous wait line with the same content when the wait ends, then edits it', async () => {
  const notices: MatrixNoticeEdit[] = []
  let ambiguous = true

  const line = new MatrixStatusLine(
    { roomId: '!room:test', eventId: '$question' },
    {
      current: () => true,
      publish: async command => {
        notices.push(command)

        if (ambiguous) {
          ambiguous = false
          throw new Error('response_lost')
        }

        return command.replaces ?? '$original'
      }
    }
  )

  const log = vi.fn()
  const ask = matrixStatusAsk(async (answer: string) => answer, line, matrixStatusLineCopy.en, log)
  await expect(ask('one')).resolves.toBe('one')
  await vi.waitFor(() => expect(notices).toHaveLength(3))
  await line.end()
  expect(notices).toHaveLength(3)
  expect(notices[1]).toEqual(notices[0])
  expect(notices[0]).toMatchObject({ body: matrixStatusLineCopy.en.waiting })
  expect(notices[2]).toMatchObject({ body: matrixStatusLineCopy.en.waited, replaces: '$original', revision: 1 })
  expect(log).toHaveBeenCalledWith('[matrix-status] publication_failed')
})

it('does not let publication failure block a real approval or leak its error', async () => {
  const line = new MatrixStatusLine(
    { roomId: '!room:test', eventId: '$question' },
    {
      current: () => true,
      publish: async () => {
        throw new Error('private-sdk-fixture')
      }
    }
  )

  const prompts = new MatrixHermesPrompts(() => {})
  const log = vi.fn()
  const ask = matrixStatusAsk(prompts.ask, line, matrixStatusLineCopy.vi, log)
  const abort = new AbortController()

  const pending = ask(
    { kind: 'approval', command: 'private command', description: 'private description', allowOnce: true },
    abort.signal,
    Date.now() + 60000
  )

  prompts.respond({ id: prompts.snapshot()[0]!.id, kind: 'approval', choice: 'deny' })
  await expect(pending).resolves.toEqual({ kind: 'approval', choice: 'deny' })
  await line.end()
  expect(log.mock.calls.every(([line]) => line === '[matrix-status] publication_failed')).toBe(true)
})

it('says the wait is over only when the last overlapping wait ends, and keeps the legacy function without an admitted line', async () => {
  const update = vi.fn(async () => {})
  const line = { update } as unknown as MatrixStatusLine
  let first!: (value: string) => void
  let second!: (value: string) => void

  const raw = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>(done => {
          first = done
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>(done => {
          second = done
        })
    )

  expect(matrixStatusAsk(raw, undefined, matrixStatusLineCopy.en, vi.fn())).toBe(raw)
  const ask = matrixStatusAsk(raw, line, matrixStatusLineCopy.en, vi.fn())
  const one = ask()
  const two = ask()
  first('one')
  await one
  expect(update.mock.calls).toEqual([[matrixStatusLineCopy.en.waiting], [matrixStatusLineCopy.en.waiting]])
  second('two')
  await two
  expect(update.mock.calls).toEqual([
    [matrixStatusLineCopy.en.waiting],
    [matrixStatusLineCopy.en.waiting],
    [matrixStatusLineCopy.en.waited]
  ])

  for (const copy of Object.values(matrixStatusLineCopy)) {
    expect(copy.waiting.trim()).toBeTruthy()
    expect(copy.waited.trim()).toBeTruthy()
    expect(copy.waited).not.toBe(copy.waiting)
  }
})

it('in the private chat the wait lives in the working line and simply goes: no status line, never "waited"', async () => {
  const sent: MatrixNoticeEdit[] = []
  let clock = 1_000_000

  const progress = new MatrixProgressLine(
    { roomId: '!room:test', eventId: '$question' },
    {
      current: () => true,
      publish: async command => {
        sent.push(command)

        return command.replaces ?? '$line'
      },
      now: () => clock,
      after: (_milliseconds, _run) => () => {}
    },
    { privateChat: true, heartbeatText: () => 'beat' }
  )

  const prompts = new MatrixHermesPrompts(() => {})
  const log = vi.fn()
  const ask = matrixStatusAsk(prompts.ask, undefined, matrixStatusLineCopy.en, log, progress)
  const abort = new AbortController()
  const pending = ask({ kind: 'clarify', question: 'Private question', choices: [] }, abort.signal, Date.now() + 60000)
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({
    body: matrixStatusLineCopy.en.waiting,
    statusLine: true,
    progress: { kind: 'device', phase: 'waiting' }
  })
  expect(JSON.stringify(sent)).not.toContain('Private question')

  prompts.respond({ id: prompts.snapshot()[0]!.id, kind: 'clarify', answer: 'Private answer' })
  await expect(pending).resolves.toEqual({ kind: 'clarify', answer: 'Private answer' })
  clock += 5_000
  // The wait is over and there is nothing else to show: the line is removed, not edited to the past tense.
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toMatchObject({ redact: true, replaces: '$line', body: '' })
  expect(JSON.stringify(sent)).not.toContain(matrixStatusLineCopy.en.waited)
})
