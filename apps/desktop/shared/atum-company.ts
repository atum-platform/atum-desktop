/**
 * The company that publishes Atum, as its enterprise registration certificate names it,
 * and the role addresses people write to. Company facts only: never a person's name,
 * phone number or personal email address on any Atum surface.
 */
export const ATUM_COMPANY = {
  /** The registered name, as the certificate prints it. */
  legalName: 'CÔNG TY TNHH ANKA VENTURES VIETNAM',
  /** The registered English name. */
  englishName: 'Anka Ventures Vietnam Company Limited',
  /** Mã số doanh nghiệp. */
  enterpriseCode: '0110665173',
  /** The head office in the short form a one-line seller line uses. */
  headOffice: {
    vi: 'Số nhà 68, ngõ 73 Nguyễn Lương Bằng, P. Đống Đa, Hà Nội',
    en: 'No. 68, Lane 73 Nguyen Luong Bang St., Dong Da Ward, Hanoi'
  }
} as const

/**
 * Atum's role mailboxes: help with anything, and personal data (requests about your data,
 * deleting your account). The only addresses an Atum window may start an email to.
 */
export const ATUM_MAILBOXES = {
  support: 'support@atumplatform.com',
  privacy: 'privacy@atumplatform.com'
} as const

export type AtumMailbox = keyof typeof ATUM_MAILBOXES

/**
 * An email to one of Atum's role mailboxes, as a window's `openLink` opens it in the mail
 * app: the address, a subject and an optional body, nothing else (main refuses anything
 * more: electron/matrix/ipc-policy.ts). A space is `%20`, never `+`, for every mail app.
 */
export function atumMailLink(mailbox: AtumMailbox, subject: string, body?: string): string {
  const fields = [`subject=${encodeURIComponent(subject)}`, ...(body ? [`body=${encodeURIComponent(body)}`] : [])]

  return `mailto:${ATUM_MAILBOXES[mailbox]}?${fields.join('&')}`
}

/** The macOS About panel's line, and the bundle's NSHumanReadableCopyright. */
export const ATUM_COPYRIGHT = `© 2026 ${ATUM_COMPANY.englishName}`
