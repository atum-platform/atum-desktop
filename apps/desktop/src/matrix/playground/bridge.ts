import type { DesktopLocale } from '../../../shared/desktop-locale'
import type { MatrixMessage, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import { matrixActionCopy } from '../../../shared/matrix-action-copy'
import type { MatrixDesktopServicesStatus } from '../../../shared/matrix-desktop-services'
import {
  type MatrixModelCatalog,
  type MatrixModelRoute,
  matrixModelRouteId,
  matrixRouteIdOfChoice,
  parseMatrixModel
} from '../../../shared/matrix-models'
import type { GroupPolicyRead } from '../../../shared/room-participation/runtime'

import {
  FIRST_RUN_ROOM,
  firstRunReview,
  firstRunSnapshot,
  LAUNCH_STEPS,
  launchSnapshot,
  PLAYGROUND_MEMBERS,
  PLAYGROUND_MESSAGES,
  PLAYGROUND_TYPING,
  playgroundAlias,
  type PlaygroundScenario,
  scenarioSnapshot
} from './fixtures'
import { playgroundPets } from './pet-fixtures'

type Listener = (snapshot: MatrixSnapshot) => void

/**
 * The playground's stand-in for the native bridge: fixture snapshots, a scripted launch,
 * and no Electron, Hermes, Matrix or network. Every method the window may call resolves
 * harmlessly, so any control can be clicked while designing.
 */
export class PlaygroundStore {
  private listeners = new Set<Listener>()
  private timers: ReturnType<typeof setTimeout>[] = []
  private reading: ReturnType<typeof setTimeout> | undefined
  current: MatrixSnapshot
  scenario: PlaygroundScenario
  /** A signed-in window speaks the account's language preference (MatrixLanguageProvider),
   * so the fixtures carry the language the playground was asked for. */
  locale?: DesktopLocale

  constructor(scenario: PlaygroundScenario, locale?: DesktopLocale) {
    this.scenario = scenario
    this.locale = locale
    this.current = this.speaking(scenarioSnapshot(scenario))
  }

  private speaking(snapshot: MatrixSnapshot): MatrixSnapshot {
    const locale = this.locale

    return locale && snapshot.identity
      ? {
          ...snapshot,
          // An assistant's notice is said in the owner's language, as main says it: the line it
          // says when it joins a group, or the one about a reply it held. A progress line keeps
          // the agent's own (already redacted) working words.
          messages: snapshot.messages.map(message =>
            message.notice && !message.own && !message.progress
              ? {
                  ...message,
                  body: message.id.startsWith('$joined')
                    ? matrixActionCopy[locale].groupJoined
                    : matrixActionCopy[locale].replyQuoteUnreadable
                }
              : message
          ),
          displayPreferences: {
            appearance: { value: 'system', writable: true },
            textSize: { value: 100, writable: true },
            notifications: { value: true, writable: true },
            sound: { value: true, writable: true },
            shareActivity: { value: true, writable: true },
            ...snapshot.displayPreferences,
            language: { value: locale, writable: true }
          }
        }
      : snapshot
  }

  setLocale(locale: DesktopLocale) {
    this.locale = locale
    this.emit(this.current)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  set(scenario: PlaygroundScenario) {
    this.clear()
    this.scenario = scenario
    this.emit(scenarioSnapshot(scenario))

    if (scenario === 'launch' || scenario === 'launch-slow') {
      this.runLaunch(scenario === 'launch-slow')
    }

    if (scenario === 'first-run') {
      this.runFirstRun()
    }
  }

  /** A new account's launch: the first message waits in the main panel while the assistant
   * gets ready (the AI step is slow here, as it is on a real first run), then in its chat. */
  private runFirstRun() {
    let at = 0

    // Whatever the person did meanwhile (answered, a chat opened) carries through each step.
    const step = (readiness: NonNullable<MatrixSnapshot['readiness']>) => () =>
      this.emit({
        ...firstRunSnapshot(readiness),
        firstRun: this.current.firstRun,
        firstRunOpen: this.current.firstRunOpen,
        firstRunMarker: this.current.firstRunMarker,
        rooms: this.current.rooms,
        roomId: this.current.roomId,
        messages: this.current.messages
      })

    LAUNCH_STEPS.forEach(({ step: name, ms }) => {
      this.timers.push(setTimeout(step({ phase: 'starting', step: name, since: Date.now() }), at))
      at += name === 'ai' ? 6000 : ms
    })

    this.timers.push(setTimeout(step({ phase: 'ready', since: Date.now() }), at))
  }

  /** The window opened the assistant's first chat (it has none yet on a first run). */
  createAssistantRoom(): string {
    this.emit({
      ...this.current,
      rooms: [FIRST_RUN_ROOM, ...this.current.rooms],
      roomId: FIRST_RUN_ROOM.id,
      messages: []
    })

    return FIRST_RUN_ROOM.id
  }

  /** Allow: "Looking now…" (macOS asks, the folders are read), then, once the assistant is
   * ready and has its chat, the person's answer and the assistant's review there. */
  firstRunAllow() {
    this.emit({ ...this.current, firstRun: 'working' })
    const { consent, answer } = firstRunReview(this.locale)
    const base = { encrypted: true, decryptionFailed: false, pending: false, failed: false, attachment: false }

    const deliver = () => {
      const roomId = this.current.roomId

      if (this.current.readiness?.phase !== 'ready' || !roomId) {
        this.timers.push(setTimeout(deliver, 400))

        return
      }

      const me = this.current.identity?.userId ?? ''
      const atum = this.current.assistant?.userId ?? ''

      this.emit({
        ...this.current,
        firstRun: undefined,
        firstRunOpen: undefined,
        firstRunMarker: 'answered',
        firstRunWelcome: 'done',
        messages: [{ ...base, id: '$consent', sender: me, body: consent, timestamp: Date.now(), own: true }],
        hermes: 'running',
        hermesActivity: {
          roomId,
          turnId: '00000000-0000-4000-8000-f43742eb71c2',
          invocationId: 'playground-first-run',
          state: 'running',
          tools: [],
          text: answer.slice(0, 90)
        }
      })
      this.timers.push(
        setTimeout(() => {
          this.emit({
            ...this.current,
            hermes: 'ready',
            hermesActivity: undefined,
            messages: [
              ...this.current.messages,
              {
                ...base,
                id: '$review',
                sender: atum,
                body: answer,
                timestamp: Date.now(),
                own: false,
                replyTo: '$consent'
              }
            ]
          })
        }, 2400)
      )
    }

    this.timers.push(setTimeout(deliver, 1800))
  }

  firstRunStart(ending: 'done' | 'dismissed') {
    this.emit({
      ...this.current,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: ending
    })
  }

  /** Not now: the welcome is dismissed for the account; the window shows the ordinary greeting. */
  firstRunDecline() {
    this.emit({
      ...this.current,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: 'dismissed'
    })
  }

  /** Compatibility end state for an older first-run surface. */
  firstRunFinish() {
    this.emit({
      ...this.current,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: 'done'
    })
  }

  /** The recovery key written down: the custody mark goes. */
  recoveryWritten() {
    const security = this.current.security

    if (security) {
      const { custody: _done, ...rest } = security
      this.emit({ ...this.current, security: rest })
    }
  }

  replay() {
    this.set(this.scenario)
  }

  /** One-tap approval as main runs it (device-approval.ts): a pick, then the key on its way. */
  approvalPick(index: number | null) {
    const approval = this.current.security?.approval

    if (!approval?.choices) {
      return
    }

    const right = index !== null && approval.choices[index]?.join() === '1036,4349,6060'
    this.approvalSet(right ? 'unlocking' : 'mismatch')

    if (right) {
      this.timers.push(setTimeout(() => this.approvalSet('done'), 1500))
    }
  }

  /** "Yes, it's me": the comparison starts, then the three candidate number codes. */
  approvalAccept() {
    const security = this.current.security
    const approval = security?.approval

    if (!security || !approval) {
      return
    }

    this.approvalSet('waiting')
    this.timers.push(
      setTimeout(() => {
        this.emit({
          ...this.current,
          security: {
            ...security,
            approval: {
              ...approval,
              state: 'compare',
              since: Date.now(),
              choices: [
                [1036, 2011, 3322],
                [1036, 4349, 6060],
                [1036, 7488, 8190]
              ]
            }
          }
        })
      }, 900)
    )
  }

  approvalSet(state: NonNullable<NonNullable<MatrixSnapshot['security']>['approval']>['state']) {
    const security = this.current.security
    const approval = security?.approval

    if (security && approval) {
      this.emit({ ...this.current, security: { ...security, approval: { ...approval, state, since: Date.now() } } })
    }
  }

  approvalDismiss() {
    const security = this.current.security

    if (security?.approval) {
      const { approval: _done, ...rest } = security
      this.emit({ ...this.current, security: rest })
    }
  }

  /** Reconnect: the agent's executor replaced on this Mac, as main runs it (agent-reenroll.ts). */
  reconnectAgent(principal: string) {
    const readiness = (value: NonNullable<MatrixSnapshot['readiness']>) => ({
      ...this.current,
      agents: this.current.agents?.map(agent =>
        agent.principal === principal ? { ...agent, readiness: value } : agent
      )
    })

    this.emit(readiness({ phase: 'blocked', step: 'assistant', code: 'agent_reconnecting', since: Date.now() }))
    this.timers.push(setTimeout(() => this.emit(readiness({ phase: 'ready', since: Date.now() })), 2500))
  }

  /** A way in was chosen: the browser trip, then the launch, as main runs them. */
  signIn() {
    this.clear()
    this.emit({ ...this.current, state: 'signing_in', error: null })
    this.timers.push(setTimeout(() => this.runLaunch(false), 1500))
  }

  cancelSignIn() {
    this.clear()
    this.emit({ ...this.current, state: 'signed_out', error: null })
  }

  select(roomId: string) {
    const conversation = scenarioSnapshot('chat')

    this.emit({
      ...this.current,
      roomId,
      destination: null,
      messages: roomId === conversation.roomId ? conversation.messages : (PLAYGROUND_MESSAGES[roomId] ?? []),
      members: PLAYGROUND_MEMBERS[roomId] ?? [],
      typing: PLAYGROUND_TYPING[roomId] ?? []
    })
  }

  /** One message of the open chat changed, as sync would bring it back (Matrix chat, launch night). */
  updateMessage(eventId: string, change: (message: MatrixMessage) => MatrixMessage) {
    this.emit({
      ...this.current,
      messages: this.current.messages.map(message => (message.id === eventId ? change(message) : message))
    })
  }

  /** Your reaction added or taken back: one per person per key. */
  react(eventId: string, key: string, reacted: boolean) {
    const me = this.current.identity?.userId ?? ''

    this.updateMessage(eventId, message => {
      const others = (message.reactions ?? []).filter(reaction => reaction.key !== key)
      const existing = message.reactions?.find(reaction => reaction.key === key)
      const senders = (existing?.senders ?? []).filter(sender => sender !== me).concat(reacted ? [me] : [])
      const next = senders.length ? [...others, { key, count: senders.length, own: reacted, senders }] : others

      return { ...message, reactions: next.length ? next : undefined }
    })
  }

  /** Your words, sent (a reply names what it answers). */
  sent(body: string, replyTo?: string) {
    const me = this.current.identity?.userId ?? ''

    this.emit({
      ...this.current,
      typing: [],
      messages: [
        ...this.current.messages,
        {
          id: `$sent-${Date.now()}`,
          sender: me,
          body,
          timestamp: Date.now(),
          own: true,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false,
          ...(replyTo ? { replyTo } : {})
        }
      ]
    })
  }

  /** A room's own flags and names, as sync would bring them back (launch night). */
  updateRoom(roomId: string, change: Partial<MatrixSnapshot['rooms'][number]>) {
    this.emit({
      ...this.current,
      rooms: this.current.rooms.map(room => (room.id === roomId ? { ...room, ...change } : room))
    })
  }

  /** An agent retired, as main answers it: the agent leaves the roster and its private chats
   * with the owner are left and forgotten (retired-agent-rooms.ts); groups stay. */
  retire(principal: string) {
    const agent = this.current.agents?.find(each => each.principal === principal)
    const owner = this.current.identity?.userId

    const own = (room: MatrixSnapshot['rooms'][number]) =>
      Boolean(agent) &&
      (room.participants ?? []).every(member => member.userId === owner || member.userId === agent?.userId) &&
      (room.participants ?? []).some(member => member.userId === agent?.userId)

    this.emit({
      ...this.current,
      agents: this.current.agents?.filter(each => each.principal !== principal),
      rooms: this.current.rooms.filter(room => !own(room)),
      ...(this.current.rooms.some(room => room.id === this.current.roomId && own(room))
        ? { roomId: null, messages: [] }
        : {})
    })
  }

  leave(roomId: string) {
    this.emit({
      ...this.current,
      rooms: this.current.rooms.filter(room => room.id !== roomId),
      ...(this.current.roomId === roomId ? { roomId: null, messages: [] } : {})
    })
  }

  /** An unsent message sent again (it goes through) or dropped. */
  unsent(eventId: string, resend: boolean) {
    this.emit({
      ...this.current,
      messages: resend
        ? this.current.messages.map(message =>
            message.id === eventId ? { ...message, id: `$sent-${Date.now()}`, failed: false } : message
          )
        : this.current.messages.filter(message => message.id !== eventId)
    })
  }

  /** The chat on screen is read a moment later: its unread count clears, as sync clears it. */
  attend(roomId: string | null) {
    clearTimeout(this.reading)

    if (!roomId) {
      return
    }

    this.reading = setTimeout(() => {
      if (this.current.roomId === roomId) {
        this.emit({
          ...this.current,
          rooms: this.current.rooms.map(room =>
            room.id === roomId ? { ...room, unreadNotifications: 0, highlights: 0, unread: false } : room
          )
        })
      }
    }, 900)
  }

  emit(snapshot: MatrixSnapshot) {
    const current = this.speaking(snapshot)
    this.current = current
    this.listeners.forEach(listener => listener(current))
  }

  private runLaunch(slow: boolean) {
    let at = 0

    LAUNCH_STEPS.forEach(({ step, ms }) => {
      this.timers.push(setTimeout(() => this.emit(launchSnapshot(step, Date.now())), at))
      at += slow && step === 'ai' ? 9000 : ms
    })

    this.timers.push(setTimeout(() => this.emit(scenarioSnapshot('chat')), at))
  }

  private clear() {
    this.timers.forEach(clearTimeout)
    this.timers = []
    clearTimeout(this.reading)
  }
}

const noop = async () => {}

const PLAYGROUND_MODEL_ROUTES: readonly Omit<MatrixModelRoute, 'current'>[] = [
  {
    id: matrixModelRouteId('openai-codex', 'gpt-5.6-sol'),
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    providerLabel: 'ChatGPT',
    accountLabel: 'ChatGPT plan',
    connection: 'plan',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: ['low', 'medium', 'high'],
    ready: true
  },
  {
    id: matrixModelRouteId('openai-codex', 'gpt-5.6-luna'),
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    providerLabel: 'ChatGPT',
    accountLabel: 'ChatGPT plan',
    connection: 'plan',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: ['low', 'medium', 'high'],
    ready: true
  },
  {
    id: matrixModelRouteId('anthropic', 'claude-sonnet-4-6'),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    providerLabel: 'Anthropic',
    accountLabel: 'API key',
    connection: 'key',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: ['low', 'medium', 'high'],
    ready: true
  },
  {
    id: matrixModelRouteId('ollama', 'qwen3:14b'),
    provider: 'ollama',
    model: 'qwen3:14b',
    name: 'Qwen 3 14B',
    providerLabel: 'Ollama',
    accountLabel: 'On this Mac',
    connection: 'local',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: [],
    ready: true
  }
]

/** A sanitized, local-only catalog. It demonstrates capabilities, never credential authority. */
export function playgroundModelCatalog(snapshot: MatrixSnapshot, roomId: string): MatrixModelCatalog {
  const room = snapshot.rooms.find(each => each.id === roomId)
  const roomAgent = snapshot.agents?.find(agent => agent.principal === room?.agentPrincipal)

  const connected = roomAgent && !roomAgent.isDefault
    ? (roomAgent.localModel ?? roomAgent.connectedModel)
    : (snapshot.localModel ?? snapshot.connectedModel)

  const current = connected ? matrixRouteIdOfChoice(connected) : undefined

  return {
    routes: PLAYGROUND_MODEL_ROUTES.map(route => ({ ...route, current: route.id === current })),
    accounts: [
      { id: 'openai-codex', providerLabel: 'ChatGPT', accountLabel: 'ChatGPT plan', connection: 'plan', ready: true, models: 2 },
      { id: 'anthropic', providerLabel: 'Anthropic', accountLabel: 'API key', connection: 'key', ready: true, models: 1 },
      { id: 'ollama', providerLabel: 'Ollama', accountLabel: 'On this Mac', connection: 'local', ready: true, models: 1 },
      { id: 'openrouter', providerLabel: 'OpenRouter', accountLabel: 'Not signed in', connection: 'key', ready: false, models: 3 }
    ],
    ...(current && PLAYGROUND_MODEL_ROUTES.some(route => route.id === current) ? { current } : {}),
    agentName: roomAgent?.name ?? 'Atum',
    destination: 'this_mac',
    unavailable: 1
  }
}

export function playgroundBridge(store: PlaygroundStore): MatrixUiBridge {
  const groupPolicies = new Map<string, GroupPolicyRead>()

  return {
    // Workplace's native pages: the playground opens the page frame, never a page.
    pages: {
      open: async () => ({ viewId: 'playground' }),
      setBounds: async () => ({ ok: true as const }),
      setVisibility: async () => ({ ok: true as const }),
      focus: async () => ({ ok: true as const }),
      close: async () => ({ ok: true as const }),
      onState: () => () => {}
    },
    // The new-tab page offers its address field only when a browser exists; pages never
    // load here.
    consumerBrowser: {
      onPopup: () => () => {},
      onNotice: () => () => {},
      prepare: async ({ url }) => ({ url }),
      release: async () => ({ ok: true })
    },
    // People found by @name: a scripted directory (`playgroundAlias`).
    aliases: { pending: async () => ({ ok: true as const, request: null }), request: playgroundAlias },
    // Contact us: the Founder chat the fixtures made, opened as main opens it; none elsewhere.
    founder: {
      contact: async () => {
        const roomId = store.current.founder?.roomId

        if (!roomId) {
          return { unavailable: true as const }
        }

        store.select(roomId)

        return { roomId }
      }
    },
    windowFacts: async () => ({
      platform: 'darwin',
      isFullscreen: false,
      windowButtonPosition: { x: 12, y: 13 },
      overlayWidth: 0
    }),
    subscribeWindow: () => () => {},
    setWindowMode: noop,
    snapshot: async () => store.current,
    signIn: async () => store.signIn(),
    repairOwnerDevice: async () => {
      store.emit({ ...store.current, deviceDamaged: undefined, ownerDeviceRepair: undefined })

      return { state: 'repaired' }
    },
    cancelOwnerDeviceRepair: noop,
    cancelSignIn: async () => store.cancelSignIn(),
    signOut: noop,
    retry: noop,
    endDeviceSession: noop,
    dismissNewSignIn: noop,
    document: noop,
    arrangeWord: noop,
    previewDocument: async () => ({ token: 'preview', name: 'notes.txt', kind: 'text' as const, text: '' }),
    closeDocumentPreview: noop,
    pdf: { show: async () => ({ shown: true }), hide: noop, close: noop },
    readDomain: async () => ({ issuer: 'https://id.atum.chat/', subject: 'minh', principal: 'principal' }),
    cancelDomain: noop,
    enrollment: async () => ({ state: 'absent' as const, identity: null }),
    enrollHermes: async () => ({ state: 'ready' as const, identity: null }),
    setupAssistant: noop,
    revokeHermes: async () => ({ state: 'absent' as const, identity: null }),
    // `?fail=1`: opening an assistant's chat fails, to show the failure notice.
    connectHermes: async () => {
      if (new URLSearchParams(location.search).get('fail') === '1') {
        throw new Error("Error invoking remote method 'matrix:ui': Error: matrix_not_ready")
      }
    },
    invokeHermes: async () => ({ state: 'cancelled' as const }),
    sendAssistant: async () => ({ eventId: '$sent', result: { state: 'published' as const } }),
    recoverHermes: async () => ({ state: 'unknown' as const }),
    sendTurn: async () => ({ turnId: '00000000-0000-4000-8000-11e594f48195' }),
    retryTurn: async () => ({ turnId: '00000000-0000-4000-8000-e79acd97ac88' }),
    answerTurnHere: async (turnId: string) => ({ turnId }),
    retryReadiness: async () => store.replay(),
    reconnectAgent: async principal => store.reconnectAgent(principal),
    openStorageSettings: async () => {},
    icloudKeychain: async () => {},
    approval: {
      accept: async () => store.approvalAccept(),
      pick: async index => store.approvalPick(index),
      decline: async () => store.approvalSet('declined'),
      signOutDevice: async () => {},
      dismiss: async () => store.approvalDismiss(),
      confirm: async () => store.approvalSet('unlocking'),
      retry: async () => store.approvalSet('waiting')
    },
    // The first message's answers and the recovery key's write-down, scripted.
    firstRun: {
      start: async input => store.firstRunStart(input.ending),
      allow: async () => store.firstRunAllow(),
      decline: async () => store.firstRunDecline(),
      finish: async () => store.firstRunFinish()
    },
    recoveryKey: {
      reveal: async () => 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666',
      written: async () => store.recoveryWritten()
    },
    openTopUp: noop,
    cancelHermes: noop,
    createAgent: async () => ({ principal: 'agent-new', roomId: '!new:example.invalid' }),
    importAgent: async () => ({ principal: 'agent-imported', roomId: '!imported:example.invalid' }),
    retireAgent: async (principal: string) => {
      store.retire(principal)

      return { sessionCleanup: 'complete' as const }
    },
    listenHermes: noop,
    setContinuousListening: noop,
    stopListeningHermes: noop,
    respondHermes: noop,
    configureHermes: async () => ({ state: 'ready' as const }),
    // Back to Atum's AI, as main does: the default assistant drops its own connection.
    useAtumModel: async () => {
      store.emit({
        ...store.current,
        atumModel: true,
        ownModel: false,
        localModel: undefined,
        agents: store.current.agents?.map(each => (each.isDefault ? { ...each, localModel: undefined } : each))
      })

      return { state: 'ready' as const }
    },
    modelCatalog: async roomId => playgroundModelCatalog(store.current, roomId),
    selectModelRoute: async (roomId, routeId, target) => {
      const catalog = playgroundModelCatalog(store.current, roomId)
      const route = catalog.routes.find(each => each.id === routeId && each.ready && each.target === target)
      // An account-plan model (`?subscriptions=`) answers through the same switch in main.
      const [planProvider, planModel] = routeId.split(':')
      const plan =
        !route && (planProvider === 'openai-codex' || planProvider === 'opencode-go') && planModel && target === 'agent_default'
          ? { provider: planProvider, model: planModel, name: planModel, efforts: [] }
          : undefined

      if (!plan && (!route || route.destination !== 'this_mac')) {
        throw new Error('matrix_connected_model_unavailable')
      }

      const chosen = plan ?? route!
      const localModel = {
        provider: chosen.provider,
        model: chosen.model,
        capability: { id: chosen.model, displayName: chosen.name, efforts: chosen.efforts }
      }

      const room = store.current.rooms.find(each => each.id === roomId)
      const agent = store.current.agents?.find(each => each.principal === room?.agentPrincipal)

      store.emit({
        ...store.current,
        // A plan model answers as the default assistant's own connection, as main switches it.
        ...(!agent || agent.isDefault ? { localModel, ...(plan ? { atumModel: false, ownModel: true } : {}) } : {}),
        agents: store.current.agents?.map(each =>
          each.principal === room?.agentPrincipal ? { ...each, localModel } : each
        )
      })

      return { status: 'applied' as const, current: routeId }
    },
    command: async command => {
      if (command.kind === 'displayPreference' && store.current.displayPreferences) {
        store.emit({
          ...store.current,
          displayPreferences: {
            ...store.current.displayPreferences,
            [command.field]: { value: command.value, writable: true }
          }
        })

        return null
      }

      if (command.kind === 'setModel') {
        const room = store.current.rooms.find(each => each.id === command.roomId)
        // Like main: an OpenRouter shelf model is the cloud's choice only, never the room's record.
        const roomModel = parseMatrixModel(command.model)

        store.emit({
          ...store.current,
          rooms: store.current.rooms.map(each =>
            each.id === command.roomId
              ? { ...each, ...(roomModel ? { model: roomModel } : {}), ...(command.effort ? { effort: command.effort } : {}) }
              : each
          ),
          agents: store.current.agents?.map(agent =>
            agent.principal === room?.agentPrincipal && agent.answering === 'cloud' && command.model
              ? {
                  ...agent,
                  cloudModel: {
                    ...agent.cloudModel,
                    offered: agent.cloudModel?.offered ?? ['default'],
                    current: command.model === 'nguyet-thuc' ? 'default' : command.model
                  }
                }
              : agent
          )
        })

        return { status: 'applied' }
      }

      if (command.kind === 'groupPolicy') {
        // Fixture only: native IPC/SDK enforce owner, roster and bounds in production.
        const current: GroupPolicyRead = groupPolicies.get(command.roomId) ?? {
          policy: {
            v: 1,
            agents: Object.fromEntries((store.current.agents ?? []).map(agent => [agent.userId, { mode: 'joins' }])),
            dailyTurns: 30
          },
          usage: { v: 1, day: new Date().toISOString().slice(0, 10), turns: 12 }
        }

        const change = command.change

        const policy = change
          ? 'agentId' in change
            ? { ...current.policy, agents: { ...current.policy.agents, [change.agentId]: { mode: change.mode } } }
            : 'dailyTurns' in change
              ? { ...current.policy, dailyTurns: change.dailyTurns }
              : { ...current.policy, routingDisclosure: 1 as const }
          : current.policy

        const next = { ...current, policy }

        groupPolicies.set(command.roomId, next)

        return next
      }

      if (command.kind === 'select') {
        store.select(command.roomId)
      }

      // The first chat with the assistant, as the server would create it.
      if (command.kind === 'create' && command.direct && store.current.firstRunMarker) {
        return store.createAssistantRoom()
      }

      // The conversation menu and a failed send, answered as the SDK and sync would.
      if (command.kind === 'chatTitle') {
        store.updateRoom(command.roomId, { title: command.title || undefined })
      }

      // A group's shared name and topic, as the room state would sync back.
      if (command.kind === 'groupName') {
        store.updateRoom(command.roomId, { name: command.name, title: undefined })
      }

      if (command.kind === 'groupTopic') {
        store.updateRoom(command.roomId, { topic: command.topic || undefined })
      }

      if (command.kind === 'chatLook') {
        store.updateRoom(command.roomId, { look: command.look })
      }

      if (command.kind === 'mute') {
        store.updateRoom(command.roomId, { muted: command.muted })
      }

      if (command.kind === 'favourite') {
        store.updateRoom(command.roomId, {
          favourite: command.favourite,
          ...(command.favourite ? { lowPriority: undefined } : {})
        })
      }

      if (command.kind === 'lowPriority') {
        store.updateRoom(command.roomId, {
          lowPriority: command.lowPriority || undefined,
          ...(command.lowPriority ? { favourite: false } : {})
        })
      }

      if (command.kind === 'leave' || command.kind === 'forget') {
        store.leave(command.roomId)
      }

      // Matrix's own message features, answered as the SDK and sync would.
      if (command.kind === 'markUnread') {
        store.updateRoom(command.roomId, {
          markedUnread: command.unread || undefined,
          unreadNotifications: 0,
          highlights: 0,
          unread: false
        })
      }

      if (command.kind === 'react') {
        store.react(command.eventId, command.key, command.reacted)
      }

      if (command.kind === 'send') {
        store.sent(command.body, command.replyTo)
      }

      if (command.kind === 'forward') {
        return '$playground-forwarded'
      }

      if (command.kind === 'edit') {
        store.updateMessage(command.eventId, message => ({ ...message, body: command.body, edited: true }))
      }

      if (command.kind === 'redact') {
        store.updateMessage(command.eventId, message => ({
          ...message,
          body: '',
          redacted: true,
          reactions: undefined,
          edited: undefined
        }))
      }

      if (command.kind === 'resend' || command.kind === 'discard') {
        store.unsent(command.eventId, command.kind === 'resend')
      }

      // Discover and apps are destinations: the window follows them as it does from main.
      if (command.kind === 'discoverApps') {
        store.emit({ ...store.current, destination: { kind: 'discover' } })
      }

      if (command.kind === 'selectApp') {
        store.emit({ ...store.current, destination: { kind: 'app', appId: command.appId } })
      }

      // Recovery and devices, scripted: a sample key (never a real one) and a short wait.
      if (command.kind === 'devices') {
        const me = store.current.identity

        // Named as the server reports them (a phone app sets its own name; one never did).
        return command.userId === me?.userId
          ? [
              { ...me, fingerprint: '', verified: true, lastSeenAt: Date.now() },
              {
                userId: me.userId,
                deviceId: 'KXQWPRTZLM',
                fingerprint: '',
                verified: true,
                name: 'Element X · iPhone',
                lastSeenAt: Date.now() - 3 * 3_600_000
              },
              {
                userId: me.userId,
                deviceId: 'HBNVCEUYTD',
                fingerprint: '',
                verified: false,
                lastSeenAt: Date.now() - 9 * 86_400_000
              }
            ]
          : [{ userId: command.userId, deviceId: 'PLMOKNIJUH', fingerprint: '', verified: false }]
      }

      if (command.kind === 'recoveryCreateKey') {
        return { id: 'playground-key', key: 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666' }
      }

      if (command.kind === 'recoverySetUp' || command.kind === 'recoveryRestore') {
        const restored = command.kind === 'recoveryRestore' ? 128 : undefined
        store.emit({ ...store.current, security: { recovery: 'working' } })
        setTimeout(() => store.emit({ ...store.current, security: { recovery: 'ready', restored } }), 1400)
      }

      return null
    },
    attend: async roomId => store.attend(roomId),
    typing: async () => null,
    openLink: noop,
    // The companion: Gigi as an older account's stand-in (`pet-fixtures.ts`).
    pets: playgroundPets(),
    subscribe: listener => store.subscribe(listener)
  }
}

/**
 * Reporting and updates as main reports them (dev only): sharing on, as a fresh install
 * has it, and `?update=ready` for a downloaded update. Nothing leaves the page.
 */
export function playgroundDesktopServices(
  update: 'downloaded' | 'idle',
  currentVersion = '2.0.0',
  checked = true
): NonNullable<Window['atumDesktopServices']> {
  const listeners = new Set<(status: MatrixDesktopServicesStatus) => void>()

  let status: MatrixDesktopServicesStatus = {
    busy: false,
    // Sharing is opt-in: a fresh install starts with it off.
    reporting: { configured: true, diagnosticId: '7f3a-92c1-5be0', enabled: true },
    update: {
      channel: 'latest',
      progress: null,
      notes: [],
      error: null,
      requiredBelow: null,
      armed: true,
      checkedAt: checked ? Date.now() : null,
      packaged: true,
      state: update,
      version: update === 'downloaded' ? '2.0.1' : null
    },
    version: currentVersion
  }

  const publish = (next: MatrixDesktopServicesStatus) => {
    status = next
    listeners.forEach(listener => listener(status))

    return status
  }

  return {
    active: () => {},
    setUpdateChannel: async channel => {
      if (channel !== 'latest' && channel !== 'beta') {
        return false
      }

      publish({ ...status, update: { ...status.update, channel } })

      return true
    },
    checkUpdates: async () => {
      publish({ ...status, update: { ...status.update, state: 'checking' } })
      setTimeout(() => publish({ ...status, update: { ...status.update, checkedAt: Date.now(), state: 'idle' } }), 1200)

      return true
    },
    error: () => {},
    feedback: async () => {
      await new Promise(resolve => setTimeout(resolve, 600))

      return { sent: true }
    },
    onChanged: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    ready: () => {},
    restart: async () => false,
    setEnabled: async enabled => publish({ ...status, reporting: { ...status.reporting, enabled } }),
    status: async () => status
  }
}
