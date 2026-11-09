import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isTeamSpaceRoom } from '../../shared/matrix-company-channel-room'
import { matrixSdkErrorPayload } from '../../src/matrix/sdk-error-code'
import { matrixSdkCommandTimeout, MatrixSdkHost } from '../../src/matrix/sdk-host-queue'

import { matrixTurnsNeedingHost } from './agent-routing'
import { matrixTurnOwnsHeldLease } from './agent-runtime'
import {
  appBotChatSelectedLine,
  localAppChatRoom,
  logAppChatFailures,
  startAppChat
} from './app-bots/open-chat'
import { platformAppChatRoom } from './app-bots/platform-room'
import { CompanyChannelConfirmations, companyChannelOpenFailedLine, companyChannelSelectedLine } from './company-room-guard'
import { matrixHostEndsTurns, matrixHostLiveness, matrixLeaseHostAction } from './host-health'
import { parseMatrixCommand, parseMatrixSignInMethod, requireMatrixCaller } from './ipc-policy'
import { MatrixExecutorLease } from './lease'
import { logNotesSelfOpenFailures } from './notes-self-log'
import { MatrixOwnerDeviceRepair, matrixOwnerRepairError, matrixOwnerRepairPreservesWork } from './owner-device-repair'
import { matrixHumanSdkReady } from './sdk-host'
import { matrixHumanSnapshot } from './window-launch'

// Execute the actual main callbacks without booting Electron, a live account or Keychain.
// Only external boundaries are supplied; the dispatch/catch and lifecycle decisions are main's.
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('./main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const mainContexts = new WeakMap<object, Record<string, unknown>>()
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
  mainContexts.set(executable, sandbox)
  return executable
}

const oldOwner = { userId: '@owner:test', deviceId: 'OLD' }
const newOwner = { ...oldOwner, deviceId: 'NEW' }
const snapshot = () => ({
  state: 'ready' as const,
  identity: oldOwner,
  rooms: [],
  roomId: null,
  messages: [],
  error: null
})

function ipcFixture() {
  let current = oldOwner
  const account = {
    identity: () => current,
    repairOwnerDevice: vi.fn(async () => {
      current = newOwner
      return { domain: true, replaced: oldOwner }
    }),
    cancelOwnerDeviceRepair: vi.fn()
  }
  const repair = new MatrixOwnerDeviceRepair({
    account,
    damaged: () => true,
    resume: async () => ({ signed: true, backup: true }),
    log: vi.fn()
  })
  const ui = { webContents: { mainFrame: { url: 'atum-matrix://ui/matrix.html' } } }
  const context = {
    ui,
    UI_URL: ui.webContents.mainFrame.url,
    closing: false,
    state: snapshot(),
    operation: false,
    ownerDeviceRepair: repair,
    ownerRepairController: () => repair,
    requireMatrixCaller,
    // Main registers the handler through this (an app chat's failure leaves its line); it passes
    // every other request and its failure through untouched.
    logAppChatFailures,
    parseMatrixSignInMethod,
    matrixOwnerRepairError,
    fenceDeviceBeforeOperationLock: vi.fn(),
    matrixDeviceStopFence: undefined,
    anyOperation: () => false,
    sessionChecks: { released: vi.fn() },
    desktopServices: undefined,
    publish: vi.fn(),
    reconcileDeviceControl: vi.fn(async () => {})
  }
  const invoke = mainCode('ui', context, true)
  const event = { sender: ui.webContents, senderFrame: ui.webContents.mainFrame }
  return { account, repair, context, event, invoke }
}

describe('main repair IPC', () => {
  it('logs a notes-self failure even when main refuses it before SDK dispatch', async () => {
    const f = ipcFixture()
    f.context.anyOperation = () => true
    const log = vi.fn()
    const invoke = mainCode('ui', f.context, true)
    // mainCode supplies console itself; capture that shared boundary for this request.
    const warn = vi.spyOn(console, 'warn').mockImplementation(log)

    try {
      await expect(invoke(f.event, { kind: 'command', command: { kind: 'notesSelfOpen' } }))
        .rejects.toThrow('matrix_not_ready')
      expect(log).toHaveBeenCalledExactlyOnceWith('[Matrix] notes-self open outcome=failed code=matrix_not_ready')
    } finally {
      warn.mockRestore()
    }
  })

  it('dispatches repair and its cancel through the existing authenticated bridge', async () => {
    const f = ipcFixture()
    await expect(f.invoke(f.event, { kind: 'repairOwnerDevice' })).resolves.toEqual({ state: 'repaired' })
    expect(f.account.repairOwnerDevice).toHaveBeenCalledExactlyOnceWith(oldOwner, 'google')
    await f.invoke(f.event, { kind: 'cancelOwnerDeviceRepair' })
    expect(f.account.cancelOwnerDeviceRepair).toHaveBeenCalledOnce()
    expect(f.context.publish).not.toHaveBeenCalled()
    expect(f.context.sessionChecks.released).toHaveBeenCalledOnce()
  })

  it('allows repair cancellation while the operation lock is held, rejects foreign senders first', async () => {
    const f = ipcFixture()
    f.context.anyOperation = () => true
    const invoke = mainCode('ui', f.context, true)
    await expect(invoke({ sender: {}, senderFrame: {} }, { kind: 'cancelOwnerDeviceRepair' })).rejects.toThrow(
      'matrix_ipc_denied'
    )
    expect(f.account.cancelOwnerDeviceRepair).not.toHaveBeenCalled()
    await invoke(f.event, { kind: 'cancelOwnerDeviceRepair' })
    expect(f.account.cancelOwnerDeviceRepair).toHaveBeenCalledOnce()
    await expect(invoke(f.event, { kind: 'repairOwnerDevice' })).rejects.toThrow('matrix_operation_pending')
  })

  it.each([
    'matrix_login_cancelled',
    'matrix_login_timed_out',
    'matrix_login_failed',
    'matrix_account_mismatch',
    'matrix_password_unavailable',
    'matrix_owner_repair_busy',
    'matrix_owner_repair_not_damaged',
    'matrix_owner_repair_stale',
    'matrix_owner_repair_method_invalid',
    'matrix_operation_pending',
    'matrix_recovery_stale',
    'auth_storage_unavailable',
    'auth_storage_disk_full',
    'unsafe token detail'
  ])('never publishes signed_out or a generic connection failure for %s', async code => {
    const f = ipcFixture()
    f.account.repairOwnerDevice.mockRejectedValueOnce(new Error(code))
    await expect(f.invoke(f.event, { kind: 'repairOwnerDevice' })).rejects.toThrow(
      matrixOwnerRepairError(new Error(code)).message
    )
    expect(f.context.publish).not.toHaveBeenCalled()
    expect(f.account.identity()).toEqual(oldOwner)
    expect(f.context.sessionChecks.released).toHaveBeenCalledOnce()
  })
})

// A click on an app's chat that reports nothing is the worst failure. The real handler writes its
// line wherever the open fails, including before the open is reached (a window not yet ready).
describe('main app chat IPC', () => {
  it.each([
    // No apps workspace yet, as on a window that has not finished starting.
    ['no apps workspace', { matrixApps: undefined }, { kind: 'appChat', appId: 'a'.repeat(36) }],
    // An id that is not an app's.
    ['an id that is not an app id', { matrixApps: { snapshot: () => ({ apps: [] }) } }, { kind: 'appChat', appId: 'moon' }]
  ])('writes the failed line, with the closed code, for %s', async (_case, extra, request) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const f = ipcFixture()
      const invoke = mainCode('ui', { ...f.context, ...extra }, true)

      await expect(invoke(f.event, request)).rejects.toThrow('matrix_not_ready')
      expect(warn.mock.calls).toEqual([['[Matrix] app bot open app=unknown outcome=failed code=matrix_not_ready']])
    } finally {
      warn.mockRestore()
    }
  })

  it('names the app from the catalog when it has one, and writes nothing for other requests', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const f = ipcFixture()
      const appId = '00000000-0000-4000-8000-e2f66bfade22'

      // A catalog that has the app, whose window is not ready: the open is refused before it starts.
      const invoke = mainCode(
        'ui',
        {
          ...f.context,
          matrixApps: { snapshot: () => ({ apps: [{ app: 'acme', app_id: appId, bot: {} }] }) },
          hosts: new Map(),
          profileSelection: false,
          lifecycle: undefined,
          domainOperation: false,
          matrixHumanSdkReady: () => false
        },
        true
      )

      await expect(invoke(f.event, { kind: 'appChat', appId })).rejects.toThrow('matrix_not_ready')
      expect(warn.mock.calls).toEqual([['[Matrix] app bot open app=acme outcome=failed code=matrix_not_ready']])

      // Another request that fails does not write an app chat line.
      warn.mockClear()
      await expect(invoke({ sender: {}, senderFrame: {} }, { kind: 'cancelOwnerDeviceRepair' })).rejects.toThrow(
        'matrix_ipc_denied'
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// An app's chat opens by waiting for its room to sync, up to a quarter of a minute. That wait is the open's
// own: the real handler must not hold the account for it, or the person could not switch chats, send, or sign
// out meanwhile. The SDK drops a selection the person has moved from, and its stop ends the wait.
describe('main app chat open, while its room is on its way', () => {
  const appId = '00000000-0000-4000-8000-e2f66bfade22'
  const otherAppId = '00000000-0000-4000-8000-31996b8ab271'

  const botOf = (slug: string) => ({
    v: 1,
    user_id: `@app-${slug}:test`,
    handle: `${slug}_bot`,
    display_name: slug,
    state: 'active',
    device: { device_id: 'BOT_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    groups: false,
    consent: 'accepted'
  })

  const apps = [
    { app: 'acme', app_id: appId, bot: botOf('acme') },
    { app: 'beta', app_id: otherAppId, bot: botOf('beta') }
  ]

  /**
   * The person's SDK at the far end of a real command queue. It answers as the SDK does: a chat's room is
   * found at once, and an open then waits for its room until the test brings it (`arrive`) or the SDK is
   * stopped, which ends every wait with `matrix_sdk_stopped`.
   */
  function humanSdk() {
    const received: Array<{ kind: string; [key: string]: unknown }> = []
    const waiting = new Map<string, string>()
    let queue!: MatrixSdkHost
    const answer = (id: string, value: unknown) => queueMicrotask(() => queue.result(id, true, value))

    const opened = (room: string) => ({
      roomId: room,
      outcome: 'created',
      reason: 'first_use',
      joined: 1,
      left: 0,
      pointer: 'written',
      shown: 'none'
    })

    queue = new MatrixSdkHost(
      (id, value) => {
        const command = value as { kind: string; appId?: string; [key: string]: unknown }
        received.push(command)

        if (command.kind === 'openAppBotDm') {
          waiting.set(id, command.appId!)

          return
        }

        if (command.kind === 'stop') {
          for (const waitingId of waiting.keys()) {
            queueMicrotask(() => queue.result(waitingId, false, matrixSdkErrorPayload(new Error('matrix_sdk_stopped'))))
          }

          waiting.clear()
        }

        answer(id, command.kind === 'findAppBotDm' ? { roomId: null, selection: 0 } : command.kind === 'send' ? '$sent' : null)
      },
      () => {}
    )

    return {
      queue,
      received,
      kinds: () => received.map(command => command.kind),
      /** Sync brings the room an open is waiting for. */
      arrive(forApp: string, room = `!${forApp.slice(0, 4)}:test`) {
        for (const [id, waitingApp] of waiting) {
          if (waitingApp === forApp) {
            waiting.delete(id)
            queue.result(id, true, opened(room))
          }
        }
      },
      /** The SDK ends an open with a closed code, as it does when the room never comes. */
      fail(forApp: string, code: string) {
        for (const [id, waitingApp] of waiting) {
          if (waitingApp === forApp) {
            waiting.delete(id)
            queue.result(id, false, matrixSdkErrorPayload(new Error(code)))
          }
        }
      }
    }
  }

  function openingFixture() {
    const f = ipcFixture()
    const human = { queue: undefined as unknown as MatrixSdkHost, identity: oldOwner, window: {} }
    const sdk = humanSdk()
    human.queue = sdk.queue
    const hosts = new Map([['human', human]])
    const openingAppChats = new Map<string, unknown>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let invoke: ReturnType<typeof mainCode>

    // Main's own `anyOperation` over the state the real handler writes (`operation`).
    const sandbox = () => mainContexts.get(invoke) as Record<string, any>

    const account = {
      ...f.account,
      // The signed-in account's local storage scope, as the real account reports it.
      appScope: () => ({ accountKey: 'test-account', generation: 1 }),
      // The platform has no room verifier route yet (404): the local rule opens the chat.
      appBotStart: vi.fn(async () => ({ status: 404 })),
      // Sign-out, as the account does it: the SDK is stopped first, then the device is cleared.
      signOut: vi.fn(async (finish: (...args: unknown[]) => Promise<void>) => {
        await finish(oldOwner, undefined, undefined)
      }),
      hasOrphanedEnrollments: () => false
    }

    const context = {
      ...f.context,
      hosts,
      openingAppChats,
      matrixApps: { snapshot: () => ({ apps }), botChat: (id: string) => apps.find(app => app.app_id === id) },
      matrixHumanSdkReady,
      matrixSdkCommandTimeout,
      startAppChat,
      localAppChatRoom,
      platformAppChatRoom,
      appBotChatSelectedLine,
      // A selected company channel's diagnostics, as main has them (this chat is no channel: nothing is logged).
      companyChannelConfirmations: new CompanyChannelConfirmations({ read: async () => ({ channels: [] }), changed: () => {} }),
      companyChannelSelectedLine,
      companyChannelOpenFailedLine,
      parseMatrixCommand,
      randomUUID: () => '00000000-0000-4000-8000-11e594f48195',
      app: { getVersion: () => '1.0.0' },
      profileSelection: false,
      lifecycle: undefined,
      domainOperation: false,
      anyOperation: () => Boolean(sandbox().operation),
      account,
      // `command` reaches the human SDK, as main's does.
      command: (value: unknown) => human.queue.command(value),
      documents: { closePreviews: vi.fn() },
      guardRoomCommand: vi.fn(async () => {}),
      assistantCommand: (input: unknown) => input,
      productAgent: () => undefined,
      allAgents: () => [],
      config: {},
      AGENT_ONE_CONVERSATION: false,
      MATRIX_COMPANY_CHANNEL_TYPE: 'io.atum.company_channel',
      isTeamSpaceRoom,
      publish: vi.fn((next: unknown) => {
        sandbox().state = next
      }),
      // Sign-out, as main does it: the human host stops (every pending command fails), the window moves on.
      stopSdk: async () => {
        hosts.delete('human')
        await human.queue.stop()
      },
      // The rest of main's sign-out, which this test is not about: each piece present and quiet.
      executionDeviceNames: { invalidate: vi.fn() },
      scheduleContinuousListening: vi.fn(),
      moveGeneration: 0,
      moveAborts: new Set(),
      defaultAgent: {},
      agentMoves: { clear: vi.fn() },
      cloudAgents: { clear: vi.fn() },
      placedAgents: { reset: vi.fn() },
      movingAgents: { clear: vi.fn() },
      deviceApproval: { reset: vi.fn() },
      agentRoster: { invalidate: vi.fn() },
      sourceGateSync: { stop: vi.fn() },
      signingOutCodexOwners: () => [],
      forgetCodexOwners: vi.fn(),
      forgetSubscriptionKey: vi.fn(),
      matrixConsumerBrowser: { releaseConsumerPartitions: async () => {} },
      clearDevice: vi.fn(async () => {}),
      forgetAgents: vi.fn(async () => {}),
      outcomeStore: { clear: vi.fn() },
      signedOutNotice: () => null,
      deviceIdentity: undefined,
      ownPresence: { offline: vi.fn(async () => {}) },
      deviceControlOwner: undefined,
      cloudEnrollments: undefined,
      petOverlays: undefined,
      deviceBootstrap: undefined,
      deviceLedger: undefined,
      drive: undefined,
      localBrain: undefined,
      hermesPages: undefined,
      ownerUnlock: undefined,
      recoveryCustody: undefined,
      ownDeviceDamaged: undefined,
      icloudMirrored: undefined,
      approvalAsked: undefined,
      declinedDevice: undefined,
      brainActive: false,
      brainOwner: null,
      startupState: undefined,
      agentCleanupRequired: false,
      orphanedEnrollmentsTried: false
    }

    invoke = mainCode('ui', context, true)

    return {
      ...f,
      context,
      sdk,
      warn,
      invoke,
      hosts,
      openingAppChats,
      operation: () => Boolean(sandbox().operation),
      signedIn: () => sandbox().state.identity,
      open: (id = appId) => invoke(f.event, { kind: 'appChat', appId: id }),
      command: (value: unknown) => invoke(f.event, { kind: 'command', command: value }),
      /** The open has reached the SDK's wait for its room. */
      reached: (kind = 'openAppBotDm', count = 1) =>
        vi.waitFor(() => expect(sdk.kinds().filter(each => each === kind)).toHaveLength(count), { timeout: 5_000 })
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('holds nothing up while the room is on its way: another chat, a send, and another app’s open all go ahead', async () => {
    const f = openingFixture()
    const opening = f.open()
    await f.reached()

    // The open is under way, and it is not an account operation.
    expect(f.operation()).toBe(false)
    expect(f.context.anyOperation()).toBe(false)
    expect(f.openingAppChats.has(appId)).toBe(true)

    await expect(f.command({ kind: 'select', roomId: '!elsewhere:test' })).resolves.toBeNull()
    await expect(f.command({ kind: 'send', roomId: '!elsewhere:test', body: 'Hello' })).resolves.toBe('$sent')
    expect(f.sdk.received).toContainEqual({ kind: 'select', roomId: '!elsewhere:test' })
    expect(f.sdk.received).toContainEqual(expect.objectContaining({ kind: 'send', roomId: '!elsewhere:test' }))

    // Another app's chat opens alongside it.
    const other = f.open(otherAppId)
    await f.reached('openAppBotDm', 2)
    expect(f.openingAppChats.size).toBe(2)

    // The rooms come; each open ends, and the guard is clear.
    f.sdk.arrive(appId)
    f.sdk.arrive(otherAppId)
    await expect(opening).resolves.toMatch(/^!/u)
    await expect(other).resolves.toMatch(/^!/u)
    expect(f.openingAppChats.size).toBe(0)
    expect(f.operation()).toBe(false)
    // The line each open writes is main's own, once.
    expect(f.warn.mock.calls.filter(([line]) => String(line).includes('outcome=created'))).toHaveLength(2)
  })

  it('opens one chat per app at a time: a second ask is refused as busy, and the retry goes ahead once it has ended', async () => {
    const f = openingFixture()
    const first = f.open()
    await f.reached()

    await expect(f.open()).rejects.toThrow('matrix_not_ready')
    expect(f.sdk.kinds().filter(kind => kind === 'openAppBotDm')).toHaveLength(1)
    expect(f.warn.mock.calls).toContainEqual(['[Matrix] app bot open app=acme outcome=failed code=matrix_not_ready'])

    // The first ends without its room (sync never brought it): the guard is clear for the retry.
    f.sdk.fail(appId, 'matrix_app_bot_syncing')
    await expect(first).rejects.toThrow('matrix_app_bot_syncing')
    expect(f.openingAppChats.size).toBe(0)

    const retry = f.open()
    await f.reached('openAppBotDm', 2)
    f.sdk.arrive(appId)
    await expect(retry).resolves.toMatch(/^!/u)
  })

  it('does not let an open on a host that has been replaced hold the app', async () => {
    const f = openingFixture()
    // What a previous account's open left behind while its platform call hung.
    f.openingAppChats.set(appId, { queue: {} })

    const opening = f.open()
    await f.reached()
    f.sdk.arrive(appId)
    await expect(opening).resolves.toMatch(/^!/u)
  })

  it('still refuses to start while a real account operation holds the account', async () => {
    const f = openingFixture()
    mainContexts.get(f.invoke)!.operation = true

    await expect(f.open()).rejects.toThrow('matrix_not_ready')
    expect(f.sdk.kinds()).not.toContain('openAppBotDm')
    expect(f.openingAppChats.size).toBe(0)
  })

  it('says why when the room never comes, as the person can act on it', async () => {
    const f = openingFixture()
    const opening = f.open()
    await f.reached()

    f.sdk.fail(appId, 'matrix_app_bot_syncing')
    await expect(opening).rejects.toThrow('matrix_app_bot_syncing')
    // One line for the open, once (the platform's own line for its answer is another).
    expect(f.warn.mock.calls.filter(([line]) => String(line).includes('app bot open'))).toEqual([
      ['[Matrix] app bot open app=acme outcome=failed code=matrix_app_bot_syncing']
    ])
  })

  it('lets the person sign out meanwhile: the wait ends, nothing is selected, and no error is left behind', async () => {
    const f = openingFixture()
    const opening = f.open()
    await f.reached()

    // Not refused as a pending operation: the open holds nothing.
    await expect(f.invoke(f.event, { kind: 'signOut' })).resolves.toBeUndefined()
    expect(f.context.account.signOut).toHaveBeenCalledOnce()
    expect(f.signedIn()).toBeNull()

    // The open ended with the SDK's stop: it opened nothing, and the window is told nothing to put on the sign-in
    // screen (an error here would read as a failed sign-in).
    await expect(opening).resolves.toBeNull()
    expect(f.warn.mock.calls).toContainEqual(['[Matrix] app bot open app=acme outcome=failed code=matrix_sdk_stopped'])
    // And no chat was selected after the sign-out started: the host saw no select, and the room that
    // arrives late has nobody to select it.
    expect(f.sdk.kinds()).not.toContain('select')
    f.sdk.arrive(appId)
    expect(f.sdk.kinds()).not.toContain('select')
    expect(f.openingAppChats.size).toBe(0)
    expect(f.operation()).toBe(false)
  })

  it('still reports a failure when the account is the same one, even if its chat engine restarted', async () => {
    const f = openingFixture()
    const opening = f.open()
    await f.reached()

    // The same person is signed in: an open that cannot end well says so.
    f.sdk.fail(appId, 'matrix_app_bot_resting')
    await expect(opening).rejects.toThrow('matrix_app_bot_resting')
  })
})

describe('main human replacement with a real lease', () => {
  it.each([false, true])(
    'retains the exact term and does not abort (admitted=%s); real sign-out still releases',
    async admitted => {
      const calls: string[] = []
      const executorId = '00000000-0000-4000-8000-75c02539218c'
      const now = Date.now()
      const lease = new MatrixExecutorLease({
        request: async operation => {
          calls.push(operation)
          return operation === 'release'
            ? { held: false }
            : {
                held: true,
                executorId,
                leaseToken: '00000000-0000-4000-8000-127ad7633157',
                boundary: now,
                acquiredAt: now,
                expiresAt: now + 90_000
              }
        }
      })
      lease.start(executorId, 2)
      await new Promise<void>(resolve => setImmediate(resolve))
      const held = lease.held(executorId)!
      const abort = new AbortController()
      let finish!: () => void
      const f = ipcFixture()
      // Hold after the account commit, exactly where main replaces its human host.
      const repair = new MatrixOwnerDeviceRepair({
        account: f.account,
        damaged: () => true,
        log: vi.fn(),
        resume: () =>
          new Promise(resolve => {
            finish = () => resolve({ signed: true, backup: true })
          })
      })
      const running = repair.run()
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      const agent = {
        role: 'agent',
        lease,
        invocation: admitted ? { roomId: '!chat:test', abort, leaseSignal: held.signal } : undefined,
        listener: { snapshot: () => undefined }
      }
      const host = { identity: newOwner }
      let state = { ...snapshot(), identity: newOwner, state: 'connecting' }
      const context = {
        closing: false,
        agent,
        hosts: new Map<string, { identity?: typeof oldOwner; ready?: boolean }>([
          ['human', host],
          ['agent', { ready: true }]
        ]),
        enrollmentOf: () => ({ state: 'ready', identity: { executorId } }),
        isCloudOnlyAgent: () => false,
        isMovingAgent: () => false,
        // The agent-home model is not running: no drain or checkpoint is holding a lease here.
        agentHome: undefined,
        matrixLeaseHostAction,
        matrixHumanSdkReady,
        matrixTurnOwnsHeldLease,
        ownerRepairPreservesWork: () => matrixOwnerRepairPreservesWork(repair, state as never, false),
        get state() {
          return state
        },
        matrixHostLiveness,
        matrixHostEndsTurns,
        matrixTurnsNeedingHost,
        requireHost: () => ['human', host],
        agentOfRole: () => undefined,
        allAgents: () => [agent],
        stopListening: vi.fn(),
        scheduleContinuousListening: vi.fn(),
        humanEngineError: null,
        matrixLogCode: () => null,
        matrixChatTokenRefused: () => false,
        matrixHumanSnapshot,
        deviceApproval: { observe: vi.fn() },
        unverifiedDevices: { observe: vi.fn() },
        enrichAppBotDisplay: async (value: unknown) => value,
        matrixApps: undefined,
        publish: vi.fn((value: typeof state) => {
          state = value
        })
      }
      try {
        const receive = mainCode('sdkSnapshot', context, true)
        receive({}, { ...snapshot(), identity: newOwner, state: 'connecting' })
        expect(context.publish).toHaveBeenCalledOnce() // swallowed callback errors cannot pass unnoticed
        expect(abort.signal.aborted).toBe(false)
        expect(context.stopListening).not.toHaveBeenCalled()
        mainCode('reconcileLease', context)(agent)
        expect(lease.held(executorId)?.signal).toBe(held.signal)
        expect(held.signal.aborted).toBe(false)
        expect(calls).toEqual(['acquire'])

        // Even with a pending repair, real lifecycle evidence wins.
        for (const ended of [
          { ...state, state: 'signed_out', identity: null },
          { ...state, error: 'matrix_sign_out_pending' },
          { ...state, identity: { userId: '@other:test', deviceId: 'OTHER' } }
        ]) {
          expect(matrixOwnerRepairPreservesWork(repair, ended as never, false)).toBe(false)
        }
        expect(matrixOwnerRepairPreservesWork(repair, state as never, true)).toBe(false)
        state = { ...state, state: 'signed_out' }
        mainCode('reconcileLease', { ...context, state })(agent)
        await vi.waitFor(() => expect(calls).toEqual(['acquire', 'release']))
        expect(held.signal.aborted).toBe(true)
        expect(lease.held(executorId)).toBeNull()
      } finally {
        finish()
        await running
        await lease.stop()
      }
    }
  )
})

it('main resumes only the human host and clears old storage only after signed backup restore', async () => {
  const f = ipcFixture()
  const humanStop = vi.fn(async () => {})
  const agentStop = vi.fn()
  const state = snapshot()
  const hosts = new Map<string, { identity: typeof oldOwner; queue: { stop: typeof humanStop }; ready?: boolean }>([
    ['human', { identity: oldOwner, queue: { stop: humanStop } }],
    ['agent', { identity: { userId: '@agent:test', deviceId: 'AGENT' }, queue: { stop: agentStop }, ready: true }]
  ])
  const agentHost = hosts.get('agent')
  const account = f.account
  const context = {
    MatrixOwnerDeviceRepair,
    ownerDeviceRepair: undefined,
    account,
    ownDeviceDamaged: `${oldOwner.userId}\n${oldOwner.deviceId}`,
    closing: false,
    state,
    hosts,
    matrixHumanSdkReady,
    sdkRendererRecovery: { cancel: vi.fn() },
    humanPrepared: true,
    resetDeviceControlReadyChecks: vi.fn(),
    ownerUnlock: undefined,
    ownerUnlockRetryAt: 0,
    sessionRestartedAt: undefined,
    startHost: vi.fn(async () => {
      hosts.set('human', { identity: newOwner, queue: { stop: vi.fn(async () => {}) } })
      Object.assign(state, { identity: newOwner, state: 'ready' })
    }),
    waitUntil: async (predicate: () => boolean) => predicate(),
    unlockOwner: vi.fn(async () => ({ state: 'unlocked', signed: false, backup: true })),
    clearDevice: vi.fn(async () => {}),
    deviceLedger: { forget: vi.fn() },
    scheduleContinuousListening: vi.fn(),
    allAgents: () => [{ role: 'agent' }],
    backgroundAgentTrust: vi.fn(),
    ensureAgentTrust: vi.fn(),
    publish: vi.fn()
  }
  const repair: MatrixOwnerDeviceRepair = mainCode('ownerRepairController', context)()
  expect(await repair.run()).toEqual({ state: 'resume_pending' })
  expect(humanStop).toHaveBeenCalledOnce()
  expect(agentStop).not.toHaveBeenCalled()
  expect(hosts.get('agent')).toBe(agentHost)
  expect(context.startHost).toHaveBeenCalledExactlyOnceWith('human', { preserveRuntime: true })
  expect(context.clearDevice).not.toHaveBeenCalled()
  expect(context.deviceLedger.forget).not.toHaveBeenCalled()
  expect(repair.snapshot(newOwner)).toEqual({ state: 'resume_pending' })
  expect(repair.replacing(newOwner)).toBe(true)
  expect(repair.snapshot({ ...newOwner, userId: '@other:test' })).toBeUndefined()
  repair.cancel()
  expect(account.identity()).toEqual(newOwner)
  context.unlockOwner.mockResolvedValue({ state: 'unlocked', signed: true, backup: true })
  expect(await repair.run()).toEqual({ state: 'repaired' })
  expect(account.repairOwnerDevice).toHaveBeenCalledOnce()
  expect(context.clearDevice).toHaveBeenCalledExactlyOnceWith(oldOwner)
  expect(context.deviceLedger.forget).toHaveBeenCalledExactlyOnceWith(oldOwner)
  expect(context.backgroundAgentTrust).toHaveBeenCalledOnce()
  expect(repair.snapshot(newOwner)).toBeUndefined()
  expect(repair.replacing(newOwner)).toBe(false)
})

function deviceReconcileContext(activate: () => Promise<{ state: string }>) {
  return {
    state: { ...snapshot(), identity: oldOwner },
    closing: false,
    ownerRepairPreservesWork: () => false,
    deviceIdentity: { activate: vi.fn(activate) },
    deviceControlOwner: undefined,
    deviceControlScope: undefined,
    deviceControlLastAttempt: 0,
    deviceControlReadyFlight: undefined,
    deviceControlFlightScope: undefined,
    DEVICE_CONTROL_RETRY_MS: 60_000,
    DEVICE_CONTROL_VERIFY_MS: 5 * 60_000,
    executionDeviceNames: { invalidate: vi.fn() },
    executionPolicies: { refreshAll: vi.fn() },
    scheduleExecutionPolicyReconcile: vi.fn(),
    scheduleContinuousListening: vi.fn(),
    publish: vi.fn()
  }
}

it('main silently enrolls at sign-in and publishes only reconnecting then ready status', async () => {
  const context = deviceReconcileContext(async () => ({ state: 'enrolled' }))
  const reconcile = mainCode('reconcileDeviceControl', context)
  const live = mainContexts.get(reconcile)!

  await reconcile()

  expect(context.deviceIdentity.activate).toHaveBeenCalledOnce()
  expect(live.deviceControlOwner).toBeUndefined()
  expect(context.publish).toHaveBeenCalledTimes(2)
})

it('main queues the new account when an account switch races the previous enrollment flight', async () => {
  let finish!: (presence: { state: string }) => void
  const context = deviceReconcileContext(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const reconcile = mainCode('reconcileDeviceControl', context)
  const live = mainContexts.get(reconcile)!
  const first = reconcile()
  const liveState = live.state as ReturnType<typeof snapshot>
  liveState.identity = newOwner
  const switched = reconcile()

  finish({ state: 'enrolled' })
  await first
  await vi.waitFor(() => expect(context.deviceIdentity.activate).toHaveBeenCalledTimes(2))
  finish({ state: 'enrolled' })
  await switched

  expect(live.deviceControlScope).toBe(`${newOwner.userId}\n${newOwner.deviceId}`)
  expect(live.deviceControlOwner).toBeUndefined()
})

it('main keeps a failed enrollment reconnecting and retries in the background', async () => {
  const activate = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ state: 'enrolled' })
  const context = deviceReconcileContext(activate)
  const reconcile = mainCode('reconcileDeviceControl', context)
  const live = mainContexts.get(reconcile)!

  await reconcile()
  expect(live.deviceControlOwner).toEqual(oldOwner)
  await reconcile(true)

  expect(context.deviceIdentity.activate).toHaveBeenCalledTimes(2)
  expect(live.deviceControlOwner).toBeUndefined()
})
