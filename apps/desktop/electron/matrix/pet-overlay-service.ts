import { randomUUID } from 'node:crypto'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixPetChatRef, type MatrixPetTarget, type MatrixPetView } from '../../shared/matrix-pet'
import type { MatrixPetOverlayAction, MatrixPetOverlaySnapshot } from '../../shared/matrix-pet-overlay'
import { petChatAnswered, petChatUnsaved } from '../../shared/pet-chat-thread'
import type {
  AtumPetChatHistoryResult,
  AtumPetChatRef,
  AtumPetChatResult,
  AtumPetChatTurn
} from '../../shared/pet-chat/atum-pet-chat'
import { petChatCommand } from '../../shared/pet-engine/chat-action'
import { petWorkFor } from '../../src/matrix/pet/presentation'

import { type MatrixPetOverlayData, type MatrixPetOverlayHost, MatrixPetOverlays } from './pet-overlay'
import type { MatrixPetDisplay } from './pet-overlay-preferences'

export interface MatrixPetOverlayContext {
  accountKey: string
  scope: string
  locale: MatrixPetOverlaySnapshot['locale']
  reducedMotion: boolean
  dark?: boolean
  snapshot: MatrixSnapshot
}

export interface MatrixPetOverlayPorts {
  context(): MatrixPetOverlayContext | undefined
  read(target: MatrixPetTarget): Promise<MatrixPetView>
  /** Resolves only the enrolled agent's private owner room from native facts. */
  room(agent: string): string | undefined
  /** Pet-scoped companion chat; the overlay never names a room or agent. */
  chat(input: {
    ref: AtumPetChatRef
    message_id: string
    message: string
    locale: MatrixPetOverlayContext['locale']
  }): Promise<AtumPetChatResult>
  history(ref: AtumPetChatRef): Promise<AtumPetChatHistoryResult>
  action(target: MatrixPetTarget, action: MatrixPetOverlayAction): Promise<void>
}

interface Binding {
  target: MatrixPetTarget
  view: MatrixPetView
  ref: AtumPetChatRef
  recent: AtumPetChatTurn[]
  /** Every turn answered while this overlay is bound; what the history lacks is shown, never stored. */
  session: AtumPetChatTurn[]
  reply?: { text: string; at: number }
  refreshing?: boolean
}

/** Joins the window registry to the native pet reader and the pet's own chat. */
export class MatrixPetOverlayService {
  readonly windows: MatrixPetOverlays
  private readonly bindings = new Map<string, Binding>()
  private timer?: ReturnType<typeof setInterval>
  private epoch = 0
  private disposed = false
  private readonly pending = new Map<string, object>()

  constructor(
    private readonly ports: MatrixPetOverlayPorts,
    private readonly display: MatrixPetDisplay,
    host: Omit<MatrixPetOverlayHost, 'submit' | 'action' | 'restore' | 'remember'>
  ) {
    this.windows = new MatrixPetOverlays({
      ...host,
      restore: key => display.position(key),
      remember: (key, point) => display.remember(key, point),
      submit: (key, text) => this.submit(key, text),
      action: (key, action) => ports.action(this.current(key).binding.target, action)
    })
    this.windows.setShowReplyExcerpt(display.read().showReplyExcerpt)
  }

  readPreferences() {
    return this.display.read()
  }

  writePreferences(value: unknown) {
    const preferences = this.display.write(value)
    this.windows.setShowReplyExcerpt(preferences.showReplyExcerpt)

    return preferences
  }

  async open(target: MatrixPetTarget) {
    const context = this.ports.context()

    if (
      this.disposed ||
      !context ||
      !target ||
      target.scope !== context.scope ||
      typeof target.agent !== 'string' ||
      !this.ports.room(target.agent)
    ) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    const key = JSON.stringify([context.accountKey, target.agent])
    const epoch = this.epoch
    const request = {}
    this.pending.set(key, request)
    let view: MatrixPetView

    try {
      view = await this.ports.read({ scope: target.scope, agent: target.agent })
    } catch (error) {
      if (this.pending.get(key) === request) {
        this.pending.delete(key)
      }

      throw error
    }

    const currentRequest = this.pending.get(key) === request

    if (currentRequest) {
      this.pending.delete(key)
    }

    if (
      !currentRequest ||
      this.epoch !== epoch ||
      this.ports.context()?.scope !== context.scope ||
      !this.ports.room(target.agent)
    ) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    const ref = matrixPetChatRef(view)

    if (!ref) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    const binding: Binding = {
      target: { scope: context.scope, agent: target.agent },
      view,
      ref,
      recent: [],
      session: []
    }

    const data = this.data(binding)
    this.bindings.set(key, binding)

    try {
      this.windows.open({ ...data, agentKey: key })
    } catch (error) {
      this.bindings.delete(key)
      throw error
    }

    void this.loadHistory(key, binding)
    this.observe()
    this.timer ??= setInterval(() => {
      this.observe()

      for (const [key, each] of this.bindings) {
        void this.refresh(key, each)
      }
    }, 15_000)
  }

  observe() {
    for (const [key, binding] of this.bindings) {
      if (!this.windows.has(key)) {
        this.bindings.delete(key)

        continue
      }

      try {
        this.current(key)
        this.windows.update({ ...this.data(binding), agentKey: key })
      } catch {
        this.windows.close(key)
        this.bindings.delete(key)
      }
    }

    if (!this.bindings.size) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  clear() {
    this.epoch += 1
    this.pending.clear()
    clearInterval(this.timer)
    this.timer = undefined

    for (const key of this.bindings.keys()) {
      this.windows.close(key)
    }

    this.bindings.clear()
  }

  dispose() {
    this.disposed = true
    this.clear()
    this.windows.dispose()
  }

  private current(key: string) {
    const binding = this.bindings.get(key)
    const context = this.ports.context()
    const room = binding && this.ports.room(binding.target.agent)

    if (!binding || !context || context.scope !== binding.target.scope || !room || !this.windows.has(key)) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    return { binding, context, room }
  }

  private data(binding: Binding): Omit<MatrixPetOverlayData, 'agentKey'> {
    const context = this.ports.context()
    const room = this.ports.room(binding.target.agent)
    const until = binding.view.visitEndsAt ?? binding.view.selection.visitEndsAt

    if (
      !context ||
      context.scope !== binding.target.scope ||
      !room ||
      !binding.view.sprite?.enabled ||
      (until && Date.parse(until) <= Date.now())
    ) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    return {
      sprite: binding.view.sprite,
      dark: context.dark,
      locale: context.locale,
      reducedMotion: context.reducedMotion,
      work: petWorkFor({ ...context.snapshot, roomId: room }),
      recent: binding.recent,
      unsaved: petChatUnsaved(binding.recent, binding.session),
      reply: binding.reply
    }
  }

  private async loadHistory(key: string, binding: Binding) {
    try {
      const result = await this.ports.history(binding.ref)

      if (!result.ok || this.bindings.get(key) !== binding) {
        return
      }

      this.current(key)
      binding.recent = result.history.recent
      this.windows.update({ ...this.data(binding), agentKey: key })
    } catch {
      /* History is a convenience; the composer still works without it. */
    }
  }

  private async refresh(key: string, binding: Binding) {
    if (binding.refreshing) {
      return
    }

    binding.refreshing = true

    try {
      const view = await this.ports.read(binding.target)

      if (this.bindings.get(key) !== binding) {
        return
      }

      this.current(key)
      binding.view = view
      this.windows.update({ ...this.data(binding), agentKey: key })
    } catch {
      if (this.bindings.get(key) === binding) {
        this.windows.close(key)
        this.bindings.delete(key)
      }
    } finally {
      binding.refreshing = false
    }
  }

  private async submit(key: string, text: string) {
    const { binding, context } = this.current(key)
    const sentAt = new Date().toISOString()

    const result = await this.ports.chat({
      ref: binding.ref,
      message_id: randomUUID(),
      message: text,
      locale: context.locale
    })

    const current = this.current(key)

    if (current.binding !== binding) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    if (result.ok !== true) {
      throw new Error(result.code)
    }

    // `reply` is the answer; `recent` is only the pet's stored history, which a first chat or
    // the platform's fallback leaves without this exchange. Show the answer either way.
    binding.recent = result.reply.recent
    binding.session = petChatAnswered(
      binding.session,
      { text, at: sentAt },
      { text: result.reply.reply, at: new Date().toISOString() }
    )
    binding.reply = { text: result.reply.reply, at: Date.now() }
    this.windows.update({ ...this.data(binding), agentKey: key })
    const command = petChatCommand(result.reply.action)

    if (command) {
      this.windows.applyCommand(key, command)
    }
  }
}
