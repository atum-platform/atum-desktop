import { describe, expect, it, vi } from 'vitest'

import { CONSUMER_BROWSER_IPC } from '../../shared/browser/ipc'
import type { MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_AGENT_SOURCES_IPC } from '../../shared/matrix-agent-sources'
import { MATRIX_CLIPBOARD_IPC } from '../../shared/matrix-clipboard'
import { MATRIX_INVITE_LINK_IPC } from '../../shared/matrix-invite-link'
import { MATRIX_KEEP_AWAKE, type MatrixKeepAwakeBridge } from '../../shared/matrix-keep-awake'
import { MATRIX_LOGIN_STARTUP, type MatrixLoginStartupBridge } from '../../shared/matrix-login-startup'
import { MATRIX_MAC_SOURCES_IPC } from '../../shared/matrix-mac-sources'
import { MATRIX_MESSAGE_LINK_IPC } from '../../shared/matrix-message-link'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import { MATRIX_PAGES_IPC } from '../../shared/matrix-pages'
import { MATRIX_PERMISSIONS_IPC } from '../../shared/matrix-permissions'
import { MATRIX_WINDOW_CHANNELS } from '../../shared/matrix-window'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

import './ui-preload'

function bridge(): MatrixUiBridge {
  return electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'atumMatrix')?.[1] as MatrixUiBridge
}

describe('Matrix UI preload window appearance', () => {
  it('forwards only the closed window-failure diagnostic', () => {
    electron.invoke.mockClear()
    bridge().windowFailureDiagnostic!({
      source: 'connectHermes',
      code: 'matrix_agent_unavailable',
      retryable: true
    })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'windowFailureDiagnostic',
      value: { source: 'connectHermes', code: 'matrix_agent_unavailable', retryable: true }
    })
  })

  it('forwards only the agent principal for the read-only service status', async () => {
    electron.invoke.mockClear()
    const principal = '00000000-0000-4000-8000-11e594f48195'
    await bridge().cloudAgent!({ action: 'serviceStatus', principal })
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'cloudAgent', action: 'serviceStatus', principal }]
    ])
  })

  it('forwards only the chosen room/event Stop target; native owns principal, route and request ID', async () => {
    electron.invoke.mockClear()
    const input = {
      action: 'stopTurn' as const,
      roomId: '!room:test',
      eventId: '$event',
      principal: 'other',
      requestId: 'renderer',
      url: 'https://wrong.test',
      token: 'renderer'
    }
    await bridge().cloudAgent!(input)
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'cloudAgent', action: 'stopTurn', roomId: '!room:test', eventId: '$event' }]
    ])
  })
  it('forwards only the trial versions shown; native reads the owner, the offer route and the request ID', async () => {
    electron.invoke.mockClear()
    const input = {
      action: 'trialAccept' as const,
      offerVersion: 4,
      disclosureVersion: 3,
      requestId: 'renderer',
      ownerUserId: '@other:test'
    }
    await bridge().cloudAgent!(input)
    await bridge().cloudAgent!({ action: 'readerEnroll' })
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'cloudAgent', action: 'trialAccept', offerVersion: 4, disclosureVersion: 3 }],
      ['matrix:ui', { kind: 'cloudAgent', action: 'readerEnroll' }]
    ])
  })
  it("asks for a connection's model catalog with the room alone, and a switch with one route id and target", async () => {
    electron.invoke.mockClear()
    await bridge().modelCatalog!('!room:test')
    await bridge().selectModelRoute!('!room:test', 'openai-codex:gpt-6-luna', 'agent_default')
    // Main finds the agent, its provider and its catalog itself.
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'modelCatalog', roomId: '!room:test' }],
      [
        'matrix:ui',
        {
          kind: 'selectModelRoute',
          roomId: '!room:test',
          routeId: 'openai-codex:gpt-6-luna',
          target: 'agent_default'
        }
      ]
    ])
  })
  it('forwards only the agent and the Proton count for a daily cap write', async () => {
    electron.invoke.mockClear()
    // Renderer extras never cross: native main finds the account, the route and the request ID.
    await bridge().modelDestinations!.cap('00000000-0000-4000-8000-11e594f48195', 0)
    expect(electron.invoke.mock.calls).toEqual([
      [
        'matrix:ui',
        {
          kind: 'modelDestinations',
          action: 'cap',
          agentPrincipal: '00000000-0000-4000-8000-11e594f48195',
          dailyProtons: 0
        }
      ]
    ])
  })
  it("forwards only the shell's appearance choice on its own fixed channel", async () => {
    electron.invoke.mockClear()
    await bridge().setWindowAppearance!('dark')
    expect(electron.invoke.mock.calls).toEqual([[MATRIX_WINDOW_CHANNELS.setAppearance, 'dark']])
  })
})

describe('Matrix UI preload app-bot intake', () => {
  it('forwards only the catalog app id and declared field values on fixed operations', async () => {
    electron.invoke.mockClear()
    const apps = bridge().apps!
    const appId = '00000000-0000-4000-8000-11e594f48195'

    await apps.botIntakeStatus(appId)
    await apps.botIntakeSubmit(appId, { preferred_name: 'Minh' })

    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'appBotIntakeStatus', appId }],
      ['matrix:ui', { kind: 'appBotIntakeSubmit', appId, values: { preferred_name: 'Minh' } }]
    ])
  })

  it('forwards only the app and exact Matrix event identity for bot-api media', async () => {
    electron.invoke.mockClear()
    const input = {
      appId: '00000000-0000-4000-8000-11e594f48195',
      roomId: '!moon:test',
      eventId: '$photo'
    }

    await bridge().apps!.botApiMedia(input)

    expect(electron.invoke.mock.calls).toEqual([['matrix:ui', { kind: 'appBotMedia', ...input }]])
  })
})

describe('Matrix UI preload consumer browser bridge', () => {
  it('exposes one fixed clipboard write that carries only the text', async () => {
    electron.invoke.mockClear()
    const clipboard = bridge().clipboard!
    expect(Object.keys(clipboard)).toEqual(['writeText'])
    await clipboard.writeText('Here is a plan.')
    expect(electron.invoke.mock.calls).toEqual([[MATRIX_CLIPBOARD_IPC.write, 'Here is a plan.']])
  })
  it('exposes only pending/live identifier targets for native message links', async () => {
    electron.invoke.mockClear()
    electron.on.mockClear()
    electron.removeListener.mockClear()
    const listener = vi.fn()
    const links = bridge().messageLinks!
    const unsubscribe = links.subscribe(listener)
    const receive = electron.on.mock.calls.find(([name]) => name === MATRIX_MESSAGE_LINK_IPC.opened)?.[1]
    const target = {
      companyId: '00000000-0000-4000-8000-4423c334534f',
      roomId: '!general:atum.example',
      eventId: '$message'
    }

    receive({}, target)
    expect(listener).toHaveBeenCalledExactlyOnceWith(target)
    await links.takePending()
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_MESSAGE_LINK_IPC.pending)
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith(MATRIX_MESSAGE_LINK_IPC.opened, receive)
  })
  it('hands native invite tokens through the process-local channel only', async () => {
    electron.invoke.mockClear()
    electron.on.mockClear()
    electron.removeListener.mockClear()
    const listener = vi.fn()
    const links = bridge().inviteLinks!
    const unsubscribe = links.subscribe(listener)
    const receive = electron.on.mock.calls.find(([name]) => name === MATRIX_INVITE_LINK_IPC.opened)?.[1]
    const token = 'A'.repeat(43)

    receive({}, token)
    expect(listener).toHaveBeenCalledExactlyOnceWith(token)
    await links.takePending()
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_INVITE_LINK_IPC.pending)
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith(MATRIX_INVITE_LINK_IPC.opened, receive)
  })
  it('exposes passive local permissions and fixed pane keys without grant or executor authority', async () => {
    electron.invoke.mockClear()
    const permissions = bridge().permissions!
    expect(Object.keys(permissions).sort()).toEqual(['openSettings', 'relaunch', 'status', 'watch'])
    await permissions.status()
    await permissions.openSettings('microphone')
    await permissions.relaunch!()
    expect(electron.invoke.mock.calls).toEqual([
      [MATRIX_PERMISSIONS_IPC.status],
      [MATRIX_PERMISSIONS_IPC.settings, 'microphone'],
      [MATRIX_PERMISSIONS_IPC.relaunch]
    ])
  })
  it('exposes only closed per-account source reads and boolean switches', async () => {
    electron.invoke.mockClear()
    const sources = bridge().macSources!
    await sources.read()
    await sources.set('messages', false)
    expect(electron.invoke.mock.calls).toEqual([
      [MATRIX_MAC_SOURCES_IPC.read],
      [MATRIX_MAC_SOURCES_IPC.set, 'messages', false]
    ])
  })
  it('exposes account-wide sources without an account or assistant selector', async () => {
    electron.invoke.mockClear()
    electron.on.mockClear()
    electron.removeListener.mockClear()
    const sources = bridge().agentSources!
    expect(Object.keys(sources).sort()).toEqual(['presented', 'read', 'set', 'subscribe'])
    await sources.presented?.()
    await sources.read()
    await sources.set('team_spaces', false)
    expect(electron.invoke.mock.calls).toEqual([
      [MATRIX_AGENT_SOURCES_IPC.presented],
      [MATRIX_AGENT_SOURCES_IPC.read],
      [MATRIX_AGENT_SOURCES_IPC.set, 'team_spaces', false]
    ])

    // A change announcement carries nothing from main; the listener just re-reads.
    const listener = vi.fn()
    const stop = sources.subscribe!(listener)
    const [[channel, receive]] = electron.on.mock.calls as unknown as [[string, (...args: unknown[]) => void]]
    expect(channel).toBe(MATRIX_AGENT_SOURCES_IPC.changed)
    receive({}, { private: 'payload' })
    expect(listener).toHaveBeenCalledExactlyOnceWith()
    stop()
    expect(electron.removeListener).toHaveBeenCalledWith(MATRIX_AGENT_SOURCES_IPC.changed, receive)
  })
  it("exposes the recovery key's write-down as two fixed operations that take nothing from the window", async () => {
    electron.invoke.mockClear()
    const recovery = bridge().recoveryKey!
    expect(Object.keys(recovery).sort()).toEqual(['reveal', 'written'])
    await recovery.reveal()
    await recovery.written()
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'recoveryReveal' }],
      ['matrix:ui', { kind: 'recoveryWritten' }]
    ])
  })
  it("exposes first learning plus the legacy answers, carrying only the chat and the window's language", async () => {
    electron.invoke.mockClear()
    const firstRun = bridge().firstRun!
    expect(Object.keys(firstRun).sort()).toEqual(['allow', 'decline', 'finish', 'start'])
    await firstRun.start({ roomId: '!atum:test', locale: 'en', ending: 'dismissed' })
    await firstRun.allow({ locale: 'vi' })
    await firstRun.allow({ roomId: '!atum:test', locale: 'en' })
    await firstRun.decline()
    await firstRun.finish()
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'firstRunStart', locale: 'en', ending: 'dismissed', roomId: '!atum:test' }],
      ['matrix:ui', { kind: 'firstRunAllow', locale: 'vi' }],
      ['matrix:ui', { kind: 'firstRunAllow', locale: 'en', roomId: '!atum:test' }],
      ['matrix:ui', { kind: 'firstRunDecline' }],
      ['matrix:ui', { kind: 'firstRunFinish' }]
    ])
  })
  it('tags only explicit first-run Google reads and consent with the account language', async () => {
    electron.invoke.mockClear()
    const google = bridge().googleConnections!
    const context = { origin: 'first_run' as const, locale: 'vi' as const }
    await google.status(context)
    await google.connect('google', context)
    await google.status()
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:google-connections:request', { kind: 'status', context }],
      ['matrix:google-connections:request', { kind: 'connect', grant: 'google', context }],
      ['matrix:google-connections:request', { kind: 'status' }]
    ])
  })
  it('exposes named wallet reads without a principal, URL, credential or purchase method', async () => {
    electron.invoke.mockClear()
    const wallet = bridge().wallet!
    expect(Object.keys(wallet).sort()).toEqual(['history', 'refresh'])
    await wallet.refresh()
    await wallet.history('opaque_cursor')
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'walletRefresh' }],
      ['matrix:ui', { kind: 'walletHistory', before: 'opaque_cursor' }]
    ])
  })
  it('exposes only bound profile read/edit operations, never an SDK command or target user ID', async () => {
    const profiles = bridge().profiles!
    expect(Object.keys(profiles).sort()).toEqual(['change', 'close', 'member', 'open', 'read'])
    await profiles.read({ kind: 'human' })
    await profiles.open({ kind: 'human' })
    await profiles.change('editor', { kind: 'remove' })
    await profiles.close('editor')
    await profiles.member('@linh:test')
    expect(electron.invoke).toHaveBeenCalledWith('matrix:profiles:read', { kind: 'human' })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:profiles:open', { kind: 'human' })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:profiles:change', 'editor', { kind: 'remove' })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:profiles:close', 'editor')
    expect(electron.invoke).toHaveBeenCalledWith('matrix:profiles:member', '@linh:test')
  })
  it('publishes the Company Desktop adapter over one closed request', async () => {
    electron.invoke.mockClear()
    electron.invoke.mockResolvedValue({ ok: true, value: {} })
    const companyDesktop = bridge().companyDesktop as Record<string, (...args: unknown[]) => unknown>

    expect(Object.keys(companyDesktop).sort()).toEqual([
      'commandBoard',
      'configureAI',
      'correctProjectBrain',
      'createOrder',
      'ensurePrivateCos',
      'fundFromMember',
      'listBoard',
      'openBoardAttachment',
      'openCitation',
      'openOrder',
      'readAI',
      'readBoardActivity',
      'readBoardCard',
      'readBoardView',
      'readOrder',
      'readPacks',
      'readPendingFund',
      'readPrivateCos',
      'readPrivateCosCapability',
      'readPrivateCosReceipt',
      'readProjectBrain',
      'readWallet',
      'searchBoard',
      'stopPrivateCos'
    ])
    await companyDesktop.readWallet!('00000000-0000-4000-8000-61b0206ddea9')
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'company-desktop',
      companyDesktop: { action: 'read-wallet', companyId: '00000000-0000-4000-8000-61b0206ddea9' }
    })
  })

  it('keeps company avatar media on the closed Company IPC surface', async () => {
    electron.invoke.mockClear()
    const companies = bridge().companies!
    const photo = { type: 'image/png' as const, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }

    expect(Object.keys(companies).sort()).toEqual(['avatar', 'native', 'open', 'pending', 'request', 'search', 'uploadAvatar'])
    await companies.uploadAvatar!(photo)
    await companies.avatar!('!company:matrix.test')
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'company-avatar-upload', photo }],
      ['matrix:ui', { kind: 'company-avatar-read', roomId: '!company:matrix.test' }]
    ])
  })
  it('exposes the device-local login choice only through fixed UI preload operations', async () => {
    const startup = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'atumLoginStartup')?.[1] as
      | MatrixLoginStartupBridge
      | undefined

    expect(startup).toBeDefined()
    await startup!.status()
    await startup!.setEnabled(true)
    await startup!.setEnabled(false)
    await startup!.openSettings()
    await startup!.acknowledge()
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_LOGIN_STARTUP.status)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_LOGIN_STARTUP.enabled, true)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_LOGIN_STARTUP.enabled, false)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_LOGIN_STARTUP.openSettings)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_LOGIN_STARTUP.acknowledge)
  })
  it('exposes the one device-local keep-awake choice on fixed operations', async () => {
    const keepAwake = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'atumKeepAwake')?.[1] as
      | MatrixKeepAwakeBridge
      | undefined

    expect(keepAwake).toBeDefined()
    await keepAwake!.status()
    await keepAwake!.setEnabled(true)
    await keepAwake!.setEnabled(false)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_KEEP_AWAKE.status)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_KEEP_AWAKE.enabled, true)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_KEEP_AWAKE.enabled, false)
  })
  it('exposes only inventory, opaque launch, cleanup, fixed readiness and arrangement settings', async () => {
    const native = bridge().nativeApps!
    expect(Object.keys(native).sort()).toEqual([
      'end',
      'launch',
      'list',
      'onEnded',
      'openArrangementSettings',
      'readiness'
    ])
    const listener = vi.fn()
    const stop = native.onEnded(listener)
    const handler = electron.on.mock.calls.find(([name]) => name === MATRIX_NATIVE_APPS.ended)?.[1]
    handler({}, 'operation-1')
    expect(listener).toHaveBeenCalledWith('operation-1')
    await native.list(true)
    await native.readiness('!selected:test', true)
    const request = { appId: 'opaque', requestId: 'operation-1', mode: 'normal' as const }
    await native.launch(request)
    await native.end(request.requestId)
    await native.openArrangementSettings()
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.list, true)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.readiness, '!selected:test', true)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.launch, request)
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.end, 'operation-1')
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.settings)
    stop()
    expect(electron.removeListener).toHaveBeenCalledWith(MATRIX_NATIVE_APPS.ended, handler)
  })
  it('exposes only scoped pet reads and revision-fenced writes, without credentials or paths', async () => {
    const pets = bridge().pets!
    const target = { scope: 'account:1', agent: 'agent-a' }
    const pet = { ref: { kind: 'bundled' as const, slug: 'gigi' }, enabled: false, scale: 1 }
    expect(Object.keys(pets).sort()).toEqual([
      'adoptPending',
      'beginVisit',
      'cancel',
      'catalog',
      'chat',
      'chatHistory',
      'choosePhoto',
      'diagnostic',
      'discardPending',
      'generate',
      'hatch',
      'onHatchProgress',
      'read',
      'recovery',
      'retryPending',
      'write'
    ])
    await pets.read(target)
    await pets.catalog(target)
    await pets.beginVisit(target)
    await pets.write(target, 4, pet)
    await pets.choosePhoto()
    await pets.generate({ target, operationId: '00000000-0000-4000-8000-232a373eb43a', prompt: 'a dog', count: 1 })
    await pets.hatch({
      target,
      operationId: '00000000-0000-4000-8000-232a373eb43a',
      token: 'drafts',
      index: 0,
      displayName: 'Daisy',
      description: 'A dog',
      quote: {
        kind: 'offer',
        id: '00000000-0000-4000-8000-232a373eb43a',
        version: 1,
        priceMicroProtons: 65_000_000_000
      }
    })
    await pets.adoptPending(target)
    await pets.recovery(target)
    await pets.retryPending(target)
    await pets.discardPending(target)
    await pets.cancel('00000000-0000-4000-8000-232a373eb43a')
    await pets.chat({
      ref: { kind: 'bundled', slug: 'gigi' },
      message_id: '00000000-0000-4000-8000-232a373eb43a',
      message: 'hello',
      locale: 'vi'
    })
    await pets.chatHistory({ kind: 'bundled', slug: 'gigi' })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'petChat',
      input: {
        ref: { kind: 'bundled', slug: 'gigi' },
        message_id: '00000000-0000-4000-8000-232a373eb43a',
        message: 'hello',
        locale: 'vi'
      }
    })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'petChatHistory',
      input: { ref: { kind: 'bundled', slug: 'gigi' } }
    })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petRead', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petCatalog', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petVisit', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petRecovery', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petRetryPending', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petDiscardPending', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petWrite', target, revision: 4, pet })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petPhoto' })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'petGenerate',
      input: { target, operationId: '00000000-0000-4000-8000-232a373eb43a', prompt: 'a dog', count: 1 }
    })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'petHatch',
      input: {
        target,
        operationId: '00000000-0000-4000-8000-232a373eb43a',
        token: 'drafts',
        index: 0,
        displayName: 'Daisy',
        description: 'A dog',
        quote: {
          kind: 'offer',
          id: '00000000-0000-4000-8000-232a373eb43a',
          version: 1,
          priceMicroProtons: 65_000_000_000
        }
      }
    })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', { kind: 'petAdoptPending', target })
    expect(electron.invoke).toHaveBeenCalledWith('matrix:ui', {
      kind: 'petCancel',
      operationId: '00000000-0000-4000-8000-232a373eb43a'
    })
  })
  it('sends a companion diagnostic as one closed value, and a refused send never reaches the page', async () => {
    const line = {
      event: 'start' as const,
      reason: 'remount' as const,
      restore: 'saved' as const,
      agent: 'agent-a',
      work: 'idle' as const,
      pose: 'idle' as const,
      surface: 'floor' as const,
      x: 3,
      window: 'focused' as const,
      repeats: 0
    }

    electron.invoke.mockClear()
    electron.invoke.mockRejectedValueOnce(new Error('matrix_ipc_denied'))
    expect(bridge().pets!.diagnostic!(line)).toBeUndefined()
    await Promise.resolve()
    expect(electron.invoke.mock.calls).toEqual([['matrix:ui', { kind: 'petDiagnostic', value: line }]])
  })
  it('sends the create sheet’s handle line fire-and-forget, and a refusal never reaches the sheet', async () => {
    const line = { source: 'typed' as const, check: 'taken' as const, outcome: 'claimed_other' as const }

    electron.invoke.mockClear()
    electron.invoke.mockRejectedValueOnce(new Error('matrix_ipc_denied'))
    expect(bridge().aliases!.diagnostic!(line)).toBeUndefined()
    await Promise.resolve()
    expect(electron.invoke.mock.calls).toEqual([['matrix:ui', { kind: 'aliasDiagnostic', value: line }]])
  })
  it('maps only native page view controls, never the scoped pages API', async () => {
    const pages = bridge().pages!
    const onState = vi.fn()
    const stop = pages.onState(onState)
    const stateHandler = electron.on.mock.calls.find(([name]) => name === MATRIX_PAGES_IPC.state)?.[1]

    stateHandler({}, { viewId: 'page-1', status: 'ready' })
    expect(onState).toHaveBeenCalledWith({ viewId: 'page-1', status: 'ready' })

    await pages.open({ page: 'scheduled', locale: 'en', appearance: 'light' })
    await pages.setBounds({ viewId: 'page-1', bounds: { x: 1, y: 2, width: 3, height: 4 } })
    await pages.setVisibility({ viewId: 'page-1', visible: true, overlayActive: false })
    await pages.focus('page-1')
    await pages.close('page-1')

    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_PAGES_IPC.open, {
      page: 'scheduled',
      locale: 'en',
      appearance: 'light'
    })
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_PAGES_IPC.bounds, {
      viewId: 'page-1',
      bounds: { x: 1, y: 2, width: 3, height: 4 }
    })
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_PAGES_IPC.visibility, {
      viewId: 'page-1',
      visible: true,
      overlayActive: false
    })
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_PAGES_IPC.focus, 'page-1')
    expect(electron.invoke).toHaveBeenCalledWith(MATRIX_PAGES_IPC.close, 'page-1')
    expect(Object.keys(pages).sort()).toEqual(['close', 'focus', 'onState', 'open', 'setBounds', 'setVisibility'])

    stop()
    expect(electron.removeListener).toHaveBeenCalledWith(MATRIX_PAGES_IPC.state, stateHandler)
  })

  it('exposes only the existing consumer-browser prepare/release and event operations', async () => {
    electron.invoke.mockClear()
    const consumerBrowser = bridge().consumerBrowser
    const popup = vi.fn()
    const notice = vi.fn()

    expect(consumerBrowser).toBeDefined()
    expect(Object.keys(consumerBrowser!).sort()).toEqual(['onNotice', 'onOpen', 'onPopup', 'prepare', 'release'])
    const stopPopup = consumerBrowser!.onPopup(popup)
    const stopNotice = consumerBrowser!.onNotice(notice)
    const popupHandler = electron.on.mock.calls.find(([name]) => name === CONSUMER_BROWSER_IPC.popup)?.[1]
    const noticeHandler = electron.on.mock.calls.find(([name]) => name === CONSUMER_BROWSER_IPC.state)?.[1]
    popupHandler({}, { sourceWebContentsId: 7, url: 'https://example.com/' })
    noticeHandler({}, { sourceWebContentsId: 7, type: 'navigation_blocked' })

    expect(popup).toHaveBeenCalledWith({ sourceWebContentsId: 7, url: 'https://example.com/' })
    expect(notice).toHaveBeenCalledWith({ sourceWebContentsId: 7, type: 'navigation_blocked' })

    await consumerBrowser!.prepare({ partition: 'atum-consumer-browser-tab-1', url: 'https://example.com/' })
    await consumerBrowser!.release('atum-consumer-browser-tab-1')
    expect(electron.invoke).toHaveBeenNthCalledWith(1, CONSUMER_BROWSER_IPC.prepare, {
      partition: 'atum-consumer-browser-tab-1',
      url: 'https://example.com/'
    })
    expect(electron.invoke).toHaveBeenNthCalledWith(2, CONSUMER_BROWSER_IPC.release, 'atum-consumer-browser-tab-1')

    stopPopup()
    stopNotice()
    expect(electron.removeListener).toHaveBeenCalledWith(CONSUMER_BROWSER_IPC.popup, popupHandler)
    expect(electron.removeListener).toHaveBeenCalledWith(CONSUMER_BROWSER_IPC.state, noticeHandler)
  })
})

describe('Matrix UI preload open-source licences', () => {
  it('asks main for the packaged notice with nothing but the window title', async () => {
    electron.invoke.mockClear()
    await bridge().openSourceNotices!('Open-source licences')
    expect(electron.invoke.mock.calls).toEqual([
      ['matrix:ui', { kind: 'openSourceNotices', title: 'Open-source licences' }]
    ])
  })
})

it('Drive import forwards only bare chooser intent and opaque plan IDs on the existing channel', async () => {
  electron.invoke.mockClear()
  const drive = bridge().drive!
  const planId = '00000000-0000-4000-8000-11e594f48195'
  await drive.importPlan!()
  await drive.importRun!(planId)
  await drive.importCancel!(planId)
  expect(electron.invoke.mock.calls).toEqual([
    ['matrix:drive:request', { kind: 'importPlan' }],
    ['matrix:drive:request', { kind: 'importRun', planId }],
    ['matrix:drive:request', { kind: 'importCancel', planId }]
  ])
})
