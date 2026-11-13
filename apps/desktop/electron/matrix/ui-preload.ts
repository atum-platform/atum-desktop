import { contextBridge, ipcRenderer } from 'electron'

import { exposeMatrixBrowserImport } from './browser-import-preload'
import { createMatrixCompanyDesktopBridge } from './company-desktop-preload'
import { exposeMatrixDesktopServices } from './desktop-services-preload'
import { exposeMatrixDeviceBridge } from './device/bridge-preload'
import { exposeMatrixKeepAwake } from './keep-awake-preload'
import { exposeMatrixLoginStartup } from './login-startup-preload'
import { createMatrixPetDisplayBridge } from './pet-display-preload'

exposeMatrixDesktopServices(true)
exposeMatrixKeepAwake()
exposeMatrixLoginStartup()
exposeMatrixBrowserImport()
exposeMatrixDeviceBridge()

import { APP_VIEW_IPC, type AppViewState } from '../../shared/app-view/ipc'
import { CONSUMER_BROWSER_IPC, type ConsumerBrowserNotice, type ConsumerBrowserPopup } from '../../shared/browser/ipc'
import {
  MATRIX_CHANNELS as channel,
  type MatrixCloudAgentRequest,
  type MatrixCommand,
  type MatrixSnapshot,
  type MatrixUiBridge
} from '../../shared/matrix'
import { MATRIX_AGENT_SOURCES_IPC } from '../../shared/matrix-agent-sources'
import { MATRIX_CLIPBOARD_IPC } from '../../shared/matrix-clipboard'
import type { MatrixCompanyDesktopRequest } from '../../shared/matrix-company-desktop'
import { MATRIX_DRIVE_IPC, type MatrixDriveView } from '../../shared/matrix-drive'
import { MATRIX_FOLDER_ACCESS_IPC } from '../../shared/matrix-folder-access'
import { MATRIX_GOOGLE_CONNECTION_IPC } from '../../shared/matrix-google-connections'
import { MATRIX_INVITE_LINK_IPC } from '../../shared/matrix-invite-link'
import { MATRIX_LINK_PREVIEW_IPC } from '../../shared/matrix-link-preview'
import { MATRIX_MAC_SOURCES_IPC } from '../../shared/matrix-mac-sources'
import { MATRIX_MESSAGE_LINK_IPC, type MatrixMessageLinkTarget } from '../../shared/matrix-message-link'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import { MATRIX_PAGES_IPC, type MatrixPagesState } from '../../shared/matrix-pages'
import { MATRIX_PERMISSIONS_IPC } from '../../shared/matrix-permissions'
import type {
  MatrixSubscriptionCatalog,
  MatrixSubscriptionKeyResult,
  MatrixSubscriptionPoll,
  MatrixSubscriptionSignIn,
  MatrixSubscriptionsStatus
} from '../../shared/matrix-subscriptions'
import { MATRIX_VOICE_IPC } from '../../shared/matrix-voice'
import { MATRIX_WINDOW_CHANNELS, type MatrixWindowFacts } from '../../shared/matrix-window'

const invoke = (kind: string) => ipcRenderer.invoke(channel.ui, { kind })

const bridge: MatrixUiBridge = {
  // Fire and forget: main validates the three closed fields before writing main.log.
  windowFailureDiagnostic: value => {
    void Promise.resolve(ipcRenderer.invoke(channel.ui, { kind: 'windowFailureDiagnostic', value })).catch(() => {})
  },
  awareness: {
    read: () => invoke('awarenessRead'),
    change: (identity, roomId, action) => ipcRenderer.invoke(channel.ui, {kind:'awarenessChange', identity, roomId, action})
  },
  ownerLocation: {
    read: () => invoke('ownerLocationRead'),
    setEnabled: enabled => ipcRenderer.invoke(channel.ui, { kind: 'ownerLocationSetEnabled', enabled })
  },
  drive: {
    read: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'read' }),
    search: (query, scope, requestId) => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'search', query, scope, requestId }),
    cancelSearch: requestId => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'cancelSearch', requestId }),
    connect: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'connect' }),
    chooseFolder: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'chooseFolder' }),
    cancelSignIn: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'cancelSignIn' }),
    disconnect: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'disconnect' }),
    enter: id => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'enter', id }),
    back: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'back' }),
    preview: id => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'preview', id }),
    closePreview: token => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'closePreview', token }),
    open: id => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'open', id }),
    reveal: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'reveal' }),
    taskStatus: roomId => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'taskStatus', roomId }),
    sendTask: input => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'sendTask', input }),
    importPlan: () => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'importPlan' }),
    importRun: planId => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'importRun', planId }),
    importCancel: planId => ipcRenderer.invoke(MATRIX_DRIVE_IPC.request, { kind: 'importCancel', planId }),
    subscribe: listener => {
      const receive = (_event: Electron.IpcRendererEvent, view: MatrixDriveView) => listener(view)
      ipcRenderer.on(MATRIX_DRIVE_IPC.changed, receive)

      return () => ipcRenderer.removeListener(MATRIX_DRIVE_IPC.changed, receive)
    }
  },
  companies: {
    pending: () => ipcRenderer.invoke(channel.ui, { kind: 'company-pending' }),
    request: companyRequest => ipcRenderer.invoke(channel.ui, { kind: 'company', companyRequest }),
    uploadAvatar: photo => ipcRenderer.invoke(channel.ui, { kind: 'company-avatar-upload', photo }),
    avatar: roomId => ipcRenderer.invoke(channel.ui, { kind: 'company-avatar-read', roomId }),
    search: companySearch => ipcRenderer.invoke(channel.ui, { kind: 'company-search', companySearch }),
    open: companySearchOpen => ipcRenderer.invoke(channel.ui, { kind: 'company-search-open', companySearchOpen }),
    native: (family, request) =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'company-native',
        companyNativeFamily: family,
        companyNativeRequest: request
      })
  },
  companyDesktop: createMatrixCompanyDesktopBridge(request =>
    ipcRenderer.invoke(channel.ui, { kind: 'company-desktop', companyDesktop: request as MatrixCompanyDesktopRequest })),
  googleConnections: {
    status: context => ipcRenderer.invoke(MATRIX_GOOGLE_CONNECTION_IPC, { kind: 'status', ...(context ? { context } : {}) }),
    connect: (grant, context) =>
      ipcRenderer.invoke(MATRIX_GOOGLE_CONNECTION_IPC, { kind: 'connect', grant, ...(context ? { context } : {}) }),
    disconnect: groupId => ipcRenderer.invoke(MATRIX_GOOGLE_CONNECTION_IPC, { kind: 'disconnect', groupId }),
    setSourcePreferences: preferences =>
      ipcRenderer.invoke(MATRIX_GOOGLE_CONNECTION_IPC, { kind: 'preferences', preferences })
  },
  aliases: {
    pending: () => ipcRenderer.invoke(channel.ui, { kind: 'alias-pending' }),
    request: aliasRequest => ipcRenderer.invoke(channel.ui, { kind: 'alias', aliasRequest }),
    // Fire and forget: main validates the closed line and writes it to main.log.
    diagnostic: line => {
      void Promise.resolve(ipcRenderer.invoke(channel.ui, { kind: 'aliasDiagnostic', value: line })).catch(() => {})
    }
  },
  people: {
    search: input => ipcRenderer.invoke(channel.ui, { kind: 'people-search', input }),
    privacy: () => ipcRenderer.invoke(channel.ui, { kind: 'people-privacy', input: {} }),
    setPrivacy: enabled => ipcRenderer.invoke(channel.ui, { kind: 'people-privacy', input: { enabled } })
  },
  founder: {
    contact: () => ipcRenderer.invoke(channel.ui, { kind: 'founder-contact' })
  },
  clipboard: {
    writeText: async text => {
      await ipcRenderer.invoke(MATRIX_CLIPBOARD_IPC.write, text)
    }
  },
  messageLinks: {
    takePending: () => ipcRenderer.invoke(MATRIX_MESSAGE_LINK_IPC.pending),
    subscribe: listener => {
      const receive = (_event: Electron.IpcRendererEvent, target: MatrixMessageLinkTarget) => {
        listener(target)
        // A live listener consumed the broker's retained copy. Clearing it prevents a later
        // renderer reload from reopening the same OS delivery.
        void Promise.resolve(ipcRenderer.invoke(MATRIX_MESSAGE_LINK_IPC.pending)).catch(() => {})
      }

      ipcRenderer.on(MATRIX_MESSAGE_LINK_IPC.opened, receive)

      return () => ipcRenderer.removeListener(MATRIX_MESSAGE_LINK_IPC.opened, receive)
    }
  },
  inviteLinks: {
    takePending: () => ipcRenderer.invoke(MATRIX_INVITE_LINK_IPC.pending),
    subscribe: listener => {
      const receive = (_event: Electron.IpcRendererEvent, token: string) => {
        listener(token)
        // A live listener owns the process-memory handoff now. Clear the broker's retained copy
        // without logging or persisting it.
        void Promise.resolve(ipcRenderer.invoke(MATRIX_INVITE_LINK_IPC.pending)).catch(() => {})
      }

      ipcRenderer.on(MATRIX_INVITE_LINK_IPC.opened, receive)

      return () => ipcRenderer.removeListener(MATRIX_INVITE_LINK_IPC.opened, receive)
    }
  },
  // The two account subscriptions: booleans, safe model names and one opaque sign-in handle.
  subscriptions: {
    status: () => ipcRenderer.invoke(channel.ui, { kind: 'subscriptionsStatus' }) as Promise<MatrixSubscriptionsStatus>,
    catalog: roomId =>
      ipcRenderer.invoke(channel.ui, { kind: 'subscriptionCatalog', roomId }) as Promise<MatrixSubscriptionCatalog>,
    startChatGpt: () =>
      ipcRenderer.invoke(channel.ui, { kind: 'subscriptionChatGptStart' }) as Promise<
        MatrixSubscriptionSignIn | { status: 'cancelled' }
      >,
    pollChatGpt: session =>
      ipcRenderer.invoke(channel.ui, { kind: 'subscriptionChatGptPoll', session }) as Promise<MatrixSubscriptionPoll>,
    cancelChatGpt: async session => {
      await ipcRenderer.invoke(channel.ui, { kind: 'subscriptionChatGptCancel', session })
    },
    disconnectChatGpt: async () => {
      await ipcRenderer.invoke(channel.ui, { kind: 'subscriptionChatGptDisconnect' })
    },
    connectOpenCode: value =>
      ipcRenderer.invoke(channel.ui, { kind: 'subscriptionOpenCodeSave', value }) as Promise<MatrixSubscriptionKeyResult>,
    disconnectOpenCode: async () => {
      await ipcRenderer.invoke(channel.ui, { kind: 'subscriptionOpenCodeDisconnect' })
    }
  },
  permissions: {
    status: () => ipcRenderer.invoke(MATRIX_PERMISSIONS_IPC.status),
    openSettings: permission => ipcRenderer.invoke(MATRIX_PERMISSIONS_IPC.settings, permission),
    relaunch: () => ipcRenderer.invoke(MATRIX_PERMISSIONS_IPC.relaunch),
    watch: listener => {
      let stopped = false

      const poll = () => {
        void ipcRenderer
          .invoke(MATRIX_PERMISSIONS_IPC.status)
          .then(snapshot => {
            if (!stopped) {
              listener(snapshot)
            }
          })
          .catch(() => {})
      }

      const timer = setInterval(poll, 1_500)
      poll()

      return () => {
        stopped = true
        clearInterval(timer)
      }
    }
  },
  macSources: {
    read: () => ipcRenderer.invoke(MATRIX_MAC_SOURCES_IPC.read),
    set: (source, enabled) => ipcRenderer.invoke(MATRIX_MAC_SOURCES_IPC.set, source, enabled)
  },
  agentSources: {
    read: () => ipcRenderer.invoke(MATRIX_AGENT_SOURCES_IPC.read),
    presented: () => ipcRenderer.invoke(MATRIX_AGENT_SOURCES_IPC.presented),
    set: (gate, enabled) => ipcRenderer.invoke(MATRIX_AGENT_SOURCES_IPC.set, gate, enabled),
    subscribe: listener => {
      const receive = () => listener()
      ipcRenderer.on(MATRIX_AGENT_SOURCES_IPC.changed, receive)

      return () => ipcRenderer.removeListener(MATRIX_AGENT_SOURCES_IPC.changed, receive)
    }
  },
  folderAccess: {
    read: () => ipcRenderer.invoke(MATRIX_FOLDER_ACCESS_IPC.read),
    apply: choices => ipcRenderer.invoke(MATRIX_FOLDER_ACCESS_IPC.apply, choices),
    add: () => ipcRenderer.invoke(MATRIX_FOLDER_ACCESS_IPC.add),
    remove: id => ipcRenderer.invoke(MATRIX_FOLDER_ACCESS_IPC.remove, id)
  },
  checkout: {
    refresh: () => invoke('checkoutRefresh'),
    start: packId => ipcRenderer.invoke(channel.ui, { kind: 'checkoutStart', packId }),
    status: () => invoke('checkoutStatus'),
    resume: () => invoke('checkoutResume'),
    openCheckout: () => invoke('checkoutOpen'),
    dismissTerminal: () => invoke('checkoutDismiss')
  },
  companyStore: {
    refresh: companyId => ipcRenderer.invoke(channel.ui, { kind: 'company-store', companyStoreRequest: { action: 'refresh', companyId } }),
    purchase: (companyId, input) => ipcRenderer.invoke(channel.ui, { kind: 'company-store', companyStoreRequest: { action: 'purchase', companyId, input } }),
    resume: (companyId, idempotencyKey) => ipcRenderer.invoke(channel.ui, { kind: 'company-store', companyStoreRequest: { action: 'resume', companyId, idempotencyKey } }),
    cancel: (companyId, entitlementId) => ipcRenderer.invoke(channel.ui, { kind: 'company-store', companyStoreRequest: { action: 'cancel', companyId, entitlementId } })
  },
  store: {
    refresh: () => invoke('storeRefresh'),
    purchase: input => ipcRenderer.invoke(channel.ui, { kind: 'storePurchase', input }),
    resume: idempotencyKey => ipcRenderer.invoke(channel.ui, { kind: 'storeResume', idempotencyKey }),
    cancel: entitlementId => ipcRenderer.invoke(channel.ui, { kind: 'storeCancel', entitlementId })
  },
  wallet: {
    refresh: () => invoke('walletRefresh'),
    history: before => ipcRenderer.invoke(channel.ui, { kind: 'walletHistory', before })
  },
  voice: {
    microphone: roomId => ipcRenderer.invoke(MATRIX_VOICE_IPC.microphone, roomId),
    settings: roomId => ipcRenderer.invoke(MATRIX_VOICE_IPC.request, { kind: 'settings', roomId }),
    transcribe: (roomId, dataUrl, mimeType) =>
      ipcRenderer.invoke(MATRIX_VOICE_IPC.request, { kind: 'transcribe', roomId, dataUrl, mimeType }),
    speak: (roomId, text) => ipcRenderer.invoke(MATRIX_VOICE_IPC.request, { kind: 'speak', roomId, text })
  },
  profiles: {
    read: target => ipcRenderer.invoke('matrix:profiles:read', target),
    open: target => ipcRenderer.invoke('matrix:profiles:open', target),
    change: (scope, change) => ipcRenderer.invoke('matrix:profiles:change', scope, change),
    close: scope => ipcRenderer.invoke('matrix:profiles:close', scope),
    member: userId => ipcRenderer.invoke('matrix:profiles:member', userId)
  },
  linkPreviews: {
    read: (roomId, eventId) => ipcRenderer.invoke(MATRIX_LINK_PREVIEW_IPC.read, roomId, eventId)
  },
  assistants: {
    read: principal => ipcRenderer.invoke('matrix:assistants:read', principal),
    save: change => ipcRenderer.invoke('matrix:assistants:save', change),
    avatar: change => ipcRenderer.invoke('matrix:assistants:avatar', change)
  },
  routines: {
    read: principal => ipcRenderer.invoke('matrix:routines:read', principal),
    create: input => ipcRenderer.invoke('matrix:routines:create', input),
    update: input => ipcRenderer.invoke('matrix:routines:update', input),
    run: input => ipcRenderer.invoke('matrix:routines:run', input),
    delete: input => ipcRenderer.invoke('matrix:routines:delete', input),
    runs: (principal, routineId) => ipcRenderer.invoke('matrix:routines:runs', principal, routineId),
    ownerZone: () => ipcRenderer.invoke('matrix:routines:owner-zone')
  },
  backgroundSweep: {
    read: agentPrincipal =>
      ipcRenderer.invoke(channel.ui, { kind: 'backgroundSweep', action: 'read', agentPrincipal }),
    save: (agentPrincipal, write) =>
      ipcRenderer.invoke(channel.ui, { kind: 'backgroundSweep', action: 'save', agentPrincipal, write })
  },
  nativeApps: {
    list: refresh => ipcRenderer.invoke(MATRIX_NATIVE_APPS.list, refresh),
    launch: request => ipcRenderer.invoke(MATRIX_NATIVE_APPS.launch, request),
    end: id => ipcRenderer.invoke(MATRIX_NATIVE_APPS.end, id),
    openArrangementSettings: () => ipcRenderer.invoke(MATRIX_NATIVE_APPS.settings),
    readiness: (roomId, refresh) => ipcRenderer.invoke(MATRIX_NATIVE_APPS.readiness, roomId, refresh),
    onEnded: listener => {
      const receive = (_event: Electron.IpcRendererEvent, id: string) => listener(id)
      ipcRenderer.on(MATRIX_NATIVE_APPS.ended, receive)

      return () => ipcRenderer.removeListener(MATRIX_NATIVE_APPS.ended, receive)
    }
  },
  petDisplay: createMatrixPetDisplayBridge(),
  pets: {
    read: target => ipcRenderer.invoke(channel.ui, { kind: 'petRead', target }),
    write: (target, revision, pet) => ipcRenderer.invoke(channel.ui, { kind: 'petWrite', target, revision, pet }),
    catalog: target => ipcRenderer.invoke(channel.ui, { kind: 'petCatalog', target }),
    beginVisit: target => ipcRenderer.invoke(channel.ui, { kind: 'petVisit', target }),
    choosePhoto: () => ipcRenderer.invoke(channel.ui, { kind: 'petPhoto' }),
    generate: input => ipcRenderer.invoke(channel.ui, { kind: 'petGenerate', input }),
    hatch: input => ipcRenderer.invoke(channel.ui, { kind: 'petHatch', input }),
    adoptPending: target => ipcRenderer.invoke(channel.ui, { kind: 'petAdoptPending', target }),
    recovery: target => ipcRenderer.invoke(channel.ui, { kind: 'petRecovery', target }),
    retryPending: target => ipcRenderer.invoke(channel.ui, { kind: 'petRetryPending', target }),
    discardPending: target => ipcRenderer.invoke(channel.ui, { kind: 'petDiscardPending', target }),
    cancel: operationId => ipcRenderer.invoke(channel.ui, { kind: 'petCancel', operationId }),
    chat: input => ipcRenderer.invoke(channel.ui, { kind: 'petChat', input }),
    chatHistory: ref => ipcRenderer.invoke(channel.ui, { kind: 'petChatHistory', input: { ref } }),
    onHatchProgress: listener => {
      const receive = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress as never)
      ipcRenderer.on('matrix:pet:hatch-progress', receive)

      return () => ipcRenderer.removeListener('matrix:pet:hatch-progress', receive)
    },
    // Fire and forget: main validates the closed line and writes it to main.log.
    diagnostic: line => {
      void Promise.resolve(ipcRenderer.invoke(channel.ui, { kind: 'petDiagnostic', value: line })).catch(() => {})
    }
  },
  pages: {
    open: input => ipcRenderer.invoke(MATRIX_PAGES_IPC.open, input),
    setBounds: input => ipcRenderer.invoke(MATRIX_PAGES_IPC.bounds, input),
    setVisibility: input => ipcRenderer.invoke(MATRIX_PAGES_IPC.visibility, input),
    focus: viewId => ipcRenderer.invoke(MATRIX_PAGES_IPC.focus, viewId),
    close: viewId => ipcRenderer.invoke(MATRIX_PAGES_IPC.close, viewId),
    onState: listener => {
      const receive = (_event: Electron.IpcRendererEvent, state: MatrixPagesState) => listener(state)
      ipcRenderer.on(MATRIX_PAGES_IPC.state, receive)

      return () => {
        ipcRenderer.removeListener(MATRIX_PAGES_IPC.state, receive)
      }
    }
  },
  apps: {
    onReturn: listener => {
      ipcRenderer.on('matrix:apps:return', listener)

      return () => {
        ipcRenderer.removeListener('matrix:apps:return', listener)
      }
    },
    refresh: () => invoke('appsRefresh'),
    menu: appId => ipcRenderer.invoke(channel.ui, { kind: 'appMenu', appId }),
    history: (appId, cursor) => ipcRenderer.invoke(channel.ui, { kind: 'appHistory', appId, cursor: cursor ?? null }),
    connection: (appId, action, options) =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'appConnection',
        appId,
        action,
        ...(options?.autoConfirm === true ? { autoConfirm: true } : {})
      }),
    chat: (appId, locale) => ipcRenderer.invoke(channel.ui, { kind: 'appChat', appId, locale }),
    group: (appId, name, locale) => ipcRenderer.invoke(channel.ui, { kind: 'appGroup', appId, name, locale }),
    botInvite: (appId, roomId) => ipcRenderer.invoke(channel.ui, { kind: 'appBotInvite', appId, roomId }),
    withdraw: appId => ipcRenderer.invoke(channel.ui, { kind: 'appWithdraw', appId }),
    botStatus: appId => ipcRenderer.invoke(channel.ui, { kind: 'appBotStatus', appId }),
    botConsent: (appId, disclosureVersion, locale) => ipcRenderer.invoke(channel.ui, { kind: 'appBotConsent', appId, disclosureVersion, locale }),
    botRevoke: appId => ipcRenderer.invoke(channel.ui, { kind: 'appBotRevoke', appId }),
    botOutcome: (appId, roomId, eventId) => ipcRenderer.invoke(channel.ui, { kind: 'appBotOutcome', appId, roomId, eventId }),
    botApiMedia: input => ipcRenderer.invoke(channel.ui, { kind: 'appBotMedia', ...input }),
    botIntakeStatus: appId => ipcRenderer.invoke(channel.ui, { kind: 'appBotIntakeStatus', appId }),
    botIntakeSubmit: (appId, values) => ipcRenderer.invoke(channel.ui, { kind: 'appBotIntakeSubmit', appId, values }),
    send: (appId, roomId, body, locale, replyTo, quote) =>
      ipcRenderer.invoke(channel.ui, { kind: 'appSend', appId, roomId, body, locale, replyTo, quote }),
    invoke: (appId, roomId, eventId) => ipcRenderer.invoke(channel.ui, { kind: 'appInvoke', appId, roomId, eventId }),
    view: {
      open: input => ipcRenderer.invoke(APP_VIEW_IPC.open, input),
      setBounds: input => ipcRenderer.invoke(APP_VIEW_IPC.bounds, input),
      setVisibility: input => ipcRenderer.invoke(APP_VIEW_IPC.visibility, input),
      focus: id => ipcRenderer.invoke(APP_VIEW_IPC.focus, id),
      back: id => ipcRenderer.invoke(APP_VIEW_IPC.back, id),
    external: id => ipcRenderer.invoke(APP_VIEW_IPC.external, id),
    reload: id => ipcRenderer.invoke(APP_VIEW_IPC.reload, id),
      close: id => ipcRenderer.invoke(APP_VIEW_IPC.close, id),
      onState: listener => {
        const receive = (_event: Electron.IpcRendererEvent, state: AppViewState) => listener(state)
        ipcRenderer.on(APP_VIEW_IPC.state, receive)

        return () => {
          ipcRenderer.removeListener(APP_VIEW_IPC.state, receive)
        }
      }
    }
  },
  consumerBrowser: {
    onPopup: listener => {
      const receive = (_event: Electron.IpcRendererEvent, payload: ConsumerBrowserPopup) => listener(payload)
      ipcRenderer.on(CONSUMER_BROWSER_IPC.popup, receive)

      return () => {
        ipcRenderer.removeListener(CONSUMER_BROWSER_IPC.popup, receive)
      }
    },
    onNotice: listener => {
      const receive = (_event: Electron.IpcRendererEvent, payload: ConsumerBrowserNotice) => listener(payload)
      ipcRenderer.on(CONSUMER_BROWSER_IPC.state, receive)

      return () => {
        ipcRenderer.removeListener(CONSUMER_BROWSER_IPC.state, receive)
      }
    },
    prepare: input => ipcRenderer.invoke(CONSUMER_BROWSER_IPC.prepare, input),
    release: partition => ipcRenderer.invoke(CONSUMER_BROWSER_IPC.release, partition)
  },
  windowFacts: () => ipcRenderer.invoke(MATRIX_WINDOW_CHANNELS.facts),
  onDocumentClose: prepare => {
    const receive = (_event: Electron.IpcRendererEvent, id: unknown) => {
      if (typeof id !== 'string') {
        return
      }

      void Promise.resolve()
        .then(prepare)
        .then(
          () => ipcRenderer.send(MATRIX_WINDOW_CHANNELS.documentCloseReady, id, true),
          () => ipcRenderer.send(MATRIX_WINDOW_CHANNELS.documentCloseReady, id, false)
        )
    }

    ipcRenderer.on(MATRIX_WINDOW_CHANNELS.prepareDocumentClose, receive)

    return () => ipcRenderer.removeListener(MATRIX_WINDOW_CHANNELS.prepareDocumentClose, receive)
  },
  setWindowAppearance: appearance => ipcRenderer.invoke(MATRIX_WINDOW_CHANNELS.setAppearance, appearance),
  setWindowMode: async mode => {
    const result = await ipcRenderer.invoke(MATRIX_WINDOW_CHANNELS.setMode, mode)

    if (!result?.ok) {
      throw new Error('matrix_window_mode_unavailable')
    }
  },
  subscribeWindow: listener => {
    const receive = (_event: Electron.IpcRendererEvent, facts: MatrixWindowFacts) => listener(facts)
    ipcRenderer.on(MATRIX_WINDOW_CHANNELS.factsChanged, receive)

    return () => {
      ipcRenderer.removeListener(MATRIX_WINDOW_CHANNELS.factsChanged, receive)
    }
  },
  terminals: {
    open: (roomId, id) => ipcRenderer.invoke(channel.ui, { kind: 'terminalOpen', roomId, id }),
    close: (roomId, id) => ipcRenderer.invoke(channel.ui, { kind: 'terminalClose', roomId, id }),
    read: (roomId, id) => ipcRenderer.invoke(channel.ui, { kind: 'terminalRead', roomId, id }),
    respond: (roomId, id, result) => ipcRenderer.invoke(channel.ui, { kind: 'terminalRespond', roomId, id, result }),
    subscribe: listener => {
      const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
      ipcRenderer.on(channel.terminal, receive)

      return () => ipcRenderer.removeListener(channel.terminal, receive)
    }
  },
  snapshot: () => invoke('snapshot'),
  signIn: method => ipcRenderer.invoke(channel.ui, { kind: 'signIn', method }),
  repairOwnerDevice: method => ipcRenderer.invoke(channel.ui, { kind: 'repairOwnerDevice', method }),
  cancelOwnerDeviceRepair: () => ipcRenderer.invoke(channel.ui, { kind: 'cancelOwnerDeviceRepair' }),
  cancelSignIn: () => invoke('cancelSignIn'),
  signOut: options => ipcRenderer.invoke(channel.ui, { kind: 'signOut', forgetKey: options?.forgetKey === true }),
  retry: () => invoke('retry'),
  endDeviceSession: deviceId => ipcRenderer.invoke(channel.ui, { kind: 'endDeviceSession', deviceId }),
  dismissNewSignIn: deviceId => ipcRenderer.invoke(channel.ui, { kind: 'newSignInDismiss', deviceId }),
  document: (roomId, action) => ipcRenderer.invoke(channel.ui, { kind: 'document', roomId, action }),
  arrangeWord: (roomId, show) => ipcRenderer.invoke(channel.ui, { kind: 'arrangeWord', roomId, show }),
  previewDocument: roomId => ipcRenderer.invoke(channel.ui, { kind: 'previewDocument', roomId }),
  closeDocumentPreview: token => ipcRenderer.invoke(channel.ui, { kind: 'closeDocumentPreview', token }),
  textDocument: {
    read: token => ipcRenderer.invoke(channel.ui, { kind: 'textDocument', action: 'read', token }),
    write: (token, input) => ipcRenderer.invoke(channel.ui, { kind: 'textDocument', action: 'write', token, input }),
    recoveryRead: token => ipcRenderer.invoke(channel.ui, { kind: 'textDocument', action: 'recoveryRead', token }),
    recoveryWrite: (token, input) =>
      ipcRenderer.invoke(channel.ui, { kind: 'textDocument', action: 'recoveryWrite', token, input }),
    recoveryDiscard: (token, draftRevision) =>
      ipcRenderer.invoke(channel.ui, { kind: 'textDocument', action: 'recoveryDiscard', token, draftRevision })
  },
  pdf: {
    show: (token, bounds) => ipcRenderer.invoke(channel.ui, { kind: 'pdfShow', token, bounds }),
    hide: token => ipcRenderer.invoke(channel.ui, { kind: 'pdfHide', token }),
    close: token => ipcRenderer.invoke(channel.ui, { kind: 'pdfClose', token })
  },
  readDomain: () => invoke('readDomain'),
  cancelDomain: () => invoke('cancelDomain'),
  enrollment: () => invoke('enrollment'),
  enrollHermes: () => invoke('enrollHermes'),
  setupAssistant: () => invoke('setupAssistant'),
  revokeHermes: () => invoke('revokeHermes'),
  connectHermes: roomId => ipcRenderer.invoke(channel.ui, { kind: 'connectHermes', roomId }),
  listenHermes: (roomId, locale) => ipcRenderer.invoke(channel.ui, { kind: 'listenHermes', roomId, locale }),
  setContinuousListening: (roomId, enabled, locale) =>
    ipcRenderer.invoke(channel.ui, { kind: 'setContinuousListening', roomId, enabled, locale }),
  stopListeningHermes: roomId => ipcRenderer.invoke(channel.ui, { kind: 'stopListeningHermes', roomId }),
  invokeHermes: (roomId, eventId, locale) =>
    ipcRenderer.invoke(channel.ui, { kind: 'invokeHermes', roomId, eventId, locale }),
  sendAssistant: (roomId, body, locale) =>
    ipcRenderer.invoke(channel.ui, { kind: 'sendAssistant', roomId, body, locale }),
  recoverHermes: (roomId, eventId) => ipcRenderer.invoke(channel.ui, { kind: 'recoverHermes', roomId, eventId }),
  sendTurn: (roomId, body, reply) =>
    ipcRenderer.invoke(channel.ui, { kind: 'sendTurn', roomId, body, ...(reply ? { reply } : {}) }),
  retryTurn: turnId => ipcRenderer.invoke(channel.ui, { kind: 'retryTurn', turnId }),
  answerTurnHere: (turnId, always) =>
    ipcRenderer.invoke(channel.ui, { kind: 'answerTurnHere', turnId, always: always === true }),
  // S1: this Mac's device service and moving an agent to the cloud (main asks the owner natively).
  cloudAgent: (request: MatrixCloudAgentRequest) =>
    ipcRenderer.invoke(channel.ui, {
      kind: 'cloudAgent',
      action: request.action,
      ...(request.action === 'serviceStatus'
        ? { principal: request.principal }
        : {}),
      ...(request.action === 'stopTurn' ? { roomId: request.roomId, eventId: request.eventId } : {}),
      ...(request.action === 'trialAccept'
        ? { offerVersion: request.offerVersion, disclosureVersion: request.disclosureVersion }
        : {})
    }),
  modelDestinations: {
    read: agentPrincipal => ipcRenderer.invoke(channel.ui, { kind: 'modelDestinations', action: 'read', agentPrincipal }),
    write: (agentPrincipal, destination, model) =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'modelDestinations',
        action: 'write',
        agentPrincipal,
        destination,
        model
      }),
    writeSubscription: (agentPrincipal, source, model, effort) =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'modelDestinations',
        action: 'writeSubscription',
        agentPrincipal,
        source,
        model,
        effort
      }),
    cap: (agentPrincipal, dailyProtons) =>
      ipcRenderer.invoke(channel.ui, { kind: 'modelDestinations', action: 'cap', agentPrincipal, dailyProtons })
  },
  retryReadiness: () => ipcRenderer.invoke(channel.ui, { kind: 'retryReadiness' }),
  reconnectAgent: principal => ipcRenderer.invoke(channel.ui, { kind: 'reconnectAgent', principal }),
  openStorageSettings: () => ipcRenderer.invoke(channel.ui, { kind: 'openStorageSettings' }),
  icloudKeychain: enabled => ipcRenderer.invoke(channel.ui, { kind: 'icloudKeychain', enabled: enabled === true }),
  approval: {
    accept: () => invoke('approvalAccept'),
    pick: index => ipcRenderer.invoke(channel.ui, { kind: 'approvalPick', index }),
    decline: () => invoke('approvalDecline'),
    signOutDevice: () => invoke('approvalSignOut'),
    dismiss: () => invoke('approvalDismiss'),
    confirm: () => invoke('approvalConfirm'),
    retry: () => invoke('approvalRetry')
  },
  firstRun: {
    start: input =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'firstRunStart',
        locale: input.locale,
        ending: input.ending,
        ...(input.roomId ? { roomId: input.roomId } : {})
      }),
    allow: input =>
      ipcRenderer.invoke(channel.ui, {
        kind: 'firstRunAllow',
        locale: input.locale,
        ...(input.roomId ? { roomId: input.roomId } : {})
      }),
    decline: () => invoke('firstRunDecline'),
    finish: () => invoke('firstRunFinish')
  },
  recoveryKey: {
    reveal: () => invoke('recoveryReveal'),
    written: () => invoke('recoveryWritten')
  },
  openTopUp: () => ipcRenderer.invoke(channel.ui, { kind: 'openTopUp' }),
  cancelHermes: roomId => ipcRenderer.invoke(channel.ui, { kind: 'cancelHermes', roomId }),
  createAgent: (name, persona, hireConfirmed) => ipcRenderer.invoke(channel.ui, { kind: 'createAgent', name, persona, hireConfirmed }),
  importAgent: (name, hireConfirmed) => ipcRenderer.invoke(channel.ui, { kind: 'importAgent', name, hireConfirmed }),
  retireAgent: principal => ipcRenderer.invoke(channel.ui, { kind: 'retireAgent', principal }),
  renewAgent: assistantId => ipcRenderer.invoke(channel.ui, { kind: 'renewAgent', assistantId }),
  respondHermes: response => ipcRenderer.invoke(channel.ui, { kind: 'respondHermes', response }),
  configureHermes: model => ipcRenderer.invoke(channel.ui, { kind: 'configureHermes', model }),
  useAtumModel: () => ipcRenderer.invoke(channel.ui, { kind: 'useAtumModel' }),
  modelCatalog: roomId => ipcRenderer.invoke(channel.ui, { kind: 'modelCatalog', roomId }),
  selectModelRoute: (roomId, routeId, target) =>
    ipcRenderer.invoke(channel.ui, { kind: 'selectModelRoute', roomId, routeId, target }),
  command: (command: MatrixCommand) => ipcRenderer.invoke(channel.ui, { kind: 'command', command }),
  attend: roomId => ipcRenderer.invoke(channel.ui, { kind: 'command', command: { kind: 'attend', roomId } }),
  typing: (roomId, typing) =>
    ipcRenderer.invoke(channel.ui, { kind: 'command', command: { kind: 'typing', roomId, typing } }),
  openLink: url => ipcRenderer.invoke(channel.ui, { kind: 'openLink', url }),
  openSourceNotices: title => ipcRenderer.invoke(channel.ui, { kind: 'openSourceNotices', title }),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: MatrixSnapshot) => listener(snapshot)
    ipcRenderer.on(channel.snapshot, receive)

    return () => {
      ipcRenderer.removeListener(channel.snapshot, receive)
    }
  }
}

contextBridge.exposeInMainWorld('atumMatrix', bridge)
