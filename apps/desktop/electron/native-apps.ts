import type { NativeAppEntry, NativeAppLaunchRequest, NativeAppLaunchResult } from '../shared/skills-launcher'
import { officeFileMatches, officeKindForBundle } from '../shared/skills-launcher'

import type { NativeWindowSnapshot, NativeWindowTarget } from './native-app-window'
import { wordCompanionLayout } from './word-companion'
import type { WordBounds } from './word-companion-mac'

interface ChatWindow {
  isDestroyed(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  getNormalBounds(): WordBounds
  getBounds(): WordBounds
  getMinimumSize(): number[]
  setMinimumSize(width: number, height: number): void
  unmaximize(): void
  maximize(): void
  setBounds(bounds: WordBounds): void
  show(): void
}
interface ResolvedApp extends NativeWindowTarget { entry: NativeAppEntry }
interface Pair {
  id: string
  target: ResolvedApp
  native: NativeWindowSnapshot
  chat: ChatWindow
  bounds: WordBounds
  minimum: number[]
  maximized: boolean
}
export interface NativeAppsDependencies {
  inventory: {
    resolve(id: string): Promise<ResolvedApp>
    launch(id: string, documentPath?: string): Promise<ResolvedApp>
  }
  windows: {
    list(target: ResolvedApp): Promise<NativeWindowSnapshot[]>
    arrange(target: ResolvedApp, window: NativeWindowSnapshot, bounds: WordBounds): Promise<void>
    restore(target: ResolvedApp, window: NativeWindowSnapshot): Promise<void>
  }
  window(): ChatWindow | null
  authority(): string
  authorizePath(path: unknown): string
  workArea(bounds: WordBounds): WordBounds
  beforeLaunch(): Promise<void>
  ended(id: string): void
}

/** One geometry association; launching never grants document-content access. */
export class NativeAppsController {
  private pair: Pair | null = null
  private generation = 0
  private pending = 0
  private tail: Promise<unknown> = Promise.resolve()
  private intent: string | null = null
  private choices: { id: string; authority: string; appId: string; ids: number[] } | null = null
  private refreshTask: Promise<void> | null = null
  private lastRefreshAt = 0

  constructor(private readonly deps: NativeAppsDependencies) {}

  isActive() {return Boolean(this.pair || this.pending)}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => undefined)

    return result
  }

  private detachChat() {
    const pair = this.pair
    this.pair = null

    if (!pair) {return null}
    this.deps.ended(pair.id)

    if (!pair.chat.isDestroyed()) {
      pair.chat.setMinimumSize(pair.minimum[0], pair.minimum[1])
      pair.chat.setBounds(pair.bounds)

      if (pair.maximized) {pair.chat.maximize()}
    }

    return pair
  }

  clear(): Promise<void> {
    this.generation += 1
    this.choices = null
    const id = this.intent
    this.intent = null
    const pair = this.detachChat()

    if (id && !pair) {this.deps.ended(id)}

    return this.enqueue(async () => {
      if (pair) {await this.deps.windows.restore(pair.target, pair.native).catch(() => undefined)}
    })
  }

  end(id: string) {return id === this.intent || id === this.pair?.id ? this.clear() : Promise.resolve()}

  async launch(request: NativeAppLaunchRequest): Promise<NativeAppLaunchResult> {
    if (!request || !/^[0-9a-f-]{36}$/iu.test(request.requestId) || !['beside', 'normal'].includes(request.mode) ||
      typeof request.appId !== 'string') {throw new Error('NATIVE_APP_INVALID_REQUEST')}

    const authority = this.deps.authority()
    const choice = this.choices

    if (request.windowId !== undefined && (!Number.isInteger(request.windowId) || !choice ||
      choice.id !== request.requestId || choice.appId !== request.appId || choice.authority !== authority ||
      !choice.ids.includes(request.windowId))) {throw new Error('NATIVE_APP_WINDOW_UNAVAILABLE')}

    const cleared = this.clear()
    const generation = ++this.generation
    this.intent = request.requestId
    this.pending += 1
    const valid = () => generation === this.generation && authority === this.deps.authority()

    try {
      await cleared

      if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}
      // Keep cross-companion cleanup outside this queue: Word uses the same
      // sequence, so simultaneous clicks cannot deadlock each other's tails.
      await this.deps.beforeLaunch()

      return await this.enqueue(async () => {
        if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}
        const documentPath = request.documentPath === undefined ? undefined : this.deps.authorizePath(request.documentPath)
        const resolved = await this.deps.inventory.resolve(request.appId)

        if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}

        if (documentPath) {
          const kind = officeKindForBundle(resolved.entry.bundleId)

          if (!kind || !officeFileMatches(kind, documentPath)) {throw new Error('NATIVE_APP_INVALID_DOCUMENT')}
        }

        const target = request.windowId === undefined
          ? await this.deps.inventory.launch(request.appId, documentPath)
          : resolved

        const result = (status: NativeAppLaunchResult['status'], reason?: NativeAppLaunchResult['reason']): NativeAppLaunchResult =>
          ({ id: request.requestId, app: target.entry, status, ...(reason ? { reason } : {}) })

        if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}

        if (request.mode === 'normal') {return result('opened')}

        if (target.entry.bundleId === 'com.atum.desktop') {return result('opened', 'unsupported')}
        const chat = this.deps.window()

        if (!chat || chat.isDestroyed()) {return result('opened', 'unsupported')}

        if (chat.isFullScreen()) {return result('opened', 'fullscreen')}
        let candidates: NativeWindowSnapshot[]

        try {
          candidates = []

          // LaunchServices may return before the process is discoverable or
          // before it exposes a standard window. Both share one retry budget.
          for (let attempt = 0; attempt <= 8 && valid(); attempt += 1) {
            if (attempt) {await new Promise(resolve => setTimeout(resolve, 250))}

            try {candidates = await this.deps.windows.list(target)} catch (error) {
              if (!(error instanceof Error) || error.message !== 'unavailable') {throw error}
            }

            if (candidates.length) {break}
          }
        } catch (error) {
          return result('opened', error instanceof Error && error.message === 'permission' ? 'permission' : 'unsupported')
        }

        if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}
        const eligible = candidates.filter(window => !window.fullscreen && !window.minimized)

        if (eligible.length === 0) {return result('opened', candidates.some(window => window.fullscreen) ? 'fullscreen' : 'no-window')}

        const native = request.windowId === undefined ? eligible.length === 1 ? eligible[0] : null :
          eligible.find(window => window.id === request.windowId)

        if (!native) {
          if (request.windowId !== undefined) {throw new Error('NATIVE_APP_WINDOW_UNAVAILABLE')}
          this.choices = { id: request.requestId, authority, appId: request.appId, ids: eligible.map(window => window.id) }

          return { ...result('choose-window'), windows: eligible.map(({ id, title }) => ({ id, title })) }
        }

        let layout: ReturnType<typeof wordCompanionLayout>

        try {layout = wordCompanionLayout(this.deps.workArea(chat.getBounds()))} catch {return result('opened', 'unsupported')}

        const pair: Pair = { id: request.requestId, target, native, chat, bounds: chat.getNormalBounds(),
          minimum: chat.getMinimumSize(), maximized: chat.isMaximized() }

        try {
          await this.deps.windows.arrange(target, native, layout.word)

          if (!valid() || chat.isDestroyed()) {throw new Error('NATIVE_APP_CANCELLED')}
          this.pair = pair

          if (pair.maximized) {chat.unmaximize()}
          chat.setMinimumSize(360, 480)
          chat.setBounds(layout.chat)
          chat.show()

          return result('beside')
        } catch (error) {
          if (this.pair === pair) {this.detachChat()}
          await this.deps.windows.restore(target, native).catch(() => undefined)

          if (!valid()) {throw new Error('NATIVE_APP_CANCELLED')}

          return result('opened', error instanceof Error && error.message === 'permission' ? 'permission' : 'layout-failed')
        }
      })
    } finally {this.pending -= 1}
  }

  refresh(): Promise<void> {
    if (this.refreshTask) {return this.refreshTask}
    const pair = this.pair

    if (!pair || this.pending || Date.now() - this.lastRefreshAt < 500) {return Promise.resolve()}
    this.lastRefreshAt = Date.now()

    const task = this.enqueue(async () => {
      if (this.pair !== pair || this.pending) {return false}

      try {
        const windows = await this.deps.windows.list(pair.target)

        return !windows.some(window => window.id === pair.native.id)
      } catch (error) {return error instanceof Error && error.message === 'unavailable'}
    }).then(async unavailable => {
      // Clear outside the queue so restoration cannot wait on its own task.
      if (unavailable && this.pair === pair && !this.pending) {await this.clear()}
    })

    this.refreshTask = task.finally(() => {this.refreshTask = null})

    return this.refreshTask
  }
}
