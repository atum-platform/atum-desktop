import { createHash, randomUUID } from 'node:crypto'

import type { MacKnowledgeSource, MacSourceConsentSnapshot } from './contract'

const ACCOUNT_KEY = /^[0-9a-f]{64}$/u
const STORE_VERSION = 3
const STORE_PREFIX = 'matrix-mac-sources-consent.'

export interface MacSourcesConsentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface MacSourcesConsentScope {
  accountKey: string
  generation: number
}

/** A domain-less install can keep local choices; signed-out configured accounts fail closed. */
export function macSourceConsentScope(
  account: MacSourcesConsentScope | null, domainConfigured: boolean, installationId: string
): MacSourcesConsentScope | null {
  return account ?? (domainConfigured ? null : {
    accountKey: createHash('sha256').update(`mac-sources-local:${installationId}`).digest('hex'), generation: 0
  })
}

const on = (): MacSourceConsentSnapshot => ({
  google: true,
  folders: true,
  messages: true,
  browser: true,
  location: true,
  teamSpaces: true
})

/**
 * A new account's sources: on wherever no macOS prompt is involved. Google, Team spaces and
 * Location (city and time zone; precise location isn't built) start on. Mac folders, Messages and
 * Browser need a macOS step, so they start off and the first-run ask turns them on with it.
 */
const firstRun = (): MacSourceConsentSnapshot => ({
  google: true,
  folders: false,
  messages: false,
  browser: false,
  location: true,
  teamSpaces: true
})

const off = (): MacSourceConsentSnapshot => ({
  google: false,
  folders: false,
  messages: false,
  browser: false,
  location: false,
  teamSpaces: false
})

function parse(value: string | null): MacSourceConsentSnapshot | null {
  if (!value) {
    return null
  }

  try {
    const row = JSON.parse(value) as Record<string, unknown>

    if (!row || Array.isArray(row)) {
      return null
    }

    // Slice 1 wrote v1 with the three newly gated Mac sources. Preserve every explicit off
    // choice while the new prompt-free sources adopt the owner's on-by-default decision.
    if (
      Object.keys(row).sort().join(',') === 'browser,location,messages,version' &&
      row.version === 1 &&
      typeof row.messages === 'boolean' &&
      typeof row.browser === 'boolean' &&
      typeof row.location === 'boolean'
    ) {
      return { ...on(), messages: row.messages, browser: row.browser, location: row.location }
    }

    return Object.keys(row).sort().join(',') ===
        'browser,folders,google,location,messages,teamSpaces,version' &&
      (row.version === 2 || row.version === STORE_VERSION) &&
      typeof row.google === 'boolean' &&
      typeof row.folders === 'boolean' &&
      typeof row.messages === 'boolean' &&
      typeof row.browser === 'boolean' &&
      typeof row.location === 'boolean' &&
      typeof row.teamSpaces === 'boolean'
      ? {
          google: row.google,
          folders: row.folders,
          messages: row.messages,
          browser: row.browser,
          location: row.location,
          teamSpaces: row.teamSpaces
        }
      : null
  } catch {
    return null
  }
}

/**
 * One encrypted, account-scoped source record. No record fails closed until main classifies it:
 * A new first run enables every prompt-free source while sources behind a macOS step start off. Existing accounts
 * retain the earlier on-by-default posture. A v1 record keeps every explicit off choice.
 * Corrupt, switched, or unreadable state also fails closed. Tool handlers read this state (or its bounded policy projection) for every
 * operation, so revocation takes effect without rebuilding a cached prompt.
 */
export class MacSourcesConsentStore {
  constructor(
    private readonly storage: MacSourcesConsentStorage,
    private readonly scope: () => MacSourcesConsentScope | null
  ) {}

  installationId(): string {
    const key = 'matrix-mac-sources-installation'
    const saved = this.storage.getItem(key)

    if (saved) {return saved}
    const id = randomUUID()
    this.storage.setItem(key, id)

    return id
  }

  pendingNarrow(): MacKnowledgeSource[] { return this.sourceList('pending-narrow') }
  queueNarrow(source: MacKnowledgeSource): void {
    this.saveSourceList('pending-narrow', [...new Set([...this.pendingNarrow(), source])])
  }
  clearPendingNarrow(sources: MacKnowledgeSource[]): void {
    this.saveSourceList('pending-narrow', this.pendingNarrow().filter(source => !sources.includes(source)))
  }
  overriddenOptOuts(): MacKnowledgeSource[] { return this.sourceList('overridden-opt-outs') }
  recordOverriddenOptOuts(sources: MacKnowledgeSource[], macId: string): void {
    const previous = this.overriddenOptOuts()

    if (sources.some(source => !previous.includes(source))) {
      // Invalidate presentation BEFORE saving notice evidence: a crash between writes
      // must never preserve an old shown marker for a newly widened source.
      this.writeScoped(`presented.${macId}`, '0')
      this.saveSourceList('overridden-opt-outs', [...new Set([...previous, ...sources])])
    }
  }
  presentedAt(macId: string): number | null {
    const value = Number(this.readScoped(`presented.${macId}`))

    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  presented(macId: string, at = Date.now()): void {
    if (!Number.isSafeInteger(at) || at <= 0) {throw new Error('matrix_mac_sources_invalid_presentation')}

    if (!this.presentedAt(macId)) {this.writeScoped(`presented.${macId}`, String(at))}
  }
  private sourceList(suffix: string): MacKnowledgeSource[] {
    const value = this.readScoped(suffix)

    if (!value) {return []}
    const list: unknown = JSON.parse(value)

    if (!Array.isArray(list) || !list.every(source => Object.hasOwn(off(), source))) {
      throw new Error('matrix_mac_sources_consent_unavailable')
    }

    return [...new Set(list)] as MacKnowledgeSource[]
  }
  private saveSourceList(suffix: string, sources: MacKnowledgeSource[]): void {
    this.writeScoped(suffix, JSON.stringify(sources))
  }
  private readScoped(suffix: string): string | null {
    const scope = this.validScope()

    return scope ? this.storage.getItem(`${this.key(scope.accountKey)}.${suffix}`) : null
  }
  private writeScoped(suffix: string, value: string): void {
    const scope = this.validScope()

    if (!scope) {throw new Error('matrix_mac_sources_consent_unavailable')}
    this.storage.setItem(`${this.key(scope.accountKey)}.${suffix}`, value)
  }

  accountGatesImport(): { mergeId: string; consent: MacSourceConsentSnapshot } {
    const scope = this.validScope()

    if (!scope) {throw new Error('matrix_mac_sources_consent_unavailable')}
    const key = `${this.key(scope.accountKey)}.account-gates-import`
    const saved = this.storage.getItem(key)

    if (saved) {
      const row = JSON.parse(saved) as { mergeId: string; consent: MacSourceConsentSnapshot }

      if (/^[0-9a-f-]{36}$/u.test(row.mergeId) && parse(JSON.stringify({ version: STORE_VERSION, ...row.consent }))) {return row}
      throw new Error('matrix_mac_sources_consent_unavailable')
    }

    const value = { mergeId: randomUUID(), consent: this.read() }
    this.storage.setItem(key, JSON.stringify(value))

    return value
  }

  accountGatesMerged(): boolean {
    const scope = this.validScope()

    return Boolean(scope && this.storage.getItem(`${this.key(scope.accountKey)}.account-gates-imported`) === '1')
  }

  markAccountGatesMerged(): void {
    const scope = this.validScope()

    if (!scope) {throw new Error('matrix_mac_sources_consent_unavailable')}
    this.storage.setItem(`${this.key(scope.accountKey)}.account-gates-imported`, '1')
  }

  read(): MacSourceConsentSnapshot {
    const scope = this.validScope()

    return scope ? this.readFor(scope.accountKey) : off()
  }

  set(source: MacKnowledgeSource, enabled: boolean): MacSourceConsentSnapshot {
    const scope = this.validScope()

    if (!scope || typeof enabled !== 'boolean') {
      throw new Error('matrix_mac_sources_consent_unavailable')
    }

    const next = { ...this.readFor(scope.accountKey), [source]: enabled }
    this.storage.setItem(
      this.key(scope.accountKey),
      JSON.stringify({ version: STORE_VERSION, ...next })
    )

    const current = this.validScope()

    if (
      !current ||
      current.accountKey !== scope.accountKey ||
      current.generation !== scope.generation
    ) {
      throw new Error('matrix_mac_sources_consent_stale')
    }

    return next
  }

  setAll(enabled: boolean): MacSourceConsentSnapshot {
    const scope = this.validScope()

    if (!scope || typeof enabled !== 'boolean') {
      throw new Error('matrix_mac_sources_consent_unavailable')
    }

    const next: MacSourceConsentSnapshot = {
      google: enabled,
      folders: enabled,
      messages: enabled,
      browser: enabled,
      location: enabled,
      teamSpaces: enabled
    }

    this.storage.setItem(
      this.key(scope.accountKey),
      JSON.stringify({ version: STORE_VERSION, ...next })
    )

    const current = this.validScope()

    if (
      !current ||
      current.accountKey !== scope.accountKey ||
      current.generation !== scope.generation
    ) {
      throw new Error('matrix_mac_sources_consent_stale')
    }

    return next
  }

  /**
   * A new account enables every prompt-free source; sources behind a macOS step start closed.
   * Initialization is create-only so later publishes while the first-run ask is open never erase
   * a saved choice, and an existing record (including any explicit off) is never rewritten.
   */
  initializeFirstRunDefaults(): MacSourceConsentSnapshot | null {
    return this.initialize(false)
  }

  /** Existing accounts retain the pre-first-run release's on-by-default posture, once classified. */
  initializeExistingOpen(): MacSourceConsentSnapshot | null {
    return this.initialize(true)
  }

  /** Owner-approved upgrade assumption for a locally confirmed, already-connected Google account.
   * V2 did not distinguish its automatic first-run false from an explicit off choice.
   * Once rewritten as v3, later explicit off choices are preserved.
   */
  initializeConnectedGoogle(connected: boolean): MacSourceConsentSnapshot | null {
    const scope = this.validScope()

    if (!scope || !connected) {
      return null
    }

    const stored = this.storage.getItem(this.key(scope.accountKey))
    const consent = parse(stored)

    if (!stored || !consent || JSON.parse(stored).version !== 2) {
      return null
    }

    return this.set('google', true)
  }

  private initialize(enabled: boolean): MacSourceConsentSnapshot | null {
    const scope = this.validScope()

    if (!scope) {
      throw new Error('matrix_mac_sources_consent_unavailable')
    }

    const key = this.key(scope.accountKey)

    if (this.storage.getItem(key) !== null) {
      return null
    }

    const next = enabled ? on() : firstRun()
    this.storage.setItem(key, JSON.stringify({ version: STORE_VERSION, ...next }))

    const current = this.validScope()

    if (!current || current.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_mac_sources_consent_stale')
    }

    return next
  }

  private validScope(): MacSourcesConsentScope | null {
    try {
      const scope = this.scope()

      return scope && ACCOUNT_KEY.test(scope.accountKey) && Number.isSafeInteger(scope.generation)
        ? scope
        : null
    } catch {
      return null
    }
  }

  private readFor(accountKey: string): MacSourceConsentSnapshot {
    try {
      const stored = this.storage.getItem(this.key(accountKey))

      // Until main has classified the account as first-run or existing, no record means no read.
      return stored === null ? off() : (parse(stored) ?? off())
    } catch {
      return off()
    }
  }

  private key(accountKey: string): string {
    return `${STORE_PREFIX}${accountKey}`
  }
}
