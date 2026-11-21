import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ipcMain, type WebContents } from 'electron'

import type { ManagedModelAccessSnapshot } from '../../../src/lib/atum-managed-model-access'

import { recordWorkBillingUnit, type WorkBillingUnit } from './billing'
import { type WorkIncarnation, WorkSidecar, type WorkStartOptions } from './process'

export const WORK_ACCESS_CHANNEL = 'atum:work:read-model-access'
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
}

interface WorkBinding {
  account: Account
  process: WorkSidecar
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

    this.binding ??= {
      account,
      process: new WorkSidecar({
        ...this.options,
        account,
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
      const view = this.view
      const frame = event.senderFrame

      if (!view || view.contents !== event.sender || !frame || frame.parent !== null) {
        return 'unavailable'
      }

      try {
        if (new URL(frame.url).origin !== view.incarnation.origin) {
          return 'unavailable'
        }
      } catch {
        return 'unavailable'
      }

      const access = await this.readModelAccess(view.incarnation)

      return this.view === view && !frame.detached && frame.parent === null &&
        frame.url.startsWith(view.incarnation.origin + '/') ? access : 'unavailable'
    })
  }
}

function disabledMarker(account: Account) {
  return join(account.root, 'work-disabled')
}

function supported() {
  return process.platform === 'darwin' && process.arch === 'arm64'
}
