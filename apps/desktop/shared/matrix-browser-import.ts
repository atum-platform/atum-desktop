export const MATRIX_BROWSER_IMPORT = {
  status: 'matrix:browser-import:status',
  run: 'matrix:browser-import:run'
} as const

/**
 * Why an import did not happen. Closed words: the renderer picks the copy, and none of them carries a path,
 * a site, a cookie or a platform message.
 */
export type MatrixBrowserImportReason =
  /** Not macOS, or this build has no Secure Enclave helper to sign with. */
  | 'unsupported'
  | 'signed_out'
  /** Google Chrome is not installed here, or has never been used. */
  | 'chrome_not_found'
  /** Chrome has no site that can be imported (everything it holds is left behind by default). */
  | 'nothing_to_import'
  /** macOS did not let Atum read Chrome's saved sign-ins (the Keychain dialog was declined or not answered). */
  | 'keychain_denied'
  /** The Touch ID approval is not available on this Mac. */
  | 'approval_unavailable'
  /** The primary agent has no cloud computer to receive the import. */
  | 'no_computer'
  /** The computer's key could not be verified, so nothing was sealed. */
  | 'key_untrusted'
  | 'offline'
  /** The platform did not accept the transfer. */
  | 'refused'
  | 'busy'
  | 'failed'

/** What the person is shown after a run: the counts and the agent, never a name of a site. */
export interface MatrixBrowserImportLast {
  /** Sites whose logins went to the agent. */
  siteCount: number
  /** Sites left behind by default (banking, wallets, password managers). */
  skippedSiteCount: number
  agentPrincipal: string
  /** Epoch milliseconds. */
  at: number
}

export type MatrixBrowserImportOutcome =
  | ({ outcome: 'imported' } & MatrixBrowserImportLast)
  /** The person said no (or did not answer) at the Touch ID approval. Nothing left this Mac. */
  | { outcome: 'declined' }
  | { outcome: 'unavailable'; reason: MatrixBrowserImportReason }

export interface MatrixBrowserImportStatus {
  /** `unavailable`: there is nothing to offer on this Mac or for this account right now. */
  state: 'ready' | 'running' | 'unavailable'
  /**
   * True while this Mac is not yet enrolled: the first import then asks for one extra Touch ID, to confirm the Mac,
   * before the one that confirms the import. The panel says so beforehand; it is never a surprise.
   */
  firstImport?: boolean
  /** The last import that reached the agent, for this account. */
  last?: MatrixBrowserImportLast
}

/**
 * Both calls take nothing. The browser, the profile, the sites and the agent are all decided in main; the
 * renderer can neither widen what is imported nor redirect it.
 */
export interface MatrixBrowserImportBridge {
  status(): Promise<MatrixBrowserImportStatus>
  run(): Promise<MatrixBrowserImportOutcome>
}

declare global {
  interface Window {
    atumBrowserImport?: MatrixBrowserImportBridge
  }
}
