export type MatrixCheckoutOrderStatus = 'creating' | 'pending' | 'paid' | 'cancelled' | 'expired'
export interface MatrixCheckoutPayment {
  account_name: string
  account_number: string
  bank_bin: string
  description: string
  expires_at: string
  qr_code: string
}
/** The VietQR card lines PayOS issued for a pending top-up (the in-place QR). */
export type ProtonOrderPayment = MatrixCheckoutPayment

/** The platform's public snake-case Matrix top-up order contract (0164). */
export interface ProtonOrder {
  amount_vnd: number
  bonus_protons: number
  checkout_url: string | null
  created_at: string
  id: string
  order_code: number
  package_id: string
  paid_protons: number
  paid_at: string | null
  payment: MatrixCheckoutPayment | null
  status: MatrixCheckoutOrderStatus
  total_protons: number
}

/** Server-issued top-up packs; the renderer never calculates a price or bonus. */
export interface MatrixTopUpPack {
  id: string
  amountVnd: number
  paidMicroProtons: number
  bonusMicroProtons: number
  totalMicroProtons: number
}

export interface MatrixCheckoutIntent {
  idempotencyKey: string
  packId: string
  orderId: string | null
}

export interface MatrixCheckoutSnapshot {
  state: 'loading' | 'ready' | 'unavailable'
  packs: MatrixTopUpPack[]
  checkoutOpen: boolean
  order: ProtonOrder | null
  reconciliationPending: boolean
  intent: MatrixCheckoutIntent | null
}

export interface MatrixCheckoutBridge {
  refresh(): Promise<void>
  start(packId: string): Promise<unknown>
  status(): Promise<unknown>
  resume(): Promise<unknown>
  openCheckout(): Promise<void>
  dismissTerminal(): Promise<void>
}

// The same BIN table Moon shows on its QR card (moon2-app lib/payos.ts).
const BANK_NAMES_BY_BIN: Record<string, string> = {
  '970422': 'MB Bank',
  '970436': 'Vietcombank',
  '970415': 'VietinBank',
  '970405': 'Agribank',
  '970407': 'Techcombank',
  '970418': 'BIDV',
  '970416': 'ACB',
  '970432': 'VPBank',
  '970423': 'TPBank',
  '970403': 'Sacombank'
}

/** A bank the table does not name still gets a line: its BIN is what a banking app accepts. */
export function protonBankName(bin: string): string {
  return BANK_NAMES_BY_BIN[bin] ?? bin
}
