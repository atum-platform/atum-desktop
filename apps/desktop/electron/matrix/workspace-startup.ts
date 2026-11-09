import type { MatrixHermesRuntimeConfig } from './hermes-runtime'
import { matrixWorkspaceChoice, migrateMatrixWorkspaceLayout, readMatrixWorkspace } from './workspace-layout'

interface MatrixWorkspaceStartupOptions {
  home: string
  userData: string
  runtime: MatrixHermesRuntimeConfig
  roots(): readonly string[]
  quiescent(): boolean
  log(reason: string): void
}

/** Main's one startup pass. Every runtime entry point waits; quit ends only its owned helper. */
export class MatrixWorkspaceStartup {
  private readonly abort = new AbortController()
  private ready?: Promise<void>

  constructor(private readonly options: MatrixWorkspaceStartupOptions) {
    options.runtime.workspaceHome = options.home
    options.runtime.knownDriveRoots = options.roots

    options.runtime.beforeOpen = async () => {
      this.abort.signal.throwIfAborted()

      if (!this.ready) {
        throw new Error('workspace_layout_deferred')
      }

      await this.ready
      this.abort.signal.throwIfAborted()
    }
  }

  start(): Promise<void> {
    return (this.ready ??= this.run())
  }

  stop(): void {
    this.abort.abort()
  }

  watched(): string {
    const roots = this.options.roots()

    return readMatrixWorkspace(matrixWorkspaceChoice(process.env, this.options.home, roots), roots)
  }

  private async run(): Promise<void> {
    try {
      const result = await migrateMatrixWorkspaceLayout({
        home: this.options.home,
        userData: this.options.userData,
        python: this.options.runtime.python,
        runtimeSource: this.options.runtime.source,
        runtimeProfiles: this.options.runtime.profiles,
        env: process.env,
        signal: this.abort.signal,
        knownDriveRoots: this.options.roots(),
        quiescent: this.options.quiescent()
      })

      if (result.reason) {
        this.options.log(result.reason)
      }
    } catch {
      this.options.log('workspace_layout_deferred')
    }
  }
}
