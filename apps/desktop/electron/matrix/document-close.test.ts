import { expect, it, vi } from 'vitest'

import { MatrixDocumentClose } from './document-close'

it('coalesces close requests and accepts only the original trusted nonce', async () => {
  const close = new MatrixDocumentClose()
  let id = ''
  const send = vi.fn(value => {id = value})
  const pending = close.prepare(send, () => true)
  expect(close.prepare(send, () => true)).toBe(pending)
  close.acknowledge('foreign', true)
  const complete = vi.fn()
  void pending.then(complete)
  await Promise.resolve()
  expect(complete).not.toHaveBeenCalled()
  close.acknowledge(id, true)
  await pending
  expect(send).toHaveBeenCalledOnce()
})

it('refuses unavailable, revoked or timed-out checkpoints and allows a new attempt', async () => {
  const close = new MatrixDocumentClose()
  let id = ''
  const first = close.prepare(value => {id = value}, () => false)
  close.acknowledge(id, true)
  await expect(first).rejects.toThrow('MATRIX_DOCUMENT_CLOSE_REFUSED')
  const next = close.prepare(value => {id = value}, () => true)
  close.acknowledge(id, false)
  await expect(next).rejects.toThrow('MATRIX_DOCUMENT_CLOSE_REFUSED')
  await expect(close.prepare(() => undefined, () => true, 1)).rejects.toThrow('MATRIX_DOCUMENT_CLOSE_REFUSED')
  const retry = close.prepare(value => {id = value}, () => true)
  close.acknowledge(id, true)
  await expect(retry).resolves.toBeUndefined()
})
