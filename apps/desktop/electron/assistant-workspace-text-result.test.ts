import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  AssistantWorkspaceTextResultProvider,
  publishAssistantWorkspaceTextResultToWindows
} from './assistant-workspace-text-result'
import {
  AtumFilesystemCapabilityAuthority,
  DEFAULT_PERSONAL_AGENT_ID,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor
} from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'

const ACTOR: Extract<FilesystemCapabilityActor, { kind: 'personal' }> = {
  kind: 'personal',
  personalAgentId: DEFAULT_PERSONAL_AGENT_ID
}

const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function harness() {
  const userData = mkdtempSync(join(tmpdir(), 'atum-assistant-write-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 7)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 7, paths })
  const account: FilesystemAccountEnvelope = { accountId: ACCOUNT_A, accountGeneration: 7 }
  const leases = new WorkspaceTextFileLeaseProvider(authority)
  const published: unknown[] = []

  const provider = new AssistantWorkspaceTextResultProvider(authority, leases, event => {
    published.push(event)

    return ['window-a']
  })

  return { account, authority, leases, paths, provider, published }
}

test('an approved write lands exact bytes, publishes an opaque lease, and never leaks the raw path', async () => {
  const { account, leases, paths, provider, published } = harness()
  const target = join(paths.workspaceRoot, 'created.md')

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: '# created\n',
    operationId: 'tool-main-success',
    resourcePath: target,
    sessionId: 'session-main-success'
  })

  assert.equal(result.outcome, 'success')
  assert.equal(JSON.stringify(result).includes(target), false)
  assert.equal(readFileSync(target, 'utf8'), '# created\n')
  assert.equal(published.length, 1)

  if (result.outcome === 'success') {
    assert.equal((await leases.read(result.descriptor.fileRef)).text, '# created\n')
  }
})

test('the same operation id cannot write twice', async () => {
  const { account, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'once.md')

  const first = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: '# first\n',
    operationId: 'tool-replay',
    resourcePath: target,
    sessionId: 'session-replay'
  })

  assert.equal(first.outcome, 'success')

  const replay = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: '# replay\n',
    operationId: 'tool-replay',
    resourcePath: target,
    sessionId: 'session-replay'
  })

  assert.equal(replay.outcome === 'failure' && replay.code, 'permission_expired')
  assert.equal(readFileSync(target, 'utf8'), '# first\n')
})

test('a client that already disconnected before the write starts gets a closed expiry and no write', async () => {
  const { account, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'disconnected.md')
  const client = new AbortController()
  client.abort()

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'must not land',
    operationId: 'tool-disconnected-main',
    resourcePath: target,
    sessionId: 'session-disconnected-main',
    abortSignal: client.signal
  })

  assert.equal(result.outcome === 'failure' && result.code, 'permission_expired')
  assert.throws(() => readFileSync(target), /ENOENT/u)
})

test('a final-component symlink at the target prevents the main-owned write', async () => {
  const { account, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'swapped-main.txt')
  const outside = join(paths.root, 'outside-main.txt')
  writeFileSync(outside, 'outside-safe')
  symlinkSync(outside, target)

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'must not escape',
    operationId: 'tool-main-symlink',
    resourcePath: target,
    sessionId: 'session-main-symlink'
  })

  assert.equal(result.outcome === 'failure' && result.code, 'scope_escape')
  assert.equal(readFileSync(outside, 'utf8'), 'outside-safe')
})

test('a write outside the workspace, a non-text type, and a wrong actor fail closed', async () => {
  const { account, paths, provider } = harness()

  const outside = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'escape',
    operationId: 'tool-outside',
    resourcePath: join(paths.root, 'outside.md'),
    sessionId: 'session-outside'
  })

  assert.equal(outside.outcome === 'failure' && outside.code, 'scope_escape')

  const binary = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'not text',
    operationId: 'tool-binary',
    resourcePath: join(paths.workspaceRoot, 'blob.bin'),
    sessionId: 'session-binary'
  })

  assert.equal(binary.outcome, 'failure')

  const conversation = await provider.requestWrite({
    account,
    actor: { kind: 'conversation', conversationId: 'thread' },
    content: 'no',
    operationId: 'tool-conversation',
    resourcePath: join(paths.workspaceRoot, 'conversation.md'),
    sessionId: 'session-conversation'
  })

  assert.equal(conversation.outcome, 'failure')
  assert.throws(() => readFileSync(join(paths.workspaceRoot, 'conversation.md')), /ENOENT/u)
})

test('an approved overwrite replaces exact bytes atomically and yields a readable opaque lease', async () => {
  const { account, leases, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'nested')
  const file = join(target, 'existing.md')
  const replacement = '# exact replacement\n'
  mkdirSync(target)
  writeFileSync(file, 'old')

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: replacement,
    operationId: 'tool-main-overwrite',
    resourcePath: file,
    sessionId: 'session-main-overwrite'
  })

  assert.equal(readFileSync(file, 'utf8'), replacement)
  assert.equal(result.outcome, 'success')

  if (result.outcome === 'success') {
    assert.equal((await leases.read(result.descriptor.fileRef)).text, replacement)
  }
})

test('an undelivered success releases its opaque lease instead of orphaning custody', async () => {
  const { account, authority, leases, paths } = harness()
  const provider = new AssistantWorkspaceTextResultProvider(authority, leases, () => [])

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'saved without a window',
    operationId: 'tool-no-window',
    resourcePath: join(paths.workspaceRoot, 'no-window.txt'),
    sessionId: 'session-no-window'
  })

  assert.equal(result.outcome, 'success')

  if (result.outcome === 'success') {
    await assert.rejects(leases.read(result.descriptor.fileRef), /CAPABILITY_REVOKED/u)
  }
})

test('first adopter keeps a two-window lease when the other window dismisses', async () => {
  const { account, authority, leases, paths } = harness()
  const provider = new AssistantWorkspaceTextResultProvider(authority, leases, () => ['window-a', 'window-b'])

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'shared result',
    operationId: 'tool-two-window',
    resourcePath: join(paths.workspaceRoot, 'two-window.txt'),
    sessionId: 'session-two-window'
  })

  assert.equal(result.outcome, 'success')

  if (result.outcome === 'success') {
    assert.deepEqual(provider.adopt(result.descriptor.fileRef, 'window-a'), { adopted: true })
    assert.deepEqual(await provider.dismiss(result.descriptor.fileRef, 'window-b'), { released: false })
    assert.doesNotThrow(() => provider.assertAccess(result.descriptor.fileRef, 'window-a'))
    assert.throws(() => provider.assertAccess(result.descriptor.fileRef, 'window-b'), /CAPABILITY_DENIED/u)
    await assert.rejects(provider.release(result.descriptor.fileRef, 'window-b'), /CAPABILITY_DENIED/u)
    assert.equal((await leases.read(result.descriptor.fileRef)).text, 'shared result')
    await provider.release(result.descriptor.fileRef, 'window-a')
    await assert.rejects(leases.read(result.descriptor.fileRef), /CAPABILITY_REVOKED/u)
  }
})

test('an entirely unadopted multi-window result is eventually released', async () => {
  const { account, authority, leases, paths } = harness()

  const provider = new AssistantWorkspaceTextResultProvider(
    authority,
    leases,
    () => ['window-a', 'window-b'],
    { adoptionTimeoutMs: 5 }
  )

  const result = await provider.requestWrite({
    account,
    actor: ACTOR,
    content: 'temporary result',
    operationId: 'tool-unadopted',
    resourcePath: join(paths.workspaceRoot, 'unadopted.txt'),
    sessionId: 'session-unadopted'
  })

  assert.equal(result.outcome, 'success')
  await new Promise(resolve => setTimeout(resolve, 20))

  if (result.outcome === 'success') {
    await assert.rejects(leases.read(result.descriptor.fileRef), /CAPABILITY_REVOKED/u)
  }
})

test('assistant result delivery reaches every live application window', () => {
  const deliveries: string[] = []

  const event = {
    sessionId: 'session-secondary',
    toolCallId: 'tool-secondary',
    result: {
      version: 1 as const,
      kind: 'workspace_text_file' as const,
      outcome: 'failure' as const,
      code: 'permission_denied' as const,
      retryable: true,
      rendererMessage: 'The file write was not allowed.'
    }
  }

  const window = (name: string, id: number, destroyed = false, throws = false) => ({
    isDestroyed: () => destroyed,
    webContents: {
      id,
      isDestroyed: () => false,
      send: (channel: string) => {
        if (throws) {
          throw new Error('window disappeared')
        }

        deliveries.push(`${name}:${channel}`)
      }
    }
  })

  assert.deepEqual(
    publishAssistantWorkspaceTextResultToWindows(
      [window('closing-primary', 0, false, true), window('primary', 1), window('secondary', 2), window('dead', 3, true)],
      event
    ),
    ['1', '2']
  )
  assert.deepEqual(deliveries, [
    'primary:atum:filesystem:assistant-text-result',
    'secondary:atum:filesystem:assistant-text-result'
  ])
})

function decisionFor(
  authority: AtumFilesystemCapabilityAuthority,
  account: FilesystemAccountEnvelope,
  target: string,
  operationId: string,
  byteSize: number
) {
  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: Date.now() + 10_000
  })

  const decision = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: byteSize,
    operationId,
    resourcePath: target
  })

  assert.equal(decision.allowed, true)

  return decision.allowed ? decision.writeReceiptId! : ''
}

test('successful authorized completion publishes only the existing opaque lease descriptor', async () => {
  const { account, authority, leases, paths, provider, published } = harness()
  const target = join(paths.workspaceRoot, 'answer.md')
  const text = '# Xin chào\n'
  const receiptId = decisionFor(authority, account, target, 'tool-1', Buffer.byteLength(text))
  writeFileSync(target, text)

  const result = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-1',
    receiptId,
    sessionId: 'session-1',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(result.outcome, 'success')
  assert.deepEqual(result, {
    version: 1,
    kind: 'workspace_text_file',
    outcome: 'success',
    descriptor: result.outcome === 'success' ? result.descriptor : null
  })
  assert.equal(JSON.stringify(result).includes(target), false)
  assert.equal(JSON.stringify(result).includes(ACCOUNT_A), false)
  assert.equal(JSON.stringify(result).includes(receiptId), false)
  assert.deepEqual(published, [{ sessionId: 'session-1', toolCallId: 'tool-1', result }])

  if (result.outcome === 'success') {
    assert.equal((await leases.read(result.descriptor.fileRef)).text, text)
  }
})

test('completion replay, wrong operation, tool failure, stale account, and invalid bytes fail closed with safe copy', () => {
  const { account, authority, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'private-name.txt')
  const secret = 'never expose this content'
  const receiptId = decisionFor(authority, account, target, 'tool-2', Buffer.byteLength(secret))
  writeFileSync(target, secret)

  const wrongOperation = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'spoofed-tool',
    receiptId,
    sessionId: 'session-2',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(wrongOperation.outcome, 'failure')
  assert.equal(wrongOperation.outcome === 'failure' && wrongOperation.code, 'permission_expired')

  const replay = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-2',
    receiptId,
    sessionId: 'session-2',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(replay.outcome === 'failure' && replay.code, 'permission_expired')

  const failedReceipt = decisionFor(authority, account, target, 'tool-3', 3)

  const failed = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-3',
    receiptId: failedReceipt,
    sessionId: 'session-2',
    status: 'error',
    toolName: 'write_file'
  })

  assert.equal(failed.outcome === 'failure' && failed.code, 'io_failed')

  const wrongAccountReceipt = decisionFor(authority, account, target, 'tool-account', 3)

  const wrongAccount = provider.complete({
    account: { accountId: '00000000-0000-4000-8000-b454f82c5857', accountGeneration: 7 },
    actor: ACTOR,
    operationId: 'tool-account',
    receiptId: wrongAccountReceipt,
    sessionId: 'session-2',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(wrongAccount.outcome === 'failure' && wrongAccount.code, 'account_stale')

  const invalidTarget = join(paths.workspaceRoot, 'invalid.txt')
  const invalidReceipt = decisionFor(authority, account, invalidTarget, 'tool-4', 2)
  writeFileSync(invalidTarget, Buffer.from([0xc3, 0x28]))

  const invalid = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-4',
    receiptId: invalidReceipt,
    sessionId: 'session-2',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(invalid.outcome === 'failure' && invalid.code, 'io_failed')

  for (const result of [wrongOperation, replay, failed, wrongAccount, invalid]) {
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(target), false)
    assert.equal(serialized.includes(ACCOUNT_A), false)
    assert.equal(serialized.includes(secret), false)
  }
})

test('account quiescence invalidates an unconsumed successful decision before lease issuance', () => {
  const { account, authority, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'answer.txt')
  const receiptId = decisionFor(authority, account, target, 'tool-5', 2)
  writeFileSync(target, 'ok')
  authority.revokeAccount(account)

  const result = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-5',
    receiptId,
    sessionId: 'session-3',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(result.outcome === 'failure' && result.code, 'permission_expired')
})

test('a final-component symlink swap never mints a renderer lease', () => {
  const { account, authority, paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'swapped.txt')
  const outside = join(paths.root, 'outside.txt')
  const receiptId = decisionFor(authority, account, target, 'tool-swap', 2)
  writeFileSync(outside, 'ok')
  symlinkSync(outside, target)

  const result = provider.complete({
    account,
    actor: ACTOR,
    operationId: 'tool-swap',
    receiptId,
    sessionId: 'session-swap',
    status: 'ok',
    toolName: 'write_file'
  })

  assert.equal(result.outcome === 'failure' && result.code, 'scope_escape')
})

test('an orphaned receipt publishes a closed expiry failure instead of hanging the consumer', async () => {
  const { account, provider, published } = harness()

  provider.trackReceipt({
    account,
    actor: ACTOR,
    operationId: 'tool-orphaned',
    receiptId: 'missing-receipt',
    sessionId: 'session-orphaned',
    expiresAt: Date.now() + 5
  })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(published.length, 1)

  const event = published[0] as {
    sessionId: string
    toolCallId: string
    result: { outcome: string; code: string; rendererMessage: string; incidentRef: string }
  }

  assert.equal(event.sessionId, 'session-orphaned')
  assert.equal(event.toolCallId, 'tool-orphaned')
  assert.equal(event.result.outcome, 'failure')
  assert.equal(event.result.code, 'permission_expired')
  assert.equal(event.result.rendererMessage, 'The file permission expired. Try again.')
  assert.match(event.result.incidentRef, /^[a-f0-9]{20}$/u)
})
