import { expect, it, vi } from 'vitest'

import { MATRIX_PROMPT_MAX } from '../../shared/matrix'

import { MatrixHermesPrompts, readMatrixHermesPrompt } from './hermes-prompts'

const approval = { kind: 'approval' as const, command: 'fixture', description: 'fixture', allowOnce: true }

it('bounds pending prompts and releases every capability on lifetime end', async () => {
  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()
  const deadlineAt = Date.now() + 60000

  const requests = Array.from({ length: 8 }, () =>
    expect(prompts.ask(approval, abort.signal, deadlineAt)).rejects.toThrow('expired')
  )

  expect(prompts.snapshot().every(prompt => prompt.deadlineAt === deadlineAt)).toBe(true)
  expect(() => prompts.ask(approval, abort.signal, deadlineAt)).toThrow('limit')
  abort.abort()
  expect(prompts.snapshot()).toEqual([])
  await Promise.all(requests)
})

it('offers one-shot native capabilities, validates responses, and rejects stale ids and broad grants', async () => {
  const changed = vi.fn()
  const prompts = new MatrixHermesPrompts(changed)
  const abort = new AbortController()
  const first = prompts.ask(approval, abort.signal, Date.now() + 60000)
  const id = prompts.snapshot()[0].id

  for (const response of [
    null,
    {},
    { id, kind: 'clarify', answer: 'yes' },
    { id, kind: 'approval', choice: 'always' }
  ]) {
    expect(() => prompts.respond(response)).toThrow()
  }

  expect(prompts.snapshot()).toHaveLength(1)
  prompts.respond({ id, kind: 'approval', choice: 'once', session_id: 'forged', all: true })
  expect(prompts.snapshot()).toEqual([])
  expect(await first).toEqual({ kind: 'approval', choice: 'once' })
  expect(() => prompts.respond({ id, kind: 'approval', choice: 'once' })).toThrow('expired')
  const next = prompts.ask(approval, abort.signal, Date.now() + 60000)
  const rejected = expect(next).rejects.toThrow('expired')
  expect(prompts.snapshot()[0].id).not.toBe(id)
  abort.abort()
  expect(prompts.snapshot()).toEqual([])
  await rejected
  expect(changed).toHaveBeenCalledTimes(4)
})

it('supports parallel questions, bounded answers, skip, deny-only and immediate cancellation', async () => {
  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()
  const deny = prompts.ask({ ...approval, allowOnce: false }, abort.signal, Date.now() + 60000)

  const clarify = prompts.ask(
    { kind: 'clarify', question: 'Where?', choices: ['Here'] },
    abort.signal,
    Date.now() + 60000
  )

  const [a, b] = prompts.snapshot()
  expect(() => prompts.respond({ id: a.id, kind: 'approval', choice: 'once' })).toThrow('invalid')
  expect(() =>
    prompts.respond({ id: b.id, kind: 'clarify', answer: 'x'.repeat(MATRIX_PROMPT_MAX + 1) })
  ).toThrow('invalid')
  prompts.respond({ id: b.id, kind: 'clarify', answer: '' })
  expect(await clarify).toEqual({ kind: 'clarify', answer: '' })
  prompts.respond({ id: a.id, kind: 'approval', choice: 'deny' })
  expect(await deny).toEqual({ kind: 'approval', choice: 'deny' })
  abort.abort()
  expect(() => prompts.ask(approval, abort.signal, Date.now() + 60000)).toThrow()
})

it('accepts a clarify answer as long as a full prompt and refuses one past it', async () => {
  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()

  const within = prompts.ask({ kind: 'clarify', question: 'Where?', choices: [] }, abort.signal, Date.now() + 60000)
  prompts.respond({ id: prompts.snapshot()[0].id, kind: 'clarify', answer: 'x'.repeat(MATRIX_PROMPT_MAX) })
  expect(await within).toEqual({ kind: 'clarify', answer: 'x'.repeat(MATRIX_PROMPT_MAX) })

  const over = prompts.ask({ kind: 'clarify', question: 'Where?', choices: [] }, abort.signal, Date.now() + 60000)
  expect(() =>
    prompts.respond({ id: prompts.snapshot()[0].id, kind: 'clarify', answer: 'x'.repeat(MATRIX_PROMPT_MAX + 1) })
  ).toThrow('invalid')
  abort.abort()
  await expect(over).rejects.toThrow('expired')
})

it('projects only display fields, requires occurrence ids and honors deny-only backend choices', () => {
  expect(
    readMatrixHermesPrompt('approval.request', {
      request_id: 'occurrence',
      command: 'fixture',
      description: '',
      choices: ['deny'],
      secret: 'not exposed',
      pattern_key: 'not exposed'
    })
  ).toEqual({
    requestId: 'occurrence',
    content: { ...approval, description: '', allowOnce: false }
  })

  for (const payload of [{}, { request_id: 'x', command: 'x'.repeat(16001), description: '' }]) {
    expect(() => readMatrixHermesPrompt('approval.request', payload)).toThrow('invalid')
  }

  expect(
    readMatrixHermesPrompt('clarify.request', { request_id: 'r', question: 'Where?', choices: null }).content
  ).toEqual({ kind: 'clarify', question: 'Where?', choices: [] })
  expect(() =>
    readMatrixHermesPrompt('clarify.request', { request_id: 'r', question: 'Where?', choices: [42] })
  ).toThrow('invalid')
})

it('refuses an elapsed deadline even before its abort event is delivered', async () => {
  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()
  const pending = prompts.ask(approval, abort.signal, Date.now() - 1)
  const rejected = expect(pending).rejects.toThrow('expired')
  expect(() => prompts.respond({ id: prompts.snapshot()[0].id, kind: 'approval', choice: 'once' })).toThrow('expired')
  abort.abort()
  await rejected
})

it("carries the old app's masked prompts: the Mac's sudo password and a skill's credential", async () => {
  expect(readMatrixHermesPrompt('sudo.request', { request_id: 's' })).toEqual({ requestId: 's', content: { kind: 'sudo' } })
  expect(
    readMatrixHermesPrompt('secret.request', { request_id: 'k', env_var: 'TAVILY_API_KEY', prompt: 'Your Tavily key', metadata: { x: 1 } })
  ).toEqual({ requestId: 'k', content: { kind: 'secret', envVar: 'TAVILY_API_KEY', prompt: 'Your Tavily key' } })

  for (const payload of [
    { request_id: 'k', env_var: 'NOT A NAME', prompt: '' },
    { request_id: 'k', env_var: 'KEY', prompt: 'x'.repeat(2001) },
    { env_var: 'KEY', prompt: '' }
  ]) {
    expect(() => readMatrixHermesPrompt('secret.request', payload)).toThrow('invalid')
  }

  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()
  const sudo = prompts.ask({ kind: 'sudo' }, abort.signal, Date.now() + 60000)
  const sudoId = prompts.snapshot()[0].id
  // The answer must match the prompt's kind and fit its bound.
  expect(() => prompts.respond({ id: sudoId, kind: 'secret', value: 'x' })).toThrow('expired')
  expect(() => prompts.respond({ id: sudoId, kind: 'sudo', password: 'x'.repeat(1025) })).toThrow('invalid')
  prompts.respond({ id: sudoId, kind: 'sudo', password: 'correct horse' })
  await expect(sudo).resolves.toEqual({ kind: 'sudo', password: 'correct horse' })

  const secret = prompts.ask({ kind: 'secret', envVar: 'KEY', prompt: '' }, abort.signal, Date.now() + 60000)
  // Nothing about the value ever appears in the snapshot the window renders.
  expect(prompts.snapshot()[0]).not.toHaveProperty('value')
  prompts.respond({ id: prompts.snapshot()[0].id, kind: 'secret', value: '' })
  await expect(secret).resolves.toEqual({ kind: 'secret', value: '' })
})
