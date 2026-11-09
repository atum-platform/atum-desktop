import { expect, it, vi } from 'vitest'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../shared/matrix'

import { matrixInvocationRequestHash } from './invocation'
import { recoverMatrixResult } from './result-recovery'

function fixture() {
  const target = { roomId: '!room:test', eventId: '$request' }

  const context = {
    human: { userId: '@owner:test', deviceId: 'NEW-HUMAN' },
    domain: { issuer: 'https://mas.test/', subject: 'owner', principal: 'owner-principal' }
  }

  const message: MatrixInvocationMessage = {
    ...target,
    sender: context.human.userId,
    senderDevice: 'OLD-HUMAN',
    wireType: 'm.room.encrypted',
    senderVerified: true,
    timestamp: 1,
    related: false,
    content: { msgtype: 'm.text', body: 'Prior task' }
  }

  const row = {
    ...target,
    owner: context.domain.principal,
    state: 'completed',
    requestHash: matrixInvocationRequestHash(message),
    senderDevice: message.senderDevice,
    agentUserId: '@agent:test',
    agentDevice: 'OLD-AGENT',
    invocationId: '00000000-0000-4000-8000-e5602db60729',
    transactionId: '00000000-0000-4000-8000-4e243949dc7d',
    publishedEvent: '$reply'
  }

  const result = { state: 'published' as const, eventId: '$reply', body: 'Already done' }
  const read = vi.fn(async (command: { kind: string }) => (command.kind === 'readInvocation' ? message : result))
  const authorize = vi.fn(async () => row)
  const contextFn = vi.fn(() => context)
  const abort = new AbortController()

  return {
    target,
    context,
    message,
    row,
    result,
    read,
    authorize,
    contextFn,
    abort,
    run: () => recoverMatrixResult({ context: contextFn, read, authorize }, target, abort.signal)
  }
}

it('new device retrieves original binding and reply with no executor, attachment read, claim or dispatch', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(f.authorize.mock.calls).toEqual([[{ operation: 'recover', ...f.target, requestHash: f.row.requestHash }]])
  expect(f.read.mock.calls).toEqual([
    [{ kind: 'readInvocation', ...f.target }],
    [
      {
        kind: 'readResult',
        ...f.target,
        agentUserId: '@agent:test',
        agentDevice: 'OLD-AGENT',
        invocationId: f.row.invocationId,
        transactionId: f.row.transactionId,
        publishedEvent: '$reply'
      }
    ]
  ])
})

it('recovers a long question and a long answer, as long as any message this app sends', async () => {
  const f = fixture()
  f.message.content.body = 'A long question. '.repeat(1200)
  f.row.requestHash = matrixInvocationRequestHash(f.message)
  f.result.body = 'A long answer. '.repeat(1500)
  expect(f.message.content.body.length).toBeGreaterThan(16_000)
  expect(f.result.body.length).toBeGreaterThan(16_000)
  expect(await f.run()).toEqual(f.result)

  // Longer than one message can be: not something this app sent, so it is refused.
  f.result.body = 'x'.repeat(40_000)
  await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
})

it.each(['unknown', 'claimed', 'dispatched'])('never tries to execute or publish a %s outcome', async state => {
  const f = fixture()
  f.row.state = state
  expect(await f.run()).toEqual({ state: 'unknown' })
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.authorize).toHaveBeenCalledTimes(1)
})

it.each([
  'owner',
  'roomId',
  'eventId',
  'requestHash',
  'senderDevice',
  'agentUserId',
  'agentDevice',
  'invocationId',
  'transactionId',
  'publishedEvent'
] as const)('rejects mismatched or malformed %s', async field => {
  const f = fixture()
  f.row[field] = ''
  await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
  expect(f.read).toHaveBeenCalledTimes(1)
})

it.each(['sender', 'senderDevice', 'wireType'] as const)(
  'untrusted trigger %s cannot query the domain',
  async field => {
    const f = fixture()
    Object.assign(f.message, { [field]: '' })
    await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
    expect(f.authorize).not.toHaveBeenCalled()
  }
)

// 0.20: a plain room's trigger names the stand-in device, which the recorded binding names too.
it('recovers a plain room trigger bound to the stand-in device', async () => {
  const f = fixture()
  f.message.wireType = 'm.room.message'
  f.message.senderDevice = MATRIX_PLAIN_SENDER_DEVICE
  f.row.senderDevice = MATRIX_PLAIN_SENDER_DEVICE
  f.row.requestHash = matrixInvocationRequestHash(f.message)
  expect(await f.run()).toEqual(f.result)
})

it('refuses a trigger of any other event type', async () => {
  const f = fixture()
  f.message.wireType = 'm.sticker'
  await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
  expect(f.authorize).not.toHaveBeenCalled()
})

it('restored own trigger yields only explicitly unverified recorded history, never execution authority', async () => {
  const f = fixture()
  f.message.senderVerified = false
  expect(await f.run()).toEqual({ ...f.result, state: 'unverified' })
  expect(f.authorize.mock.calls).toEqual([[{ operation: 'recover', ...f.target, requestHash: f.row.requestHash }]])
  delete (f.row as Partial<typeof f.row>).publishedEvent
  expect(await f.run()).toEqual({ state: 'unknown' })
})

it('unverified result cannot become a verified success or settle a lost acknowledgement', async () => {
  const f = fixture()
  f.read.mockImplementation(async command =>
    command.kind === 'readInvocation' ? f.message : ({ ...f.result, state: 'unverified' } as any)
  )
  expect(await f.run()).toEqual({ ...f.result, state: 'unverified' })
  delete (f.row as Partial<typeof f.row>).publishedEvent
  expect(await f.run()).toEqual({ state: 'unknown' })
})

it('null SDK trigger fails closed before the domain lookup', async () => {
  const f = fixture()
  f.read.mockResolvedValue(null as any)
  await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
  expect(f.authorize).not.toHaveBeenCalled()
})

it('files use their descriptor hash without downloading bytes', async () => {
  const f = fixture()
  f.message.content = {
    msgtype: 'm.file',
    body: 'file.txt',
    attachment: { name: 'file.txt', fingerprint: 'a'.repeat(64) }
  }
  f.row.requestHash = matrixInvocationRequestHash(f.message)
  expect(await f.run()).toEqual(f.result)
  expect(f.read.mock.calls[0]).toEqual([{ kind: 'readInvocation', ...f.target }])
})

it('recovers a photo (m.image) by its descriptor hash, and the hash names the message type', async () => {
  const f = fixture()
  const attachment = { name: 'IMG_1.jpg', fingerprint: 'a'.repeat(64) }
  f.message.content = { msgtype: 'm.image', body: 'IMG_1.jpg', attachment }
  f.row.requestHash = matrixInvocationRequestHash(f.message)
  expect(await f.run()).toEqual(f.result)
  expect(f.read.mock.calls[0]).toEqual([{ kind: 'readInvocation', ...f.target }])
  expect(f.row.requestHash).not.toBe(
    matrixInvocationRequestHash({ ...f.message, content: { ...f.message.content, msgtype: 'm.file' } })
  )
})

it('refuses an m.image without its attachment, and an m.video with one', async () => {
  for (const content of [
    { msgtype: 'm.image', body: 'IMG_1.jpg' },
    { msgtype: 'm.video', body: 'clip.mp4', attachment: { name: 'clip.mp4', fingerprint: 'a'.repeat(64) } }
  ]) {
    const f = fixture()
    f.message.content = content
    await expect(f.run()).rejects.toThrow('matrix_recovery_untrusted')
    expect(f.authorize).not.toHaveBeenCalled()
  }
})

it.each(['abort', 'switch'])('drops completion on %s during lookup', async mode => {
  const f = fixture()
  f.authorize.mockImplementation(async () => {
    if (mode === 'abort') {
      f.abort.abort()
    } else {
      f.contextFn.mockReturnValue({ ...f.context, human: { ...f.context.human, deviceId: 'OTHER' } })
    }

    return f.row
  })
  await expect(f.run()).rejects.toThrow()
  expect(f.read).toHaveBeenCalledTimes(1)
})
