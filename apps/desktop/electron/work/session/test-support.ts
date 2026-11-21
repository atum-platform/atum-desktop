import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { WebContents } from 'electron'

import type { WorkIncarnation } from '../sidecar/process'

import type { OwnerViewPort } from './pairing'
import { type WorkSessionAccount, workSessionPaths, type WorkSessionPaths } from './paths'
import type { PairingGrantLookup, T3AuthCli } from './t3-auth'
import type { PinHost, TrialContext, UpdateIncarnation } from './update'

/**
 * A stand-in for one T3 home, faithful to the rules S0-5 measured:
 * a session token is accepted when its signature verifies under the key FILE
 * and its row is not revoked; a pairing grant is checked by ROW only; `pairing
 * list` never shows a startup (hidden) grant; the offline commands re-create a
 * missing key. Rows live in the "database" file, so a snapshot and a restore
 * move them exactly as T3's would.
 */
interface Row {
  sessions: { id: string; keyId: string; revoked: boolean }[]
  links: { id: string; credential: string; consumed: boolean; revoked: boolean; hidden: boolean }[]
}

export interface FakeToken {
  sid: string
  keyId: string
}

export class FakeT3Home {
  readonly paths: WorkSessionPaths
  running = false

  constructor(readonly root: string) {
    this.paths = workSessionPaths({ root })
    mkdirSync(dirname(this.paths.signingKey), { recursive: true })
    mkdirSync(this.paths.userdata, { recursive: true })

    if (!existsSync(this.paths.database)) {
      this.write({ sessions: [], links: [] })
    }
  }

  private read(): Row {
    return JSON.parse(readFileSync(this.paths.database, 'utf8')) as Row
  }

  private write(rows: Row): void {
    writeFileSync(this.paths.database, JSON.stringify(rows))
  }

  ensureKey(): string {
    if (!existsSync(this.paths.signingKey)) {
      writeFileSync(this.paths.signingKey, randomUUID())
    }

    return readFileSync(this.paths.signingKey, 'utf8')
  }

  issueSession(): FakeToken {
    const rows = this.read()
    const token = { sid: randomUUID(), keyId: this.ensureKey() }
    rows.sessions.push({ id: token.sid, keyId: token.keyId, revoked: false })
    this.write(rows)

    return token
  }

  createLink(hidden: boolean): string {
    const rows = this.read()
    const credential = `TOK${randomUUID().replace(/-/gu, '').slice(0, 16)}`
    rows.links.push({ id: randomUUID(), credential, consumed: false, revoked: false, hidden })
    this.write(rows)

    return credential
  }

  accepts(token: FakeToken | undefined): boolean {
    if (!token || !existsSync(this.paths.signingKey) || readFileSync(this.paths.signingKey, 'utf8') !== token.keyId) {
      return false
    }

    return this.read().sessions.some(row => row.id === token.sid && !row.revoked)
  }

  acceptsGrant(credential: string): boolean {
    return this.read().links.some(link => link.credential === credential && !link.consumed && !link.revoked)
  }

  /** The browser-session exchange: a live grant becomes a session. */
  consume(credential: string): FakeToken | undefined {
    const rows = this.read()
    const link = rows.links.find(row => row.credential === credential && !row.consumed && !row.revoked)

    if (!link) {
      return undefined
    }

    link.consumed = true
    this.write(rows)

    return this.issueSession()
  }

  sessionCount(): number {
    return this.read().sessions.filter(row => !row.revoked).length
  }

  cli(): T3AuthCli {
    return {
      sessionIds: async () => {
        this.ensureKey()

        return this.read().sessions.filter(row => !row.revoked).map(row => row.id)
      },
      revokeSession: async id => {
        const rows = this.read()

        for (const row of rows.sessions) {
          if (row.id === id) {
            row.revoked = true
          }
        }

        this.write(rows)
      },
      pairingIds: async () => this.read().links.filter(row => !row.hidden && !row.consumed && !row.revoked).map(row => row.id),
      revokePairing: async id => {
        const rows = this.read()
        const link = rows.links.find(row => row.id === id && !row.revoked)

        if (!link) {
          return false
        }

        link.revoked = true
        this.write(rows)

        return true
      }
    }
  }

  grants(): PairingGrantLookup {
    return {
      idForCredential: credential =>
        this.read().links.find(link => link.credential === credential && !link.revoked)?.id,
      unusedIds: () => this.read().links.filter(link => !link.consumed && !link.revoked).map(link => link.id)
    }
  }
}

export function tempAccount(name = 'acct'): { account: WorkSessionAccount; home: FakeT3Home } {
  const root = mkdtempSync(join(tmpdir(), `work-session-${name}-`))

  return { account: { key: name, generation: 1, root }, home: new FakeT3Home(root) }
}

export function removeAccount(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** A pin host whose server is the fake home. Records the order of everything it is asked to do. */
export class FakeHost implements PinHost {
  readonly events: string[]
  live?: UpdateIncarnation
  bound = false
  grants = new Map<string, string>()
  starts = 0
  /** Called when `start` begins, to assert what a server would observe at first readiness. */
  onStart?: (context: { trial?: TrialContext }) => void
  failStart = false
  trialMode?: (home: FakeT3Home) => UpdateIncarnation['trial']
  /** Mutates the database the way a newer server's migration would. */
  migrate?: (home: FakeT3Home) => void

  constructor(
    readonly home: FakeT3Home,
    events: string[] = [],
    readonly version = '0.1.11'
  ) {
    this.events = events
  }

  current(): UpdateIncarnation | undefined {
    return this.live
  }

  async start(options: { continuation: boolean; trial?: TrialContext }): Promise<UpdateIncarnation> {
    this.events.push(`start:${this.version}:${options.continuation ? 'cont' : 'nocont'}${options.trial ? ':trial' : ''}`)
    this.onStart?.({ trial: options.trial })

    if (this.failStart) {
      throw new Error('work_start_failed')
    }

    this.home.ensureKey()
    this.home.running = true
    this.migrate?.(this.home)
    const credential = this.home.createLink(true)
    this.starts += 1
    let url: string | undefined = `http://127.0.0.1:${40000 + this.starts}/pair#token=${credential}`
    const origin = `http://127.0.0.1:${40000 + this.starts}`

    const incarnation: UpdateIncarnation = {
      id: randomUUID(),
      accountKey: 'acct',
      generation: 1,
      origin,
      home: this.home.paths.home,
      pid: 12345,
      exited: new Promise<void>(() => undefined),
      takePairingUrl: () => {
        const value = url
        url = undefined

        return value
      },
      trial: this.trialMode?.(this.home)
    }

    this.live = incarnation

    return incarnation
  }

  async stop(): Promise<void> {
    this.events.push(`stop:${this.version}`)
    this.home.running = false
    this.live = undefined
    this.bound = false
  }

  bindOwnerView(): () => void {
    if (this.bound) {
      throw new Error('work_view_unavailable')
    }

    this.bound = true

    return () => {
      this.bound = false
    }
  }
}

export type ViewMode = 'ok' | 'mint_then_hang' | 'dead_load'

/** The partition's cookie store, shared by every view of one account. */
export interface Jar {
  cookie?: FakeToken
}

export class FakeView implements OwnerViewPort {
  contents = {} as WebContents
  url = 'about:blank'
  closed = false
  historyCleared = false
  partitionCleared = false
  seen: string[] = []

  constructor(
    private readonly home: FakeT3Home,
    private readonly mode: ViewMode = 'ok',
    private readonly jar: Jar = {}
  ) {}

  get cookie(): FakeToken | undefined {
    return this.jar.cookie
  }

  set cookie(value: FakeToken | undefined) {
    this.jar.cookie = value
  }

  async load(url: string): Promise<void> {
    this.seen.push(url)

    if (this.mode === 'dead_load') {
      throw new Error('load_failed')
    }

    const token = /#token=(.+)$/u.exec(url)?.[1]

    if (token) {
      // The client strips the fragment and submits the token once.
      this.url = url.split('#')[0]
      this.cookie = this.home.consume(token)
    } else {
      this.url = url
    }
  }

  currentUrl(): string {
    return this.url
  }

  async hasSessionCookie(): Promise<boolean> {
    return Boolean(this.cookie)
  }

  async signedIn(): Promise<boolean> {
    return this.mode === 'mint_then_hang' ? false : this.home.accepts(this.cookie)
  }

  clearHistory(): void {
    this.historyCleared = true
  }

  async clearPartition(): Promise<void> {
    this.partitionCleared = true
  }

  private listeners: (() => void)[] = []

  onClosed(listener: () => void): void {
    this.listeners.push(listener)
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.listeners.splice(0).forEach(listener => listener())
    }
  }
}

export type { WorkIncarnation }
