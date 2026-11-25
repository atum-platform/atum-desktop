import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { logAppChatFailures } from './app-bots/open-chat'
import { parseMatrixCommand, requireMatrixCaller } from './ipc-policy'
import { logNotesSelfOpenFailures } from './notes-self-log'

// Execute the actual main IPC and hold decisions, replacing external boundaries only.
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('./main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function mainCode(name: string, context: Record<string, unknown>, ipc = false) {
  let found: ts.Node | undefined

  const visit = (node: ts.Node) => {
    if (!ipc && ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node
    }

    if (
      ipc &&
      ts.isCallExpression(node) &&
      node.expression.getText(source).startsWith('ipcMain.') &&
      node.arguments[0]?.getText(source) === `channel.${name}`
    ) {
      found = node.arguments[1]
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  if (!found) {
    throw new Error(`Missing main callback ${name}`)
  }

  const code = ts.transpileModule(`(${found.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText

  const sandbox = {
    ...context,
    logNotesSelfOpenFailures,
    Error,
    AbortController,
    AbortSignal,
    console,
    clearTimeout,
    setTimeout,
    queueMicrotask
  }

  const executable = runInNewContext(code, sandbox)

  return executable
}

function fixture() {
  const ui = { webContents: { mainFrame: { url: 'atum-matrix://ui/matrix.html' } } }
  const human = { queue: { command: vi.fn(async () => '$sent') } }
  const hosts = new Map([['human', human]])
  const identity = { userId: '@owner:test', deviceId: 'desktop' }
  const agent = { answering: 'cloud' }
  const guardRoomCommand = vi.fn(async () => {})

  const context: Record<string, unknown> = {
    ui, UI_URL: ui.webContents.mainFrame.url, requireMatrixCaller, logAppChatFailures,
    fenceDeviceBeforeOperationLock: vi.fn(), matrixDeviceStopFence: undefined,
    state: { state: 'ready' }, closing: false, operation: false, domainOperation: false,
    parseMatrixCommand, requireRoomAgent: () => agent, agentOfRoom: () => agent,
    account: { identity: () => identity },
    hosts, guardRoomCommand, matrixSdkCommandTimeout: () => 20_000, pendingMatrixDrafts: undefined,
    observeMessage: (send: () => unknown) => send()
  }

  context.dispatchSdkCommand = mainCode('dispatchSdkCommand', context)
  context.command = mainCode('command', context)

  const invoke = mainCode('ui', context, true)

  const send = () => invoke({ sender: ui.webContents, senderFrame: ui.webContents.mainFrame }, {
    kind: 'sendAssistant', roomId: '!luna:test', body: 'Hello Luna'
  })

  return { human, guardRoomCommand, hosts, send }
}

describe('cloud assistant owner send IPC', () => {
  it('posts one Matrix message through the owner SDK without an agent SDK host', async () => {
    const f = fixture()
    await expect(f.send()).resolves.toEqual({ eventId: '$sent', result: { state: 'published' } })
    expect(f.guardRoomCommand).toHaveBeenCalledWith('send', '!luna:test')
    expect(f.human.queue.command).toHaveBeenCalledExactlyOnceWith(
      { kind: 'send', roomId: '!luna:test', body: 'Hello Luna' }, 20_000
    )
  })

  it('drops a send if the owner SDK changes during the room check', async () => {
    const f = fixture()
    f.guardRoomCommand.mockImplementation(async () => { f.hosts.delete('human') })
    await expect(f.send()).rejects.toThrow('matrix_not_ready')
    expect(f.human.queue.command).not.toHaveBeenCalled()
  })
})
