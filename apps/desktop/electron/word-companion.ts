import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { WORD_COMPANION_CHANNELS, type WordBindRequest, type WordCompanionCapture, type WordCompanionDescriptor, type WordDocumentInventory, type WordDocumentRequest, type WordDocumentRequestRef } from '../shared/word-companion'

import type { WordBounds, WordWindowSnapshot } from './word-companion-mac'
import type { WordLiveReplacement, WordLiveSnapshot } from './word-live-mac'

interface CompanionWindow {
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

interface WordAdapter {
  open(path: string): Promise<WordWindowSnapshot>
  arrange(snapshot: WordWindowSnapshot, bounds: WordBounds): Promise<void>
  inspect(snapshot: WordWindowSnapshot): Promise<{ saved: boolean }>
  restore(snapshot: WordWindowSnapshot): Promise<void>
  listDocuments?(): Promise<Array<{ path: string; name: string; windowNumber: number }>>
  bind?(path: string, windowNumber?: number): Promise<WordWindowSnapshot>
  bringToFront?(snapshot: WordWindowSnapshot): Promise<void>
}

interface Binding {
  descriptor: WordCompanionDescriptor
  owner: string
  authority: string
  word: WordWindowSnapshot
  snapshot?: WordCompanionCapture
  agentScope?: string
  requests?: Set<string>
  uncertain?: boolean
}

interface Pair extends Binding {
  window: CompanionWindow
  bounds: WordBounds
  maximized: boolean
  minimumSize: number[]
}

export interface WordCompanionDependencies {
  beforeOpen?(): Promise<void>
  window(): CompanionWindow | null
  /** Throws while signed out/quiescing; generation is part of this key. */
  authority(): string
  authorizePath(requested: unknown): string
  live: {
    read(pair: WordWindowSnapshot): Promise<WordLiveSnapshot>
    replace(pair: WordWindowSnapshot, edit: WordLiveReplacement): Promise<WordLiveSnapshot>
  }
  resolveRequest(request: WordDocumentRequestRef): Promise<unknown>
  workArea(bounds: WordBounds): WordBounds
  word: WordAdapter
  ended(id: string): void
  bindingEnded?(id: string): void
}

/** Normal desktop windows, in display-local DIPs. No full-screen Space. */
export function wordCompanionLayout(area: WordBounds): { chat: WordBounds; word: WordBounds } {
  if (area.width < 1000 || area.height < 500) {throw new Error('WORD_SCREEN_TOO_SMALL')}
  const gap = 8
  const chatWidth = Math.max(360, Math.round((area.width - gap) * 0.35))

  return {
    chat: { ...area, width: chatWidth },
    word: { ...area, x: area.x + chatWidth + gap, width: area.width - chatWidth - gap }
  }
}

/** Serializes native operations; cancellation invalidates before any await. */
export class WordCompanionController {
  private pair: Pair | null = null
  private binding: Binding | null = null
  private bindingGeneration = 0
  private bindingIntent: { id: string; owner: string } | null = null
  private inventoryGeneration = 0
  private candidates = new Map<string, { owner: string; authority: string; path: string; windowNumber: number }>()
  private intent: { id: string; owner: string } | null = null
  private generation = 0
  private pending = 0
  private tail: Promise<unknown> = Promise.resolve()
  private refreshTask: Promise<void> | null = null
  private lastRefreshAt = -Infinity

  constructor(private readonly deps: WordCompanionDependencies) {}

  isActive(): boolean {return Boolean(this.pair || this.binding || this.pending)}

  /** Layout callers must not mistake a content-only link for a geometry owner. */
  isArranged(): boolean {return Boolean(this.pair || this.pending)}

  async listDocuments(owner: string): Promise<WordDocumentInventory> {
    const authority = this.deps.authority()
    const generation = ++this.inventoryGeneration
    this.candidates.clear()

    if (!this.deps.word.listDocuments) {return { documents: [], reason: 'unavailable' }}

    try {
      const documents = await this.deps.word.listDocuments()

      if (generation !== this.inventoryGeneration || authority !== this.deps.authority()) {throw new Error('WORD_OPEN_CANCELLED')}

      return { documents: documents.slice(0, 256).map(document => {
        const id = randomUUID()
        this.candidates.set(id, { owner, authority, path: document.path, windowNumber: document.windowNumber })

        return { id, name: document.name.slice(0, 512), path: document.path.slice(0, 4096) }
      }) }
    } catch (error) {
      return { documents: [], reason: String(error).includes('WORD_AUTOMATION_DENIED') ? 'permission' : 'unavailable' }
    }
  }

  /** Prepare the exact open document; this operation owns no window geometry. */
  async bind(owner: string, request: WordBindRequest): Promise<WordCompanionDescriptor> {
    if (!request || typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(request.requestId) ||
      Boolean(request.candidateId) === Boolean(request.path)) {throw new Error('WORD_INVALID_REQUEST')}

    const authority = this.deps.authority()
    const candidate = request.candidateId ? this.candidates.get(request.candidateId) : undefined

    if (request.candidateId && (!candidate || candidate.owner !== owner || candidate.authority !== authority)) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
    const target = this.deps.authorizePath(candidate?.path ?? request.path)

    if (!/\.(doc|docx)$/iu.test(target) || !this.deps.word.bind) {throw new Error('WORD_UNSUPPORTED_FILE')}
    const generation = ++this.bindingGeneration
    this.bindingIntent = { id: request.requestId, owner }
    const valid = () => generation === this.bindingGeneration && authority === this.deps.authority()

    try {
      return await this.enqueue(async () => {
        if (!valid() || this.deps.authorizePath(target) !== target) {throw new Error('WORD_OPEN_CANCELLED')}
        const word = await this.deps.word.bind!(target, candidate?.windowNumber)

        if (!valid() || word.path !== target || (candidate && word.windowNumber !== candidate.windowNumber)) {throw new Error('WORD_OPEN_CANCELLED')}
        const previous = this.binding
        const binding: Binding = { descriptor: { id: request.requestId, path: target, name: path.basename(target) }, owner, authority, word }
        this.binding = binding

        if (previous) {this.deps.bindingEnded?.(previous.descriptor.id)}

        return binding.descriptor
      })
    } finally {
      if (this.bindingIntent?.id === request.requestId) {this.bindingIntent = null}
    }
  }

  async unbind(owner: string, id: unknown): Promise<void> {
    if (this.bindingIntent?.owner === owner && this.bindingIntent.id === id) {
      this.bindingGeneration += 1
      this.bindingIntent = null
    }

    const binding = this.binding

    if (!binding || binding.owner !== owner || binding.descriptor.id !== id) {return}
    this.bindingGeneration += 1
    this.binding = null
    this.deps.bindingEnded?.(binding.descriptor.id)
  }

  async bringToFront(owner: string, id: unknown): Promise<void> {
    const binding = this.binding
    this.assertBinding(binding, owner, id)
    await this.enqueue(async () => {
      this.assertBinding(binding, owner, id)

      if (!this.deps.word.bringToFront) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
      await this.deps.word.bringToFront(binding.word)
      this.assertBinding(binding, owner, id)
    })
  }

  async showBeside(owner: string, id: unknown): Promise<WordCompanionDescriptor> {
    const binding = this.binding
    this.assertBinding(binding, owner, id)
    const generation = ++this.generation
    const valid = () => generation === this.generation
    this.pending += 1

    try {
      await this.deps.beforeOpen?.()

      return await this.enqueue(async () => {
      this.assertBinding(binding, owner, id)

      if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}

      if (this.pair?.owner === owner && this.pair.word.path === binding.word.path && this.pair.word.windowNumber === binding.word.windowNumber) {
        const pair = this.pair
        await this.deps.word.bringToFront?.(binding.word)
        this.assertBinding(binding, owner, id)

        if (!valid() || this.pair !== pair) {throw new Error('WORD_OPEN_CANCELLED')}

        return pair.descriptor
      }

      await this.detach()
      const window = this.deps.window()

      if (!window || window.isDestroyed()) {throw new Error('WORD_WINDOW_UNAVAILABLE')}

      if (window.isFullScreen()) {throw new Error('WORD_EXIT_FULLSCREEN')}
      const layout = wordCompanionLayout(this.deps.workArea(window.getBounds()))
      const word = this.deps.word.bind ? await this.deps.word.bind(binding.word.path, binding.word.windowNumber) : binding.word
      this.assertBinding(binding, owner, id)

      const pair: Pair = { descriptor: { ...binding.descriptor, id: randomUUID() }, owner, authority: binding.authority, word,
        window, bounds: window.getNormalBounds(), maximized: window.isMaximized(), minimumSize: window.getMinimumSize() }

      try {
        if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}
        await this.deps.word.arrange(word, layout.word)
        this.assertBinding(binding, owner, id)

        if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}
        await this.deps.word.bringToFront?.(word)
        this.assertBinding(binding, owner, id)

        if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}
        this.pair = pair
        this.intent = { id: pair.descriptor.id, owner }

        if (pair.maximized) {window.unmaximize()}
        window.setMinimumSize(360, 480)
        window.setBounds(layout.chat)
        window.show()

        return pair.descriptor
      } catch (error) {
        if (this.pair === pair) {this.detachAtum()}
        await this.deps.word.restore(word).catch(() => undefined)
        throw error
      }
      })
    } finally {this.pending -= 1}
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => undefined)

    return result
  }

  private restoreAtum(pair: Pair): void {
    if (pair.window.isDestroyed()) {return}
    pair.window.setMinimumSize(pair.minimumSize[0], pair.minimumSize[1])
    pair.window.setBounds(pair.bounds)

    if (pair.maximized) {pair.window.maximize()}
  }

  private detachAtum(): Pair | null {
    const pair = this.pair

    if (!pair) {return null}
    this.pair = null
    this.deps.ended(pair.descriptor.id)
    this.restoreAtum(pair)

    return pair
  }

  private async detach(): Promise<void> {
    const pair = this.detachAtum()

    if (!pair) {return}
    // A closed/renamed Word window must never prevent restoring Atum. The
    // adapter only restores the original view number if its path still matches.
    await this.deps.word.restore(pair.word).catch(() => undefined)
  }

  async open(owner: string, requested: unknown, requestId: unknown): Promise<WordCompanionDescriptor> {
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(requestId)) {throw new Error('WORD_INVALID_REQUEST')}
    const target = this.deps.authorizePath(requested)

    if (!/\.(doc|docx)$/iu.test(target)) {throw new Error('WORD_UNSUPPORTED_FILE')}
    const authority = this.deps.authority()
    const generation = ++this.generation
    this.intent = { id: requestId, owner }
    this.pending += 1
    const valid = () => generation === this.generation && authority === this.deps.authority()

    try {
      await this.deps.beforeOpen?.()

      return await this.enqueue(async () => {
        if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}
        await this.detach()

        if (!valid()) {throw new Error('WORD_OPEN_CANCELLED')}
        const window = this.deps.window()

        if (!window || window.isDestroyed()) {throw new Error('WORD_WINDOW_UNAVAILABLE')}

        if (window.isFullScreen()) {throw new Error('WORD_EXIT_FULLSCREEN')}
        const layout = wordCompanionLayout(this.deps.workArea(window.getBounds()))
        const bounds = window.getNormalBounds()
        const maximized = window.isMaximized()
        const minimumSize = window.getMinimumSize()

        // Re-prove the path after queued work; never open a swapped symlink.
        if (this.deps.authorizePath(target) !== target) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
        const word = await this.deps.word.open(target)

        const pair: Pair = { descriptor: { id: requestId, path: target, name: path.basename(target) }, owner, authority,
          word, window, bounds, maximized, minimumSize }

        let atumChanged = false

        try {
          if (!valid() || window.isDestroyed()) {throw new Error('WORD_OPEN_CANCELLED')}
          await this.deps.word.arrange(word, layout.word)

          if (!valid() || window.isDestroyed()) {throw new Error('WORD_OPEN_CANCELLED')}
          this.pair = pair
          atumChanged = true

          if (maximized) {window.unmaximize()}
          window.setMinimumSize(360, 480)
          window.setBounds(layout.chat)
          window.show()

          return pair.descriptor
        } catch (error) {
          this.pair = null

          if (atumChanged) {this.restoreAtum(pair)}
          await this.deps.word.restore(word).catch(() => undefined)
          throw error
        }
      })
    } finally {
      this.pending -= 1

      if (this.intent?.id === requestId && !this.pair) {this.intent = null}
    }
  }

  async end(owner: string, id: unknown): Promise<void> {
    if (typeof id !== 'string') {return}
    const isIntent = this.intent?.owner === owner && this.intent.id === id
    const isPair = this.pair?.owner === owner && this.pair.descriptor.id === id

    if (!isIntent && !isPair) {return}

    if (isIntent) {this.intent = null; this.generation += 1}
    await this.enqueue(async () => {
      if (this.pair?.owner === owner && this.pair.descriptor.id === id) {await this.detach()}
    })
  }

  async clearArrangement(): Promise<void> {
    this.generation += 1
    this.intent = null
    // Restore the product frame synchronously, before another native geometry
    // owner (notably the auth window) can snapshot the companion frame.
    const pair = this.detachAtum()
    await this.enqueue(async () => {
      if (pair) {await this.deps.word.restore(pair.word).catch(() => undefined)}
    })
  }

  /** On returning to Atum, drop a Word window that was closed or rebound by Save As. */
  async clear(): Promise<void> {
    this.bindingGeneration += 1
    this.bindingIntent = null
    this.inventoryGeneration += 1
    this.candidates.clear()
    const binding = this.binding
    this.binding = null

    if (binding) {this.deps.bindingEnded?.(binding.descriptor.id)}
    await this.clearArrangement()
  }

  /** Refresh both lifetimes without moving a content-only link. */
  refresh(): Promise<void> {
    if (this.refreshTask) {return this.refreshTask}
    const pair = this.pair
    const binding = this.binding

    if ((!pair && !binding) || this.pending || Date.now() - this.lastRefreshAt < 500) {return Promise.resolve()}
    this.lastRefreshAt = Date.now()

    const task = this.enqueue(async () => {
      if (binding && this.binding === binding) {
        try {
          if (binding.authority !== this.deps.authority()) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
          await this.deps.word.inspect(binding.word)
        } catch (error) {
          if (this.binding === binding && String(error).includes('WORD_DOCUMENT_UNAVAILABLE')) {
            this.binding = null
            this.bindingGeneration += 1
            this.deps.bindingEnded?.(binding.descriptor.id)
          }
        }
      }

      if (!pair) {return}

      if (this.pair !== pair || this.pending) {return}
      let unavailable = false

      try {
        await this.deps.word.inspect(pair.word)
      } catch (error) {
        unavailable = String(error).includes('WORD_DOCUMENT_UNAVAILABLE')
      }

      if (this.pair !== pair || this.pending) {return}

      try {unavailable ||= pair.authority !== this.deps.authority()} catch {unavailable = true}

      if (unavailable) {
        this.generation += 1
        this.intent = null
        await this.detach()
      }
    })

    this.refreshTask = task.finally(() => {this.refreshTask = null})

    return this.refreshTask
  }

  async capture(owner: string, id: unknown) {
    const pair = this.binding ?? this.pair
    this.assertBinding(pair, owner, id)

    return this.enqueue(async () => {
      this.assertBinding(pair, owner, id)
      const value = await this.deps.live.read(pair.word)
      this.assertBinding(pair, owner, id)

      return this.retainSnapshot(pair, value)
    })
  }

  private assertBinding(pair: Binding | null, owner: string, id: unknown): asserts pair is Binding {
    if (!pair || pair !== (this.binding ?? this.pair) || pair.owner !== owner || pair.descriptor.id !== id ||
      pair.authority !== this.deps.authority() || (pair === this.pair && this.intent?.id !== id)) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
  }

  private retainSnapshot(pair: Binding, value: WordLiveSnapshot): WordCompanionCapture {
    const snapshot = { ...value, revision: randomUUID() }
    pair.snapshot = snapshot

    return snapshot
  }

  async execute(owner: string, id: unknown, ref: WordDocumentRequestRef): Promise<WordCompanionCapture> {
    const pair = this.binding ?? this.pair
    this.assertBinding(pair, owner, id)

    if (!ref || ['profile', 'request_id', 'session_id', 'turn_id'].some(key =>
      typeof ref[key as keyof WordDocumentRequestRef] !== 'string' || !ref[key as keyof WordDocumentRequestRef] ||
      ref[key as keyof WordDocumentRequestRef].length > 256)) {throw new Error('WORD_INVALID_REQUEST')}

    const requestKey = `${ref.profile}:${ref.request_id}`
    pair.requests ??= new Set()

    if (pair.requests.has(requestKey)) {throw new Error('WORD_REQUEST_ALREADY_USED')}
    pair.requests.add(requestKey)

    return this.enqueue(async () => {
      this.assertBinding(pair, owner, id)
      const request = await this.deps.resolveRequest(ref) as WordDocumentRequest | null
      this.assertBinding(pair, owner, id)

      if (!request || request.session_id !== ref.session_id || request.turn_id !== ref.turn_id ||
        !Number.isFinite(request.expires_at) || request.expires_at * 1000 <= Date.now() ||
        typeof request.durable_session_id !== 'string' || !request.durable_session_id) {throw new Error('WORD_TURN_UNAVAILABLE')}

      const scope = JSON.stringify([ref.profile, request.durable_session_id])

      if (pair.agentScope && pair.agentScope !== scope) {throw new Error('WORD_CONVERSATION_CHANGED')}
      pair.agentScope = scope

      if (request.action === 'read') {
        const value = await this.deps.live.read(pair.word)
        this.assertBinding(pair, owner, id)

        return this.retainSnapshot(pair, value)
      }

      if (request.action !== 'replace_text') {throw new Error('WORD_INVALID_EDIT')}

      if (pair.uncertain) {throw new Error('WORD_EDIT_UNCERTAIN')}
      const snapshot = pair.snapshot

      if (!snapshot || request.revision !== snapshot.revision) {throw new Error('WORD_CONTENT_CHANGED')}
      // Spend before dispatch, including failures. A delayed duplicate request
      // can never replay a write after Undo or after a lost receipt.
      pair.snapshot = undefined

      try {
        const value = await this.deps.live.replace(pair.word, { expectedText: snapshot.text,
          find: request.find ?? '', replacement: request.replacement ?? '' })

        try {this.assertBinding(pair, owner, id)} catch {throw new Error('WORD_EDIT_UNCERTAIN')}

        return { ...this.retainSnapshot(pair, value), applied: true }
      } catch (error) {
        if (String(error).includes('WORD_EDIT_UNCERTAIN')) {pair.uncertain = true}
        throw error
      }
    })
  }
}

export function registerWordCompanionIpc(ipc: Pick<IpcMain, 'handle'>, controller: WordCompanionController,
  assertSender: (event: IpcMainInvokeEvent) => void): void {
  ipc.handle(WORD_COMPANION_CHANNELS.listDocuments, event => {
    assertSender(event)

    return controller.listDocuments(String(event.sender.id))
  })
  ipc.handle(WORD_COMPANION_CHANNELS.bind, (event, request) => {
    assertSender(event)

    return controller.bind(String(event.sender.id), request)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.unbind, (event, id) => {
    assertSender(event)

    return controller.unbind(String(event.sender.id), id)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.showBeside, (event, id) => {
    assertSender(event)

    return controller.showBeside(String(event.sender.id), id)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.bringToFront, (event, id) => {
    assertSender(event)

    return controller.bringToFront(String(event.sender.id), id)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.open, (event, filePath, requestId) => {
    assertSender(event)

    return controller.open(String(event.sender.id), filePath, requestId)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.end, (event, id) => {
    assertSender(event)

    return controller.end(String(event.sender.id), id)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.capture, (event, id) => {
    assertSender(event)

    return controller.capture(String(event.sender.id), id)
  })
  ipc.handle(WORD_COMPANION_CHANNELS.execute, (event, id, request) => {
    assertSender(event)

    return controller.execute(String(event.sender.id), id, request)
  })
}
