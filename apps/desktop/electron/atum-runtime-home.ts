/** Account execution state is separate from the machine's installed runtime. */
export interface AtumRuntimeHomeScope { generation: number; home: string }
export class AtumRuntimeHomeAuthority {
  private generation = 0
  private required = false
  private activeHome: string | null = null
  constructor(private readonly legacyHome: string) {}
  requireAccount(): void { this.required = true; this.revoke() }
  activate(home: string): void { this.generation += 1; this.activeHome = home }
  revoke(): void { this.generation += 1; this.activeHome = null }
  active(): string | null { return this.activeHome }
  capture(): AtumRuntimeHomeScope {
    if (this.required && !this.activeHome) {throw new Error('atum_runtime_account_required')}

    return { generation: this.generation, home: this.activeHome ?? this.legacyHome }
  }
  current(scope: AtumRuntimeHomeScope): boolean { return scope.generation === this.generation }
  assertCurrent(scope: AtumRuntimeHomeScope): void {
    if (!this.current(scope)) {throw new Error('atum_runtime_account_changed')}
  }
  async fence<T>(scope: AtumRuntimeHomeScope, operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(scope)
    const result = await operation()
    this.assertCurrent(scope)

    return result
  }
}
