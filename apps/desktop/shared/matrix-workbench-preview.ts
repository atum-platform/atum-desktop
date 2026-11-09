/** Display metadata only. Native retains the offered URL until explicit open. */
export interface MatrixWebPreviewOffer {
  id: string
  label: string
  hostname: string
  expiresAt: number
}

/** Native-only projection of one existing Hermes preview event. */
export interface MatrixWebPreviewTarget {
  url: string
  label: string
}
