import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'

import {
  MATRIX_WORK_IPC,
  parseWorkAttention,
  parseWorkSidebar,
  WORK_BAND_COMMANDS,
  type WorkAttentionSnapshot,
  type WorkBandCommand,
  type WorkSidebarSnapshot,
  type WorkSurfaceModeSnapshot
} from '../../../shared/matrix-work'
import { writeFileDurably } from '../session/files'
import type { WorkSessionPaths } from '../session/paths'
import type { PinHost } from '../session/update'

import type { WorkDesktopUpdateHandler } from './desktop-control'

import { recordWorkBillingUnit, type WorkBillingUnit } from './billing'
import { type WorkIncarnation, workRuntimeEnvironment, WorkSidecar, type WorkStartOptions } from './process'

export const WORK_ACCESS_CHANNEL = 'atum:work:read-model-access'
export const WORK_ASSERTION_CHANNEL = 'atum:work:connect-assertion'
export const WORK_OPEN_PROTONS_CHANNEL = 'atum:work:open-protons'
export type WorkAccess = 'allowed' | 'empty' | 'unavailable'

interface Account {
  key: string
  generation: number
  root: string
}

interface WorkHostOptions {
  log?(phase: string, ms: number): void
  resources: string
  surfaceModeChanged?(snapshot: WorkSurfaceModeSnapshot | null): void
  sidebarChanged?(snapshot: WorkSidebarSnapshot | null): void
  attentionChanged?(snapshot: WorkAttentionSnapshot | null): void
  ready?(): void
  desktopUpdate?: () => WorkDesktopUpdateHandler | undefined
  prepare?(signal: AbortSignal): Promise<void>
  account(): Account | undefined
  gatewayEnvironment(): Record<string, string>
  revokeCredentials(): void
  readAccess(): Promise<WorkAccess>
  connectAssertion?(): Promise<string>
  openProtons(): Promise<void>
}

interface WorkBinding {
  account: Account
  process: WorkSidecar
  resources: string
}

function sameAccount(a: Account, b?: Account): boolean {
  return a.key === b?.key && a.generation === b.generation && a.root === b.root
}

export class WorkHost {
  private binding?: WorkBinding
  private backendToken?: string
  private view?: { contents: WebContents; incarnation: WorkIncarnation }
  private viewStartedAt = 0
  private readonly startupPhases = new Set<string>()
  private closing?: Promise<void>
  /** The live view's last thread-list report, for a band that mounts after it (the view reports changes only). */
  private lastSidebar?: { view: NonNullable<WorkHost['view']>; snapshot: WorkSidebarSnapshot }
  private lastAttention?: { view: NonNullable<WorkHost['view']>; snapshot: WorkAttentionSnapshot }

  constructor(private readonly options: WorkHostOptions) {}

  current(): WorkIncarnation | undefined {
    return this.binding?.process.current()
  }

  async start(input: WorkStartOptions): Promise<WorkIncarnation> {
    const account = this.options.account()

    if (!account || existsSync(disabledMarker(account)) || this.closing || !supported()) {
      throw new Error('work_unavailable')
    }

    if (this.binding && !sameAccount(this.binding.account, account)) {
      throw new Error('work_account_teardown_required')
    }

    const resources = input.resources ?? this.options.resources

    if (this.binding && this.binding.resources !== resources) {
      throw new Error('work_pin_teardown_required')
    }

    this.binding ??= {
      account,
      resources,
      process: new WorkSidecar({
        account,
        resources,
        log: this.options.log,
        prepare: this.options.prepare,
        ready: this.options.ready,
        desktopUpdate: this.options.desktopUpdate?.(),
        gatewayEnvironment: () => {
          const environment = this.options.gatewayEnvironment()
          this.backendToken = environment.ATUM_FILESYSTEM_BROKER_TOKEN

          return environment
        },
        revokeCredentials: () => {
          this.backendToken = undefined
          this.options.revokeCredentials()
        },
        current: () => sameAccount(account, this.options.account())
      })
    }
    const incarnation = await this.binding.process.start(input)
    void incarnation.exited.then(() => {
      if (this.view?.incarnation === incarnation) {
        this.view = undefined
      }
    })

    return incarnation
  }

  /** Bind a pin for WorkSession restarts while sharing the same owner IPC handlers. */
  forResources(resources: string): PinHost {
    return {
      current: () => this.binding?.resources === resources ? this.current() : undefined,
      start: input => this.start({ ...input, resources }),
      stop: () => this.binding?.resources === resources ? this.stop() : Promise.resolve(),
      bindOwnerView: (incarnation, contents) => this.bindOwnerView(incarnation, contents)
    }
  }

  authTools(paths: WorkSessionPaths, resources = this.binding?.resources ?? this.options.resources) {
    return {
      executable: join(resources, 'work-runtime', 't3'),
      environment: workRuntimeEnvironment(paths.work, resources)
    }
  }

  stop(): Promise<void> {
    this.view = undefined
    this.options.surfaceModeChanged?.(null)
    this.options.sidebarChanged?.(null)
    this.options.attentionChanged?.(null)

    if (this.closing) {
      return this.closing
    }

    const stopping = this.binding?.process.stop()

    if (!stopping) {
      return Promise.resolve()
    }

    this.closing = stopping.finally(() => {
      this.binding = undefined
      this.closing = undefined
    })

    return this.closing
  }

  /** Whether Work may run for the signed-in account: false with no account, or while its Work-off marker exists (§8.5). */
  enabled(): boolean {
    const account = this.options.account()

    return account !== undefined && !existsSync(disabledMarker(account))
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const account = this.options.account()

    if (!account) {
      throw new Error('work_unavailable')
    }

    if (enabled) {
      try {
        unlinkSync(disabledMarker(account))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    } else {
      writeFileDurably(disabledMarker(account), '')
      await this.stop()
    }
  }

  bindOwnerView(incarnation: WorkIncarnation, contents: WebContents): () => void {
    if (this.current() !== incarnation || contents.isDestroyed() || this.view) {
      throw new Error('work_view_unavailable')
    }

    const view = { contents, incarnation }
    this.view = view
    this.viewStartedAt = Date.now()
    this.startupPhases.clear()

    const detach = () => {
      if (this.view === view) {
        this.view = undefined
        this.options.surfaceModeChanged?.(null)
        this.options.sidebarChanged?.(null)
        this.options.attentionChanged?.(null)
      }
    }

    contents.once('destroyed', detach)

    return detach
  }

  async recordBillingUnit(token: unknown, unit: WorkBillingUnit, signal: AbortSignal): Promise<void> {
    if (!this.backendToken || this.backendToken !== token) {
      return
    }

    const incarnation = this.current()

    if (!incarnation) {
      throw new Error('work_billing_unavailable')
    }

    await recordWorkBillingUnit(incarnation.home, unit, signal, () => this.current() === incarnation)
  }

  async readModelAccess(incarnation: WorkIncarnation): Promise<WorkAccess> {
    if (this.current() !== incarnation) {
      return 'unavailable'
    }

    try {
      const access = await this.options.readAccess()

      return this.current() === incarnation ? access : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  attention(): WorkAttentionSnapshot | null {
    const last = this.lastAttention

    return last && last.view === this.view && this.current() === last.view.incarnation ? last.snapshot : null
  }

  sidebar(): WorkSidebarSnapshot | null {
    const last = this.lastSidebar

    return last && last.view === this.view && this.current() === last.view.incarnation ? last.snapshot : null
  }

  async getSurfaceMode(): Promise<WorkSurfaceModeSnapshot | null> {
    const view = this.view

    if (!view || this.current() !== view.incarnation || view.contents.isDestroyed() ||
      !this.binding || !sameAccount(this.binding.account, this.options.account())) {
      return null
    }

    const value: unknown = await view.contents.executeJavaScript('window.atumSurfaceMode?.getSurfaceMode() ?? null')

    if (this.view !== view || !this.binding || !sameAccount(this.binding.account, this.options.account())) {
      return null
    }

    return parseSurfaceMode(value)
  }

  /** The band's buttons run T3's own commands in the live owner view (its `window.atumWorkCommands`). */
  async runCommand(command: WorkBandCommand): Promise<boolean> {
    const view = this.view

    if (!WORK_BAND_COMMANDS.includes(command) || !view || this.current() !== view.incarnation || view.contents.isDestroyed() ||
      !this.binding || !sameAccount(this.binding.account, this.options.account())) {
      return false
    }

    // The press landed in the band, outside the view: without keyboard focus the view cannot take
    // the caret New thread puts in its composer, so on an empty draft the button looked dead.
    if (command === 'chat.new') {
      view.contents.focus()
    }

    const ran: unknown = await view.contents.executeJavaScript(`window.atumWorkCommands?.run(${JSON.stringify(command)}) ?? false`)

    return this.view === view && ran === true
  }

  async setSurfaceMode(projectId: string, mode: 'work' | 'code'): Promise<void> {
    const view = this.view

    if (!view || this.current() !== view.incarnation || view.contents.isDestroyed() || !this.binding || !sameAccount(this.binding.account, this.options.account())) {
      throw new Error('work_unavailable')
    }

    if (!projectId || projectId.length > 255 || (mode !== 'work' && mode !== 'code')) {
      throw new Error('work_mode_invalid')
    }

    await view.contents.executeJavaScript(`window.atumSurfaceMode ? window.atumSurfaceMode.setSurfaceMode(${JSON.stringify(projectId)}, ${JSON.stringify(mode)}) : Promise.reject(new Error('work_unavailable'))`)

    if (this.view !== view) {
      throw new Error('work_unavailable')
    }
  }

  registerOwnerPreload(): void {
    ipcMain.handle(WORK_ASSERTION_CHANNEL, async event => {
      const view = this.ownerCaller(event)
      const account = this.options.account()

      if (!view || !account || !this.binding || !sameAccount(this.binding.account, account)) {
        throw new Error('work_unavailable')
      }

      const assertion = await this.options.connectAssertion?.()

      if (!assertion || this.ownerCaller(event) !== view || !sameAccount(account, this.options.account())) {
        throw new Error('work_unavailable')
      }

      return assertion
    })
    ipcMain.handle('atum:work:startup-phase', (event, phase: unknown) => {
      if (!this.ownerCaller(event) || typeof phase !== 'string' ||
        !['ws-connected', 'providers-ready', 'threads-painted'].includes(phase) || this.startupPhases.has(phase)) {return}

      if (phase === 'threads-painted') {event.sender.setBackgroundThrottling(true)}
      this.startupPhases.add(phase)
      this.options.log?.(phase, Date.now() - this.viewStartedAt)
    })
    ipcMain.handle(MATRIX_WORK_IPC.surfaceModeChanged, (event, value: unknown) => {
      if (!this.ownerCaller(event)) {
        return
      }

      this.options.surfaceModeChanged?.(parseSurfaceMode(value))
    })
    ipcMain.handle(MATRIX_WORK_IPC.sidebarChanged, (event, value: unknown) => {
      const view = this.ownerCaller(event)
      const snapshot = parseWorkSidebar(value)

      if (!view || !snapshot) {
        return
      }

      this.lastSidebar = { view, snapshot }
      this.options.sidebarChanged?.(snapshot)
    })
    ipcMain.handle(MATRIX_WORK_IPC.attentionChanged, (event, value: unknown) => {
      const view = this.ownerCaller(event)
      const snapshot = parseWorkAttention(value)

      if (!view || !snapshot) {
        return
      }

      this.lastAttention = { view, snapshot }
      this.options.attentionChanged?.(snapshot)
    })
    ipcMain.handle(WORK_ACCESS_CHANNEL, async event => {
      const view = this.ownerCaller(event)

      if (!view) {
        return 'unavailable'
      }

      const access = await this.readModelAccess(view.incarnation)

      return this.ownerCaller(event) === view ? access : 'unavailable'
    })
    ipcMain.handle(WORK_OPEN_PROTONS_CHANNEL, async event => {
      if (!this.ownerCaller(event)) {
        return false
      }

      try {
        await this.options.openProtons()

        return true
      } catch {
        return false
      }
    })
  }

  private ownerCaller(event: IpcMainInvokeEvent) {
    const view = this.view
    const frame = event.senderFrame

    if (!view || view.contents !== event.sender || this.current() !== view.incarnation ||
      !frame || frame.detached || frame.parent !== null) {
      return undefined
    }

    try {
      return new URL(frame.url).origin === view.incarnation.origin ? view : undefined
    } catch {
      return undefined
    }
  }
}

function disabledMarker(account: Account) {
  return join(account.root, 'work-disabled')
}

function supported() {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

function parseSurfaceMode(value: unknown): WorkSurfaceModeSnapshot | null {
  if (!value || typeof value !== 'object') {
      return null
    }

  const row = value as Record<string, unknown>

  return typeof row.projectId === 'string' && row.projectId.length > 0 && row.projectId.length <= 255 && (row.mode === 'work' || row.mode === 'code')
    ? { projectId: row.projectId, mode: row.mode } : null
}
