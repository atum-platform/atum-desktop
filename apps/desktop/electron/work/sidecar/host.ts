import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'

import type { ManagedModelAccessSnapshot } from '../../../src/lib/atum-managed-model-access'
import type { WorkSessionPaths } from '../session/paths'
import type { PinHost } from '../session/update'

import { recordWorkBillingUnit, type WorkBillingUnit } from './billing'
import { type WorkIncarnation, workRuntimeEnvironment, WorkSidecar, type WorkStartOptions } from './process'

export const WORK_ACCESS_CHANNEL = 'atum:work:read-model-access'
export const WORK_OPEN_PROTONS_CHANNEL = 'atum:work:open-protons'
export type WorkAccess = 'allowed' | 'empty' | 'unavailable'

interface Account {
  key: string
  generation: number
  root: string
}

interface WorkHostOptions {
  resources: string
  account(): Account | undefined
  gatewayEnvironment(): Record<string, string>
  revokeCredentials(): void
  accessState(): Promise<ManagedModelAccessSnapshot>
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
  private closing?: Promise<void>

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
      writeFileSync(disabledMarker(account), '', { mode: 0o600 })
      await this.stop()
    }
  }

  bindOwnerView(incarnation: WorkIncarnation, contents: WebContents): () => void {
    if (this.current() !== incarnation || contents.isDestroyed() || this.view) {
      throw new Error('work_view_unavailable')
    }

    const view = { contents, incarnation }
    this.view = view

    const detach = () => {
      if (this.view === view) {
        this.view = undefined
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
      const snapshot = await this.options.accessState()

      if (this.current() !== incarnation) {
        return 'unavailable'
      }

      if ('access_alias' in snapshot && snapshot.access_alias === 'binh-minh') {
        if (snapshot.state === 'ready') {
          return 'allowed'
        }

        if (snapshot.state === 'insufficient_funds') {
          return 'empty'
        }
      }
    } catch {
      return 'unavailable'
    }

    return 'unavailable'
  }

  registerOwnerPreload(): void {
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
