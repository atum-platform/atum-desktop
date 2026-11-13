import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { AgentHomeHolds, type HoldReason } from './agent-home-placement/holds'
import { AgentHomeJournal } from './agent-home-placement/journal'
import { MemoryStore } from './agent-home-placement/mac.fixture'
import { logAppChatFailures } from './app-bots/open-chat'
import { assistantBlocked } from './assistant-policy'
import { sendAssistantMessage } from './assistant-send'
import { matrixCloudAgentAnswersInCloud } from './cloud-agent-placement'
import { parseMatrixCommand, requireMatrixCaller } from './ipc-policy'
import { dispatchMatrixCommand } from './message-dispatch'
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


function fixture(options: { cloud?: boolean; reasons?: HoldReason[]; moving?: boolean; migration?: boolean; hostReady?: boolean } = {}) {
  const ui = { webContents: { mainFrame: { url: 'atum-matrix://ui/matrix.html' } } }
  const agent = { role: 'agent', operation: false, listener: { snapshot: () => ({ state: 'idle' }) } }
  const human = { queue: { command: vi.fn(async () => '$sent') } }
  const journal = new AgentHomeJournal(new MemoryStore())
  let holds = new AgentHomeHolds(journal)

  for (const reason of options.reasons ?? []) {
    holds.add('luna', reason)
  }

  // A completed move's durable stand-down survives restart; the IPC must accept that fact.
  if (options.reasons?.length === 1 && options.reasons[0] === 'standDown') {
    holds = new AgentHomeHolds(journal)
    holds.seed('luna')
  }

  const context: Record<string, unknown> = {
    ui, UI_URL: ui.webContents.mainFrame.url, requireMatrixCaller, logAppChatFailures,
    fenceDeviceBeforeOperationLock: vi.fn(), matrixDeviceStopFence: undefined,
    state: { state: 'ready' }, closing: false, operation: false, domainOperation: false,
    parseMatrixCommand, requireRoomAgent: () => agent,
    cloudPrincipal: () => 'luna', movingAgents: new Set(options.moving ? ['luna'] : []),
    homeMigrationForOwner: () => ({ holds: { held: () => options.migration ?? false } }),
    agentHome: { isHeld: (principal: string) => holds.has(principal), holds },
    isCloudAgent: () => options.cloud ?? true, isCloudOnlyAgent: () => false,
    cloudAgentMacRole: () => 'standby', matrixCloudAgentAnswersInCloud,
    account: { identity: () => ({ userId: '@owner:test' }) },
    hosts: new Map<string, unknown>([['human', human], ['agent', { ready: options.hostReady ?? false }]]),
    guardRoomCommand: vi.fn(async () => {}), dispatchMatrixCommand,
    matrixSdkCommandTimeout: () => 20_000, pendingMatrixDrafts: undefined,
    runtime: options.cloud === false ? {} : undefined, assistantBlocked,
    holdOperation: vi.fn(), noteCheckInOwnerMessage: vi.fn(),
    requireAssistantRoom: vi.fn(async () => {}), sendAssistantMessage,
    observeMessage: (send: () => unknown) => send(), rememberSentHere: vi.fn(),
    runHermes: vi.fn(async () => ({ state: 'published' })), matrixInvocationResult: (result: unknown) => result
  }

  context.dispatchSdkCommand = mainCode('dispatchSdkCommand', context)
  context.command = mainCode('command', context)
  context.macJobHomeHeld = mainCode('macJobHomeHeld', context)
  context.refuseCloudAgent = mainCode('refuseCloudAgent', context)
  const invoke = mainCode('ui', context, true)

  const send = () => invoke({ sender: ui.webContents, senderFrame: ui.webContents.mainFrame }, {
    kind: 'sendAssistant', roomId: '!luna:test', body: 'Hello Luna', locale: 'en'
  })

  return { context, human, send }
}

describe('cloud assistant owner send IPC', () => {
  it.each([[['standDown'] as HoldReason[]], [[] as HoldReason[]]])('posts with holds %j and an idle/unavailable standby without a local turn', async reasons => {
    const f = fixture({ reasons })
    await expect(f.send()).resolves.toEqual({ eventId: '$sent', result: { state: 'published' } })
    expect(f.context.guardRoomCommand).toHaveBeenCalledWith('send', '!luna:test')
    expect(f.human.queue.command).toHaveBeenCalledExactlyOnceWith({ kind: 'send', roomId: '!luna:test', body: 'Hello Luna' }, 20_000)
    expect(f.context.rememberSentHere).toHaveBeenCalledExactlyOnceWith('$sent')
    expect(f.context.runHermes).not.toHaveBeenCalled()
    expect(f.context.holdOperation).not.toHaveBeenCalled()
    expect(f.context.requireAssistantRoom).not.toHaveBeenCalled()
  })

  it('retains local room preflight and exactly one local invocation', async () => {
    const f = fixture({ cloud: false, hostReady: true })
    await expect(f.send()).resolves.toMatchObject({ eventId: '$sent' })
    expect(f.context.requireAssistantRoom).toHaveBeenCalled()
    expect(f.context.runHermes).toHaveBeenCalledExactlyOnceWith({ roomId: '!luna:test', eventId: '$sent' }, 'en', undefined, undefined, expect.anything())
  })

  it('keeps a stood-down local agent fenced', async () => {
    const f = fixture({ cloud: false, hostReady: true, reasons: ['standDown'] })
    await expect(f.send()).rejects.toThrow('matrix_agent_unavailable')
    expect(f.human.queue.command).not.toHaveBeenCalled()
  })
})

it('refuses the retired move action without calling an account or transport', async () => {
  const request = mainCode('cloudAgentRequest', {})
  await expect(request({ action: 'moveToCloud', principal: 'luna' })).rejects.toThrow('matrix_command_invalid')
})
