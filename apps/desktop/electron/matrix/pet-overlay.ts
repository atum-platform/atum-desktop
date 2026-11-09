import { isDeepStrictEqual } from 'node:util'

import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, Screen } from 'electron'

import {
  MATRIX_PET_OVERLAY_IPC as IPC,
  type MatrixPetOverlayAction,
  type MatrixPetOverlaySnapshot
} from '../../shared/matrix-pet-overlay'
import type { PetInfo } from '../../shared/pet'
import type { AtumPetChatTurn } from '../../shared/pet-chat/atum-pet-chat'
import { createEngineState, decide } from '../../shared/pet-engine/decide'
import { integrate } from '../../shared/pet-engine/motion'
import { profileFor, stageSize } from '../../shared/pet-engine/profile'
import type { PetCommand, PetEngineState, PetSignals } from '../../shared/pet-engine/types'
import { petHitBox } from '../../src/matrix/pet/hit-box'
import { petScreenWorld } from '../../src/matrix/pet/screen-world'
import { cascadeBounds, retireesFor } from '../pet-overlay-registry'

import { parseMatrixPetOverlayInput, requireMatrixCaller } from './ipc-policy'

const PANEL_HEIGHT = 384
const PANEL_WIDTH = 320
const REPLY_TTL = 12_000
const REPLY_MAX = 160

export interface MatrixPetOverlayData {
  /** Native account/profile scoped key; never accepted from the overlay. */
  agentKey: string
  sprite: PetInfo
  locale: MatrixPetOverlaySnapshot['locale']
  work: PetSignals['work']
  reducedMotion: boolean
  dark?: boolean
  recent: AtumPetChatTurn[]
  unsaved: AtumPetChatTurn[]
  reply?: { text: string; at: number }
}

export interface MatrixPetOverlayHost {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  screen: Pick<Screen, 'getAllDisplays' | 'getCursorScreenPoint'>
  preload: string
  url: string
  signed: boolean
  /** Main revalidates the account generation and resolves the private target. */
  submit(agentKey: string, text: string): Promise<void>
  action(agentKey: string, action: MatrixPetOverlayAction): Promise<void> | void
  restore(agentKey: string): { x: number; y: number } | undefined
  remember(agentKey: string, point: { x: number; y: number }): void
  now?(): number
}

interface Entry {
  window: BrowserWindow
  data: MatrixPetOverlayData
  state: PetEngineState
  size: MatrixPetOverlaySnapshot['size']
  chatOpen: boolean
  lastActive: number
  worldSignature: string
  timer?: ReturnType<typeof setTimeout>
  pointerTimer?: ReturnType<typeof setInterval>
  drag?: { cursor: { x: number; y: number }; bounds: { x: number; y: number } }
}

/** Only a bounded excerpt under the explicit local preference crosses this window. */
export function matrixPetOverlayBubble(
  data: MatrixPetOverlayData,
  allowExcerpt: boolean,
  now: number
): MatrixPetOverlaySnapshot['bubble'] {
  if (data.work === 'waiting') {
    return { kind: 'yourTurn' }
  }

  if (data.work === 'failed') {
    return { kind: 'failed' }
  }

  if (!data.reply || now < data.reply.at || now - data.reply.at >= REPLY_TTL) {
    return undefined
  }

  if (allowExcerpt) {
    return { kind: 'excerpt', text: [...data.reply.text.replace(/\s+/gu, ' ').trim()].slice(0, REPLY_MAX).join('') }
  }

  return { kind: 'done' }
}

/** Native-owned engine and lifetime; the bundled page paints snapshots only. */
export class MatrixPetOverlays {
  private readonly entries = new Map<string, Entry>()
  private disposed = false
  private allowExcerpt = false

  constructor(private readonly host: MatrixPetOverlayHost) {
    for (const channel of [IPC.drag, IPC.click, IPC.menu, IPC.popIn, IPC.setInteractive, IPC.submit]) {
      host.ipc.handle(channel, (event, value) => this.receive(channel, event, value))
    }
  }

  /** One chat action, applied only to an open overlay of this exact pet. */
  applyCommand(agentKey: string, command: PetCommand) {
    const entry = this.entries.get(agentKey)

    if (entry && entry.chatOpen && !entry.window.isDestroyed()) {
      entry.lastActive = this.now()
      this.beat(entry, [command])
    }
  }

  setShowReplyExcerpt(value: boolean) {
    this.allowExcerpt = value === true

    for (const entry of this.entries.values()) {
      this.paint(entry)
    }
  }

  has(agentKey: string) {
    return this.entries.has(agentKey)
  }

  open(data: MatrixPetOverlayData) {
    if (this.disposed || !data.agentKey || !data.sprite.enabled || !data.sprite.spritesheetBase64) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    const existing = this.entries.get(data.agentKey)

    if (existing) {
      this.update(data)

      return
    }

    for (const key of retireesFor([...this.entries.keys()])) {
      this.close(key)
    }

    const size = stageSize({ w: data.sprite.frameW ?? 192, h: data.sprite.frameH ?? 208 }, data.sprite, 'overlay')
    const width = Math.ceil(Math.max(PANEL_WIDTH, size.width))
    const height = Math.ceil(PANEL_HEIGHT + size.height)
    const displays = this.host.screen.getAllDisplays()
    const first = displays[0]?.workArea

    const initial = cascadeBounds(
      this.host.restore(data.agentKey) ?? { x: first?.x ?? 0, y: (first?.y ?? 0) + (first?.height ?? height) - height },
      [...this.entries.values()].map(row => row.window.getBounds())
    )

    const world = petScreenWorld(displays, initial, width, height)

    if (!world || !world.world.free.length) {
      throw new Error('matrix_pet_overlay_unavailable')
    }

    const window = this.host.createWindow({
      x: Math.round(world.origin.x + world.point.x),
      y: Math.round(world.origin.y + world.point.y),
      width,
      height,
      frame: false,
      transparent: true,
      type: 'panel',
      focusable: false,
      show: false,
      resizable: false,
      movable: false,
      hiddenInMissionControl: true,
      webPreferences: {
        preload: this.host.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        partition: 'persist:matrix-pet',
        devTools: !this.host.signed,
        navigateOnDragDrop: false,
        backgroundThrottling: false
      }
    })

    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setIgnoreMouseEvents(true, { forward: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
      window.webContents.on(event as 'will-navigate', e => e.preventDefault())
    }

    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    const now = this.now()

    const entry: Entry = {
      window,
      data,
      size,
      chatOpen: false,
      lastActive: now,
      worldSignature: this.worldSignature(world),
      state: createEngineState({
        now,
        x: world.point.x,
        y: world.world.floorY,
        profile: profileFor(data.sprite.locomotion),
        stateRows: data.sprite.stateRows
      })
    }

    this.entries.set(data.agentKey, entry)
    window.once('closed', () => this.retire(data.agentKey, entry))
    window.webContents.once('did-finish-load', () => {
      if (this.entries.get(data.agentKey) !== entry) {
        return
      }

      this.beat(entry, [])
      window.showInactive()
    })
    entry.pointerTimer = setInterval(() => this.pointer(entry), 80)
    void window.loadURL(this.host.url).catch(() => {
      if (this.entries.get(data.agentKey) === entry) {
        this.close(data.agentKey)
      }
    })
  }

  update(data: MatrixPetOverlayData) {
    const entry = this.entries.get(data.agentKey)

    if (!entry) {
      return
    }

    if (!data.sprite.enabled) {
      this.close(data.agentKey)

      return
    }

    if (!isDeepStrictEqual(entry.data.sprite, data.sprite)) {
      this.close(data.agentKey)
      this.open(data)

      return
    }

    entry.data = data

    if (data.work !== 'idle') {
      entry.lastActive = this.now()
    }

    this.beat(entry, [])
  }

  close(agentKey: string) {
    const entry = this.entries.get(agentKey)

    if (!entry) {
      return
    }

    const { x, y } = entry.window.getBounds()
    this.remember(agentKey, { x, y })
    this.retire(agentKey, entry)
    entry.window.destroy()
  }

  dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true

    for (const key of [...this.entries.keys()]) {
      this.close(key)
    }

    for (const channel of [IPC.drag, IPC.click, IPC.menu, IPC.popIn, IPC.setInteractive, IPC.submit]) {
      this.host.ipc.removeHandler(channel)
    }
  }

  private retire(key: string, entry: Entry) {
    clearTimeout(entry.timer)
    clearInterval(entry.pointerTimer)

    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }

  private now() {
    return this.host.now?.() ?? Date.now()
  }

  private remember(key: string, point: { x: number; y: number }) {
    // Cosmetic persistence cannot keep a window alive across account teardown.
    try {
      this.host.remember(key, point)
    } catch {
      /* Next launch can use the default position. */
    }
  }

  private foot(entry: Entry) {
    return (
      (entry.size.height * (entry.data.sprite.anchor?.footY ?? entry.data.sprite.frameH ?? 208)) /
      (entry.data.sprite.frameH ?? 208)
    )
  }

  private worldSignature(screen: NonNullable<ReturnType<typeof petScreenWorld>>) {
    return `${screen.origin.x}:${screen.origin.y}:${screen.world.width}:${screen.world.floorY}`
  }

  private world(entry: Entry) {
    const bounds = entry.window.getBounds()

    return petScreenWorld(this.host.screen.getAllDisplays(), bounds, bounds.width, PANEL_HEIGHT + this.foot(entry))
  }

  private beat(entry: Entry, commands: readonly PetCommand[]) {
    clearTimeout(entry.timer)

    if (entry.window.isDestroyed() || entry.drag) {
      return
    }

    const screen = this.world(entry)

    if (!screen || !screen.world.free.length) {
      this.close(entry.data.agentKey)

      return
    }

    entry.worldSignature = this.worldSignature(screen)
    const now = this.now()
    entry.state = decide(
      { ...entry.state, now, x: screen.point.x },
      screen.world,
      {
        work: entry.data.work,
        idleMs: now - entry.lastActive,
        away: false,
        reducedMotion: entry.data.reducedMotion
      },
      commands,
      Math.random
    ).state
    this.paint(entry)
    this.schedule(entry)
  }

  private schedule(entry: Entry) {
    if (entry.state.motion) {
      entry.timer = setTimeout(() => {
        const now = this.now()
        const moved = integrate(entry.state, entry.state.intent, Math.max(0, now - entry.state.now))
        entry.state = { ...entry.state, ...moved, now, ...(moved.arrived ? { motion: undefined } : {}) }
        this.paint(entry)

        if (moved.arrived) {
          this.beat(entry, [])
        } else {
          this.schedule(entry)
        }
      }, 16)
    } else {
      const now = this.now()

      const replyExpiry =
        entry.data.reply && entry.data.reply.at <= now && entry.data.reply.at + REPLY_TTL > now
          ? entry.data.reply.at + REPLY_TTL
          : null

      const wakes = [entry.state.wakeAt, replyExpiry].filter((at): at is number => at !== null)

      if (wakes.length) {
        entry.timer = setTimeout(() => this.beat(entry, []), Math.max(1, Math.min(...wakes) - now))
      }
    }
  }

  private paint(entry: Entry) {
    if (entry.window.isDestroyed()) {
      return
    }

    const screen = this.world(entry)

    if (!screen) {
      return
    }

    const bounds = entry.window.getBounds()
    const foot = this.foot(entry)
    entry.window.setBounds({
      ...bounds,
      x: Math.round(screen.origin.x + entry.state.x),
      y: Math.round(screen.origin.y + entry.state.y - foot - PANEL_HEIGHT)
    })
    const direction = entry.state.motion ? (entry.state.motion.toX > entry.state.motion.fromX ? 1 : -1) : 0

    const snapshot: MatrixPetOverlaySnapshot = {
      sprite: entry.data.sprite,
      locale: entry.data.locale,
      size: entry.size,
      intent: {
        pose: entry.state.intent.pose,
        mirror: entry.state.intent.mirror,
        direction,
        paused:
          entry.data.reducedMotion || entry.chatOpen || (!entry.state.motion && entry.state.intent.pose === 'idle')
      },
      bubble: matrixPetOverlayBubble(entry.data, this.allowExcerpt, this.now()),
      recent: entry.data.recent,
      unsaved: entry.data.unsaved,
      chatOpen: entry.chatOpen,
      dark: entry.data.dark
    }

    entry.window.webContents.send(IPC.snapshot, snapshot)
  }

  private overPet(entry: Entry) {
    const point = this.host.screen.getCursorScreenPoint()
    const bounds = entry.window.getBounds()
    const hit = petHitBox(entry.data.sprite, entry.state.intent.pose, entry.size.zoom, entry.state.intent.mirror)
    const x = point.x - bounds.x - (bounds.width - entry.size.width) / 2
    const y = point.y - bounds.y - PANEL_HEIGHT

    return x >= hit.left && x < hit.left + hit.width && y >= hit.top && y < hit.top + hit.height
  }

  private pointer(entry: Entry) {
    if (entry.window.isDestroyed()) {
      return
    }

    if (entry.drag) {
      const point = this.host.screen.getCursorScreenPoint()
      const bounds = entry.window.getBounds()

      const target = {
        x: entry.drag.bounds.x + point.x - entry.drag.cursor.x,
        y: entry.drag.bounds.y + point.y - entry.drag.cursor.y
      }

      const screen = petScreenWorld(
        this.host.screen.getAllDisplays(),
        target,
        bounds.width,
        PANEL_HEIGHT + this.foot(entry)
      )

      if (screen) {
        entry.window.setBounds({
          ...bounds,
          x: Math.round(screen.origin.x + screen.point.x),
          y: Math.round(screen.origin.y + screen.point.y)
        })
      }
    } else {
      const screen = this.world(entry)

      if (!screen || !screen.world.free.length) {
        this.close(entry.data.agentKey)

        return
      }

      const bounds = entry.window.getBounds()

      if (
        entry.worldSignature !== this.worldSignature(screen) ||
        Math.round(screen.origin.x + screen.point.x) !== bounds.x ||
        Math.round(screen.origin.y + screen.point.y) !== bounds.y
      ) {
        entry.state = { ...entry.state, x: screen.point.x, y: screen.world.floorY, motion: undefined }
        this.beat(entry, [])
      }
    }

    const cursor = this.host.screen.getCursorScreenPoint()
    const bounds = entry.window.getBounds()
    const left = bounds.x + (bounds.width - PANEL_WIDTH) / 2

    const overPanel =
      entry.chatOpen &&
      cursor.x >= left &&
      cursor.x < left + PANEL_WIDTH &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + PANEL_HEIGHT

    entry.window.setIgnoreMouseEvents(!(entry.drag || overPanel || this.overPet(entry)), { forward: true })
  }

  private async receive(channel: string, event: IpcMainInvokeEvent, value: unknown) {
    const entry = [...this.entries.values()].find(row => row.window.webContents === event.sender)
    requireMatrixCaller(event, this.disposed ? undefined : entry?.window.webContents, this.host.url)
    const input = parseMatrixPetOverlayInput(channel, value)

    if (!entry) {
      throw new Error('matrix_ipc_denied')
    }

    if (channel === IPC.popIn) {
      try {
        await this.host.action(entry.data.agentKey, 'chat')
      } catch {
        throw new Error('matrix_pet_overlay_action_failed')
      }

      this.close(entry.data.agentKey)

      return
    }

    if (channel === IPC.setInteractive) {
      this.pointer(entry)

      return
    }

    if (channel === IPC.drag) {
      if (input === 'start') {
        if (!this.overPet(entry) || entry.chatOpen) {
          throw new Error('matrix_pet_overlay_invalid')
        }

        clearTimeout(entry.timer)
        entry.drag = { cursor: this.host.screen.getCursorScreenPoint(), bounds: entry.window.getBounds() }
      } else if (entry.drag) {
        entry.drag = undefined
        const screen = this.world(entry)

        if (screen) {
          entry.state = { ...entry.state, x: screen.point.x, y: screen.world.floorY, motion: undefined }
        }

        this.remember(entry.data.agentKey, entry.window.getBounds())
        this.beat(entry, [])
      }

      this.pointer(entry)

      return
    }

    const action = channel === IPC.click ? 'chat' : channel === IPC.menu ? (input as MatrixPetOverlayAction) : undefined

    if (action === 'chat') {
      entry.chatOpen = !entry.chatOpen
      entry.window.setFocusable(entry.chatOpen)

      if (entry.chatOpen) {
        entry.window.focus()
      }

      this.beat(entry, [])
    } else if (action === 'wave' || action === 'sit' || action === 'lounge') {
      entry.lastActive = this.now()
      this.beat(entry, [{ action }])
    } else if (action) {
      try {
        await this.host.action(entry.data.agentKey, action)
      } catch {
        throw new Error('matrix_pet_overlay_action_failed')
      }

      if (action === 'hide') {
        this.close(entry.data.agentKey)
      }
    } else if (channel === IPC.submit) {
      if (!entry.chatOpen) {
        throw new Error('matrix_pet_overlay_invalid')
      }

      try {
        await this.host.submit(entry.data.agentKey, input as string)
      } catch (error) {
        // Typed companion-chat refusals (402/429/503) reach the panel as one
        // short line; nothing else from main crosses this window.
        if (error instanceof Error && error.message) {
          throw error
        }

        throw new Error('matrix_pet_overlay_send_failed')
      }
    }
  }
}
