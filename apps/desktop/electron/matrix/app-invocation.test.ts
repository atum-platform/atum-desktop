import { randomUUID } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import type { MatrixInvocationMessage, MatrixSdkCommand } from '../../shared/matrix'
import type { EncryptedStore } from '../encrypted-store'

import { invokeMatrixApp, invokeMatrixHermes, type MatrixAppTurn } from './invocation'

function fixture() {
  const human = { userId: '@owner:test', deviceId: 'OWNER' }

  const agent = {
    issuer: 'https://mas.test/',
    subject: 'owner',
    principal: randomUUID(),
    agentPrincipal: randomUUID(),
    executorId: randomUUID(),
    userId: '@app:test',
    deviceId: 'APP',
    expiresAt: Date.now() + 3600000,
    appId: randomUUID(),
    appVersionId: randomUUID(),
    installationId: randomUUID(),
    linkEpoch: 1
  }

  const target = { roomId: '!room:test', eventId: '$request' }

  const message: MatrixInvocationMessage = {
    ...target,
    wireType: 'm.room.encrypted',
    sender: human.userId,
    senderDevice: human.deviceId,
    senderVerified: true,
    timestamp: Date.now(),
    related: false,
    content: { msgtype: 'm.text', body: 'Only this text', mentionedUserIds: [agent.userId] }
  }

  const rows = new Map<string, string>()

  const grant = {
    invocationId: randomUUID(),
    state: 'claimed',
    expiresAt: Date.now() + 120000,
    owner: agent.principal,
    payer: agent.principal,
    capability: 'app-turn',
    agentPrincipal: agent.agentPrincipal,
    agentDevice: agent.deviceId,
    appId: agent.appId,
    appVersionId: agent.appVersionId,
    installationId: agent.installationId,
    linkEpoch: agent.linkEpoch,
    transactionId: undefined as string | undefined,
    publishedEvent: undefined as string | undefined
  }

  const deps = {
    context: () => ({ human, agent }),
    read: vi.fn(
      async (command: MatrixSdkCommand): Promise<unknown> => (command.kind === 'readInvocation' ? message : '$reply')
    ),
    authorize: vi.fn(async (input: Record<string, unknown>) => {
      if (input.operation === 'dispatch') {
        if (grant.state !== 'claimed') {
          throw new Error('denied')
        }

        grant.state = 'dispatched'
      }

      if (input.operation === 'complete') {
        grant.state = 'completed'
        grant.transactionId ??= randomUUID()
      }

      if (input.operation === 'published') {
        grant.publishedEvent = '$reply'
      }

      return { ...input, ...grant }
    }),
    confirm: vi.fn(async () => true),
    prepare: vi.fn(async () => true),
    execute: vi.fn(async (_input: MatrixAppTurn) => ({ text: 'App reply' })),
    store: {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      failureCode: () => null,
      assertEncryptionAvailable: () => {}
    } as unknown as EncryptedStore
  }

  const run = () => invokeMatrixApp(deps, target, new AbortController().signal)

  return { human, agent, target, message, grant, deps, run, rows }
}

it('uses the shared durable lifecycle and sends only addressed text and opaque invocation identifiers', async () => {
  const f = fixture()
  expect(await f.run()).toEqual({ state: 'published', eventId: '$reply' })
  const value = f.deps.execute.mock.calls[0][0]
  expect(Object.keys(value).sort()).toEqual(['deadlineAt', 'invocationId', 'mentionedUserIds', 'signal', 'text'])
  expect(value.mentionedUserIds).toEqual([f.agent.userId])
  expect(value.text).toBe('Only this text')
  expect(value.invocationId).toBe(f.grant.invocationId)
  expect(value).not.toHaveProperty('requestHash')
  expect(f.deps.authorize.mock.calls.map(([input]) => input.operation)).toEqual([
    'claim',
    'dispatch',
    'complete',
    'published'
  ])
  expect(await f.run()).toEqual({ state: 'published', eventId: '$reply' })
  expect(f.deps.execute).toHaveBeenCalledOnce()
  expect([...f.rows.values()][0]).not.toContain('storedSession')
})

it('does not extend Hermes owner-phone listening consent to partner apps', async () => {
  const f = fixture()
  f.message.senderDevice = 'VERIFIED_PHONE'
  await expect(invokeMatrixApp({ ...f.deps, watch: {
    id: 'watch', roomId: f.target.roomId, sender: f.human,
    since: f.message.timestamp - 1, until: Date.now() + 60_000
  } }, f.target, new AbortController().signal)).rejects.toThrow('matrix_invocation_untrusted')
  expect(f.deps.execute).not.toHaveBeenCalled()
  expect(f.deps.authorize).not.toHaveBeenCalled()
})

it('freezes verified text and mentions before asynchronous authorization', async () => {
  const f = fixture()
  f.message.content.mentionedUserIds!.push('@second:test', f.agent.userId)
  f.deps.confirm.mockImplementationOnce(async () => {
    f.message.content.body = 'changed text'
    f.message.content.mentionedUserIds!.push('@injected:test')

    return true
  })
  expect(await f.run()).toEqual({ state: 'published', eventId: '$reply' })
  expect(f.deps.execute.mock.calls[0][0]).toMatchObject({
    text: 'Only this text',
    mentionedUserIds: [f.agent.userId, '@second:test']
  })
})

it.each(['ambient', 'other-app', 'malformed', 'related', 'reply', 'file'])(
  'ignores %s before setup, consent, authority or provider calls',
  async mode => {
    const f = fixture()

    if (mode === 'ambient') {
      delete f.message.content.mentionedUserIds
    }

    if (mode === 'other-app') {
      f.message.content.mentionedUserIds = ['@other:test']
    }

    if (mode === 'malformed') {
      f.message.content.invalidMentions = true
    }

    if (mode === 'related') {
      f.message.related = true
    }

    // An app turn never takes a reply (the Hermes path passes its quote; this one does not).
    if (mode === 'reply') {
      f.message.related = true
      f.message.content.replyTo = '$answer'
    }

    if (mode === 'file') {
      f.message.content.msgtype = 'm.file'
    }

    expect(await f.run()).toEqual({ state: 'ignored' })

    for (const action of [f.deps.prepare, f.deps.confirm, f.deps.authorize, f.deps.execute]) {
      expect(action).not.toHaveBeenCalled()
    }

    expect(f.deps.read.mock.calls.every(([command]) => command.kind === 'readInvocation')).toBe(true)
  }
)

it.each([
  'owner',
  'payer',
  'capability',
  'appId',
  'appVersionId',
  'installationId',
  'linkEpoch',
  'agentPrincipal',
  'agentDevice'
] as const)('refuses a changed %s in the platform grant before provider dispatch', async key => {
  const f = fixture()
  Object.assign(f.grant, { [key]: key === 'linkEpoch' ? 2 : 'other' })
  await expect(f.run()).rejects.toThrow('matrix_invocation_invalid')
  expect(f.deps.execute).not.toHaveBeenCalled()
})

it('detects an in-place connection epoch mutation during the SDK read', async () => {
  const f = fixture()
  f.deps.read.mockImplementation(async () => {
    f.agent.linkEpoch++

    return f.message
  })
  await expect(f.run()).rejects.toThrow('matrix_invocation_cancelled')
  expect(f.deps.authorize).not.toHaveBeenCalled()
})

it('recreates a dispatcher and recovers publication with the same transaction, without calling the app twice', async () => {
  const f = fixture()
  f.deps.read.mockImplementation(async command => {
    if (command.kind === 'readInvocation') {
      return f.message
    }

    throw new Error('offline after provider completed')
  })
  expect(await f.run()).toEqual({ state: 'publication_pending' })
  const transaction = f.grant.transactionId
  f.deps.read.mockImplementation(async command => (command.kind === 'readInvocation' ? f.message : '$reply'))
  f.deps.prepare.mockResolvedValue(false)
  expect(await invokeMatrixApp({ ...f.deps, publicationOnly: true }, f.target, new AbortController().signal)).toEqual({
    state: 'published',
    eventId: '$reply'
  })
  expect(f.grant.transactionId).toBe(transaction)
  expect(f.deps.execute).toHaveBeenCalledOnce()
  expect(f.deps.prepare).toHaveBeenCalledOnce()
  expect(f.deps.confirm).toHaveBeenCalledOnce()
})

it.each(['missing', 'new-enrollment'])('publication retry cannot execute a %s outcome', async mode => {
  const f = fixture()

  if (mode === 'new-enrollment') {
    await f.run()
    f.agent.executorId = randomUUID()
    f.deps.authorize.mockClear()
    f.deps.prepare.mockClear()
    f.deps.execute.mockClear()
    f.deps.confirm.mockClear()
  }

  expect(await invokeMatrixApp({ ...f.deps, publicationOnly: true }, f.target, new AbortController().signal)).toEqual({
    state: 'ignored'
  })
  expect(f.deps.authorize).not.toHaveBeenCalled()
  expect(f.deps.prepare).not.toHaveBeenCalled()
  expect(f.deps.execute).not.toHaveBeenCalled()
  expect(f.deps.confirm).not.toHaveBeenCalled()
})

it('does not replay an unknown provider outcome', async () => {
  const f = fixture()
  f.deps.execute.mockRejectedValue(new Error('provider response lost'))
  expect(await f.run()).toEqual({ state: 'unknown' })
  expect(await f.run()).toEqual({ state: 'unknown' })
  expect(f.deps.execute).toHaveBeenCalledOnce()
})

it('retains a completed result but cannot publish after the app scope changes during execution', async () => {
  const f = fixture()
  f.deps.execute.mockImplementation(async () => {
    f.agent.linkEpoch++

    return { text: 'completed' }
  })
  expect(await f.run()).toEqual({ state: 'publication_pending' })
  expect(f.rows.size).toBe(1)
  expect(f.deps.read.mock.calls.every(([command]) => command.kind === 'readInvocation')).toBe(true)
})

it.each(['app', 'human', 'malformed'])("doesn't turn %s addressing into a manual Hermes turn", async mode => {
  const f = fixture()
  f.agent.userId = '@hermes:test'

  if (mode === 'human') {
    f.message.content.mentionedUserIds = ['@another-human:test']
  }

  if (mode === 'malformed') {
    f.message.content.invalidMentions = true
  }

  const execute = vi.fn(async () => ({ text: 'Hermes reply', storedSession: 'session' }))
  expect(await invokeMatrixHermes({ ...f.deps, execute }, f.target, new AbortController().signal)).toEqual({
    state: 'ignored'
  })
  expect(execute).not.toHaveBeenCalled()
  expect(f.deps.prepare).not.toHaveBeenCalled()
  expect(f.deps.authorize).not.toHaveBeenCalled()
})

it('allows explicitly addressing Hermes and an app, without interpreting text fragments', async () => {
  const f = fixture()
  f.message.content.mentionedUserIds = [f.agent.userId, '@hermes:test']
  expect((await f.run()).state).toBe('published')
  f.agent.userId = '@hermes:test'
  f.grant.capability = 'local-hermes-turn'
  f.grant.state = 'claimed'
  f.grant.invocationId = randomUUID()
  f.grant.publishedEvent = undefined
  const execute = vi.fn(async () => ({ text: 'Hermes reply', storedSession: 'session' }))
  expect((await invokeMatrixHermes({ ...f.deps, execute }, f.target, new AbortController().signal)).state).toBe(
    'published'
  )
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ text: f.message.content.body }))
})


it('never executes a local-path turn from this human device on the app path either (the fence)', async () => {
  const f = fixture()
  f.message.content = { ...f.message.content, turn: '00000000-0000-4000-8000-31f949766961' }
  expect(await f.run()).toEqual({ state: 'ignored' })
  expect(f.deps.execute).not.toHaveBeenCalled()
})

// 0.20: an app's pair is plain. Its message names no device, so a turn the owner typed on this
// Mac (main's `sentHere`) runs and its answer is marked as an app's; one typed elsewhere does not.
it('answers the owner’s message typed here in a plain app pair, never one typed elsewhere', async () => {
  const f = fixture()
  Object.assign(f.message, { wireType: 'm.room.message', roomPlain: true, senderDevice: 'unencrypted' })
  const lines: string[] = []

  expect(
    await invokeMatrixApp(
      { ...f.deps, sentHere: f.target.eventId, log: line => void lines.push(line) },
      f.target,
      new AbortController().signal
    )
  ).toEqual({ state: 'published', eventId: '$reply' })
  expect(f.deps.read).toHaveBeenCalledWith(expect.objectContaining({ kind: 'publishResult', app: true }))
  expect(lines).toContain('[Matrix] invocation wire=plain origin=here')

  const elsewhere = fixture()
  Object.assign(elsewhere.message, { wireType: 'm.room.message', roomPlain: true, senderDevice: 'unencrypted' })
  await expect(elsewhere.run()).rejects.toThrow('matrix_invocation_untrusted')
  expect(elsewhere.deps.execute).not.toHaveBeenCalled()
})
