/** The MAS human principal's ledger reads. Amounts stay exact integer micro-Protons. */
export interface MatrixWalletView {
  unit: 'micro_proton'
  balances: { available: number; paid: number; earned: number; promo: number; held: number }
  allowance: {
    kind: 'founding' | 'standard'
    state: 'granted' | 'deferred'
    amount: number
    grantedAt: string | null
  } | null
  checkoutOpen: boolean
}

export type MatrixWalletState =
  | { state: 'loading' | 'unavailable'; wallet: null }
  | { state: 'ready'; wallet: MatrixWalletView }

export interface MatrixWalletEntry {
  id: string
  at: string
  /** Future provider kinds/statuses remain visible generically, without affecting balance. */
  kind: string
  status: string
  amount: number
  reference: string | null
  closedAt: string | null
}

export interface MatrixWalletHistory {
  entries: MatrixWalletEntry[]
  next: string | null
}

/** Named native reads only. No principal, resource URL, credential or purchase action. */
export interface MatrixWalletBridge {
  refresh(): Promise<void>
  history(before?: string): Promise<MatrixWalletHistory>
}
