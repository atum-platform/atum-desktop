import { contextBridge, ipcRenderer, webUtils } from 'electron'

import { APP_VIEW_IPC } from '../shared/app-view/ipc'
import type { AdvisorySearchInvocation } from '../shared/atum-advisory-search'
import { OBSERVABILITY_IPC } from '../shared/atum-observability'
import { ATUM_SHARED_GROUP_PERSONA_IPC } from '../shared/atum-shared-group'
import { UTILITY_IPC } from '../shared/atum-utilities'
import { CONSUMER_BROWSER_IPC } from '../shared/browser/ipc'
import { NATIVE_APPS_CHANNELS } from '../shared/skills-launcher'
import { WORD_COMPANION_CHANNELS } from '../shared/word-companion'

import {
  ATUM_UPDATE_BUSY_CHANNEL,
  ATUM_UPDATE_CHECK_CHANNEL,
  ATUM_UPDATE_DOWNLOADED_CHANNEL,
  ATUM_UPDATE_RELAUNCH_CHANNEL,
  ATUM_UPDATE_STATE_CHANNEL,
  ATUM_UPDATE_STATUS_CHANNEL,
  isAtumDownloadedUpdate
} from './desktop-updater'

const managedFilesystemAuthority = process.argv.includes('--atum-managed-filesystem-authority')

contextBridge.exposeInMainWorld('hermesDesktop', {
  utilities: {
    status: () => ipcRenderer.invoke(UTILITY_IPC.status),
    connect: input => ipcRenderer.invoke(UTILITY_IPC.connect, input),
    disconnect: kind => ipcRenderer.invoke(UTILITY_IPC.disconnect, kind),
    cancel: () => ipcRenderer.invoke(UTILITY_IPC.cancel),
    setEnabled: preferences => ipcRenderer.invoke(UTILITY_IPC.setEnabled, preferences)
  },
  reporting: {
    status: () => ipcRenderer.invoke(OBSERVABILITY_IPC.status),
    setEnabled: enabled => ipcRenderer.invoke(OBSERVABILITY_IPC.enabled, enabled),
    capture: event => ipcRenderer.send(OBSERVABILITY_IPC.event, event),
    error: error => ipcRenderer.send(OBSERVABILITY_IPC.error, error),
    turn: observation => ipcRenderer.send(OBSERVABILITY_IPC.turn, observation),
    feedback: message => ipcRenderer.invoke(OBSERVABILITY_IPC.feedback, message),
    onChanged: callback => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on(OBSERVABILITY_IPC.changed, listener)

      return () => ipcRenderer.removeListener(OBSERVABILITY_IPC.changed, listener)
    }
  },
  // Main assigns this before any renderer store hydrates. Peer instance windows
  // have no URL flag, so location.search cannot establish queue ownership.
  actionPanelOwner: process.argv.includes('--atum-action-panel-owner'),
  // App views (slice 3): the renderer opens from {app, route_id}, receives an
  // opaque view id, and afterwards reports only geometry and visibility. No
  // URL, origin, or path crosses this bridge in either direction.
  appView: {
    open: input => ipcRenderer.invoke(APP_VIEW_IPC.open, input),
    setBounds: input => ipcRenderer.invoke(APP_VIEW_IPC.bounds, input),
    setVisibility: input => ipcRenderer.invoke(APP_VIEW_IPC.visibility, input),
    focus: viewId => ipcRenderer.invoke(APP_VIEW_IPC.focus, viewId),
    back: viewId => ipcRenderer.invoke(APP_VIEW_IPC.back, viewId),
    external: viewId => ipcRenderer.invoke(APP_VIEW_IPC.external, viewId),
    reload: viewId => ipcRenderer.invoke(APP_VIEW_IPC.reload, viewId),
    close: viewId => ipcRenderer.invoke(APP_VIEW_IPC.close, viewId),
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(APP_VIEW_IPC.state, listener)

      return () => ipcRenderer.removeListener(APP_VIEW_IPC.state, listener)
    }
  },
  consumerBrowser: {
    prepare: input => ipcRenderer.invoke(CONSUMER_BROWSER_IPC.prepare, input),
    release: partition => ipcRenderer.invoke(CONSUMER_BROWSER_IPC.release, partition),
    onPopup: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(CONSUMER_BROWSER_IPC.popup, listener)

      return () => ipcRenderer.removeListener(CONSUMER_BROWSER_IPC.popup, listener)
    },
    onNotice: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(CONSUMER_BROWSER_IPC.state, listener)

      return () => ipcRenderer.removeListener(CONSUMER_BROWSER_IPC.state, listener)
    }
  },
  getConnection: profile => ipcRenderer.invoke('hermes:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('hermes:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('hermes:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('hermes:window:openInstance'),
  claimAmbientCue: key => ipcRenderer.invoke('hermes:ambient:claim', key),
  setLocale: locale => ipcRenderer.invoke('atum:locale:set', locale),
  // Panel-local behind-window blur for the floating-glass material. macOS
  // only: the renderer feature-detects this and keeps its CSS-only material
  // on every other platform.
  atumVibrancy:
    process.platform === 'darwin'
      ? {
          setRegions: payload => ipcRenderer.invoke('atum:vibrancy:set-regions', payload)
        }
      : null,
  // Reversible primary-window geometry for the Atum sign-in gate: 'auth'
  // resizes/centres the window to a compact credential surface, 'normal'
  // restores the exact prior bounds/maximized state. Never persisted as the
  // user's window size. Rejected for any window but the primary.
  atumWindow: {
    setMode: mode => ipcRenderer.invoke('atum:window:set-mode', { mode })
  },
  filesystemCapability: {
    // This renderer has the opaque Atum filesystem boundary installed. Legacy
    // raw-path runtime plugin discovery must not probe its denied IPC channels.
    managedAuthority: managedFilesystemAuthority,
    adoptAssistantTextFile: fileRef => ipcRenderer.invoke('atum:filesystem:assistant-lease-adopt', fileRef),
    dismissAssistantTextFile: fileRef => ipcRenderer.invoke('atum:filesystem:assistant-lease-dismiss', fileRef),
    onAssistantTextResult: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('atum:filesystem:assistant-text-result', listener)

      return () => ipcRenderer.removeListener('atum:filesystem:assistant-text-result', listener)
    },
    selectReadRoot: () => ipcRenderer.invoke('atum:filesystem:select-read-root'),
    readText: (intentId, relativePath) => ipcRenderer.invoke('atum:filesystem:read-intent', intentId, relativePath),
    openTextFile: () => ipcRenderer.invoke('atum:filesystem:select-text-file'),
    createWorkspaceDocument: input => ipcRenderer.invoke('atum:filesystem:lease-create-document', input),
    importWordDocument: () => ipcRenderer.invoke('atum:filesystem:import-docx'),
    openWorkspaceTextFile: relativePath => ipcRenderer.invoke('atum:filesystem:lease-open-workspace', relativePath),
    exportDocument: input => ipcRenderer.invoke('atum:filesystem:export-document', input),
    documentTheme: input => ipcRenderer.invoke('atum:filesystem:document-theme', input),
    documentThemeSet: input => ipcRenderer.invoke('atum:filesystem:document-theme-set', input),
    revealExport: exportRef => ipcRenderer.invoke('atum:filesystem:reveal-export', exportRef),
    shareExport: exportRef => ipcRenderer.invoke('atum:filesystem:share-export', exportRef),
    readTextFile: fileRef => ipcRenderer.invoke('atum:filesystem:lease-read', fileRef),
    writeTextFile: (fileRef, input) => ipcRenderer.invoke('atum:filesystem:lease-write', fileRef, input),
    preserveTextFileSibling: (fileRef, input) =>
      ipcRenderer.invoke('atum:filesystem:lease-preserve-sibling', fileRef, input),
    ...(managedFilesystemAuthority
      ? {
          recovery: {
            version: 1 as const,
            read: fileRef => ipcRenderer.invoke('atum:filesystem:lease-recovery-read', fileRef),
            write: (fileRef, input) => ipcRenderer.invoke('atum:filesystem:lease-recovery-write', fileRef, input),
            discard: (fileRef, expectedDraftRevision) =>
              ipcRenderer.invoke('atum:filesystem:lease-recovery-discard', fileRef, expectedDraftRevision)
          }
        }
      : {}),
    watchTextFile: (fileRef, callback) => {
      const subscriptionId = globalThis.crypto.randomUUID()

      const listener = (_event, payload) => {
        if (payload?.subscriptionId === subscriptionId) {
          callback(payload.revision)
        }
      }

      ipcRenderer.on('atum:filesystem:lease-revision', listener)
      void ipcRenderer.invoke('atum:filesystem:lease-watch', fileRef, subscriptionId)

      return () => {
        ipcRenderer.removeListener('atum:filesystem:lease-revision', listener)
        void ipcRenderer.invoke('atum:filesystem:lease-unwatch', subscriptionId)
      }
    },
    releaseTextFile: fileRef => ipcRenderer.invoke('atum:filesystem:lease-release', fileRef)
  },
  // One overlay window per assistant, addressed by pet id (the assistant's
  // identityId). Calls that omit an id address the shared default, which is what
  // the single-pet renderer does until per-agent binding lands.
  //
  // Only the main-renderer → main calls carry an id. The overlay's own calls
  // (setBounds / setIgnoreMouse / setFocusable / control) deliberately do not:
  // main resolves those from the sending window, so an overlay cannot address
  // another pet's window or speak into another assistant's thread.
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ petId, bounds, screen }`; resolves with the screen bounds it actually
    // used, which may differ from the request when the cascade nudged the
    // window clear of another pet.
    open: request => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: petId => ipcRenderer.invoke('hermes:pet-overlay:close', { petId }),
    // Walkable desktop geometry for an overlay that wanders the screen.
    surfaces: request => ipcRenderer.invoke('hermes:pet-overlay:surfaces', request),
    setBounds: bounds => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable),
    // Main renderer → one overlay (forwarded by main): push the latest pet
    // state. `payload.petId` selects the window.
    pushState: payload => ipcRenderer.send('hermes:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer
    // submit. Main stamps the sender's pet id onto the payload.
    control: payload => ipcRenderer.send('hermes:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:control', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('hermes:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('hermes:connection-config:test', payload),
  sshConfigHosts: () => ipcRenderer.invoke('hermes:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('hermes:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('hermes:connection-config:oauth-logout', remoteUrl),
  // Hermes Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('hermes:cloud:status'),
    login: () => ipcRenderer.invoke('hermes:cloud:login'),
    logout: () => ipcRenderer.invoke('hermes:cloud:logout'),
    discover: org => ipcRenderer.invoke('hermes:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('hermes:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    set: name => ipcRenderer.invoke('hermes:profile:set', name)
  },
  product: {
    // Atum's pinned default model, or null when this build carries no pin.
    defaultModel: () => ipcRenderer.invoke('atum:product:default-model')
  },
  appUpdate: {
    setBusy: busy => ipcRenderer.send(ATUM_UPDATE_BUSY_CHANNEL, busy),
    onState: callback => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on(ATUM_UPDATE_STATE_CHANNEL, listener)

      return () => ipcRenderer.removeListener(ATUM_UPDATE_STATE_CHANNEL, listener)
    },
    onDownloaded: callback => {
      const listener = (_event, payload) => {
        if (isAtumDownloadedUpdate(payload)) {
          callback(payload)
        }
      }

      ipcRenderer.on(ATUM_UPDATE_DOWNLOADED_CHANNEL, listener)

      return () => ipcRenderer.removeListener(ATUM_UPDATE_DOWNLOADED_CHANNEL, listener)
    },
    relaunch: () => ipcRenderer.invoke(ATUM_UPDATE_RELAUNCH_CHANNEL),
    status: () => ipcRenderer.invoke(ATUM_UPDATE_STATUS_CHANNEL),
    check: () => ipcRenderer.invoke(ATUM_UPDATE_CHECK_CHANNEL)
  },
  account: {
    status: () => ipcRenderer.invoke('atum:account:status'),
    retryRestore: () => ipcRenderer.invoke('atum:account:retry-restore'),
    signIn: () => ipcRenderer.invoke('atum:account:sign-in'),
    signInWithPassword: input => ipcRenderer.invoke('atum:account:sign-in-password', input),
    cancel: () => ipcRenderer.invoke('atum:account:cancel'),
    signOut: () => ipcRenderer.invoke('atum:account:sign-out')
  },
  managedModel: {
    access: accessAlias => ipcRenderer.invoke('atum:managed-model:access', accessAlias),
    usage: limit => ipcRenderer.invoke('atum:managed-model:usage', limit)
  },
  // Per-app surfaces. Deliberately narrow: an app id in, a parsed result out.
  // `connect.start` returns only `{ opened: true }` — main opens the authorize
  // URL in the system browser, so no external URL ever reaches the renderer.
  appSurface: {
    catalog: (force?: boolean) => ipcRenderer.invoke('atum:app:catalog', force === true),
    intakeStatus: app => ipcRenderer.invoke('atum:app:intake:status', app),
    routes: app => ipcRenderer.invoke('atum:app:routes', app),
    submitIntake: (app, values) => ipcRenderer.invoke('atum:app:intake:submit', app, values),
    connectStatus: app => ipcRenderer.invoke('atum:app:connect:status', app),
    connectCandidate: app => ipcRenderer.invoke('atum:app:connect:candidate', app),
    connectStart: app => ipcRenderer.invoke('atum:app:connect:start', app),
    connectDismiss: app => ipcRenderer.invoke('atum:app:connect:dismiss', app)
  },
  // Checkout URLs never cross this bridge. Main re-fetches the caller-owned
  // pending order and permits only the configured PayOS return surface.
  protons: {
    rewards: () => ipcRenderer.invoke('atum:protons:rewards'),
    claimConnectionReward: kind => ipcRenderer.invoke('atum:protons:rewards:claim', kind),
    wallet: () => ipcRenderer.invoke('atum:protons:wallet')
  },
  // The signed entitlement envelope, the bearer and every account path stay in
  // main; the renderer mints the purchase idempotency key per confirmation and
  // reuses it on retry, which is what makes a double-click a replay.
  store: {
    catalog: () => ipcRenderer.invoke('atum:store:catalog'),
    purchase: (offerId, offerVersion, idempotencyKey, accountId, assistantId) =>
      ipcRenderer.invoke('atum:store:purchase', offerId, offerVersion, idempotencyKey, accountId, assistantId),
    agentHires: accountId => ipcRenderer.invoke('atum:store:hiring:list', accountId),
    hireAgent: (assistantId, offerId, version, key, consent, accountId) => ipcRenderer.invoke('atum:store:hiring:hire', assistantId, offerId, version, key, consent, accountId),
    cancelAgentHire: (hireId, accountId) => ipcRenderer.invoke('atum:store:hiring:cancel', hireId, accountId),
    startAgentTask: (assistantId, conversationId, skillId, accountId) => ipcRenderer.invoke('atum:store:agent:task', assistantId, conversationId, skillId, accountId),
    startTrainingTask: (assistantId, conversationId, skillId, accountId) => ipcRenderer.invoke('atum:store:training:start', assistantId, conversationId, skillId, accountId),
    purchaseStatus: purchaseId => ipcRenderer.invoke('atum:store:purchase:status', purchaseId),
    refresh: () => ipcRenderer.invoke('atum:store:refresh')
  },
  agentSync: {
    preferences: () => ipcRenderer.invoke('atum:assistants:sync:preferences'),
    patchPreferences: (accountId, patch) => ipcRenderer.invoke('atum:assistants:sync:preferences:patch', accountId, patch),
    seedPreferences: (accountId, snapshot) => ipcRenderer.invoke('atum:assistants:sync:preferences:seed', accountId, snapshot),
    status: () => ipcRenderer.invoke('atum:assistants:sync:status'),
    sync: () => ipcRenderer.invoke('atum:assistants:sync:run'),
    setMemoryEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('atum:assistants:sync:memory', id, enabled),
    resolve: (id: string, kind: 'skills' | 'memory', choice: 'local' | 'cloud') => ipcRenderer.invoke('atum:assistants:sync:resolve', id, kind, choice),
    onChanged: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('atum:assistants:sync:changed', listener)

      return () => { ipcRenderer.removeListener('atum:assistants:sync:changed', listener) }
    }
  },
  messaging: {
    status: () => ipcRenderer.invoke('atum:messaging:status'),
    roster: limit => ipcRenderer.invoke('atum:messaging:roster', limit),
    messages: (conversationId, limit) => ipcRenderer.invoke('atum:messaging:messages', conversationId, limit),
    loadOlderMessages: (conversationId, limit) =>
      ipcRenderer.invoke('atum:messaging:messages:older', conversationId, limit),
    transportStatus: () => ipcRenderer.invoke('atum:messaging:transport-status'),
    mentionTargets: conversationId => ipcRenderer.invoke('atum:messaging:mention-targets', conversationId),
    artifact: (conversationId, resourceId) => ipcRenderer.invoke('atum:messaging:artifact', conversationId, resourceId),
    ensureSpecialistConversation: specialist => ipcRenderer.invoke('atum:messaging:specialist:ensure', specialist),
    ensureContactConversation: userId => ipcRenderer.invoke('atum:messaging:contact:ensure', userId),
    handleAvailability: handle => ipcRenderer.invoke('atum:identity:handle:availability', handle),
    renameHandle: handle => ipcRenderer.invoke('atum:identity:handle:rename', handle),
    updateProfile: input => ipcRenderer.invoke('atum:identity:profile:update', input),
    createAvatarUpload: input => ipcRenderer.invoke('atum:identity:avatar:create', input),
    completeAvatarUpload: uploadId => ipcRenderer.invoke('atum:identity:avatar:complete', uploadId),
    clearAvatar: () => ipcRenderer.invoke('atum:identity:avatar:clear'),
    registerAssistant: input => ipcRenderer.invoke('atum:assistants:register', input),
    retireAssistant: input => ipcRenderer.invoke('atum:assistants:retire', input),
    listAssistants: () => ipcRenderer.invoke('atum:assistants:list'),
    createAssistantAvatarUpload: (assistantId, input) =>
      ipcRenderer.invoke('atum:assistants:avatar:create', assistantId, input),
    completeAssistantAvatarUpload: (assistantId, uploadId) =>
      ipcRenderer.invoke('atum:assistants:avatar:complete', assistantId, uploadId),
    clearAssistantAvatar: assistantId => ipcRenderer.invoke('atum:assistants:avatar:clear', assistantId),
    getAssistantDefinition: assistantId => ipcRenderer.invoke('atum:assistants:definition:get', assistantId),
    putAssistantDefinition: (assistantId, input) =>
      ipcRenderer.invoke('atum:assistants:definition:put', assistantId, input),
    // Main fetches the owner-authorized snapshot and holds the one-use ticket.
    // The renderer provides only the assistant id and never sees either value.
    materializeAssistant: assistantId => ipcRenderer.invoke('atum:assistants:materialize', assistantId),
    applyAssistantDefinition: assistantId => ipcRenderer.invoke('atum:assistants:definition:apply', assistantId),
    importLegacyAssistant: assistantId => ipcRenderer.invoke('atum:assistants:legacy:import', assistantId),
    socialLookup: query => ipcRenderer.invoke('atum:social:lookup', query),
    socialMutate: (action, targetProfileId) => ipcRenderer.invoke('atum:social:mutate', action, targetProfileId),
    socialRelationships: () => ipcRenderer.invoke('atum:social:relationships'),
    socialSync: () => ipcRenderer.invoke('atum:social:sync'),
    linkedApps: () => ipcRenderer.invoke('atum:identity:apps'),
    disconnectApp: app => ipcRenderer.invoke('atum:identity:apps:disconnect', app),
    draft: conversationId => ipcRenderer.invoke('atum:messaging:draft:get', conversationId),
    saveDraft: (conversationId, draft) => ipcRenderer.invoke('atum:messaging:draft:save', conversationId, draft),
    send: input => ipcRenderer.invoke('atum:messaging:send', input),
    retry: clientMessageId => ipcRenderer.invoke('atum:messaging:retry', clientMessageId),
    markRead: (conversationId, throughMessageId) =>
      ipcRenderer.invoke('atum:messaging:read', conversationId, throughMessageId),
    toggleReaction: (messageId, emoji) => ipcRenderer.invoke('atum:messaging:reaction', messageId, emoji),
    editMessage: (messageId, content) => ipcRenderer.invoke('atum:messaging:edit', messageId, content),
    recallMessage: messageId => ipcRenderer.invoke('atum:messaging:recall', messageId),
    searchMessages: (query, conversationId) => ipcRenderer.invoke('atum:messaging:search', query, conversationId),
    createMediaUpload: input => ipcRenderer.invoke('atum:messaging:media:create', input),
    completeMediaUpload: attachmentId => ipcRenderer.invoke('atum:messaging:media:complete', attachmentId),
    downloadMedia: attachmentId => ipcRenderer.invoke('atum:messaging:media:download', attachmentId),
    sendTyping: (conversationId, typing) => ipcRenderer.invoke('atum:messaging:typing', conversationId, typing),
    drainMentionJobs: () => ipcRenderer.invoke('atum:messaging:mentions:drain'),
    sync: () => ipcRenderer.invoke('atum:messaging:sync'),
    groupCapabilities: () => ipcRenderer.invoke('atum:messaging:group:capabilities'),
    groupDetail: (conversationId, cursor) => ipcRenderer.invoke('atum:messaging:group:detail', conversationId, cursor),
    groupOperate: input => ipcRenderer.invoke('atum:messaging:group:operate', input),
    groupOperations: () => ipcRenderer.invoke('atum:messaging:group:operations')
  },
  advisoryRunner: {
    claim: clientOperationId => ipcRenderer.invoke('atum:advisory:claim', clientOperationId),
    attach: () => ipcRenderer.invoke('atum:advisory:attach'),
    running: (jobId, runtimeSessionId, durableSessionId, localProfile) =>
      ipcRenderer.invoke('atum:advisory:running', jobId, runtimeSessionId, durableSessionId, localProfile),
    complete: (jobId, replyText) => ipcRenderer.invoke('atum:advisory:complete', jobId, replyText),
    fail: (jobId, errorCode, retryable) => ipcRenderer.invoke('atum:advisory:fail', jobId, errorCode, retryable),
    cancelConversation: (conversationId, targetId) =>
      ipcRenderer.invoke('atum:advisory:cancel-conversation', conversationId, targetId),
    search: (invocation: AdvisorySearchInvocation) => ipcRenderer.invoke('atum:advisory:search', invocation),
    onJob: callback => {
      const listener = (_event, job) => callback(job)
      ipcRenderer.on('atum:advisory:job', listener)

      return () => ipcRenderer.removeListener('atum:advisory:job', listener)
    },
    onCancel: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('atum:advisory:cancel', listener)

      return () => ipcRenderer.removeListener('atum:advisory:cancel', listener)
    }
  },
  atumSharedGroups: {
    preview: input => ipcRenderer.invoke(ATUM_SHARED_GROUP_PERSONA_IPC.preview, input),
    approve: input => ipcRenderer.invoke(ATUM_SHARED_GROUP_PERSONA_IPC.approve, input),
    revoke: input => ipcRenderer.invoke(ATUM_SHARED_GROUP_PERSONA_IPC.revoke, input)
  },
  onAtumMessagingChanged: callback => {
    const listener = () => callback()
    ipcRenderer.on('atum:messaging:changed', listener)

    return () => ipcRenderer.removeListener('atum:messaging:changed', listener)
  },
  onAtumMessagingTransportChanged: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('atum:messaging:transport-changed', listener)

    return () => ipcRenderer.removeListener('atum:messaging:transport-changed', listener)
  },
  onAtumMessagingTypingChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('atum:messaging:typing-changed', listener)

    return () => ipcRenderer.removeListener('atum:messaging:typing-changed', listener)
  },
  onAtumConversationRequested: callback => {
    const listener = (_event, conversationId) => callback(conversationId)
    ipcRenderer.on('atum:messaging:open-conversation', listener)

    return () => ipcRenderer.removeListener('atum:messaging:open-conversation', listener)
  },
  api: request => ipcRenderer.invoke('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('hermes:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('hermes:selectPaths', options),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  // The document is converted to Markdown in the MAIN process — only the
  // finished text crosses this bridge, never the package. See
  // electron/docx-extract.ts.
  docxPreview: filePath => ipcRenderer.invoke('hermes:docx:preview', filePath),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('hermes:keep-awake', on),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('hermes:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    setPercent: percent => ipcRenderer.send('hermes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('hermes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  consumerFiles: {
    capture: token => ipcRenderer.invoke('atum:files:capture', token),
    roots: () => ipcRenderer.invoke('atum:files:roots'),
    list: dirPath => ipcRenderer.invoke('atum:files:list', dirPath),
    search: (dirPath, query) => ipcRenderer.invoke('atum:files:search', dirPath, query),
    open: filePath => ipcRenderer.invoke('atum:files:open', filePath),
    openNative: filePath => ipcRenderer.invoke('atum:files:open-native', filePath),
    reveal: filePath => ipcRenderer.invoke('atum:files:reveal', filePath),
    rename: (filePath, newName) => ipcRenderer.invoke('atum:files:rename', filePath, newName),
    trash: filePath => ipcRenderer.invoke('atum:files:trash', filePath),
    mkdir: (dirPath, name) => ipcRenderer.invoke('atum:files:mkdir', dirPath, name),
    thumbnail: (filePath, size) => ipcRenderer.invoke('atum:files:thumbnail', filePath, size),
    releaseView: token => ipcRenderer.invoke('atum:files:release-view', token)
  },
  ...(process.platform === 'darwin' ? {
    nativeApps: {
      listOpenDocumentWindows: () => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.listOpenDocumentWindows),
      resolveOpenDocumentWindow: id => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.resolveOpenDocumentWindow, id),
      list: refresh => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.list, refresh),
      launch: request => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.launch, request),
      end: id => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.end, id),
      chooseFile: kind => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.chooseFile, kind),
      openArrangementSettings: permission => ipcRenderer.invoke(NATIVE_APPS_CHANNELS.openArrangementSettings, permission),
      onEnded: callback => {
        const listener = (_event, id) => callback(id)
        ipcRenderer.on(NATIVE_APPS_CHANNELS.ended, listener)

        return () => ipcRenderer.removeListener(NATIVE_APPS_CHANNELS.ended, listener)
      }
    },
    wordCompanion: {
      linkingVersion: 1,
      listDocuments: () => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.listDocuments),
      bind: request => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.bind, request),
      unbind: id => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.unbind, id),
      showBeside: id => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.showBeside, id),
      bringToFront: id => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.bringToFront, id),
      onBindingEnded: callback => {
        const listener = (_event, id) => callback(id)
        ipcRenderer.on(WORD_COMPANION_CHANNELS.bindingEnded, listener)

        return () => ipcRenderer.removeListener(WORD_COMPANION_CHANNELS.bindingEnded, listener)
      },
      open: (filePath, requestId) => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.open, filePath, requestId),
      end: id => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.end, id),
      capture: id => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.capture, id),
      execute: (id, request) => ipcRenderer.invoke(WORD_COMPANION_CHANNELS.execute, id, request),
      onEnded: callback => {
        const listener = (_event, id) => callback(id)
        ipcRenderer.on(WORD_COMPANION_CHANNELS.ended, listener)

        return () => ipcRenderer.removeListener(WORD_COMPANION_CHANNELS.ended, listener)
      }
    }
  } : {}),
  atumPdfView: {
    show: (token, bounds) => ipcRenderer.invoke('atum:pdf-view:show', token, bounds),
    hide: token => ipcRenderer.invoke('atum:pdf-view:hide', token),
    close: token => ipcRenderer.invoke('atum:pdf-view:close', token)
  },
  gitRoot: startPath => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('hermes:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('hermes:fs:openDir', dirPath),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('hermes:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('hermes:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('hermes:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('hermes:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('hermes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('hermes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('hermes:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('hermes:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('hermes:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('hermes:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('hermes:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('hermes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('hermes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('hermes:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('hermes:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('hermes:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('hermes:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('hermes:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('hermes:git:review:shipInfo', repoPath),
      createPr: repoPath => ipcRenderer.invoke('hermes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('hermes:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)

    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)

    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)

    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)

    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)

    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:connection:applied', listener)

    return () => ipcRenderer.removeListener('hermes:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)

    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)

    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: opts => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('hermes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)

      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  }
})
