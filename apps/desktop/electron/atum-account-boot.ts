export interface AtumAccountBootOptions {
  createWindow(): void
  restore(): Promise<unknown>
  restoreFailed(): void
}

/** First paint is an ordering invariant; hosted restore is bounded background work. */
export function startAtumRestoreAfterWindow(options: AtumAccountBootOptions): void {
  options.createWindow()
  void options.restore().catch(() => options.restoreFailed())
}
